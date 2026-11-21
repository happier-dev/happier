import { composeSessionReadinessV1, isSessionReadinessNativeSelectionV1, type SessionCredentialReadinessV1, type SessionReadinessAgentV1, type SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol';
import { resolveMachineSpawnReadinessV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { MachinesAgentsListOutputSchema, buildMachineAgentInventoryKey, resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { MachinesAgentsListInput } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { readSessionModelSelectionV2FromMetadata, resolveAmbientProviderConnectionForModelIntent } from '@happier-dev/agents/session/state/metadataReaders';
import { resolveRetainedTeamProviderBindingRevisionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { readSessionOwnerLocality, type tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import type { StoredCredentials } from '@/persistence';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ResolveSessionTransportContextResult } from './resolveSessionTransportContext';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { AccessibleMachineAccessV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { MachineInventoryProviderIsolationObserver } from '@/session/actions/cliActionDeps/machineInventory';
import { logger } from '@/ui/logger';

export type SessionReadinessInventoryReader = (
  input: MachinesAgentsListInput, providerIsolation?: MachineInventoryProviderIsolationObserver,
) => Promise<unknown>;
export type SessionReadinessTeamProviderResourcesReader = (input: Readonly<{
  teamId: string; resourceId: string;
}>) => Promise<readonly TeamCredentialResourceCatalogEntryV1[]>;
export type SessionReadinessCredentialReader = (input: Readonly<{
  machineId: string; purpose: QualifiedConnectedAccountPurposeV1; machineAccess: AccessibleMachineAccessV1 | null;
  teamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
}>) => Promise<SessionCredentialReadinessV1>;

/** Read the admitted conversation through Session evidence and consult inventory for launch readiness. */
export async function readSessionReadiness(input: Readonly<{
  credentials: StoredCredentials;
  session: Extract<ResolveSessionTransportContextResult, { ok: true }>['rawSession'];
  metadata: ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
  awareness: SessionAwarenessProjectionV1;
  readInventory?: SessionReadinessInventoryReader;
  readCredential?: SessionReadinessCredentialReader;
  readTeamProviderResources?: SessionReadinessTeamProviderResourcesReader;
  operation?: 'conversation' | 'credential';
  credentialPurpose?: QualifiedConnectedAccountPurposeV1;
  credentialTeamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1;
}>): Promise<SessionReadinessV1> {
  const { session, metadata, awareness } = input;
  const locality = readSessionOwnerLocality({ metadata, rawSession: session });
  const machineId = locality?.machineId;
  let machine: SessionReadinessV1['machine'] = machineId ? { status: 'unknown', machineId } : null;
  let agent: SessionReadinessAgentV1 | null = null;
  let machineUnknownReason: SessionReadinessV1['reason'];
  let agentUnknownReason: SessionReadinessV1['reason'];
  const invocation = session.effectiveAccess ?? null;
  const model = invocation?.capabilities.submitAgentInput && input.operation !== 'credential' && !session.active
    ? readSessionModelSelectionV2FromMetadata(metadata)?.ref : null;
  const teamModel = model?.source === 'team_resource' ? model : null;
  let credential: SessionCredentialReadinessV1 = teamModel
    ? { kind: 'team', teamId: teamModel.teamId, resourceId: teamModel.resourceId, readiness: null, recoveryAction: null }
    : { kind: input.operation === 'credential' ? 'unknown' : 'not_required' };
  let canReadCredential = false;
  let credentialMachineAccess: AccessibleMachineAccessV1 | null = null;
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  const definitionId = readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId;
  const liveConversation = input.operation !== 'credential' && awareness.freshness === 'live'
    && (awareness.runtime === 'working' || (awareness.runtime === 'idle' && awareness.operational.primary === 'ready'));
  if (machineId && agentId && invocation?.capabilities.submitAgentInput === true && liveConversation) {
    machine = { status: 'ready', machineId };
    agent = { agentId, ...(definitionId ? { definitionId } : {}), current: true,
      observedAtMs: session.activeAt, state: 'ready', repair: null };
  } else if (machineId && !invocation) {
    machineUnknownReason = 'invocation_access_unknown';
  } else if (machineId && !input.readInventory) {
    machineUnknownReason = 'agent_inventory_reader_unavailable';
  } else if (machineId && input.readInventory && invocation?.capabilities.submitAgentInput === true) {
    machineUnknownReason = 'machine_host_facts_unavailable';
    try {
      // Readiness consumes this one Machine's identity, access and presence, never the
      // fleet or private metadata: the exact host-facts read, as Machine source selection does.
      const machines = await listCurrentAccountMachines({ credentials: input.credentials, token: input.credentials.token,
        projection: 'hostFacts', machineIds: [machineId],
        ...(input.serverHttpBaseUrl ? { serverHttpBaseUrl: input.serverHttpBaseUrl } : {}), signal: input.signal,
        ...(input.authorization ? { authorization: input.authorization, effectActionId: 'session.status.get' } : {}) });
      const target = machines.find(machine => machine.id === machineId);
      if (!target) machineUnknownReason = 'machine_host_facts_missing';
      if (target) {
        machineUnknownReason = 'machine_readiness_unknown';
        const reachable = isMachineReachableV1({ machine: target, nowMs: Date.now() });
        const keyAvailable = target.access?.accessState === 'ready' ? true
          : target.access ? false : 'unknown';
        canReadCredential = reachable && !target.revokedAt && !target.replacedByMachineId && keyAvailable === true;
        credentialMachineAccess = target.access ?? null;
        machine = resolveMachineSpawnReadinessV1({ selectedMachineId: machineId, machine: target,
          machineReachable: reachable, requireExactSpawnReadiness: true, keyAvailable, rpcAvailable: 'unknown' });
        if (!agentId) machineUnknownReason = 'session_agent_unknown';
        if (reachable && !target.revokedAt && !target.replacedByMachineId && keyAvailable !== false && agentId) {
          machineUnknownReason = 'agent_inventory_unavailable';
          let suppressConnectedServiceIds: readonly string[] = [];
          const parsed = MachinesAgentsListOutputSchema.safeParse(await input.readInventory({ machineId, agentId,
            ...(definitionId ? { definitionId } : {}) }, teamModel ? {
            agentTargetKey: teamModel.agentTargetKey,
            reportSuppression: serviceIds => { suppressConnectedServiceIds = serviceIds; },
          } : undefined));
          if (!parsed.success) machineUnknownReason = 'agent_inventory_invalid';
          if (parsed.success) {
            // An authenticated inventory response proves this transport/key, not the Agent's auth.
            machine = resolveMachineSpawnReadinessV1({ selectedMachineId: machineId, machine: target,
              machineReachable: reachable, requireExactSpawnReadiness: true, keyAvailable: true, rpcAvailable: true });
            const selectionKey = buildMachineAgentInventoryKey({ agentId, definitionId });
            const facts = parsed.data.items.find(item => buildMachineAgentInventoryKey(item) === selectionKey);
            const unavailable = parsed.data.unavailable?.some(item => buildMachineAgentInventoryKey(item) === selectionKey);
            if (unavailable) agentUnknownReason = 'agent_inventory_item_unavailable';
            else if (!facts) agentUnknownReason = 'agent_inventory_item_missing';
            // An unread owner/selection or connected route cannot borrow native login or the reader's defaults.
            const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
            const ambientProvider = backendTarget ? resolveAmbientProviderConnectionForModelIntent({ metadata,
              agentTargetKey: buildBackendTargetKeyV2(backendTarget), sessionActive: session.active }) : null;
            const native = isSessionReadinessNativeSelectionV1({ metadata,
              providerConnectionId: ambientProvider?.status === 'resolved' ? ambientProvider.providerConnectionId : undefined });
            let teamProviderAuthReady = false;
            if (teamModel && canReadCredential && input.readTeamProviderResources
              && backendTarget && buildBackendTargetKeyV2(backendTarget) === teamModel.agentTargetKey) {
              const binding = session.acceptedTeamCredentialBinding;
              const revision = binding?.slot.kind === 'provider_model' && binding.resourceId !== null
                ? resolveRetainedTeamProviderBindingRevisionV1(teamModel, binding) : null;
              if (revision !== null) {
                try {
                  const resources = await input.readTeamProviderResources({ teamId: teamModel.teamId, resourceId: teamModel.resourceId });
                  const resource = resources.find(row => row.id === teamModel.resourceId
                    && row.teamId === teamModel.teamId && row.resourceRevision === revision);
                  if (resource) {
                    const readiness = readTeamCredentialDeliveryReadinessV1(resource.readiness, teamModel.deliveryMode);
                    credential = { kind: 'team', teamId: teamModel.teamId, resourceId: teamModel.resourceId,
                      readiness, recoveryAction: resource.recoveryAction };
                    const connected = ConnectedServiceBindingsV2IngressSchema.safeParse(metadata?.connectedServices);
                    teamProviderAuthReady = readiness.kind === 'available' && (metadata?.connectedServices === undefined
                      || connected.success && Object.keys(connected.data.bindingsByServiceId).length === 0);
                    if (!teamProviderAuthReady && readiness.kind === 'available'
                      && connected.success && suppressConnectedServiceIds.length > 0) {
                      const { filterSuppressedConnectedServiceBindings } = await import('@/providers/spawn/authorize');
                      teamProviderAuthReady = filterSuppressedConnectedServiceBindings({
                        bindings: connected.data, suppressConnectedServiceIds,
                      }).bindings === null;
                    }
                  }
                } catch { input.signal?.throwIfAborted(); }
              }
            }
            const state = facts ? resolveMachineAgentExecutionStateV1({ ...facts,
              signIn: { status: native ? facts.signIn.status : 'unknown', native: facts.signIn },
              known: !unavailable, ...(native ? {} : { authenticationRequired: !teamProviderAuthReady }) }) : 'unknown';
            agent = { agentId, ...(definitionId ? { definitionId } : {}), current: Boolean(facts && !unavailable),
              observedAtMs: facts && !unavailable ? Date.now() : null, state,
              repair: state === 'needsSignIn' && native && target.access?.role === 'manage'
                && facts?.signIn.loginSupport === 'login_terminal'
                ? { actionId: 'machines.agents.signIn.start', input: { machineId, agentId, method: 'native' } } : null };
          }
        }
      }
    } catch {
      input.signal?.throwIfAborted();
      // Incomplete inventory is unknown. A timeout or unsupported inventory never asserts offline.
    }
  }
  if (input.operation === 'credential' && input.credentialPurpose && input.readCredential
    && canReadCredential && (invocation?.level === 'owner'
      || input.credentialTeamSelection && invocation?.capabilities.submitAgentInput === true)) {
    try { credential = await input.readCredential({ machineId: machineId!, purpose: input.credentialPurpose, machineAccess: credentialMachineAccess,
      ...(input.credentialTeamSelection ? { teamSelection: input.credentialTeamSelection } : {}) }); }
    catch { input.signal?.throwIfAborted(); }
  }
  const readiness = composeSessionReadinessV1({ configured: true, operation: input.operation ?? 'conversation', machine, agent,
    invocation, credential }, { credentialRequiredForConversation: teamModel !== null, machineUnknownReason, agentUnknownReason });
  if (readiness.reason) {
    try {
      logger.infoFile('[SESSION] Readiness unknown', JSON.stringify({
        operation: readiness.operation, cause: readiness.cause, reason: readiness.reason,
        machineStatus: machine?.status ?? null, agentState: agent?.state ?? null,
        agentCurrent: agent?.current ?? null, agentObservedAtMs: agent?.observedAtMs ?? null,
        invocationFactsPresent: invocation !== null, credentialKind: credential.kind,
      }));
    } catch { /* A diagnostic sink cannot replace readiness. */ }
  }
  return readiness;
}
