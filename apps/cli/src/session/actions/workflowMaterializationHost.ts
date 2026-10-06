import { DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginActionSchemasReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryDescriptors, projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { loadAiLaunchProfileArtifacts, readAiLaunchProfileCollection } from '@happier-dev/protocol/profiles/read';
import type { AiLaunchProfile, ResolveRoleSelectionV1Input, AccountSettings, materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createRoleSourceReader, type RoleSourceReader } from '@/session/roles/roleSources';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveWorkflowAuthorizedSession } from '@/daemon/workflows/invocationRecoveryObserver';

type Materialization = Pick<Parameters<typeof materializeWorkflowAcceptedSnapshotV1>[0], 'roleSelection' | 'effects'>;
type RoleSelection = Omit<ResolveRoleSelectionV1Input, 'roleId' | 'workflowRoles' | 'runOverrides'>;
type MachineTarget = Readonly<{ machineId: string; directory: string; signal?: AbortSignal; roleSelection?: RoleSelection }>;

export type WorkflowMaterializationHostDeps = Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl?: string;
  callMachineAction: (input: Readonly<{ machineId: string; method: string; request: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  readRoleSelection: (signal?: AbortSignal) => Promise<RoleSelection>;
  readLaunchProfile: (profileId: string, signal?: AbortSignal) => Promise<AiLaunchProfile | null>;
  readWorkflowDefinition: (ref: Parameters<NonNullable<Materialization['effects']['readWorkflowDefinition']>>[0], signal?: AbortSignal)
    => ReturnType<NonNullable<Materialization['effects']['readWorkflowDefinition']>>;
  /** The executing machine's host Action catalog, never the relay's local catalog. */
  readHostActionContract?: (actionId: string, target: MachineTarget) => ReturnType<NonNullable<Materialization['effects']['readActionContract']>>;
}>;

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Captures one exact-machine catalog observation for one admission. */
export function createWorkflowMaterializationHostV1(deps: WorkflowMaterializationHostDeps) {
  return async (target: MachineTarget): Promise<Materialization> => {
    const call = (method: string, request: unknown) => deps.callMachineAction({
      machineId: target.machineId, method, request, ...(target.signal ? { signal: target.signal } : {}),
    });
    const observeMachine = async () => {
      try {
        const roster = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await call(
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { machineId: target.machineId },
        ));
        const agents = buildMachineAgentInventoryDescriptors(roster.projection);
        const request = buildMachineAgentsDetectRequest({ agents });
        const response = await call(RPC_METHODS.CAPABILITIES_DETECT, {
          ...request, requests: [...(request.requests ?? []), { id: 'tool.executionRuns' }],
        });
        const inventory = projectMachineAgentsDetectResponse({ agents, response });
        const results = object(object(response)?.results);
        const detached = object(results?.['tool.executionRuns']);
        const detachedFacts = detached?.ok === true ? object(detached.data) : null;
        return { roster, inventory, detachedFacts,
          detachedBackends: object(detachedFacts?.backends), detachedFeatures: object(detachedFacts?.features) };
      } catch (error) {
        target.signal?.throwIfAborted();
        return null;
      }
    };
    let observation: ReturnType<typeof observeMachine> | undefined;
    const readMachine = () => observation ??= observeMachine();
    const sessions = new Map<string, Promise<boolean>>();
    const readSessionAvailability = (sessionId: string) => {
      let availability = sessions.get(sessionId);
      if (!availability) {
        const read = () => resolveWorkflowAuthorizedSession({ credentials: deps.credentials, sessionId,
          machineId: target.machineId, ...(target.signal ? { signal: target.signal } : {}) });
        availability = (deps.serverHttpBaseUrl ? runWithServerHttpBaseUrl(deps.serverHttpBaseUrl, read) : read())
          .then((authorized) => authorized !== null).catch(() => {
            target.signal?.throwIfAborted();
            return false;
          });
        sessions.set(sessionId, availability);
      }
      return availability;
    };
    const roleSelection = { ...await deps.readRoleSelection(target.signal), ...target.roleSelection };
    if (roleSelection.defaultEngine) {
      // Contextual second-opinion selection can choose another Agent family.
      // Observe that inventory before roles; availability is still decided by
      // the materializer only after its policy admission.
      const machine = await readMachine();
      roleSelection.availableAgentTargetKeys = machine ? Object.entries(machine.roster.projection.agentsById).flatMap(([agentId, agent]) => {
        const item = machine.inventory.items.find((candidate) => candidate.agentId === agentId);
        return agent.identity && item?.installed && item.platform.supported && item.dependencies.every((dependency) => dependency.installed)
          ? [buildBackendTargetKeyV2({ kind: 'agent', identity: agent.identity })] : [];
      }) : [];
    }
    const readActionContract: NonNullable<Materialization['effects']['readActionContract']> = async (actionId) => {
      const machine = await readMachine();
      if (!machine) return null;
      const contributed = machine.roster.projection.actionsById[actionId];
      if (contributed?.available === false) return null;
      try {
        target.signal?.throwIfAborted();
        if (!contributed) {
          const contract = await deps.readHostActionContract?.(actionId, target) ?? null;
          target.signal?.throwIfAborted();
          return contract;
        }
        const response = await call(RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ, {
          machineId: target.machineId, qualifiedActionId: actionId, expectedOccurrenceId: contributed.occurrenceId,
        });
        target.signal?.throwIfAborted();
        const schemas = DaemonPluginActionSchemasReadResponseSchema.safeParse(response);
        return schemas.success && schemas.data.ok && schemas.data.outputSchema !== undefined
          ? { inputSchema: schemas.data.inputSchema, outputSchema: schemas.data.outputSchema } : null;
      } catch {
        target.signal?.throwIfAborted();
        return null;
      }
    };
    return {
      roleSelection,
      effects: {
        readWorkflowDefinition: (ref) => deps.readWorkflowDefinition(ref, target.signal),
        readLaunchProfile: (profileId) => deps.readLaunchProfile(profileId, target.signal),
        readActionContract,
        resolveTargetAvailability: async (leaf, { sessionIds }) => {
          for (const sessionId of sessionIds) {
            if (!await readSessionAvailability(sessionId)) return false;
          }
          if (leaf.kind === 'wait' || leaf.kind === 'workflow') return true;
          if (leaf.actionId) return (await readActionContract(leaf.actionId)) !== null;
          const selection = leaf.selection;
          // Bound Session steps continue that Session's own Agent. Synthetic
          // Action Agent-start checks still require creation inventory.
          if (leaf.kind === 'step' && leaf.executionTarget.kind === 'session'
            && (selection.conversation?.kind === 'origin_session' || selection.conversation?.kind === 'existing_session')) return true;
          if (!selection.agentTarget) return false;
          const key = buildBackendTargetKeyV2(selection.agentTarget);
          const machine = await readMachine();
          if (!machine) return false;
          const { roster, inventory, detachedFacts, detachedBackends, detachedFeatures } = machine;
          const entry = Object.entries(roster.projection.agentsById).find(([, agent]) => agent.identity
            && buildBackendTargetKeyV2({ kind: 'agent', identity: agent.identity }) === key);
          if (!entry) return false;
          const [agentId, agent] = entry;
          if (leaf.executionTarget.kind === 'session') {
            const current = inventory.items.find((item) => item.agentId === agentId);
            return Boolean(current?.installed && current.platform.supported && current.dependencies.every((dependency) => dependency.installed)
              && agent.capabilities?.sessions?.open.includes('create') === true);
          }
          const backend = object(detachedBackends?.[agent.catalogAgentId ?? agentId]);
          return detachedFacts?.available === true && detachedFeatures?.detachedScope === true && backend?.available === true;
        },
      },
    };
  };
}

/** Shared opened Account sources for direct, trigger and definition admissions. */
export function createCredentialedWorkflowMaterializationHostV1(params: Omit<WorkflowMaterializationHostDeps,
  'readRoleSelection' | 'readLaunchProfile'> & Readonly<{
  credentials: StoredCredentials;
  accountId?: string;
  serverHttpBaseUrl?: string;
  readRoleSources?: RoleSourceReader;
}>) {
  const artifactStore = createCredentialedAccountArtifactStore(params.credentials);
  return async (target: MachineTarget): Promise<Materialization & Readonly<{ agentStartPolicySnapshot: {
    policy: AccountSettings['sessionAgentSpawnPolicyV1']; workDepthLimit: AccountSettings['workDepthLimit'];
    allowLists: AccountSettings['sessionAgentStartAllowListsV1'];
  } }>> => {
    const resolve = async () => {
      target.signal?.throwIfAborted();
      const current = await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force',
        honorAccountSettingsModeEnv: false });
      target.signal?.throwIfAborted();
      if (current.source === 'none') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
      const sourceReader = params.readRoleSources ?? createRoleSourceReader({ artifactStore,
        accountId: params.accountId ?? readAccountIdFromToken(params.credentials.token) ?? undefined,
        readRawAccountSettings: async () => {
          if (!current.rawSettings) throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'content_unavailable' });
          return current.rawSettings;
        },
      });
      const roleSources = await sourceReader(target.signal);
      let launchProfiles: Promise<ReturnType<typeof readAiLaunchProfileCollection>> | undefined;
      const readLaunchProfile = async (profileId: string) => {
        launchProfiles ??= loadAiLaunchProfileArtifacts(current.settings.profiles, artifactStore, target.signal)
          .then((artifactsById) => readAiLaunchProfileCollection(current.settings.profiles, { artifactsById, includeShared: true }));
        const matching = (await launchProfiles).entries.filter((candidate) => candidate.kind !== 'opaque' && candidate.profile.id === profileId);
        const entry = matching.length === 1 ? matching[0] : undefined;
        return entry && entry.kind !== 'opaque' ? entry.profile : null;
      };
      const materialization = await createWorkflowMaterializationHostV1({ ...params,
        callMachineAction: (input) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.callMachineAction(input)) : params.callMachineAction(input),
        ...(params.readHostActionContract ? { readHostActionContract: (actionId: string, machine: MachineTarget) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.readHostActionContract!(actionId, machine))
          : params.readHostActionContract!(actionId, machine) } : {}),
        readWorkflowDefinition: (ref, signal) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.readWorkflowDefinition(ref, signal))
          : params.readWorkflowDefinition(ref, signal),
        readRoleSelection: async () => ({ settingsRoles: Object.fromEntries(roleSources.map((entry) => [entry.roleId, entry.role])),
          settingsOverrides: current.settings.rolesV1.overrides }),
        readLaunchProfile: (profileId) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => readLaunchProfile(profileId)) : readLaunchProfile(profileId),
      })(target);
      return { ...materialization, agentStartPolicySnapshot: { policy: current.settings.sessionAgentSpawnPolicyV1,
        workDepthLimit: current.settings.workDepthLimit, allowLists: current.settings.sessionAgentStartAllowListsV1 } };
    };
    return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, resolve) : resolve());
  };
}
