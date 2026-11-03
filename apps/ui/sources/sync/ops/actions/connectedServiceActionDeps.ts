import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountSuccessV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedServiceApiError, throwConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import type { PreparedConnectedMetadataCleanup } from '@/sync/api/account/apiConnectedMetadataCatalog';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { getAccountConnectedServiceConfigurationMode } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ProviderAccountUsageQuotaReadOptions } from '@/sync/api/account/apiProviderAccountUsage';
import { listProviderGatewayContributionsV1 } from '@happier-dev/protocol/providers/gatewayContributionsV1';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { resolveConnectedAccountPurposeDefaultTargetV1, resolveConnectedAccountPurposeDefaultOriginV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';

import { createUiConnectedAccountContent } from '@/sync/ops/connectedAccounts/connectedAccountContent';
import { randomUUID } from '@/platform/randomUUID';

export function createUiConnectedServiceAction(account: LazyActionAccountContext, quotaReadOptions?: Pick<ProviderAccountUsageQuotaReadOptions, 'readAllHistory' | 'projectionDocuments' | 'includePendingWork'>): NonNullable<ActionExecutorDeps['connectedServiceAction']> {
    const content = createUiConnectedAccountContent(account);
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
                readAccountCredential: async ref => {
                    const { getQualifiedConnectedAccountCredentialV4 } = await import('@/sync/api/account/apiQualifiedConnectedAccountsV4');
                    return getQualifiedConnectedAccountCredentialV4(account.credentials, ref, { request: account.request,
                        signal, requestPurpose: 'connected-accounts:persistence', retry: 'none' });
                },
                openAccountCredential: async envelope => content.open('credential', await content.resolveAccountMode(), envelope),
                sealAccountCredential: async payload => {
                    const mode = await content.resolveAccountMode('fresh-authority');
                    assertCurrent();
                    return content.seal('credential', mode, payload);
                },
                createSavedSecretResourceId: randomUUID,
                rotateAccountCredentialSecrets: async ({ secrets }) => {
                    const { updateSavedSecretResourceInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                    for (const secret of secrets) {
                        const result = await updateSavedSecretResourceInContext(account, { resourceId: secret.resourceId, nextValue: secret.value });
                        if (!result.ok) return result.reason === 'changed' ? 'conflict'
                            : result.reason === 'outcome_unknown' ? 'outcome_unknown' : 'unavailable';
                    }
                    return 'applied';
                },
                // The Saved Secret owner's one transaction: the key resources and the credential that references them.
                promoteAccountCredentialSecrets: async ({ secrets, credential }) => {
                    assertCurrent();
                    const { createSavedSecretResourcesWithConnectedAccountCredentialInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                    return (await createSavedSecretResourcesWithConnectedAccountCredentialInContext(account, {
                        scope: { serverId: account.serverId, accountId: account.accountId }, secrets, credential })).status;
                },
                readSetupCatalog: async () => {
                    assertCurrent();
                    const registry = getConnectedServiceRegistrySnapshot(account.accountLifetime.scope);
                    const entries = registry.entries.filter(entry => entry.service);
                    const projected = new Set(entries.map(entry => `${entry.service!.pluginId}/${entry.service!.localId}`));
                    const unavailableBundled = Object.entries(BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS).flatMap(([key, declaration]) => {
                        const service = parseQualifiedPluginContributionKey(key);
                        return !service || projected.has(key) ? [] : [{ service, canAdd: false, reason: 'descriptor-unavailable',
                            descriptor: projectConnectedAccountDescriptorV1({ descriptor: declaration.descriptor, serviceId: service.localId,
                                pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled',
                                availability: { state: 'blocked', reason: 'descriptor-unavailable' }, diagnostics: [] }),
                        }];
                    });
                    return {
                        status: registry.status === 'ready' ? 'ready' : entries.length ? 'partial' : 'unavailable',
                        services: [...entries.map(entry => ({ service: entry.service!, descriptor: entry.projectedDescriptor ?? null,
                            canAdd: entry.executable === true, reason: entry.executable === true ? null
                                : entry.availability?.state !== 'available' ? entry.availability?.reason ?? registry.errorReason ?? registry.status
                                : entry.projectionStatus ?? registry.status,
                        })), ...unavailableBundled],
                        gateways: listProviderGatewayContributionsV1(readAccountProviderDeclarations({ kind: 'account' })),
                    };
                },
                configurationCatalog: createUiConnectedServiceConfigurationCatalogHost(account, async target => {
                    const current = getAccountConnectedServiceConfigurationMode(target, account.accountLifetime.scope);
                    if (current) return current;
                    const entry = getConnectedServiceRegistrySnapshot(account.accountLifetime.scope).entries.find(entry =>
                        entry.service?.pluginId === target.service.pluginId && entry.service.localId === target.service.localId);
                    // A known policy refusal cannot fall through to bundled authoring.
                    if (entry) return null;
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
                    // Only the exact executor's validated, content-free effect
                    // receipt survives retirement; reads and member replies do not.
                    const definiteDelete = expectedEffect === 'qualified-connected-group-delete'
                        ? QualifiedConnectedAccountSuccessV4Schema.parse(result) : null;
                    const definiteCredentialCreate = expectedEffect === 'qualified-connected-credential-create'
                        ? QualifiedConnectedAccountCredentialMutationSuccessV4Schema.safeParse(result) : null;
                    if (definiteCredentialCreate && !definiteCredentialCreate.success) throw new ConnectedServiceApiError({ code: 'outcome_unknown' });
                    if (!definiteDelete && !definiteCredentialCreate?.success) account.assertCurrent();
                    // Publish every acknowledged patch, including a prefix of a reorder that later fails.
                    if (method !== 'GET' && path.startsWith('/v4/connect/qualified/group') && account.accountLifetime.isCurrent()) {
                        invalidateConnectedServiceGroupsRefreshSignal();
                    }
                    return definiteDelete ?? (definiteCredentialCreate?.success ? definiteCredentialCreate.data : result);
                },
                mutatePurposeBindings: async mutate => {
                    const { mutateConnectedAccountPurposeDefaultsInContext } = await import('@/sync/ops/connectedAccounts/connectedAccountPurposeDefaults');
                    await mutateConnectedAccountPurposeDefaultsInContext(account, mutate, signal);
                },
                admitPurposeTarget: async input => {
                    const [{ readPluginAccountAvailability }, { getActiveServerAccountScope },
                        { areServerAccountScopesEqual }, { storage }] = await Promise.all([
                        import('@/sync/domains/plugins/availability/projection'),
                        import('@/sync/domains/scope/activeServerAccountScope'),
                        import('@/sync/domains/scope/serverAccountScope'),
                        import('@/sync/domains/state/storage'),
                    ]);
                    type Admission = Parameters<typeof resolveConnectedAccountPurposeDefaultTargetV1>[0];
                    let declaration: Admission['declaration'];
                    let readAuthentication: Admission['readAuthentication'];
                    let accountServiceSelection: Admission['accountServiceSelection'];
                    const origin = resolveConnectedAccountPurposeDefaultOriginV1(input);
                    if (origin.kind === 'account') {
                        const reader = readPluginAccountAvailability(account.accountLifetime.scope);
                        const selection = await reader.ensureCurrentAccountExecution(input.purpose.consumer.pluginId);
                        assertCurrent();
                        if (selection.kind !== 'available') return null;
                        declaration = { purpose: input.purpose, accountSelection: selection };
                        if (input.target.kind === 'group' && input.target.service.pluginId !== input.purpose.consumer.pluginId) {
                            accountServiceSelection = await reader.ensureCurrentAccountExecution(input.target.service.pluginId);
                            assertCurrent();
                        }
                    } else {
                        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
                        // Explicit Machine inputs never borrow Account declarations or retained/offline projections.
                        const entry = await loadDaemonMergedProjectionCacheEntry({ machineId: origin.machineId, serverId: account.serverId,
                            accountLifetime: account.accountLifetime, reuseFreshReady: false, signal });
                        assertCurrent();
                        if (entry?.kind !== 'ready' || !entry.inputs.pluginUiProjection) return null;
                        declaration = { purpose: input.purpose, projection: entry.inputs.pluginUiProjection,
                            machineProvisionersById: entry.inputs.pluginUiProjection.machineProvisionersById };
                        const descriptors = entry.inputs.connectedAccountProjection;
                        readAuthentication = service => descriptors?.kind === 'ready'
                            ? descriptors.descriptors.find(entry => entry.pluginId === service.pluginId && entry.id === service.localId
                                && entry.availability.state === 'available')?.authentication ?? null : null;
                    }
                    assertCurrent();
                    const profile = storage.getState().profile;
                    if (profile.id !== account.accountId
                        || !areServerAccountScopesEqual(getActiveServerAccountScope(), account.accountLifetime.scope)) return null;
                    if (!resolveConnectedAccountPurposeDefaultTargetV1({ declaration, target: input.target,
                        accounts: profile.connectedAccountsV4, groups: profile.connectedAccountGroupsV4,
                        accountServiceSelection, readAuthentication, now: Date.now() })) return null;
                    // The Action owns admission once; its existing Account lifetime and CAS own settlement.
                    return assertCurrent;
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
                    const projection = await loadDaemonMergedProjectionInputs({ machineId, serverId: account.serverId, accountLifetime: account.accountLifetime, signal });
                    return getResolvedAgentCatalogEntries({ enabledAgentIds: AGENT_IDS,
                        mergedProviderProjectionById: projection?.mergedProviderProjectionById ?? null,
                        mergedBackendProjectionById: projection?.mergedBackendProjectionById ?? null,
                    }).find((agent) => agent.agentId === agentId) ?? null;
                },
                resetQuota: async (args) => {
                    const { connectedServiceQuotaRecoveryCreditConsume } = await import('@/sync/ops/connectedServiceQuotaRecoveryCredits');
                    assertCurrent();
                    return await connectedServiceQuotaRecoveryCreditConsume({ ...args,
                        serverId: account.serverId, accountId: account.accountId, assertCurrent,
                        ...(signal ? { signal } : {}),
                    });
                },
                readQuota: async input => {
                    const { getProviderAccountUsageQuota } = await import('@/sync/api/account/apiProviderAccountUsage');
                    assertCurrent();
                    return await getProviderAccountUsageQuota(account.credentials, input, {
                        ...quotaReadOptions,
                        accountMode: account.resolveAccountMode(), request: account.request, readTransport: account.readTransport, assertCurrent,
                        readPacingTargets: async () => {
                            const settings = await account.readSettings();
                            assertCurrent();
                            return settings.usagePacingTargetsV1;
                        },
                        readEnteredMonthlyPrice: async () => {
                            const [{ readConnectedMetadataCatalogInContext }, { readConnectedSubscriptionMonthlyPriceV1 }] = await Promise.all([
                                import('@/sync/api/account/apiConnectedMetadataCatalog'), import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1'),
                            ]);
                            const catalog = await readConnectedMetadataCatalogInContext(account, signal, undefined, false);
                            assertCurrent();
                            return catalog.presentation.status === 'ready' ? readConnectedSubscriptionMonthlyPriceV1(catalog.presentation, input.source.ref) : undefined;
                        },
                        ...(signal ? { signal } : {}),
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
                    return await withActionAccountRequestSignal(account, signal, ownedSignal => machineRpcWithServerScope({
                        serverId: account.serverId, accountId: account.accountId, machineId: input.machineId,
                        method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, payload: input,
                        onIssued: assertCurrent, signal: ownedSignal,
                    }));
                },
                controlCommand: async (machineId, command) => {
                    const { runConnectedAccountControlCommand } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
                    assertCurrent();
                    return await withActionAccountRequestSignal(account, signal, ownedSignal => runConnectedAccountControlCommand({ serverId: account.serverId, machineId, command,
                        assertCurrent, signal: ownedSignal }));
                },
                authenticationCommand: async (machineId, command) => {
                    const { runConnectedAccountAuthenticationCommand } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
                    assertCurrent();
                    return await withActionAccountRequestSignal(account, signal, ownedSignal => runConnectedAccountAuthenticationCommand({ serverId: account.serverId, accountId: account.accountId,
                        machineId, command, assertCurrent, signal: ownedSignal }));
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
            // A domain refusal or the transaction owner's confirmed rollback is
            // authoritative. Other 5xx can follow a committed member write.
            if (error instanceof ConnectedServiceApiError) {
                const rolledBack = error.status === 503 && error.code === 'database_transaction_conflict_exhausted';
                if (mutationIssued && error.status !== undefined && error.status >= 500 && !rolledBack) {
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
