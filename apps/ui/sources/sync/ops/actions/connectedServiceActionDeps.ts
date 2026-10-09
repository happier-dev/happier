import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { ConnectedServiceApiError, throwConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiConnectedServiceAction(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['connectedServiceAction']> {
    const invoke = async ({ actionId, input, signal }: Parameters<NonNullable<ActionExecutorDeps['connectedServiceAction']>>[0], prepare: boolean) => {
        const assertCurrent = () => { signal?.throwIfAborted(); account.assertCurrent(); };
        const localSettings = actionId === 'connectedServices.identityPrivacy.set'
            ? (await import('@/sync/domains/state/storageStore')).storage : null;
        let mutationIssued = false;
        try {
            const host: ConnectedServiceConfigurationActionHostV1 = {
                assertCurrent,
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
                mutatePurposeBindings: async mutate => {
                    const { mutateConnectedAccountPurposeDefaultsInContext } = await import('@/sync/ops/connectedAccounts/connectedAccountPurposeDefaults');
                    await mutateConnectedAccountPurposeDefaultsInContext(account, mutate, signal);
                },
                setConnectedLabel: async input => {
                    const { setConnectedLabelInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
                    await setConnectedLabelInContext(account, input, signal);
                },
                setConnectedAcknowledgement: async input => {
                    const { setConnectedAcknowledgementInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
                    await setConnectedAcknowledgementInContext(account, input, signal);
                },
                setConnectedDisclosure: async input => {
                    const { setConnectedDisclosureInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
                    await setConnectedDisclosureInContext(account, input);
                },
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
                    assertCurrent();
                    return await runConnectedAccountControlCommand({ serverId: account.serverId, machineId, command,
                        assertCurrent, ...(signal ? { signal } : {}) });
                },
                ...(localSettings ? { setIdentityPrivacy: (hidden: boolean) => localSettings.getState().applyLocalSettings({ hideConnectedAccountIdentities: hidden }, { source: 'ui' }) } : {}),
            };
            return await (prepare ? prepareConnectedServiceRevokeInputV1(host, input) : executeConnectedServiceConfigurationActionV1(host, actionId, input));
        } catch (error) {
            // A 4xx domain refusal is authoritative. A 5xx can follow a committed
            // member write (the server still awaits response projection afterward).
            if (error instanceof ConnectedServiceApiError) {
                if (mutationIssued && error.status !== undefined && error.status >= 500) {
                    return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
                }
                return { ok: false, errorCode: error.code ?? 'connected_service_request_failed', error: error.message };
            }
            const [{ ConnectedMetadataRowOperationError }, { ConnectedAccountCatalogOperationError }] = await Promise.all([
                import('@/sync/api/account/apiConnectedMetadataCatalog'),
                import('@/sync/api/account/apiConnectedAccountCatalog'),
            ]);
            if (error instanceof ConnectedMetadataRowOperationError || error instanceof ConnectedAccountCatalogOperationError) {
                return { ok: false, errorCode: error.code, error: error.code };
            }
            const disposition = classifyHttpMutationRequestFailure({ error, issued: mutationIssued, signal });
            if (disposition === 'outcome_unknown' || disposition === 'cancelled') {
                return { ok: false, errorCode: disposition, error: disposition };
            }
            throw error;
        }
    };
    const execute: NonNullable<ActionExecutorDeps['connectedServiceAction']> = args => invoke(args, false);
    return Object.assign(execute, { prepareInput: (args: Parameters<NonNullable<NonNullable<ActionExecutorDeps['connectedServiceAction']>['prepareInput']>>[0]) => invoke(args, true) });
}
