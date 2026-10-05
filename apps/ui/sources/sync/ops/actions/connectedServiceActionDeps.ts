import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { executeConnectedServiceConfigurationActionV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { ConnectedServiceApiError, throwConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiConnectedServiceAction(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['connectedServiceAction']> {
    return async ({ actionId, input, signal }) => {
        const localSettings = actionId === 'connectedServices.identityPrivacy.set'
            ? (await import('@/sync/domains/state/storageStore')).storage : null;
        let mutationIssued = false;
        try {
            return await executeConnectedServiceConfigurationActionV1({
                assertCurrent: () => { signal?.throwIfAborted(); account.assertCurrent(); },
                request: async ({ path, method, body }) => {
                    const response = await account.request(path, {
                        method,
                        headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                        ...(signal ? { signal } : {}),
                    }, { includeAuth: false, onIssued: () => { if (method !== 'GET') mutationIssued = true; } });
                    if (!response.ok) await throwConnectedServiceApiError(response);
                    const result: unknown = await response.json();
                    account.assertCurrent();
                    // Publish every acknowledged patch, including a prefix of a reorder that later fails.
                    if (method !== 'GET' && path.startsWith('/v4/connect/qualified/group')) invalidateConnectedServiceGroupsRefreshSignal();
                    return result;
                },
                mutateSettings: account.mutateRawSettings,
                resolveAgent: async (agentId, machineId) => {
                    const [{ AGENT_IDS }, { getResolvedAgentCatalogEntries }, { loadDaemonMergedProjectionInputs }] = await Promise.all([
                        import('@/agents/catalog/catalog'),
                        import('@/agents/backendCatalog/agentCatalogProjection'),
                        import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
                    ]);
                    // Catalog provenance is selected explicitly, never borrowed from the focused Home.
                    const projection = await loadDaemonMergedProjectionInputs({ machineId, serverId: account.serverId, accountLifetime: account.accountLifetime });
                    if (!projection) return null;
                    return getResolvedAgentCatalogEntries({ enabledAgentIds: AGENT_IDS, ...projection }).find((agent) => agent.agentId === agentId) ?? null;
                },
                resetQuota: async (args) => {
                    const { connectedServiceQuotaRecoveryCreditConsume } = await import('@/sync/ops/connectedServiceQuotaRecoveryCredits');
                    return await connectedServiceQuotaRecoveryCreditConsume({ ...args, serverId: account.serverId });
                },
                controlCommand: async (machineId, command) => {
                    const { runConnectedAccountControlCommand } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
                    return await runConnectedAccountControlCommand({ serverId: account.serverId, machineId, command, ...(signal ? { signal } : {}) });
                },
                ...(localSettings ? { setIdentityPrivacy: (hidden: boolean) => localSettings.getState().applyLocalSettings({ hideConnectedAccountIdentities: hidden }, { source: 'ui' }) } : {}),
            }, actionId, input);
        } catch (error) {
            // A 4xx domain refusal is authoritative. A 5xx can follow a committed
            // member write (the server still awaits response projection afterward).
            if (error instanceof ConnectedServiceApiError) {
                if (mutationIssued && error.status !== undefined && error.status >= 500) {
                    return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
                }
                return { ok: false, errorCode: error.code ?? 'connected_service_request_failed', error: error.message };
            }
            const disposition = classifyHttpMutationRequestFailure({ error, issued: mutationIssued, signal });
            if (disposition === 'outcome_unknown' || disposition === 'cancelled') {
                return { ok: false, errorCode: disposition, error: disposition };
            }
            throw error;
        }
    };
}
