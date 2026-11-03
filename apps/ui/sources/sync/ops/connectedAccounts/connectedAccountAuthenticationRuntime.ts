import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner,
    createConnectedAccountAttemptConfigurationStore,
    parseConnectedAccountConfigurationRecordContent, invokeConnectedAccountAuthenticationRuntime,
    executeConnectedAccountAuthenticationCommand,
    resolveConnectedAccountPublicOAuthClient,
    type ConnectedAccountAttemptTransactionRecord,
    type ConnectedAccountPurposeMaterializationInput, type QualifiedConnectedAccountEstablishedRuntimeOwner,
    type ConnectedAccountConfigurationRecord, type ConnectedAccountConfigurationTarget } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import { replaceConnectedServiceConfigurationCatalogV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountConfigurationPatchV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { resolvePluginUiAccountConnectedAccountRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { createPluginSurfaceAccountNetworkServices } from '@/components/plugins/surfaces/pluginSurfaceAccountNetworkServices';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { AccountConnectedServiceDeclaration } from '@/sync/domains/connectedServices/accountDeclarations';
import { createUiConnectedServiceConfigurationCatalogHost } from '@/sync/api/account/apiConnectedAccountCatalog';
import { captureSavedSecretReferenceRevisionsInContext, readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createUiConnectedAccountAttemptTransactions } from './connectedAccountAttemptTransactions';
import { createUiConnectedAccountCredentialPersistence } from './connectedAccountCredentialPersistence';
import { createUiConnectedAccountEstablishedMaterializer } from './connectedAccountEstablishedRuntime';
import type { ConnectedAccountDaemonCommand, ConnectedAccountAttemptResponse } from './connectedAccountDaemon';

type AccountRegistration = NonNullable<Awaited<ReturnType<typeof resolvePluginUiAccountConnectedAccountRegistration>>>;
export type UiConnectedAccountAuthenticationRuntime = Readonly<{
    attempts: ReturnType<typeof createConnectedAccountAuthenticationAttemptOwner>;
    configuration: ReturnType<typeof createConnectedAccountConfigurationOwner>;
    materialize(request: ConnectedAccountPurposeMaterializationInput & Readonly<{
        registerRawForRedaction(value: string): void;
    }>): Promise<ConnectedAccountMaterialization>;
    readConfiguredEndpoints: QualifiedConnectedAccountEstablishedRuntimeOwner['readConfiguredEndpoints'];
    execute(command: ConnectedAccountDaemonCommand, signal?: AbortSignal,
        addressedRecord?: ConnectedAccountAttemptTransactionRecord): Promise<ConnectedAccountAttemptResponse>;
    dispose(): void;
}>;

function configurationUnavailable(): never {
    throw Object.assign(new Error('connected_account_configuration_unavailable'), { code: 'connected_account_configuration_unavailable' });
}

/** One shared attempt owner, held by the existing Account registration lifetime. */
export async function createUiConnectedAccountAuthenticationRuntime(input: Readonly<{
    selected: AccountRegistration;
    declaration: AccountConnectedServiceDeclaration;
}>): Promise<UiConnectedAccountAuthenticationRuntime> {
    const { registration } = input.selected;
    const lifetime = registration.accountLifetime;
    const pluginVersion = registration.pluginVersion;
    if (!lifetime || !pluginVersion) throw new Error('connected_account_runtime_unavailable');
    const account = await captureLazyActionAccountContext(lifetime.scope.serverId, registration.lifecycle.signal);
    if (account.accountId !== lifetime.scope.accountId) { account.dispose(); throw new Error('action_account_scope_changed'); }
    const persistence = createUiConnectedAccountCredentialPersistence(account, registration.lifecycle.signal);
    const { transactions } = createUiConnectedAccountAttemptTransactions(account, registration.lifecycle.signal);
    const attemptConfigurations = createConnectedAccountAttemptConfigurationStore({
        createRevision: randomUUID, transactions,
    });
    const mode = (modeId: string) => input.declaration.descriptor.authentication.modes.find(value => value.id === modeId);
    const catalog = createUiConnectedServiceConfigurationCatalogHost(account, async target => mode(target.modeId) ?? null,
        registration.lifecycle.signal);
    const read = async (target: ConnectedAccountConfigurationTarget): Promise<ConnectedAccountConfigurationRecord | null> => {
        if (target.kind === 'attempt') return attemptConfigurations.read(target);
        if (target.kind === 'account') {
            const record = await persistence.readConfiguration(target.account);
            if (!record) return null;
            if (record.revisionSemantics !== 'revisioned' || record.configurationRevision === null) return configurationUnavailable();
            return parseConnectedAccountConfigurationRecordContent(persistence.content.open('configuration',
                await persistence.content.resolveAccountMode(), record.configurationContent), record.configurationRevision, 'account');
        }
        const current = await catalog.read();
        if (current.status !== 'ready' || current.record.key !== 'configurations') return configurationUnavailable();
        return current.record.value.entries.find(entry => entry.service.pluginId === target.service.pluginId
            && entry.service.localId === target.service.localId && entry.modeId === target.modeId) ?? null;
    };
    const replace: Parameters<typeof createConnectedAccountConfigurationOwner>[0]['replace'] = async request => {
        const target = request.target;
        if (target.kind === 'attempt') return attemptConfigurations.replace({ ...request, target });
        if (target.kind === 'service') {
            const current = await catalog.read();
            if (current.status !== 'ready' || current.record.key !== 'configurations') return { status: 'unavailable' };
            const write = replaceConnectedServiceConfigurationCatalogV1({ catalog: current, target,
                expectedRevision: request.expectedRevision, values: request.replacement.values,
                secretRefs: request.replacement.secretRefs, secretValues: request.replacement.secretValues ?? {},
                createRevision: randomUUID });
            if (!write) return { status: 'conflict' };
            const result = await catalog.write(write);
            if (result.status !== 'updated' && result.status !== 'applied') return { status: 'conflict' };
            const record = write.record.value.entries.find(entry => entry.service.pluginId === target.service.pluginId
                && entry.service.localId === target.service.localId && entry.modeId === target.modeId);
            return record ? { status: 'committed', record } : { status: 'unavailable' };
        }
        const credential = await persistence.readCredential(target.account);
        if (!credential || credential.revisionSemantics !== 'revisioned') return { status: 'unavailable' };
        const response = await persistence.replaceConfiguration(QualifiedConnectedAccountConfigurationPatchV4Schema.parse({
            target: { kind: 'account', ref: target.account }, expectedConfigurationRevision: request.expectedRevision,
            expectedCredentialRevision: credential.credentialRevision,
            replacementContentEnvelope: persistence.content.seal('configuration',
                await persistence.content.resolveAccountMode('fresh-authority'), request.replacement),
        }));
        return response.configurationRevision === null ? { status: 'unavailable' }
            : { status: 'committed', record: { ...request.replacement, revision: response.configurationRevision } };
    };
    const secrets: Parameters<typeof createConnectedAccountConfigurationOwner>[0]['secrets'] = {
        admit: (references, options) => captureSavedSecretReferenceRevisionsInContext(account,
            { references, signal: options?.signal }).then(() => {}),
        has: async reference => (await readSavedSecretReferenceInContext(account, reference, registration.lifecycle.signal)).ok,
        read: async (reference, options) => {
            const result = await readSavedSecretReferenceInContext(account, reference, options?.signal);
            return result.ok ? result.value : null;
        },
    };
    const configuration = createConnectedAccountConfigurationOwner({ read, replace,
        async readPublicOAuthClient(request, options) {
            const snapshot = await getServerFeaturesSnapshot({ serverId: account.serverId,
                signal: options?.signal ?? registration.lifecycle.signal });
            return resolveConnectedAccountPublicOAuthClient({ ...request,
                clients: snapshot.status === 'ready' ? snapshot.features.capabilities.connectedServices.publicOAuthClients : undefined });
        },
        replaceForControl: request => replace({ ...request, replacement: { values: request.values,
            secretRefs: request.currentSecretRefs, secretValues: request.secretValues } }),
        destroyAttempt: attemptConfigurations.destroy,
        secrets,
        isRuntimeCurrent: () => registration.lifecycle.isCurrent(),
    });
    const invoke: Parameters<typeof createConnectedAccountAuthenticationAttemptOwner>[0]['runtime']['invoke'] = async invocation => {
        const cancellation = mergeAbortSignals([registration.lifecycle.signal, invocation.signal]);
        const network = createPluginSurfaceAccountNetworkServices({ pluginId: input.declaration.service.pluginId,
            accountLifetime: lifetime, signal: cancellation.signal, isCurrent: registration.lifecycle.isCurrent });
        const register = network.registerRawForRedaction;
        try {
            const context = { ...invocation.context,
                plugin: { id: input.declaration.service.pluginId, version: pluginVersion },
                contribution: { id: input.declaration.service.localId,
                    qualifiedId: `${input.declaration.service.pluginId}/connectedAccountDescriptors/${input.declaration.service.localId}` },
                surface: 'ui' as const, invokedAtMs: Date.now(), signal: cancellation.signal,
                services: { http: network.http },
                configuration: { ...invocation.context.configuration, async getSecret(fieldId: string, options?: { signal?: AbortSignal }) {
                    const value = await invocation.context.configuration.getSecret(fieldId, options);
                    if (value !== null) register(value);
                    return value;
                } },
                attemptCredentials: {
                    async get(key: string, options?: { signal?: AbortSignal }) {
                        const value = await invocation.context.attemptCredentials.get(key, options);
                        if (value !== null) register(value);
                        return value;
                    },
                    set(key: string, value: string, options?: { signal?: AbortSignal }) {
                        register(value); return invocation.context.attemptCredentials.set(key, value, options);
                    },
                    delete: invocation.context.attemptCredentials.delete,
                },
            };
            return await invokeConnectedAccountAuthenticationRuntime({
                mode: input.selected.runtime.authentication.modes[invocation.admission.modeId],
                descriptor: invocation.admission.descriptor, operation: invocation.operation, context,
                signal: cancellation.signal, registerRawForRedaction: register,
                invokeCallback: async work => { cancellation.signal.throwIfAborted(); return await work(); },
                redactDiagnosticText: network.redactDiagnosticText,
            });
        } finally { network.dispose(); cancellation.dispose(); }
    };
    const attempts = createConnectedAccountAuthenticationAttemptOwner({
        createAttemptId: randomUUID, createAccountId: randomUUID, createSavedSecretResourceId: randomUUID,
        readSelectedSecrets: persistence.readSelectedSecrets, now: Date.now, accounts: persistence.accounts,
        configuration, runtime: {
            async admit(request) {
                const descriptor = mode(request.modeId);
                if (!descriptor || !input.selected.runtime.authentication.modes[request.modeId]) throw new Error('connected_account_authentication_mode_unavailable');
                return { service: input.declaration.service, descriptor,
                    authenticationModeCardinality: input.declaration.descriptor.authentication.modes.length === 1 ? 'single' : 'multiple',
                    occurrenceId: input.declaration.occurrenceId, sourceCustody: input.declaration.sourceCustody };
            },
            isCurrent: () => registration.lifecycle.isCurrent(), invoke,
        },
        oauth: transactions.oauth, deviceTransactions: transactions.device,
        attemptAddresses: transactions.address, settlement: persistence.settlement,
    });
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        registration.lifecycle.signal.removeEventListener('abort', dispose);
        attempts.dispose(); account.dispose();
    };
    registration.lifecycle.signal.addEventListener('abort', dispose, { once: true });
    if (registration.lifecycle.signal.aborted) dispose();
    const established = createUiConnectedAccountEstablishedMaterializer({ ...input, account, persistence,
        configuration: { read, secrets }, configurationOwner: configuration });
    return { attempts, configuration, ...established, dispose, async execute(command, signal, addressedRecord) {
        const response = await executeConnectedAccountAuthenticationCommand({ attempts, command, signal,
            ...(addressedRecord ? { addressedRecord } : {}) });
        return response.status === 'starting' && (command.operation === 'beginConnect' || command.operation === 'beginReconnect')
            ? attempts.read({ attemptId: response.attemptId, waitForProviderStart: true, signal }) : response;
    } };
}
