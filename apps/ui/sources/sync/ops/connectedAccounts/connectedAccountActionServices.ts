import { captureConnectedAccountInvocationPurposeBinding, createConnectedAccountPurposePort, projectConnectedAccountHostAccessScopes,
    readConnectedAccountListLimit,
    type ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ConnectedAccountsService, ConnectedAccountBindingSummary, ConnectedAccountRef,
    ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import { ConnectedAccountMaterializationRequestSchema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { QualifiedConnectedAccountRefSchema, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolvePluginContributionHostAccessRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { resolvePluginUiAccountConnectedAccountRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/projection';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readUiAccountConnectedServiceDeclarations } from '@/sync/domains/connectedServices/accountDeclarations';
import { readConnectedAccountCatalogForMutationInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { getQualifiedConnectedAccountGroupV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createUiConnectedAccountAuthenticationRuntime } from './connectedAccountAuthenticationRuntime';
import { createUiConnectedAccountMetadataSource } from './connectedAccountFormOptions';

type PurposePort = ReturnType<typeof createConnectedAccountPurposePort<ConnectedAccountMaterialization>>;

/** Account Actions use the incumbent purpose owner, never a native fallback. */
export function createUiConnectedAccountActionServices(input: Readonly<{
    pluginId: string;
    actionId?: string;
    connectedAccountPurposeBinding?: ConnectedAccountInvocationPurposeBinding;
    occurrenceId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    isCurrent(): boolean;
    registerRawForRedaction(value: string): void;
}>): Pick<ConnectedAccountsService, 'getBinding' | 'materialize' | 'listAccounts' | 'materializeListedAccount'> {
    let captured: ConnectedAccountInvocationPurposeBinding | undefined;
    if (input.connectedAccountPurposeBinding) {
        try {
            captured = captureConnectedAccountInvocationPurposeBinding(input.connectedAccountPurposeBinding,
                { pluginId: input.pluginId, localId: input.actionId ?? '' });
        } catch (cause) {
            throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope' }, { cause });
        }
    }
    const unavailable = (): never => { throw new PluginError({ code: 'plugin_connected_account_binding_unavailable' }); };
    const read = async <T>(purpose: string, options: Readonly<{ signal?: AbortSignal; expectedAccount?: ConnectedAccountRef }>,
        invoke: (binding: Awaited<ReturnType<PurposePort['bind']>>) => Promise<T>) => {
        const cancellation = mergeAbortSignals([input.signal, options.signal]);
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        try {
            cancellation.signal.throwIfAborted();
            if (!input.isCurrent() || !input.accountLifetime.isCurrent() || captured && !captured.isCurrent()) return unavailable();
            const availability = readPluginAccountAvailability(input.accountLifetime.scope);
            const selected = availability.readCurrentAccountExecution(input.pluginId);
            if (selected.kind !== 'available' || selected.custodyId !== input.occurrenceId) return unavailable();
            const action = selected.manifest.contributes.actions?.find(candidate => candidate.id === input.actionId);
            const requests = action ? resolvePluginContributionHostAccessRequestsV2({ manifest: selected.manifest,
                pluginId: input.pluginId, contribution: { family: 'actions', localId: action.id }, requestIds: action.hostAccess ?? [] }) : [];
            const scope = projectConnectedAccountHostAccessScopes(input.pluginId, requests).find(candidate => candidate.purpose === purpose);
            if (!scope || !action) throw new PluginError({ code: 'plugin_connected_account_purpose_undeclared' });
            account = await captureLazyActionAccountContext(input.accountLifetime.scope.serverId, cancellation.signal);
            if (account.accountId !== input.accountLifetime.scope.accountId) return unavailable();
            let purposeBindings = captured?.purposeBindings;
            if (!captured) {
                const catalog = await readConnectedAccountCatalogForMutationInContext(account, 'purposes', cancellation.signal);
                if (catalog.status !== 'ready' || catalog.record.key !== 'purposes') return unavailable();
                purposeBindings = catalog.record.value;
            }
            if (!purposeBindings) return unavailable();
            const declarations = readUiAccountConnectedServiceDeclarations(input.accountLifetime);
            const accountContext = account;
            const acquireRuntime = async (account: ConnectedAccountRef, signal: AbortSignal) => {
                const projection = availability.readAccountUiProjection();
                const descriptor = Object.values(projection?.connectedAccountDescriptorsById ?? {}).find(candidate =>
                    candidate.pluginId === account.service.pluginId && candidate.id === account.service.localId);
                const declaration = declarations.find(candidate => candidate.service.pluginId === account.service.pluginId
                    && candidate.service.localId === account.service.localId);
                if (!descriptor || !declaration) return unavailable();
                const selected = await resolvePluginUiAccountConnectedAccountRegistration({ descriptor,
                    platform: resolvePluginUiClientExecutablePlatform(), signal });
                const holder = selected?.registration.connectedAccountAuthentication;
                if (!selected || !holder) return unavailable();
                return holder.acquire(() => createUiConnectedAccountAuthenticationRuntime({ selected, declaration }));
            };
            const port = createConnectedAccountPurposePort({ ...createUiConnectedAccountMetadataSource(accountContext, declarations),
                readGroup: async (ref, signal) => (await getQualifiedConnectedAccountGroupV4(accountContext.credentials,
                    { group: ref, request: accountContext.request, signal, retry: 'none' })).group,
                async resolveConnectedAccountEndpoints(request) {
                    return (await acquireRuntime(request.account, request.signal)).readConfiguredEndpoints(request);
                },
                async materializeAccount(request) {
                    const runtime = await acquireRuntime(request.account, request.signal);
                    const retained = captured?.managedOperation?.credentialConfigurations?.find(entry =>
                        sameQualifiedConnectedAccountRef(entry.account, request.account));
                    return runtime.materialize({ ...request,
                        ...(retained === undefined ? {} : { expectedConfigurationRevision: retained.revision }),
                        registerRawForRedaction: input.registerRawForRedaction });
                },
            });
            const binding = await port.bind({ purpose: { consumer: { pluginId: input.pluginId, localId: action.id }, purpose },
                serviceRefs: scope.serviceRefs, purposeBindings, signal: cancellation.signal,
                ...(options.expectedAccount ? { expectedAccount: options.expectedAccount } : {}) });
            return await invoke(binding);
        } finally { account?.dispose(); cancellation.dispose(); }
    };
    return {
        async getBinding(purpose, options = {}) {
            try {
                return await read(purpose, options, async ({ binding }): Promise<ConnectedAccountBindingSummary> => ({ purpose,
                    account: binding.account, service: binding.account.service,
                    target: { kind: binding.group ? 'group' : 'account', displayName: binding.displayName } }));
            } catch (error) {
                if (error instanceof PluginError && error.code === 'plugin_connected_account_binding_unavailable') return null;
                throw error;
            }
        },
        async materialize(purpose, request, options = {}) {
            if (options.nativeService) throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope' });
            const parsed = ConnectedAccountMaterializationRequestSchema.parse(request);
            return read(purpose, { ...options,
                ...(options.expectedAccount ? { expectedAccount: QualifiedConnectedAccountRefSchema.parse(options.expectedAccount) } : {}) },
                binding => binding.materialize(parsed));
        },
        async listAccounts(request, options = {}) {
            const limit = readConnectedAccountListLimit(request.limit);
            return read(request.purpose, options, binding => binding.listAccounts({ ...(limit === undefined ? {} : { limit }) }));
        },
        async materializeListedAccount(request, options = {}) {
            const account = QualifiedConnectedAccountRefSchema.parse(request.account);
            const materialization = ConnectedAccountMaterializationRequestSchema.parse(request.materialization);
            return read(request.purpose, options, binding => binding.materializeListedAccount(account, materialization));
        },
    };
}
