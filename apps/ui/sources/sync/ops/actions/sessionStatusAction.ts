import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol/sessions/metadata/systemSessionV1';
import { projectSessionSummaryV1 } from '@happier-dev/protocol/sessions/control/contract';
import { composeSessionReadinessV1, isSessionReadinessNativeSelectionV1, readSessionOperationCredentialReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { resolveAgentExecutionTargetFromSessionMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { resolveAmbientProviderConnectionForModelIntent, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { isDataKeyAuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { readMachineAgentsForScope, refreshMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readAdmittedConnectedAccountCatalogInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { listEntitledTeamCredentialResources } from '@/sync/ops/teams/teamCredentialOperations';
import { buildSessionReadinessViewModel } from '@/components/sessions/model/sessionReadinessViewModel';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTargetKey } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionAcceptedWorkspace } from '@/sync/domains/session/sessionAcceptedWorkspace';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Status stays usable without a running Agent; detail reads are explicit and use the existing inventory. */
export function createUiSessionStatusGet(account: LazyActionAccountContext | null | undefined,
  options?: Readonly<{ refreshReadiness?: boolean }>): NonNullable<ActionExecutorDeps['sessionStatusGet']> {
  return async ({ sessionId, readiness, includeAcceptedWorkspace, operation, credentialPurpose, credentialTeamSelection, serverId, signal }) => {
    if (!account) return { ok: false, code: 'not_authenticated' };
    account.assertCurrent();
    signal?.throwIfAborted();
    // The Action context names the Home by its profile id; the captured Account scope by its portable id.
    if (serverId && !areServerProfileIdentifiersEquivalent(serverId, account.serverId)) return { ok: false, code: 'server_scope_mismatch' };
    let session: Awaited<ReturnType<typeof readSessionSnapshotForAuthority>>['session'];
    try {
      ({ session } = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope,
        activeRequest: account.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId,
          isCurrent: account.accountLifetime.isCurrent })));
    } catch (error) {
      // The Home answered that this Session does not exist: a definite answer, unlike an unreachable Home.
      if (error instanceof SessionSnapshotReadError && error.httpStatus === 404) return { ok: false, code: 'session_not_found' };
      throw error;
    }
    account.assertCurrent();
    signal?.throwIfAborted();
    const access = session.access;
    const invocation = access ? { v: 1 as const, level: access.level, sources: access.sources ?? [], capabilities: access.capabilities } : null;
    const metadata = readSessionOwnerMetadataView(session);
    const presentationMetadata = metadata ?? session.metadata;
    const system = presentationMetadata ? readSystemSessionMetadataFromMetadata({ metadata: presentationMetadata }) : null;
    const summary = projectSessionSummaryV1({ row: { ...session, ...(invocation ? { effectiveAccess: invocation } : {}) },
      metadata: presentationMetadata, permissionMode: resolvePermissionIntentFromSessionMetadata(presentationMetadata)?.intent,
      ...(system ? { systemPurpose: system.key ?? null } : {}),
      encryption: isDataKeyAuthCredentials(account.credentials) ? { type: 'dataKey' }
        : isLegacyAuthCredentials(account.credentials) ? { type: 'legacy' } : null });
    const acceptedWorkspace = includeAcceptedWorkspace === true ? readSessionAcceptedWorkspace(session, account.accountLifetime.scope, storage.getState()) : undefined;
    const agentTarget = resolveAgentExecutionTargetFromSessionMetadata(metadata);
    const result = { ok: true as const, session: summary, awareness: projectUiSessionAwareness(session, Date.now()),
      ...(agentTarget ? { agentTarget } : {}),
      ...(acceptedWorkspace ? { acceptedWorkspace } : {}) };
    if (readiness !== true) return result;
    // Diagnostics keep stable attribution when control admission correctly refuses an offline Machine.
    const target = resolveDisplayIdentityForSessionFromState({ state: storage.getState(),
      serverId: account.serverId, sessionId, metadata, preferProvidedMetadata: true });
    const selectedMachineId = target.machineId || null;
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const definitionId = readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId;
    if (selectedMachineId && agentId && invocation?.capabilities.submitAgentInput) {
      try {
        await refreshMachineAgents({ serverId: account.serverId, machineId: selectedMachineId,
          accountLifetime: account.accountLifetime, agentId, ...(definitionId ? { definitionId } : {}),
          ...(options?.refreshReadiness ? { force: true } : {}), ...(signal ? { signal } : {}) });
      } catch { signal?.throwIfAborted(); }
      account.assertCurrent();
      signal?.throwIfAborted();
    }
    const inventory = selectedMachineId ? readMachineAgentsForScope(account.accountLifetime, selectedMachineId) : null;
    const agent = inventory?.agents.find(agent => agent.agentId === agentId && agent.definitionId === definitionId) ?? null;
    const targetKey = resolveSessionActionDefaultTargetKey(resolveSessionActionDefaultBackend({ session }));
    const provider = targetKey ? resolveAmbientProviderConnectionForModelIntent({ metadata, agentTargetKey: targetKey, sessionActive: session.active }) : null;
    const native = isSessionReadinessNativeSelectionV1({ metadata,
      providerConnectionId: provider?.status === 'resolved' ? provider.providerConnectionId : undefined });
    const machine = selectedMachineId ? resolveServerScopedMachine(storage.getState(), account.serverId, selectedMachineId) : null;
    const model = buildSessionReadinessViewModel({ configured: true, operation, credential: { kind: operation === 'credential' ? 'unknown' : 'not_required' }, machine: { scope: account.accountLifetime.scope,
      selectedMachineId, machine, requireExactSpawnReadiness: true,
      keyAvailable: inventory?.status === 'ready' ? true : 'unknown', rpcAvailable: inventory?.status === 'ready' ? true : 'unknown' },
      agent, selection: native ? { credentialBindings: null } : null,
      inventory: inventory ?? { status: 'idle', lastCheckedAt: null }, invocation,
      mayRepairAgent: machine?.access?.role === 'manage' && machine.access.accessState === 'ready' });
    if (operation === 'credential' && credentialPurpose && selectedMachineId
      && (invocation?.level === 'owner' || credentialTeamSelection && invocation?.capabilities.submitAgentInput === true)
      && model.readiness.machine?.status === 'ready') {
      try {
        const projection = (await loadDaemonMergedProjectionInputs({ machineId: selectedMachineId, serverId: account.serverId,
          accountLifetime: account.accountLifetime, signal }))?.pluginProjectionV2;
        account.assertCurrent();
        const catalog = credentialTeamSelection ? null : await readAdmittedConnectedAccountCatalogInContext(account, 'purposes', signal);
        account.assertCurrent();
        if (!projection || !credentialTeamSelection && (!catalog || catalog.status !== 'ready' || catalog.record.key !== 'purposes')) return { ...result, readiness: model.readiness };
        let profile: ReturnType<typeof AccountProfileSchema.parse> | null = null;
        if (!credentialTeamSelection) {
          const response = await account.request('/v1/account/profile', { method: 'GET', signal }, { retry: 'none' });
          account.assertCurrent();
          if (!response.ok) return { ...result, readiness: model.readiness };
          profile = AccountProfileSchema.parse(await response.json());
          account.assertCurrent();
          if (profile.id !== account.accountId) return { ...result, readiness: model.readiness };
        }
        const team = credentialTeamSelection;
        let resource: TeamCredentialResourceCatalogEntryV1 | null = null;
        if (team) {
          let cursor: string | null = null;
          do {
            const outcome = await listEntitledTeamCredentialResources({ scope: account.accountLifetime.scope,
              address: { serverId: account.serverId, teamId: team.teamId }, cursor, signal });
            account.assertCurrent();
            if (outcome.kind !== 'succeeded') break;
            resource = outcome.value.resources.find(candidate => candidate.id === team.selection.resourceId) ?? null;
            cursor = outcome.value.nextCursor;
          } while (!resource && cursor);
        }
        const descriptors = Object.values(projection.familiesById.connectedAccounts?.entriesById ?? {}).flatMap(entry => {
          const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
          return parsed.success && parsed.data.availability.state === 'available' ? [parsed.data] : [];
        });
        const credential = readSessionOperationCredentialReadinessV1({ purpose: credentialPurpose, machineId: selectedMachineId,
          executionAccountId: account.accountId, machineAccess: machine?.access ?? null,
          repairAccess: resolveMachineRpcRoutePolicy(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD).sharedMachineAccess,
          bindings: catalog?.status === 'ready' && catalog.record.key === 'purposes' ? catalog.record.value : { v: 1, bindings: [] },
          ...(credentialTeamSelection ? { teamSelection: credentialTeamSelection } : {}),
          projection, machineProvisionersById: projection.familiesById.machineProvisioners?.entriesById ?? {},
          accounts: profile?.connectedAccountsV4 ?? [], groups: profile?.connectedAccountGroupsV4 ?? [],
          now: Date.now(), teamResource: resource, readAuthentication: service => {
            const matching = descriptors.filter(descriptor => descriptor.pluginId === service.pluginId && descriptor.serviceId === service.localId);
            return matching.length === 1 ? matching[0]!.authentication : null;
          } });
        return { ...result, readiness: composeSessionReadinessV1({ ...model.readiness, credential }) };
      } catch { signal?.throwIfAborted(); account.assertCurrent(); }
    }
    return { ...result, readiness: model.readiness };
  };
}
