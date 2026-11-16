import { DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginActionSchemasReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryDescriptors, projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { requireReadyAcpCatalog } from '@/agent/acp/catalog/configured/resolveBackend';
import type { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import type { readAccountLaunchProfiles } from '@/settings/profiles/readProfilesFromAccountSettings';
import type { AiLaunchProfile, AccountSettings, materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import type { createRoleSourceReader, RoleSourceReader } from '@/session/roles/roleSources';
import type { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { resolveWorkflowAuthorizedSession } from '@/daemon/workflows/invocationRecoveryObserver';
import type { WorkflowTargetUnavailableDetailsV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { ActionSessionAddressV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { WorkflowSessionConversation } from '@/daemon/workflows/sessionStepExecutor';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';

type Materialization = Pick<Parameters<typeof materializeWorkflowAcceptedSnapshotV1>[0], 'roleSelection' | 'effects'>;
type RoleSelection = NonNullable<Materialization['roleSelection']>;
type MachineTarget = Readonly<{ machineId: string; directory: string; signal?: AbortSignal;
  roleSelection?: RoleSelection | (() => Promise<RoleSelection>) }>;

/** Origin selection is a contextual fallback; Role and explicit engine overrides remain Protocol-owned. */
export function projectWorkflowConversationRoleSelection(origin: WorkflowSessionConversation, machineId: string): RoleSelection {
  const modelId = origin.runtimeSnapshot?.modelSelection?.value?.modelId;
  return {
    sessionRoles: origin.sessionRoles,
    ...(origin.machineId === machineId && typeof origin.runtimeSelection?.profileId === 'string'
      ? { defaultProfileId: origin.runtimeSelection.profileId } : {}),
    defaultConnectedServices: origin.machineId === machineId ? origin.runtimeSelection?.connectedServices : undefined,
    ...(origin.agentTarget ? { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(origin.agentTarget),
      ...(modelId ? { modelId } : {}) } } : {}),
  };
}

export type WorkflowMaterializationHostDeps = Readonly<{
  credentials: StoredCredentials;
  serverId?: string;
  serverIdentityId?: string;
  serverHttpBaseUrl?: string;
  callMachineAction: (input: Readonly<{ machineId: string; method: string; request: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  readRoleSelection: (roleId: string, signal?: AbortSignal) => Promise<RoleSelection>;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  readAcpCatalog?: (signal?: AbortSignal) => Promise<AcpCatalogSnapshotV1>;
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
    const { resolveWorkflowAuthorizedSession } = await import('@/daemon/workflows/invocationRecoveryObserver');
    const call = (method: string, request: unknown) => deps.callMachineAction({
      machineId: target.machineId, method, request, ...(target.signal ? { signal: target.signal } : {}),
    });
    const observeRoster = async () => {
      try {
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await call(
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
          { machineId: target.machineId, selection: 'workflowMaterialization' },
        ));
      } catch (error) {
        target.signal?.throwIfAborted();
        throw error;
      }
    };
    let rosterObservation: ReturnType<typeof observeRoster> | undefined;
    const readRoster = () => rosterObservation ??= observeRoster();
    const observeMachine = async () => {
      try {
        const roster = await readRoster();
        if (!roster) return null;
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
        throw error;
      }
    };
    let observation: ReturnType<typeof observeMachine> | undefined;
    const readMachine = () => observation ??= observeMachine();
    const sessions = new Map<string, ReturnType<typeof resolveWorkflowAuthorizedSession>>();
    const { runWithServerHttpBaseUrl } = await import("@/api/client/serverHttpBaseUrl");
    const readSession = (sessionId: string) => {
      let observation = sessions.get(sessionId);
      if (!observation) {
        const read = () => resolveWorkflowAuthorizedSession({ credentials: deps.credentials, sessionId,
          ...(target.signal ? { signal: target.signal } : {}) });
        observation = (deps.serverHttpBaseUrl ? runWithServerHttpBaseUrl(deps.serverHttpBaseUrl, read) : read())
          .catch((error) => {
            target.signal?.throwIfAborted();
            throw error;
          });
        sessions.set(sessionId, observation);
      }
      return observation;
    };
    let catalogObservation: Promise<AcpCatalogSnapshotV1 | undefined> | undefined;
    const readDefinitionIds = async (required = false) => {
      catalogObservation ??= deps.readAcpCatalog
        ? deps.readAcpCatalog(target.signal) : Promise.resolve(deps.acpCatalogSnapshot);
      const catalog = await catalogObservation;
      target.signal?.throwIfAborted();
      // Optional contextual choices cannot make native admission depend on the
      // configured catalog. Explicit selections still require ready membership.
      const { requireReadyAcpCatalog } = await import("@/agent/acp/catalog/configured/resolveBackend");
      return !required && catalog?.status !== 'ready' ? [] : requireReadyAcpCatalog(catalog).record.definitions.map((definition) => definition.id);
    };
    const readAmbientRoleSelection = async (): Promise<RoleSelection> => {
      const roleSelection = { ...(typeof target.roleSelection === 'function'
        ? await target.roleSelection() : target.roleSelection) };
      if (roleSelection.defaultEngine) {
        // Contextual second-opinion selection can choose another Agent family.
        // Observe that inventory before roles; availability is still decided by
        // the materializer only after its policy admission.
        const machine = await readMachine();
        const definitionIds = machine && Object.values(machine.roster.projection.agentsById)
          .some((agent) => agent.identity && listAgentExecutionTargetsV1(agent.identity).length === 0)
          ? await readDefinitionIds() : [];
        roleSelection.availableAgentTargetKeys = machine ? Object.entries(machine.roster.projection.agentsById).flatMap(([agentId, agent]) => {
          const item = machine.inventory.items.find((candidate) => candidate.agentId === agentId);
          return agent.identity ? listAgentExecutionTargetsV1(agent.identity, definitionIds).flatMap((executionTarget) => {
            const key = buildBackendTargetKeyV2(executionTarget);
            const available = executionTarget.definitionId === undefined
              ? item?.installed && item.platform.supported && item.dependencies.every((dependency) => dependency.installed)
              : object(machine.detachedBackends?.[key])?.available === true;
            return available ? [key] : [];
          }) : [];
        }) : [];
      }
      return roleSelection;
    };
    const observeActionContract: NonNullable<Materialization['effects']['readActionContract']> = async (actionId) => {
      // Native and contributed Action contracts do not consume Agent launch
      // readiness; a missing requester OS user must not hide their schemas.
      const roster = await readRoster();
      if (!roster) return null;
      const contributed = roster.projection.actionsById[actionId];
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
        return schemas.success && schemas.data.ok ? freezeWorkflowActionContractV1({ ...schemas.data,
          inputHints: contributed.inputHints }) : null;
      } catch (error) {
        target.signal?.throwIfAborted();
        throw error;
      }
    };
    const actionContracts = new Map<string, ReturnType<typeof observeActionContract>>();
    const readActionContract: typeof observeActionContract = async (actionId) => {
      target.signal?.throwIfAborted();
      let contract = actionContracts.get(actionId);
      if (!contract) {
        // Schema freezing, availability and repeated leaves consume the same
        // admission observation. A replay creates a new host and rechecks it.
        contract = observeActionContract(actionId);
        actionContracts.set(actionId, contract);
      }
      return contract;
    };
    return {
      roleSelection: typeof target.roleSelection === 'function' ? undefined : target.roleSelection,
      effects: {
        readRoleSelection: async (roleId) => {
          if (roleId === undefined) return readAmbientRoleSelection();
          target.signal?.throwIfAborted();
          const selected = await deps.readRoleSelection(roleId, target.signal);
          target.signal?.throwIfAborted();
          return selected;
        },
        readWorkflowDefinition: (ref) => deps.readWorkflowDefinition(ref, target.signal),
        readLaunchProfile: (profileId) => deps.readLaunchProfile(profileId, target.signal),
        readActionContract,
        resolveSessionTarget: async (value) => {
          target.signal?.throwIfAborted();
          const serverId = deps.serverIdentityId ?? deps.serverId;
          if (!serverId || !deps.serverId) return null;
          const address = ActionSessionAddressV1Schema.safeParse(typeof value === 'string'
            ? { serverId, sessionId: value } : value);
          if (!address.success) return null;
          const { isServerProfileHomeIdentity } = await import("@/server/serverProfiles");
          if (address.data.serverId !== serverId && address.data.serverId !== deps.serverId
            && !await isServerProfileHomeIdentity(deps.serverId, address.data.serverId)) return null;
          const authorized = await readSession(address.data.sessionId);
          target.signal?.throwIfAborted();
          return authorized ? { address: { serverId: address.data.serverId, sessionId: authorized.target.sessionId }, machineId: authorized.machineId } : null;
        },
        resolveTargetAvailability: async (leaf, { sessionIds }) => {
          const unavailable = (reason: WorkflowTargetUnavailableDetailsV1['reason'],
            facts: Pick<WorkflowTargetUnavailableDetailsV1, 'agentId' | 'errorCode' | 'platformReason'> = {}): WorkflowTargetUnavailableDetailsV1 => (
            { code: 'target_unavailable', reason, ...facts }
          );
          const participant = leaf.participant;
          if (participant) {
            const serverId = deps.serverIdentityId ?? deps.serverId;
            const participantServerId = participant.kind === 'session'
              ? participant.session.serverId : participant.launch.executionTarget.serverId;
            const { isServerProfileHomeIdentity } = await import("@/server/serverProfiles");
            if (!deps.serverId || !serverId || participantServerId !== serverId
              && participantServerId !== deps.serverId
              && !await isServerProfileHomeIdentity(deps.serverId, participantServerId)) {
              return unavailable('selection_unavailable');
            }
            if (participant.kind === 'session') {
              const authorized = await readSession(participant.session.sessionId);
              target.signal?.throwIfAborted();
              if (!authorized || authorized.machineId !== participant.machineId) return unavailable('session_unavailable');
            } else if (participant.launch.executionTarget.machineId !== target.machineId
              || participant.launch.directory.kind === 'managed'
              || participant.launch.checkoutCreationDraft != null) {
              return unavailable('selection_unavailable');
            }
          }
          for (const sessionId of sessionIds) {
            const conversation = leaf.selection.conversation;
            const machineId = conversation?.kind === 'existing_session' && conversation.sessionId === sessionId
              ? conversation.machineId : target.machineId;
            const authorized = await readSession(sessionId);
            target.signal?.throwIfAborted();
            if (!authorized || authorized.machineId !== machineId) return unavailable('session_unavailable');
          }
          if (leaf.kind === 'wait' || leaf.kind === 'workflow') return true;
          if (leaf.actionId) return (await readActionContract(leaf.actionId)) !== null || unavailable('action_unavailable');
          const selection = leaf.selection;
          // Bound Session steps continue that Session's own Agent. Synthetic
          // Action Agent-start checks still require creation inventory.
          if (leaf.kind === 'step' && leaf.executionTarget.kind === 'session'
            && (selection.conversation?.kind === 'origin_session' || selection.conversation?.kind === 'existing_session')) return true;
          const agentTarget = participant?.kind === 'model' ? participant.launch.agentTarget : selection.agentTarget;
          if (!agentTarget) return unavailable('selection_unavailable');
          const definitionIds = agentTarget.definitionId === undefined ? [] : await readDefinitionIds(true);
          if (agentTarget.definitionId !== undefined && !definitionIds.includes(agentTarget.definitionId)) return unavailable('selection_unavailable');
          const key = buildBackendTargetKeyV2(agentTarget);
          const machine = await readMachine();
          if (!machine) return unavailable('machine_check_failed');
          const { roster, inventory, detachedFacts, detachedBackends, detachedFeatures } = machine;
          const entry = Object.entries(roster.projection.agentsById).find(([, agent]) => agent.identity
            && listAgentExecutionTargetsV1(agent.identity, definitionIds).some((executionTarget) => buildBackendTargetKeyV2(executionTarget) === key));
          if (!entry) return unavailable('selection_unavailable');
          const [agentId, agent] = entry;
          const backend = object(detachedBackends?.[agentTarget.definitionId === undefined ? agent.catalogAgentId ?? agentId : key]);
          if (leaf.executionTarget.kind === 'session') {
            if (agent.capabilities?.sessions?.open.includes('create') !== true) return unavailable('session_creation_unavailable', { agentId });
            if (agentTarget.definitionId !== undefined) {
              return backend?.available === true || unavailable('selection_unavailable', { agentId });
            }
          }
          // A Session-backed detached Run opens the same Agent executable.
          // Declared Run support cannot override the Machine's installation facts.
          // Configured commands and execution-only factories retain their own owners.
          if (agent.capabilities?.sessions && agentTarget.definitionId === undefined) {
            const current = inventory.items.find((item) => item.agentId === agentId);
            if (!current) {
              const failed = inventory.unavailable?.find((item) => item.agentId === agentId);
              return unavailable('agent_probe_failed', { agentId, ...(failed?.errorCode ? { errorCode: failed.errorCode } : {}) });
            }
            if (!current.installed) return unavailable('agent_not_installed', { agentId });
            if (!current.platform.supported) return unavailable('platform_unsupported', { agentId, platformReason: current.platform.reason });
            if (!current.dependencies.every((dependency) => dependency.installed)) return unavailable('dependency_not_installed', { agentId });
          }
          if (leaf.executionTarget.kind === 'session') return true;
          return (detachedFacts?.available === true && detachedFeatures?.detachedScope === true && backend?.available === true)
            || unavailable('detached_execution_unavailable', { agentId });
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
  savedSecretOperationContext?: SavedSecretOperationContextV1;
}>) {
  const artifactStore = createCredentialedAccountArtifactStore(params.credentials);
  return async (target: MachineTarget): Promise<Materialization & Readonly<{ agentStartPolicySnapshot: {
    policy: AccountSettings['sessionAgentSpawnPolicyV1']; workDepthLimit: AccountSettings['workDepthLimit'];
    allowLists: AccountSettings['sessionAgentStartAllowListsV1'];
  } }>> => {
    const resolve = async () => {
      target.signal?.throwIfAborted();
      const operation = params.savedSecretOperationContext;
      const [{ readAccountIdFromToken }, { bootstrapAccountSettingsContext }, { resolveAccountSettingsScopeKeyForToken }, { getActiveAccountSettingsSnapshotLifetimeToken, getActiveAccountSettingsSnapshot }, { createRoleSourceReader }, { runWithServerHttpBaseUrl }] = await Promise.all([import("@/cloud/decodeJwtPayload"), import("@/settings/accountSettings/bootstrapAccountSettingsContext"), import("@/settings/accountSettings/accountSettingsScopeKey"), import("@/settings/accountSettings/activeAccountSettingsSnapshot"), import("@/session/roles/roleSources"), import("@/api/client/serverHttpBaseUrl")]);
      const scopeKey = resolveAccountSettingsScopeKeyForToken(params.credentials.token);
      if (operation && (operation.credentials.token !== params.credentials.token || !await operation.isCurrent())) {
        throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
      }
      const current = operation ? operation.readSnapshot()
        : await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force',
          honorAccountSettingsModeEnv: false });
      target.signal?.throwIfAborted();
      if (!current || current.source === 'none' || current.scopeKey !== scopeKey) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
      const roleAccount = { credentials: params.credentials,
        scopeKey, operationContext: operation,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), ...(target.signal ? { signal: target.signal } : {}) };
      const readSnapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
      const assertCurrent = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const { getActiveAccountSettingsSnapshotLifetimeToken } = await import("@/settings/accountSettings/activeAccountSettingsSnapshot");
        if (operation && !await operation.isCurrent() || readSnapshot()?.scopeKey !== scopeKey
          || !operation && getActiveAccountSettingsSnapshotLifetimeToken() !== roleAccount.lifetimeToken) {
          throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        }
      };
      const sourceReader = params.readRoleSources ?? createRoleSourceReader({ artifactStore,
        accountId: params.accountId ?? readAccountIdFromToken(params.credentials.token) ?? undefined,
        readRawAccountSettings: async () => {
          if (!current.rawSettings) throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'content_unavailable' });
          return current.rawSettings;
        },
      });
      let launchProfiles: ReturnType<typeof readAccountLaunchProfiles> | undefined;
      const readLaunchProfile = async (profileId: string) => {
        const { readAccountLaunchProfiles } = await import("@/settings/profiles/readProfilesFromAccountSettings");
        launchProfiles ??= readAccountLaunchProfiles(current.settings, params.credentials, target.signal, undefined, operation);
        const matching = (await launchProfiles).visibleProfiles.filter((candidate) => candidate.id === profileId);
        return matching.length === 1 && matching[0]!.enabled !== false ? matching[0]! : null;
      };
      const materialization = await createWorkflowMaterializationHostV1({ ...params,
        acpCatalogSnapshot: readSnapshot()?.acpCatalog,
        readAcpCatalog: async (signal) => {
          await assertCurrent(signal);
          const catalog = readSnapshot()?.acpCatalog;
          const { refreshActiveAcpCatalog } = await import("@/agent/acp/catalog/hydrateAcpCatalog");
          const prepared = catalog?.status === 'ready' ? catalog : await refreshActiveAcpCatalog({ credentials: params.credentials, signal, operationContext: operation });
          await assertCurrent(signal);
          return prepared;
        },
        callMachineAction: (input) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.callMachineAction(input)) : params.callMachineAction(input),
        ...(params.readHostActionContract ? { readHostActionContract: (actionId: string, machine: MachineTarget) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.readHostActionContract!(actionId, machine))
          : params.readHostActionContract!(actionId, machine) } : {}),
        readWorkflowDefinition: (ref, signal) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => params.readWorkflowDefinition(ref, signal))
          : params.readWorkflowDefinition(ref, signal),
        readRoleSelection: (roleId, signal) => {
          const read = async () => {
            await assertCurrent(signal);
            const roleSources = await sourceReader(signal, { roleIds: [roleId] });
            await assertCurrent(signal);
            // Open current Account overrides only when a Role is consumed.
            const { prepareActiveAccountRoleOverrides } = await import("@/settings/prompts/hydratePromptLibraryCatalog");
            const roleOverrides = await prepareActiveAccountRoleOverrides(roleAccount);
            await assertCurrent(signal);
            if (roleOverrides.status !== 'ready') throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' });
            return { roleSourceInventory: roleSources, settingsOverrides: roleOverrides.overrides };
          };
          return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read();
        },
        readLaunchProfile: (profileId) => params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => readLaunchProfile(profileId)) : readLaunchProfile(profileId),
      })(target);
      return { ...materialization, agentStartPolicySnapshot: { policy: current.settings.sessionAgentSpawnPolicyV1,
        workDepthLimit: current.settings.workDepthLimit, allowLists: current.settings.sessionAgentStartAllowListsV1 } };
    };
    const { runWithServerHttpBaseUrl } = await import("@/api/client/serverHttpBaseUrl");
    return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, resolve) : resolve());
  };
}
