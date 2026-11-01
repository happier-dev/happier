import { randomUUID } from 'node:crypto';
import { createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner,
    executeConnectedAccountAuthenticationCommand, type ConnectedAccountAttemptTransactionRecord } from '@happier-dev/cli-common/connectedAccounts';
import type { ActionExecuteResult, ActionExecutorContext, ActionId, ConnectedAccountDaemonCommand,
    ConnectedAccountAttemptResponse, ConnectedAccountDaemonControlCommand, ConnectedAccountDaemonControlResponse } from '@happier-dev/protocol';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION, CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { connectedAccountSourceCustodyV1Equal } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { createConnectedAccountAttemptTransactionApi } from '@/api/client/connectedAccountAttemptTransactionApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { CurrentProcessPluginActionExecutionAttempt } from '@/session/actions/createDaemonPluginActionExecutor';
import type { createConnectedAccountContributionRegistry, ConnectedAccountPortableRuntimeLease } from './contributionRegistry';
import type { ConnectedAccountHostRuntimeInvoker } from './runtimeInvoker';

export type CredentialedConnectedAccountAuthenticationRuntime = Readonly<{
    attempts: ReturnType<typeof createConnectedAccountAuthenticationAttemptOwner>;
    configuration: ReturnType<typeof createConnectedAccountConfigurationOwner>;
    execute(command: ConnectedAccountDaemonCommand, signal?: AbortSignal,
        addressedRecord?: ConnectedAccountAttemptTransactionRecord): Promise<ConnectedAccountAttemptResponse>;
    dispose(): void;
}>;
type ExecuteLocal = (actionId: ActionId, input: unknown, context: ActionExecutorContext | undefined,
    host: CredentialedConnectedAccountAuthenticationHost) => Promise<ActionExecuteResult>;
type AuthenticationOptions = Readonly<{ signal?: AbortSignal;
    native(machineId: string, command: ConnectedAccountDaemonCommand): Promise<ConnectedAccountAttemptResponse> }>;
type ControlOptions = Readonly<{ signal?: AbortSignal;
    native(machineId: string, command: ConnectedAccountDaemonControlCommand): Promise<ConnectedAccountDaemonControlResponse> }>;
type ConfigurationCommand = Extract<ConnectedAccountDaemonControlCommand, { operation: 'readConfiguration' | 'replaceConfiguration' }>;
export type CredentialedConnectedAccountAuthenticationHost = Readonly<{
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    executeAction(actionId: ActionId, input: unknown, context: ActionExecutorContext | undefined,
        executeLocal: ExecuteLocal): Promise<CurrentProcessPluginActionExecutionAttempt>;
    authenticationCommand(machineId: string | undefined, command: ConnectedAccountDaemonCommand,
        options: AuthenticationOptions): Promise<ConnectedAccountAttemptResponse>;
    controlCommand(machineId: string | undefined, command: ConnectedAccountDaemonControlCommand,
        options: ControlOptions): Promise<ConnectedAccountDaemonControlResponse>;
}>;

function unavailable(code: string, attemptId?: string) {
    return { status: 'unavailable' as const, code, ...(attemptId ? { attemptId } : {}) };
}
function failureCode(error: unknown): string {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'connected_account_service_unavailable';
}

/** Physical CLI ports only. The selected registration owns the shared attempt runtime. */
export function createCredentialedConnectedAccountAuthenticationHost(input: Readonly<{
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    operationContext?: SavedSecretOperationContextV1;
    contributions: ReturnType<typeof createConnectedAccountContributionRegistry>;
    invoker: ConnectedAccountHostRuntimeInvoker;
}>): CredentialedConnectedAccountAuthenticationHost {
    const withHome = <T>(work: () => T) => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, work);
    const credentialApi = createConnectedServiceCredentialApi(input.credentials);
    const getAccountEncryptionMode: typeof credentialApi.getAccountEncryptionMode = options => withHome(() => credentialApi.getAccountEncryptionMode(options));
    const api = withHome(() => createConnectedAccountAttemptTransactionApi({ token: input.credentials.token }));
    const transactions = withHome(() => createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: input.credentials, getAccountEncryptionMode, api,
    }));
    const persistence = withHome(() => createQualifiedConnectedAccountDaemonPersistence({
        credentials: input.credentials, getAccountEncryptionMode, attemptTransactions: transactions,
        ...(input.operationContext ? { operationContext: input.operationContext } : {}),
        secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(input.credentials),
            ...(input.operationContext ? { operationContext: input.operationContext } : {}) }),
    }));
    const createRuntime = (selected: ConnectedAccountPortableRuntimeLease): CredentialedConnectedAccountAuthenticationRuntime => {
        const configuration = createConnectedAccountConfigurationOwner({ ...persistence.configuration,
            isRuntimeCurrent: identity => selected.isCurrent() && identity.pluginId === selected.ref.pluginId
                && identity.occurrenceId === selected.occurrenceId
                && connectedAccountSourceCustodyV1Equal(identity.sourceCustody, selected.sourceCustody),
        });
        const attempts = createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: randomUUID, createAccountId: randomUUID, createSavedSecretResourceId: randomUUID,
            now: Date.now, accounts: persistence.attempts.accounts, configuration,
            async readSelectedSecrets(selections, signal) {
                const secrets = persistence.configuration.secrets;
                await secrets.admit?.(Object.values(selections).map(selection => selection.ref), { signal });
                return Object.fromEntries(await Promise.all(Object.entries(selections).map(async ([fieldId, selection]) => {
                    const value = await secrets.read(selection.ref, { signal });
                    if (value === null) throw new Error('connected_account_credential_secret_unavailable');
                    return [fieldId, value];
                })));
            },
            runtime: {
                async admit(request) {
                    const descriptor = selected.descriptor.authentication.modes.find(mode => mode.id === request.modeId);
                    if (!descriptor || !selected.runtime.authentication.modes[request.modeId]) throw new Error('connected_account_authentication_mode_unavailable');
                    return { service: selected.ref, descriptor,
                        authenticationModeCardinality: selected.descriptor.authentication.modes.length === 1 ? 'single' : 'multiple',
                        occurrenceId: selected.occurrenceId, sourceCustody: selected.sourceCustody };
                },
                isCurrent: () => selected.isCurrent(),
                invoke: invocation => input.invoker.invokeAuthentication({ ...invocation, lease: selected,
                    isConfigurationCurrent: configuration.isCurrent,
                    configurationRevocationSignal: configuration.currentnessSignal }),
            },
            oauth: transactions.oauth, deviceTransactions: transactions.device,
            attemptAddresses: transactions.address, settlement: persistence.attempts.settlement,
        });
        return { attempts, configuration, dispose: attempts.dispose, async execute(command, signal, addressedRecord) {
            const response = await executeConnectedAccountAuthenticationCommand({ attempts, command, signal,
                ...(addressedRecord ? { addressedRecord } : {}) });
            return response.status === 'starting' && (command.operation === 'beginConnect' || command.operation === 'beginReconnect')
                ? attempts.read({ attemptId: response.attemptId, waitForProviderStart: true, signal }) : response;
        } };
    };
    const select = async (service: Readonly<{ pluginId: string; localId: string }>) => {
        const selected = await input.contributions.resolveAccount(service);
        if (!selected) throw Object.assign(new Error('connected_account_authentication_mode_unavailable'), { code: 'connected_account_authentication_mode_unavailable' });
        return selected;
    };
    const runtime = (selected: ConnectedAccountPortableRuntimeLease) => selected.authentication.acquire(() => createRuntime(selected));
    const attemptConfiguration = async (selected: ConnectedAccountPortableRuntimeLease, attemptId: string,
        command: ConfigurationCommand): Promise<ConnectedAccountDaemonControlResponse> => {
        const retained = runtime(selected);
        const basis = await retained.attempts.resolveConfigurationControlTarget({ attemptId });
        if (!basis) return unavailable('connected_account_configuration_target_unavailable');
        if (command.operation === 'readConfiguration') return { status: 'configuration' as const, ...basis,
            configuration: await retained.configuration.inspect(basis) };
        const replacement = await retained.configuration.replaceForControl({ ...basis,
            expectedRevision: command.expectedRevision, values: command.values,
            secretValues: command.secretValues });
        if (replacement.status !== 'committed') return replacement;
        return { status: 'configurationCommitted', ...basis, configuration: replacement.configuration };
    };
    const host: CredentialedConnectedAccountAuthenticationHost = Object.freeze({
        ...(input.operationContext ? { savedSecretOperationContext: input.operationContext } : {}),
        async executeAction(actionId, operands, context, executeLocal): Promise<CurrentProcessPluginActionExecutionAttempt> {
            const authenticationAction = Object.values(CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION).find(id => id === actionId);
            const routedAction = authenticationAction ?? (actionId === 'connectedServices.configuration.get'
                || actionId === 'connectedServices.configuration.replace' ? actionId : undefined);
            if (!routedAction) return actionId === 'connectedServices.authentication.pending.list'
                ? { matched: true, result: await executeLocal(actionId, operands, context, host) } : { matched: false };
            const parsed = CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1[routedAction].safeParse(operands);
            if (!parsed.success) return { matched: false };
            const value = 'target' in parsed.data ? parsed.data.target : parsed.data;
            let bound: CredentialedConnectedAccountAuthenticationHost | null;
            try {
                bound = await withHome(async () => {
                    context?.signal?.throwIfAborted();
                    let record: ConnectedAccountAttemptTransactionRecord | undefined;
                    const service = 'attemptId' in value
                        ? (record = await api.read({ attemptId: value.attemptId }) ?? undefined)?.scope.service
                        : 'service' in value ? value.service : value.account.service;
                    if (!service || record?.scope.machineId) return null;
                    const declaration = input.contributions.describe(service);
                    if (!declaration?.descriptor.authentication.account) return null;
                    const selected = await select(service);
                    const modeId = 'modeId' in value ? value.modeId : 'account' in value
                        ? (await persistence.attempts.accounts.readExact(value.account))?.authenticationModeId : record?.scope.modeId;
                    if (!modeId || !selected.runtime.authentication.modes[modeId]) return null;
                    // Only executable custody and the addressed read survive routing.
                    // The callback admits the original Action/caller/signal afresh.
                    return Object.freeze({ ...host, authenticationCommand(_machineId: string | undefined,
                        command: ConnectedAccountDaemonCommand, options: AuthenticationOptions) {
                        return withHome(() => runtime(selected).execute(command, options.signal, record));
                    }, controlCommand(machineId: string | undefined,
                        command: ConnectedAccountDaemonControlCommand, options: ControlOptions) {
                        if ((command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration')
                            && command.target.kind === 'attempt') {
                            const attemptId = command.target.attemptId;
                            return withHome(async () => {
                                try { return await attemptConfiguration(selected, attemptId, command); }
                                catch (error) { return unavailable(failureCode(error)); }
                            });
                        }
                        return host.controlCommand(machineId, command, options);
                    } });
                });
            } catch (error) {
                // Artifact failure is an Account refusal, never native fallback.
                // Ordinary core admission still runs before returning that refusal.
                bound = Object.freeze({ ...host, authenticationCommand: async () => unavailable(failureCode(error)),
                    controlCommand: async () => unavailable(failureCode(error)) });
            }
            if (!bound) return { matched: false };
            return { matched: true, result: await executeLocal(actionId, operands, context, bound) };
        },
        authenticationCommand(machineId, command, options): Promise<ConnectedAccountAttemptResponse> {
            return withHome(async () => {
                try {
                    if (command.operation === 'beginConnect' || command.operation === 'beginReconnect') {
                        const service = command.operation === 'beginConnect' ? command.service : command.account.service;
                        const declared = input.contributions.describe(service);
                        if (!declared?.descriptor.authentication.account) return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_authentication_mode_unavailable');
                        const selected = await select(service);
                        const modeId = command.operation === 'beginConnect' ? command.modeId
                            : (await persistence.attempts.accounts.readExact(command.account))?.authenticationModeId;
                        if (!modeId || !selected.runtime.authentication.modes[modeId]) return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_authentication_mode_unavailable');
                        return runtime(selected).execute(command, options.signal);
                    }
                    const record = await api.read({ attemptId: command.attemptId });
                    if (!record) return unavailable('connected_account_attempt_not_found', command.attemptId);
                    if (record.scope.machineId) return options.native(record.scope.machineId, command);
                    return runtime(await select(record.scope.service)).execute(command, options.signal, record);
                } catch (error) { return unavailable(failureCode(error), 'attemptId' in command ? command.attemptId : undefined); }
            });
        },
        controlCommand(machineId, command, options): Promise<ConnectedAccountDaemonControlResponse> {
            return withHome(async () => {
                if (command.operation === 'listPendingAttempts') return { status: 'pendingAttempts' as const,
                    attempts: await api.listPending({ service: command.service, ...(machineId ? { machineId } : {}) }) };
                if (command.operation === 'describeService') {
                    try {
                        // Discovery consumes the admitted declaration, including native-only
                        // modes. Acquiring an Account runtime here hides daemon-owned imports.
                        const selected = input.contributions.describe(command.service);
                        if (!selected) return unavailable('connected_account_service_unavailable');
                        if (!selected.isCurrent()) return unavailable('connected_account_runtime_generation_changed');
                        return { status: 'described' as const, service: selected.ref, descriptor: selected.descriptor,
                            occurrenceId: selected.occurrenceId, sourceCustody: selected.sourceCustody,
                            accounts: await persistence.profiles.list(command.service) };
                    } catch (error) { return unavailable(failureCode(error)); }
                }
                if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
                    try {
                        const requested = command.target;
                        if (requested.kind === 'attempt') {
                            const record = await api.read({ attemptId: requested.attemptId });
                            if (!record) return unavailable('connected_account_attempt_not_found');
                            if (record.scope.machineId) return options.native(record.scope.machineId, command);
                            return attemptConfiguration(await select(record.scope.service), requested.attemptId, command);
                        }
                        const service = requested.kind === 'account' ? requested.account.service : requested.service;
                        if (!input.contributions.describe(service)?.descriptor.authentication.account) return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
                        const selected = await select(service);
                        const modeId = requested.kind === 'account'
                            ? (await persistence.attempts.accounts.readExact(requested.account))?.authenticationModeId : requested.modeId;
                        const mode = selected.descriptor.authentication.modes.find(candidate => candidate.id === modeId);
                        if (!mode || !selected.runtime.authentication.modes[mode.id]) return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
                        const retained = runtime(selected);
                        const basis = { target: { ...requested, modeId: mode.id }, mode,
                            occurrenceId: selected.occurrenceId, sourceCustody: selected.sourceCustody };
                        if (command.operation === 'readConfiguration') return { status: 'configuration' as const, ...basis,
                            configuration: await retained.configuration.inspect(basis) };
                        return unavailable('connected_account_configuration_unavailable');
                    } catch (error) { return unavailable(failureCode(error)); }
                }
                return machineId ? options.native(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
            });
        },
    });
    return host;
}
