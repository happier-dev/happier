import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedServiceApiError, throwConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import type { LazyActionAccountContext } from './actionAccountContext';
import type { PreparedConnectedMetadataCleanup } from '@/sync/api/account/apiConnectedMetadataCatalog';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { getAccountConnectedServiceConfigurationMode } from '@/sync/domains/connectedServices/connectedServiceRegistry';

export function createUiConnectedServiceAction(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['connectedServiceAction']> {
    const invoke = async ({ actionId, input, signal }: Parameters<NonNullable<ActionExecutorDeps['connectedServiceAction']>>[0], prepare: boolean) => {
        const assertCurrent = () => { signal?.throwIfAborted(); account.assertCurrent(); };
        const localSettings = actionId === 'connectedServices.identityPrivacy.set'
            ? (await import('@/sync/domains/state/storageStore')).storage : null;
        let mutationIssued = false;
        let preparedMetadataCleanup: PreparedConnectedMetadataCleanup | undefined;
        try {
            const { createUiConnectedServiceConfigurationCatalogHost } = await import('@/sync/api/account/apiConnectedAccountCatalog');
            const host: ConnectedServiceConfigurationActionHostV1 = {
                assertCurrent,
                configurationCatalog: createUiConnectedServiceConfigurationCatalogHost(account, async target => {
                    const current = getAccountConnectedServiceConfigurationMode(target, account.accountLifetime.scope);
                    if (current) return current;
                    const declaration = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${target.service.pluginId}/${target.service.localId}`];
                    return declaration?.descriptor.authentication.modes.find(mode => mode.id === target.modeId) ?? null;
                }, signal),
                request: async ({ path, method, body, expectedEffect }) => {
                    const response = await account.request(path, {
                        method,
                        headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                        ...(signal ? { signal } : {}),
                    }, { includeAuth: false, onIssued: () => { if (method !== 'GET') mutationIssued = true; } });
                    if (!response.ok) await throwConnectedServiceApiError(response);
                    const result: unknown = await response.json();
                    // Only the exact executor's validated, content-free DELETE
                    // receipt survives retirement; reads and member replies do not.
                    const definiteGroupDelete = expectedEffect === 'qualified-connected-group-delete'
                        ? QualifiedConnectedAccountSuccessV4Schema.parse(result) : null;
                    if (!definiteGroupDelete) account.assertCurrent();
                    // Publish every acknowledged patch, including a prefix of a reorder that later fails.
                    if (method !== 'GET' && path.startsWith('/v4/connect/qualified/group') && account.accountLifetime.isCurrent()) {
                        invalidateConnectedServiceGroupsRefreshSignal();
                    }
                    return definiteGroupDelete ?? result;
                },
                mutatePurposeBindings: async mutate => {
                    const { mutateConnectedAccountPurposeDefaultsInContext } = await import('@/sync/ops/connectedAccounts/connectedAccountPurposeDefaults');
                    await mutateConnectedAccountPurposeDefaultsInContext(account, mutate, signal);
                },
                admitResourcePurposeTarget: async input => {
                    const [{ loadDaemonMergedProjectionCacheEntry }, { normalizePluginUiProjection, resolvePluginUiProjectionPlatform },
                        { readConnectedAccountDescriptorProjection }, { getMachineContributionRegistryProjectionRevision },
                        { isConnectedAccountPurposeSetupTargetCurrent }, { getActiveServerAccountScope }, { storage }] = await Promise.all([
                        import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
                        import('@/sync/domains/plugins/ui/projection'),
                        import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection'),
                        import('@/sync/ops/machineContributionRegistryProjectionRevision'),
                        import('@/sync/domains/connectedServices/connectedAccountPurposeSetup'),
                        import('@/sync/domains/scope/activeServerAccountScope'),
                        import('@/sync/domains/state/storage'),
                    ]);
                    const target = { machineId: input.machineId, serverId: account.serverId };
                    const revision = getMachineContributionRegistryProjectionRevision(target);
                    // A retained/offline presentation is not Resource declaration authority.
                    const entry = await loadDaemonMergedProjectionCacheEntry({ ...target,
                        accountLifetime: account.accountLifetime, reuseFreshReady: false });
                    assertCurrent();
                    if (entry?.kind !== 'ready' || !entry.inputs.pluginProjectionV2) return null;
                    const projection = entry.inputs.pluginProjectionV2;
                    const request = { scope: account.accountLifetime.scope, machineId: input.machineId, purpose: input.purpose };
                    const runtime = { ...target, pluginUiProjection: normalizePluginUiProjection(projection), pluginBrowserProjection: null,
                        phase: 'current' as const, interactionEnabled: true, platform: resolvePluginUiProjectionPlatform(),
                        accountLifetime: account.accountLifetime, connectedAccountProjection: readConnectedAccountDescriptorProjection(projection) };
                    const isCurrent = () => getMachineContributionRegistryProjectionRevision(target) === revision
                        && isConnectedAccountPurposeSetupTargetCurrent({ request, viewer: getActiveServerAccountScope(), runtime,
                            profile: storage.getState().profile, target: input.target });
                    if (!isCurrent()) return null;
                    return () => {
                        assertCurrent();
                        if (!isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
                    };
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
                prepareConnectedMetadataCleanup: async ({ subject }) => {
                    const { prepareConnectedMetadataCleanupInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
                    preparedMetadataCleanup = await prepareConnectedMetadataCleanupInContext(account, subject, signal);
                },
                cleanupConnectedMetadata: async ({ subject }) => {
                    const { cleanupConnectedMetadataInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
                    await cleanupConnectedMetadataInContext(account, subject, signal, preparedMetadataCleanup);
                },
                resolveAgent: async (agentId, machineId) => {
                    const [{ AGENT_IDS }, { getResolvedAgentCatalogEntries }, { loadDaemonMergedProjectionInputs }] = await Promise.all([
                        import('@/agents/catalog/catalog'),
                        import('@/agents/backendCatalog/agentCatalogProjection'),
                        import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
                    ]);
                    // Catalog provenance is selected explicitly, never borrowed from the focused Home.
                    const projection = await loadDaemonMergedProjectionInputs({ machineId, serverId: account.serverId, accountLifetime: account.accountLifetime });
                    return getResolvedAgentCatalogEntries({ enabledAgentIds: AGENT_IDS,
                        mergedProviderProjectionById: projection?.mergedProviderProjectionById ?? null,
                        mergedBackendProjectionById: projection?.mergedBackendProjectionById ?? null,
                    }).find((agent) => agent.agentId === agentId) ?? null;
                },
                resetQuota: async (args) => {
                    const { connectedServiceQuotaRecoveryCreditConsume } = await import('@/sync/ops/connectedServiceQuotaRecoveryCredits');
                    return await connectedServiceQuotaRecoveryCreditConsume({ ...args, serverId: account.serverId });
                },
                readQuota: async input => {
                    const accountMode = await account.resolveAccountMode();
                    const settings = await account.readSettings();
                    const { getProviderAccountUsageQuota } = await import('@/sync/api/account/apiProviderAccountUsage');
                    assertCurrent();
                    return await getProviderAccountUsageQuota(account.credentials, input, {
                        accountMode, request: account.request, assertCurrent,
                        readEnteredMonthlyPrice: async () => {
                            const [{ readConnectedMetadataCatalogInContext }, { readConnectedSubscriptionMonthlyPriceV1 }] = await Promise.all([
                                import('@/sync/api/account/apiConnectedMetadataCatalog'), import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1'),
                            ]);
                            const catalog = await readConnectedMetadataCatalogInContext(account, signal, undefined, false);
                            assertCurrent();
                            return catalog.presentation.status === 'ready' ? readConnectedSubscriptionMonthlyPriceV1(catalog.presentation, input.source.ref) : undefined;
                        },
                        targets: settings.usagePacingTargetsV1, ...(signal ? { signal } : {}),
                    });
                },
                setSubscriptionPrice: async input => {
                    const { setConnectedSubscriptionPriceInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
                    assertCurrent();
                    await setConnectedSubscriptionPriceInContext(account, input, signal);
                },
                readPoolSelection: async input => {
                    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
                    assertCurrent();
                    return await machineRpcWithServerScope({
                        serverId: account.serverId, accountId: account.accountId, machineId: input.machineId,
                        method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, payload: input,
                        onIssued: assertCurrent, ...(signal ? { signal } : {}),
                    });
                },
                controlCommand: async (machineId, command) => {
                    const { runConnectedAccountControlCommand } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
                    assertCurrent();
                    return await runConnectedAccountControlCommand({ serverId: account.serverId, machineId, command,
                        assertCurrent, ...(signal ? { signal } : {}) });
                },
                authenticationCommand: async (machineId, command) => {
                    const { runConnectedAccountAuthenticationCommand } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
                    assertCurrent();
                    return await runConnectedAccountAuthenticationCommand({ serverId: account.serverId, accountId: account.accountId,
                        machineId, command, assertCurrent, ...(signal ? { signal } : {}) });
                },
                openBillingDestination: async url => {
                    const { Linking } = await import('react-native');
                    assertCurrent();
                    await Linking.openURL(url);
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
