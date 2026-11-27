import { randomUUID } from 'node:crypto';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ConnectedAccountEstablishedRuntimeRegistry, ConnectedAccountRuntimeEstablishedOperation, ConnectedAccountRuntimeEstablishedInvocation } from '@happier-dev/cli-common/connectedAccounts';
import { resolveConnectedAccountAuthenticationModeMachineRequirement } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { ConnectedAccountAuthenticationModeUnavailableError, createConnectedAccountAuthenticationAttemptOwner, createConnectedAccountConfigurationOwner,
    executeConnectedAccountAuthenticationCommand, projectConnectedAccountFailure, type ConnectedAccountAttemptTransactionRecord } from '@happier-dev/cli-common/connectedAccounts';
import type { ActionExecuteResult, ActionExecutorContext, ActionId, ConnectedAccountDaemonCommand,
    ConnectedAccountAttemptResponse, ConnectedAccountDaemonControlCommand, ConnectedAccountDaemonControlResponse,
    PluginConnectedAccountAuthenticationV2 } from '@happier-dev/protocol';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION, CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { connectedAccountSourceCustodyV1Equal } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { createConnectedAccountAttemptTransactionApi } from '@/api/client/connectedAccountAttemptTransactionApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence, readHomePublicOAuthClient,
    readHomeWebappUrl } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
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

/** The catalog and begin admission use the same declared authentication placement. */
export function resolveCredentialedConnectedAccountAuthenticationPlacement(
    authentication: PluginConnectedAccountAuthenticationV2 | undefined,
    machineId?: string,
    modeId?: string,
    operation: 'authentication' | 'testConnection' = 'authentication',
): Readonly<{ kind: 'account' } | { kind: 'machine'; machineId: string } | { kind: 'unavailable'; code: string }> {
    const mode = authentication?.modes.find(candidate => candidate.id === modeId);
    if (authentication?.account && !resolveConnectedAccountAuthenticationModeMachineRequirement(mode, false, operation)) return { kind: 'account' as const };
    if (machineId) return { kind: 'machine' as const, machineId };
    return { kind: 'unavailable' as const, code: 'connected_account_authentication_mode_unavailable' };
}
/** A host refusal keeps its typed code and cause through the one connected-account projector. */
function unavailableFrom(error: unknown, attemptId?: string) {
    const { code, diagnostic } = projectConnectedAccountFailure(error, {
        code: { fallback: 'connected_account_service_unavailable' }, phase: 'connected_account.host' });
    return { ...unavailable(code, attemptId), ...(diagnostic ? { diagnostic } : {}) };
}

/** Physical CLI ports only. The selected registration owns the shared attempt runtime. */
export function createCredentialedConnectedAccountAuthenticationHost(input: Readonly<{
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    operationContext?: SavedSecretOperationContextV1;
    /** This Account's own Home features: its web app (the OAuth relay) and its advertised public OAuth clients. */
    readHomeFeatures?: () => Promise<CliServerFeaturesSnapshot | undefined>;
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
    const readHomeFeatures = input.readHomeFeatures;
    const createRuntime = (selected: ConnectedAccountPortableRuntimeLease): CredentialedConnectedAccountAuthenticationRuntime => {
        const configuration = createConnectedAccountConfigurationOwner({ ...persistence.configuration,
            ...(readHomeFeatures ? { async readPublicOAuthClient(request: Parameters<typeof readHomePublicOAuthClient>[1], options?: { signal?: AbortSignal }) {
                const features = await readHomeFeatures();
                options?.signal?.throwIfAborted();
                return readHomePublicOAuthClient(features, request);
            } } : {}),
            isRuntimeCurrent: identity => selected.isCurrent() && identity.pluginId === selected.ref.pluginId
                && identity.occurrenceId === selected.occurrenceId
                && connectedAccountSourceCustodyV1Equal(identity.sourceCustody, selected.sourceCustody),
        });
        const attempts = createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: randomUUID, createAccountId: randomUUID, createSavedSecretResourceId: randomUUID,
            now: Date.now, accounts: persistence.attempts.accounts, configuration,
            ...(readHomeFeatures ? { readHomeWebappUrl: async () => readHomeWebappUrl(await readHomeFeatures()) } : {}),
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
                    if (!descriptor || !selected.runtime.authentication.modes[request.modeId]) throw new ConnectedAccountAuthenticationModeUnavailableError();
                    return { service: selected.ref, descriptor,
                        authenticationModeCardinality: selected.descriptor.authentication.modes.length === 1 ? 'single' : 'multiple',
                        occurrenceId: selected.occurrenceId, sourceCustody: selected.sourceCustody };
                },
                isCurrent: () => selected.isCurrent(),
                invoke: invocation => input.invoker.invokeAuthentication({ ...invocation, lease: selected,
                    configurationRevocationSignal: configuration.currentnessSignal }),
            },
            oauth: transactions.oauth, deviceTransactions: transactions.device,
            attemptAddresses: transactions.address, settlement: persistence.attempts.settlement,
        });
        return { attempts, configuration, dispose: attempts.dispose, async execute(command, signal, addressedRecord) {
            return executeConnectedAccountAuthenticationCommand({ attempts, command, signal,
                ...(addressedRecord ? { addressedRecord } : {}) });
        } };
    };
    const select = async (service: Readonly<{ pluginId: string; localId: string }>) => {
        const selected = await input.contributions.resolveAccount(service);
        if (!selected) throw Object.assign(new Error('connected_account_authentication_mode_unavailable'), { code: 'connected_account_authentication_mode_unavailable' });
        return selected;
    };
    const runtime = (selected: ConnectedAccountPortableRuntimeLease) => selected.authentication.acquire(() => createRuntime(selected));
    const execute = async (selected: ConnectedAccountPortableRuntimeLease, machineId: string | undefined,
        command: ConnectedAccountDaemonCommand, options: AuthenticationOptions,
        record?: ConnectedAccountAttemptTransactionRecord): Promise<ConnectedAccountAttemptResponse> => {
        const response = await runtime(selected).execute(command, options.signal, record);
        if ((command.operation === 'beginConnect' || command.operation === 'beginReconnect') && machineId
            && response.status === 'unavailable' && !response.attemptId
            && response.code === 'connected_account_authentication_mode_unavailable') {
            return options.native(machineId, command);
        }
        return response;
    };
    const attemptConfiguration = async (selected: ConnectedAccountPortableRuntimeLease, attemptId: string,
        command: ConfigurationCommand): Promise<ConnectedAccountDaemonControlResponse> => {
        const retained = runtime(selected);
        const basis = await retained.attempts.resolveConfigurationControlTarget({ attemptId });
        if (!basis) return unavailable('connected_account_configuration_target_unavailable');
        if (command.operation === 'readConfiguration') {
            const { mode, ...configuration } = await retained.configuration.inspect(basis);
            return { status: 'configuration' as const, ...basis, mode, configuration };
        }
        const replacement = await retained.configuration.replaceForControl({ ...basis,
            expectedRevision: command.expectedRevision, values: command.values,
            secretValues: command.secretValues });
        if (replacement.status !== 'committed') return replacement;
        const { mode, ...configuration } = replacement.configuration;
        return { status: 'configurationCommitted', ...basis, mode, configuration };
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
                    const modeId = 'modeId' in value ? value.modeId : 'account' in value
                        ? (await persistence.attempts.accounts.readExact(value.account))?.authenticationModeId : undefined;
                    if (resolveCredentialedConnectedAccountAuthenticationPlacement(declaration.descriptor.authentication, undefined, modeId).kind !== 'account') return null;
                    const selected = await select(service);
                    // Only executable custody and the addressed read survive routing.
                    // The callback admits the original Action/caller/signal afresh.
                    return Object.freeze({ ...host, authenticationCommand(machineId: string | undefined,
                        command: ConnectedAccountDaemonCommand, options: AuthenticationOptions) {
                        return withHome(() => execute(selected, machineId, command, options, record));
                    }, controlCommand(machineId: string | undefined,
                        command: ConnectedAccountDaemonControlCommand, options: ControlOptions) {
                        if ((command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration')
                            && command.target.kind === 'attempt') {
                            const attemptId = command.target.attemptId;
                            return withHome(async () => {
                                try { return await attemptConfiguration(selected, attemptId, command); }
                                catch (error) { return unavailableFrom(error); }
                            });
                        }
                        return host.controlCommand(machineId, command, options);
                    } });
                });
            } catch (error) {
                // Artifact failure is an Account refusal, never native fallback.
                // Ordinary core admission still runs before returning that refusal.
                bound = Object.freeze({ ...host, authenticationCommand: async () => unavailableFrom(error),
                    controlCommand: async () => unavailableFrom(error) });
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
                        const modeId = command.operation === 'beginConnect' ? command.modeId
                            : (await persistence.attempts.accounts.readExact(command.account))?.authenticationModeId;
                        const placement = resolveCredentialedConnectedAccountAuthenticationPlacement(declared?.descriptor.authentication, machineId, modeId);
                        if (placement.kind === 'unavailable') return unavailable(placement.code);
                        if (placement.kind === 'machine') return options.native(placement.machineId, command);
                        const selected = await select(service);
                        return execute(selected, machineId, command, options);
                    }
                    const record = await api.read({ attemptId: command.attemptId });
                    if (!record) return unavailable('connected_account_attempt_not_found', command.attemptId);
                    if (record.scope.machineId) return options.native(record.scope.machineId, command);
                    return runtime(await select(record.scope.service)).execute(command, options.signal, record);
                } catch (error) { return unavailableFrom(error, 'attemptId' in command ? command.attemptId : undefined); }
            });
        },
        controlCommand(machineId, command, options): Promise<ConnectedAccountDaemonControlResponse> {
            return withHome(async () => {
                if (command.operation === 'testConnection') {
                    try {
                        const declared = input.contributions.describe(command.account.service);
                        const credential = await persistence.attempts.accounts.readExact(command.account);
                        const placement = resolveCredentialedConnectedAccountAuthenticationPlacement(
                            declared?.descriptor.authentication, machineId, credential?.authenticationModeId, 'testConnection');
                        if (placement.kind !== 'account') return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_authentication_mode_unavailable');
                        const selected = await select(command.account.service);
                        const registry = {
                            connectedAccountContributions: { describe: (ref: typeof selected.ref) => input.contributions.describe(ref) },
                            resolveConnectedAccountRuntime: async (ref: typeof selected.ref) => ref.pluginId === selected.ref.pluginId
                                && ref.localId === selected.ref.localId ? selected : null,
                            connectedAccountRuntimeInvoker: { invokeEstablished: <TOperation extends ConnectedAccountRuntimeEstablishedOperation>(invocation: ConnectedAccountRuntimeEstablishedInvocation<TOperation>) => input.invoker.invokeEstablished({ ...invocation, lease: selected }) },
                        } satisfies ConnectedAccountEstablishedRuntimeRegistry;
                        const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
                            credentials: input.credentials, configuration: persistence.configuration,
                            configurationOwner: runtime(selected).configuration,
                            getAccountEncryptionMode: (signal, options) => getAccountEncryptionMode({ ...options, ...(signal ? { signal } : {}) }),
                            reloadController: {
                                async acquireRuntimeRegistry() { return { registry, async release() {} }; },
                                isRuntimeRegistryCurrent: candidate => candidate === registry && selected.isCurrent(),
                            },
                            isAccountRuntimeCurrent: async () => selected.isCurrent() && (!input.operationContext || await input.operationContext.isCurrent()),
                        });
                        return { status: 'connectionTested' as const, result: await owner.invoke({ account: command.account,
                            operation: { kind: 'testConnection' }, ...(options.signal ? { signal: options.signal } : {}) }) };
                    } catch (error) { return unavailableFrom(error); }
                }
                if (command.operation === 'listPendingAttempts') {
                    if (machineId) return options.native(machineId, command);
                    const pending = await api.listPending({ service: command.service });
                    return { status: 'pendingAttempts' as const, attempts: pending.length === 0 ? pending
                        : await runtime(await select(command.service)).attempts.selectResumableAttempts(pending) };
                }
                if (command.operation === 'describeService') {
                    // Operation admission belongs to the selected Machine's executable
                    // registry and peer transport, not this cold authentication catalog.
                    if (command.requiredOperation) return machineId
                        ? options.native(machineId, command)
                        : unavailable('connected_account_peer_operation_admission_unavailable');
                    try {
                        // Discovery consumes the admitted declaration, including native-only
                        // modes. Acquiring an Account runtime here hides daemon-owned imports.
                        const selected = input.contributions.describe(command.service);
                        if (!selected) return unavailable('connected_account_service_unavailable');
                        if (!selected.isCurrent()) return unavailable('connected_account_runtime_generation_changed');
                        return { status: 'described' as const, service: selected.ref, descriptor: selected.descriptor,
                            occurrenceId: selected.occurrenceId, sourceCustody: selected.sourceCustody,
                            accounts: await persistence.profiles.list(command.service) };
                    } catch (error) { return unavailableFrom(error); }
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
                        const modeId = requested.kind === 'account'
                            ? (await persistence.attempts.accounts.readExact(requested.account))?.authenticationModeId : requested.modeId;
                        // Configuration follows the service host; native-import placement applies only to acquiring credentials.
                        const declared = input.contributions.describe(service);
                        if (resolveCredentialedConnectedAccountAuthenticationPlacement(declared?.descriptor.authentication, machineId).kind !== 'account') return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
                        const selected = await select(service);
                        const mode = selected.descriptor.authentication.modes.find(candidate => candidate.id === modeId);
                        if (!mode) return machineId
                            ? options.native(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
                        const retained = runtime(selected);
                        const basis = { target: { ...requested, modeId: mode.id }, mode,
                            occurrenceId: selected.occurrenceId, sourceCustody: selected.sourceCustody };
                        if (command.operation === 'readConfiguration') {
                            const { mode, ...configuration } = await retained.configuration.inspect(basis);
                            return { status: 'configuration' as const, ...basis, mode, configuration };
                        }
                        const replacement = await retained.configuration.replaceForControl({ ...basis,
                            expectedRevision: command.expectedRevision, values: command.values,
                            secretValues: command.secretValues });
                        if (replacement.status !== 'committed') return replacement;
                        const { mode: effectiveMode, ...configuration } = replacement.configuration;
                        return { status: 'configurationCommitted' as const, ...basis, mode: effectiveMode, configuration };
                    } catch (error) { return unavailableFrom(error); }
                }
                return machineId ? options.native(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
            });
        },
    });
    return host;
}
