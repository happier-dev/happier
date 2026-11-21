import { throwIfAborted } from '../../abortSignal.js';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginActionSchemasReadResponseSchema } from '../../daemon/contributionRegistryProjection.js';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryDescriptors, projectMachineAgentsDetectResponse } from '../../capabilities/machineAgentInventory.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { listAgentExecutionTargetsV1 } from '../../agents/executionTargetV1.js';
import type { AcpCatalogSnapshotV1 } from '../../acp/catalog/catalogRowsV1.js';
import type { AiLaunchProfile } from '../../profiles/read.js';
import type { materializeWorkflowAcceptedSnapshotV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { WorkflowTargetUnavailableDetailsV1 } from '../../workflows/workflowProgressV1.js';
import { ActionSessionAddressV1Schema } from '../sessionTargetV1.js';
import { freezeWorkflowActionContractV1 } from '../actionCatalog.js';
import { parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionKey.js';

type Materialization = Pick<Parameters<typeof materializeWorkflowAcceptedSnapshotV1>[0], 'roleSelection' | 'effects'>;
type RoleSelection = NonNullable<Materialization['roleSelection']>;
export type WorkflowMaterializationMachineTargetV1 = Readonly<{ machineId: string; directory: string; signal?: AbortSignal;
  roleSelection?: RoleSelection | (() => Promise<RoleSelection>) }>;
type MachineTarget = WorkflowMaterializationMachineTargetV1;

/** Host readers authorize Account content; one shared owner projects exact-Machine materialization facts. */
export type WorkflowMaterializationHostDepsV1 = Readonly<{
  serverId?: string;
  serverIdentityId?: string;
  readAuthorizedSession: (sessionId: string, signal?: AbortSignal) => Promise<Readonly<{ target: Readonly<{ sessionId: string }>; machineId: string }> | null>;
  isHomeEquivalent: (serverId: string) => boolean | Promise<boolean>;
  callMachineAction: (input: Readonly<{ machineId: string; method: string; request: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  readRoleSelection: (roleId: string, signal?: AbortSignal) => Promise<RoleSelection>;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  readAcpCatalog?: (signal?: AbortSignal) => Promise<AcpCatalogSnapshotV1>;
  readLaunchProfile: (profileId: string, signal?: AbortSignal) => Promise<AiLaunchProfile | null>;
  readWorkflowDefinition: (ref: Parameters<NonNullable<Materialization['effects']['readWorkflowDefinition']>>[0], signal?: AbortSignal)
    => ReturnType<NonNullable<Materialization['effects']['readWorkflowDefinition']>>;
  /** The executing Machine's host Action catalog, never the relay's local catalog. */
  readHostActionContract?: (actionId: string, target: MachineTarget) => ReturnType<NonNullable<Materialization['effects']['readActionContract']>>;
}>;

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Captures one exact-machine catalog observation for one admission. */
export function createWorkflowMaterializationHostV1(deps: WorkflowMaterializationHostDepsV1) {
  return async (target: MachineTarget): Promise<Materialization> => {
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
        throwIfAborted(target.signal);
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
        throwIfAborted(target.signal);
        throw error;
      }
    };
    let observation: ReturnType<typeof observeMachine> | undefined;
    const readMachine = () => observation ??= observeMachine();
    const sessions = new Map<string, ReturnType<WorkflowMaterializationHostDepsV1['readAuthorizedSession']>>();
    const readSession = (sessionId: string) => {
      let observation = sessions.get(sessionId);
      if (!observation) {
        observation = deps.readAuthorizedSession(sessionId, target.signal)
          .catch((error) => {
            throwIfAborted(target.signal);
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
      throwIfAborted(target.signal);
      // Optional contextual choices cannot make native admission depend on the
      // configured catalog. Explicit selections still require ready membership.
      const { requireReadyAcpCatalog } = await import('../../acp/catalog/catalogRowsV1.js');
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
      // Workflow executable IDs and the roster/schema RPC's contribution keys
      // use their respective canonical identity owners.
      const identity = parseQualifiedPluginActionId(actionId);
      const contributionKey = identity ? buildQualifiedPluginContributionKey(identity) : actionId;
      const contributed = roster.projection.actionsById[contributionKey];
      if (contributed?.available === false) return null;
      try {
        throwIfAborted(target.signal);
        if (!contributed) {
          const contract = await deps.readHostActionContract?.(actionId, target) ?? null;
          throwIfAborted(target.signal);
          return contract;
        }
        const response = await call(RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ, {
          machineId: target.machineId, qualifiedActionId: contributionKey, expectedOccurrenceId: contributed.occurrenceId,
        });
        throwIfAborted(target.signal);
        const schemas = DaemonPluginActionSchemasReadResponseSchema.safeParse(response);
        return schemas.success && schemas.data.ok ? freezeWorkflowActionContractV1({ ...schemas.data,
          // An exact contributed declaration can omit its result schema.
          outputSchema: schemas.data.outputSchema ?? {},
          inputHints: contributed.inputHints }) : null;
      } catch (error) {
        throwIfAborted(target.signal);
        throw error;
      }
    };
    const actionContracts = new Map<string, ReturnType<typeof observeActionContract>>();
    const readActionContract: typeof observeActionContract = async (actionId) => {
      throwIfAborted(target.signal);
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
          throwIfAborted(target.signal);
          const selected = await deps.readRoleSelection(roleId, target.signal);
          throwIfAborted(target.signal);
          return selected;
        },
        readWorkflowDefinition: (ref) => deps.readWorkflowDefinition(ref, target.signal),
        readLaunchProfile: (profileId) => deps.readLaunchProfile(profileId, target.signal),
        readActionContract,
        resolveSessionTarget: async (value) => {
          throwIfAborted(target.signal);
          const serverId = deps.serverIdentityId ?? deps.serverId;
          if (!serverId || !deps.serverId) return null;
          const address = ActionSessionAddressV1Schema.safeParse(typeof value === 'string'
            ? { serverId, sessionId: value } : value);
          if (!address.success) return null;
          if (address.data.serverId !== serverId && address.data.serverId !== deps.serverId
            && !await deps.isHomeEquivalent(address.data.serverId)) return null;
          const authorized = await readSession(address.data.sessionId);
          throwIfAborted(target.signal);
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
            if (!deps.serverId || !serverId || participantServerId !== serverId
              && participantServerId !== deps.serverId
              && !await deps.isHomeEquivalent(participantServerId)) {
              return unavailable('selection_unavailable');
            }
            if (participant.kind === 'session') {
              const authorized = await readSession(participant.session.sessionId);
              throwIfAborted(target.signal);
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
            throwIfAborted(target.signal);
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
