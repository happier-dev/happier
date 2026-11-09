import { composeSessionReadinessV1, isSessionReadinessNativeSelectionV1, type SessionCredentialReadinessV1, type SessionReadinessAgentV1, type SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { resolveMachineSpawnReadinessV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { MachinesAgentsListOutputSchema, resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { MachinesAgentsListInput } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { resolveAmbientProviderConnectionForModelIntent } from '@happier-dev/agents/session/state/metadataReaders';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { tryDecryptSessionOwnerMetadataView, readSessionOwnerLocality } from '@/session/transport/encryption/sessionEncryptionContext';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import type { StoredCredentials } from '@/persistence';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ResolveSessionTransportContextResult } from './resolveSessionTransportContext';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { AccessibleMachineAccessV1 } from '@happier-dev/protocol/machines/machineAccessV1';

export type SessionReadinessInventoryReader = (input: MachinesAgentsListInput) => Promise<unknown>;
export type SessionReadinessCredentialReader = (input: Readonly<{
  machineId: string; purpose: QualifiedConnectedAccountPurposeV1; machineAccess: AccessibleMachineAccessV1 | null;
  teamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
}>) => Promise<SessionCredentialReadinessV1>;

/** Explicitly demanded status diagnostic; all network/Agent work uses the existing inventory owners. */
export async function readSessionReadiness(input: Readonly<{
  credentials: StoredCredentials;
  target: Extract<ResolveSessionTransportContextResult, { ok: true }>;
  readInventory?: SessionReadinessInventoryReader;
  readCredential?: SessionReadinessCredentialReader;
  operation?: 'conversation' | 'credential';
  credentialPurpose?: QualifiedConnectedAccountPurposeV1;
  credentialTeamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1;
}>): Promise<SessionReadinessV1> {
  const metadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
    accountEncryptionMode: input.target.accountEncryptionCurrentness.mode, rawSession: input.target.rawSession });
  const locality = readSessionOwnerLocality({ metadata, rawSession: input.target.rawSession });
  const machineId = locality?.machineId;
  let machine: SessionReadinessV1['machine'] = machineId ? { status: 'unknown', machineId } : null;
  let agent: SessionReadinessAgentV1 | null = null;
  const invocation = input.target.rawSession.effectiveAccess ?? null;
  let canReadCredential = false;
  let credentialMachineAccess: AccessibleMachineAccessV1 | null = null;
  // A denied invocation needs no Machine census, credentials or Agent probe.
  if (machineId && input.readInventory && invocation?.capabilities.submitAgentInput === true) {
    try {
      // Readiness consumes this one Machine's identity, access and presence, never the
      // fleet or private metadata: the exact host-facts read, as Machine source selection does.
      const machines = await listCurrentAccountMachines({ credentials: input.credentials, token: input.credentials.token,
        projection: 'hostFacts', machineIds: [machineId],
        ...(input.serverHttpBaseUrl ? { serverHttpBaseUrl: input.serverHttpBaseUrl } : {}), signal: input.signal,
        ...(input.authorization ? { authorization: input.authorization, effectActionId: 'session.status.get' } : {}) });
      const target = machines.find(machine => machine.id === machineId);
      if (target) {
        const reachable = isMachineReachableV1({ machine: target, nowMs: Date.now() });
        const keyAvailable = target.access?.accessState === 'ready' ? true
          : target.access ? false : 'unknown';
        canReadCredential = reachable && !target.revokedAt && !target.replacedByMachineId && keyAvailable === true;
        credentialMachineAccess = target.access ?? null;
        machine = resolveMachineSpawnReadinessV1({ selectedMachineId: machineId, machine: target,
          machineReachable: reachable, requireExactSpawnReadiness: true, keyAvailable, rpcAvailable: 'unknown' });
        const agentId = resolveAgentIdFromSessionMetadata(metadata);
        const definitionId = readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId;
        if (reachable && !target.revokedAt && !target.replacedByMachineId && keyAvailable !== false && agentId) {
          const parsed = MachinesAgentsListOutputSchema.safeParse(await input.readInventory({ machineId, agentId,
            ...(definitionId ? { definitionId } : {}) }));
          if (parsed.success) {
            // An authenticated inventory response proves this transport/key, not the Agent's auth.
            machine = resolveMachineSpawnReadinessV1({ selectedMachineId: machineId, machine: target,
              machineReachable: reachable, requireExactSpawnReadiness: true, keyAvailable: true, rpcAvailable: true });
            const facts = parsed.data.items.find(item => item.agentId === agentId && item.definitionId === definitionId);
            const unavailable = parsed.data.unavailable?.some(item => item.agentId === agentId && item.definitionId === definitionId);
            // An unread owner/selection or connected route cannot borrow native login or the reader's defaults.
            const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
            const ambientProvider = backendTarget ? resolveAmbientProviderConnectionForModelIntent({ metadata,
              agentTargetKey: buildBackendTargetKeyV2(backendTarget), sessionActive: input.target.rawSession.active }) : null;
            const native = isSessionReadinessNativeSelectionV1({ metadata,
              providerConnectionId: ambientProvider?.status === 'resolved' ? ambientProvider.providerConnectionId : undefined });
            const state = facts ? resolveMachineAgentExecutionStateV1({ ...facts,
              signIn: { status: native ? facts.signIn.status : 'unknown', native: facts.signIn },
              known: !unavailable, ...(native ? {} : { authenticationRequired: true }) }) : 'unknown';
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
  let credential: SessionCredentialReadinessV1 = { kind: input.operation === 'credential' ? 'unknown' : 'not_required' };
  if (input.operation === 'credential' && input.credentialPurpose && input.readCredential
    && canReadCredential && (invocation?.level === 'owner'
      || input.credentialTeamSelection && invocation?.capabilities.submitAgentInput === true)) {
    try { credential = await input.readCredential({ machineId: machineId!, purpose: input.credentialPurpose, machineAccess: credentialMachineAccess,
      ...(input.credentialTeamSelection ? { teamSelection: input.credentialTeamSelection } : {}) }); }
    catch { input.signal?.throwIfAborted(); }
  }
  return composeSessionReadinessV1({ configured: true, operation: input.operation ?? 'conversation', machine, agent,
    invocation, credential });
}
