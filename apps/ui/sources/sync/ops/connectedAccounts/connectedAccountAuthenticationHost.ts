import { readConnectedAccountBrowserSignInMachineSupport } from '@/sync/domains/connectedServices/connectedAccountBrowserSignInMachineSupport';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readUiAccountConnectedServiceDeclarations, type AccountConnectedServiceDeclaration } from '@/sync/domains/connectedServices/accountDeclarations';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiAccountConnectedAccountRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { listQualifiedConnectedAccountsV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { createUiConnectedAccountAttemptTransactionApi } from './connectedAccountAttemptTransactions';
import { createUiConnectedAccountCredentialPersistence } from './connectedAccountCredentialPersistence';
import { createUiConnectedAccountAuthenticationRuntime } from './connectedAccountAuthenticationRuntime';
import { runConnectedAccountAuthenticationCommand, runConnectedAccountControlCommand,
    type ConnectedAccountDaemonCommand, type ConnectedAccountAttemptResponse,
    type ConnectedAccountDaemonControlCommand, type ConnectedAccountDaemonControlResponse } from './connectedAccountDaemon';

type Service = AccountConnectedServiceDeclaration['service'];
const BROWSER_SIGN_IN_MACHINE_UNAVAILABLE = 'connected_account_browser_sign_in_machine_unavailable';
export type UiConnectedAccountAuthenticationModes =
    | Readonly<{ status: 'available'; modeIds: readonly string[];
        machineRequiredModeIds?: readonly string[]; machineUnavailableCode?: string }>
    | Readonly<{ status: 'unavailable'; code: string }>;
export type UiConnectedAccountAuthenticationHost = Readonly<{
    authenticationCommand(machineId: string | undefined, command: ConnectedAccountDaemonCommand): Promise<ConnectedAccountAttemptResponse>;
    controlCommand(machineId: string | undefined, command: ConnectedAccountDaemonControlCommand): Promise<ConnectedAccountDaemonControlResponse>;
    readAccountAuthenticationModes(service: Service): Promise<UiConnectedAccountAuthenticationModes>;
    describeService(service: Service, machineId?: string): Promise<Readonly<{
        description: ConnectedAccountDaemonControlResponse;
        accountAuthenticationModes: UiConnectedAccountAuthenticationModes;
    }>>;
}>;

function failureCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : 'connected_account_service_unavailable';
}
function unavailable(code: string, attemptId?: string) {
    return { status: 'unavailable' as const, code, ...(attemptId ? { attemptId } : {}) };
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Finite Action transport; the registration, not this wrapper, owns attempts. */
export function createUiConnectedAccountAuthenticationHost(account: LazyActionAccountContext, signal?: AbortSignal, requestId?: string): UiConnectedAccountAuthenticationHost {
    const api = createUiConnectedAccountAttemptTransactionApi(account, signal);
    const persistence = createUiConnectedAccountCredentialPersistence(account, signal);
    const declaration = (service: Service) => readUiAccountConnectedServiceDeclarations(account.accountLifetime)
        .find(value => value.service.pluginId === service.pluginId && value.service.localId === service.localId) ?? null;
    const projectedDeclaration = (service: Service) => readPluginAccountAvailability(account.accountLifetime.scope)
        .readAccountUiProjection()?.connectedAccountDescriptorsById?.[buildQualifiedPluginContributionKey(service)];
    const hasAccountArtifact = (service: Service) => Boolean(declaration(service)?.descriptor.authentication.account
        ?? projectedDeclaration(service)?.definition.authentication.account);
    const selection = async (service: Service) => {
        const admitted = await readPluginAccountAvailability(account.accountLifetime.scope)
            .ensureCurrentAccountExecution(service.pluginId);
        if (admitted.kind === 'unavailable') return fail(admitted.code);
        const declared = declaration(service);
        if (!declared) return fail('connected_account_service_unavailable');
        if (!declared.descriptor.authentication.account) return { declaration: declared, selected: null };
        const projected = projectedDeclaration(service);
        if (!projected) return fail('connected_account_service_unavailable');
        const selected = await resolvePluginUiAccountConnectedAccountRegistration({ descriptor: projected,
            platform: resolvePluginUiClientExecutablePlatform(), signal });
        if (!selected) return fail('connected_account_service_unavailable');
        return { declaration: declared, selected };
    };
    const runtime = async (selected: Awaited<ReturnType<typeof selection>>) => {
        const slot = selected.selected?.registration.connectedAccountAuthentication;
        if (!selected.selected || !slot) return fail('connected_account_authentication_mode_unavailable');
        const registered = selected.selected;
        return slot.acquire(() => createUiConnectedAccountAuthenticationRuntime({ selected: registered,
            declaration: selected.declaration }));
    };
    // This is the one placement policy for presentation and start. Once begun,
    // the addressed attempt record, rather than the current platform, routes work.
    const modePlacement = async (selected: Awaited<ReturnType<typeof selection>>) => {
        const modes = selected.selected ? Object.keys(selected.selected.runtime.authentication.modes) : [];
        const browser = modes.length > 0 && await readRuntimeFetchHost(account.endpointUrl) === 'browser';
        const machineRequiredModeIds = browser ? modes.filter(id => {
            const mode = selected.declaration?.descriptor.authentication.modes.find(value => value.id === id);
            return mode !== undefined && 'browserReachability' in mode && mode.browserReachability === 'unreachable';
        }) : [];
        return { status: 'available' as const,
            modeIds: Object.freeze(modes.filter(id => !machineRequiredModeIds.includes(id))),
            ...(machineRequiredModeIds.length ? { machineRequiredModeIds: Object.freeze(machineRequiredModeIds),
                machineUnavailableCode: BROWSER_SIGN_IN_MACHINE_UNAVAILABLE } : {}) };
    };
    const readAccountAuthenticationModes = async (service: Service): Promise<UiConnectedAccountAuthenticationModes> => {
        try {
            return await modePlacement(await selection(service));
        } catch (error) { return { status: 'unavailable', code: failureCode(error) }; }
    };
    const nativeControl = (machineId: string, command: ConnectedAccountDaemonControlCommand) =>
        runConnectedAccountControlCommand({ serverId: account.serverId, machineId, command, signal, requestId,
            assertCurrent: account.assertCurrent });
    const readBrowserSignInMachineSupport = (machineId: string) => {
        account.assertCurrent();
        const machine = resolveMachineForActiveServerFromState(getStorage().getState(), machineId, account.accountLifetime.scope);
        return readConnectedAccountBrowserSignInMachineSupport(machine);
    };
    const describeService = async (service: Service, machineId?: string): Promise<Readonly<{
        description: ConnectedAccountDaemonControlResponse;
        accountAuthenticationModes: UiConnectedAccountAuthenticationModes;
    }>> => {
        const accountAuthenticationModes = await readAccountAuthenticationModes(service);
        const known = declaration(service);
        if (machineId && (!known && !hasAccountArtifact(service)
            || accountAuthenticationModes.status === 'available' && !accountAuthenticationModes.modeIds.length)) {
            if (accountAuthenticationModes.status === 'available' && accountAuthenticationModes.machineRequiredModeIds?.length) {
                const support = readBrowserSignInMachineSupport(machineId);
                if (support !== 'supported') return { description: unavailable(support), accountAuthenticationModes };
            }
            const description = await nativeControl(machineId, { operation: 'describeService', service,
                requiredOperation: 'account_list' });
            return { description, accountAuthenticationModes: description.status === 'described'
                && !description.descriptor.authentication.account
                ? { status: 'available', modeIds: Object.freeze([]) } : accountAuthenticationModes };
        }
        if (!known || accountAuthenticationModes.status === 'unavailable') return {
            description: unavailable(accountAuthenticationModes.status === 'unavailable'
                ? accountAuthenticationModes.code : 'connected_account_service_unavailable'), accountAuthenticationModes };
        try {
            const listed = await listQualifiedConnectedAccountsV4(account.credentials, { service, request: account.request,
                signal, requestPurpose: 'connected-accounts:persistence', retry: 'none' });
            return { description: { status: 'described', service, descriptor: known.descriptor,
                occurrenceId: known.occurrenceId, sourceCustody: known.sourceCustody, accounts: listed.accounts },
            accountAuthenticationModes };
        } catch (error) { return { description: unavailable(failureCode(error)), accountAuthenticationModes }; }
    };
    const authenticationCommand = async (machineId: string | undefined,
        command: ConnectedAccountDaemonCommand): Promise<ConnectedAccountAttemptResponse> => {
        try {
            if (command.operation === 'beginConnect' || command.operation === 'beginReconnect') {
                const service = command.operation === 'beginConnect' ? command.service : command.account.service;
                if (!hasAccountArtifact(service)) {
                    return machineId ? runConnectedAccountAuthenticationCommand({ serverId: account.serverId,
                        accountId: account.accountId, machineId, command, signal, requestId, assertCurrent: account.assertCurrent })
                        : unavailable('connected_account_authentication_mode_unavailable');
                }
                const selected = await selection(service);
                const modeId = command.operation === 'beginConnect' ? command.modeId
                    : (await persistence.accounts.readExact(command.account))?.authenticationModeId;
                if (modeId && selected.selected?.runtime.authentication.modes[modeId]) {
                    const placement = await modePlacement(selected);
                    if (placement.machineRequiredModeIds?.includes(modeId)) {
                        if (machineId) {
                            const support = readBrowserSignInMachineSupport(machineId);
                            if (support !== 'supported') return unavailable(support);
                        }
                        return machineId ? runConnectedAccountAuthenticationCommand({ serverId: account.serverId,
                            accountId: account.accountId, machineId, command, signal, requestId, assertCurrent: account.assertCurrent })
                            : unavailable(BROWSER_SIGN_IN_MACHINE_UNAVAILABLE);
                    }
                    return (await runtime(selected)).execute(command, signal);
                }
                return machineId ? runConnectedAccountAuthenticationCommand({ serverId: account.serverId,
                    accountId: account.accountId, machineId, command, signal, requestId, assertCurrent: account.assertCurrent })
                    : unavailable('connected_account_authentication_mode_unavailable');
            }
            // The addressed record is the router for every continuation. Its
            // Machine address is usable without opening native opaque content.
            const record = await api.read({ attemptId: command.attemptId });
            if (!record) return unavailable('connected_account_attempt_not_found', command.attemptId);
            if (record.scope.machineId) return runConnectedAccountAuthenticationCommand({ serverId: account.serverId,
                accountId: account.accountId, machineId: record.scope.machineId, command, signal, requestId, assertCurrent: account.assertCurrent });
            const selected = await selection(record.scope.service);
            return (await runtime(selected)).execute(command, signal, record);
        } catch (error) { return unavailable(failureCode(error), 'attemptId' in command ? command.attemptId : undefined); }
    };
    const controlCommand = async (machineId: string | undefined,
        command: ConnectedAccountDaemonControlCommand): Promise<ConnectedAccountDaemonControlResponse> => {
        if (command.operation === 'listPendingAttempts') return { status: 'pendingAttempts',
            attempts: await api.listPending({ service: command.service, ...(machineId ? { machineId } : {}) }) };
        if (command.operation === 'describeService') {
            // Operation admission belongs to the selected Machine; an authentication
            // description cannot replace the Action's requested operation.
            if (machineId && command.requiredOperation) return nativeControl(machineId, command);
            return (await describeService(command.service, machineId)).description;
        }
        if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
            try {
                const requested = command.target;
                if (requested.kind === 'attempt') {
                    const record = await api.read({ attemptId: requested.attemptId });
                    if (!record) return unavailable('connected_account_attempt_not_found');
                    if (record.scope.machineId) return nativeControl(record.scope.machineId, command);
                    const retained = await runtime(await selection(record.scope.service));
                    const basis = await retained.attempts.resolveConfigurationControlTarget({ attemptId: requested.attemptId });
                    if (!basis) return unavailable('connected_account_configuration_target_unavailable');
                    if (command.operation === 'readConfiguration') return { status: 'configuration', ...basis,
                        configuration: await retained.configuration.inspect(basis) };
                    const replacement = await retained.configuration.replaceForControl({ ...basis,
                        expectedRevision: command.expectedRevision, values: command.values,
                        secretValues: command.secretValues });
                    if (replacement.status !== 'committed') return replacement;
                    return { status: 'configurationCommitted', ...basis,
                        configuration: replacement.configuration };
                }
                const service = requested.kind === 'account' ? requested.account.service : requested.service;
                if (!hasAccountArtifact(service)) return machineId
                    ? nativeControl(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
                const selected = await selection(service);
                const known = selected.declaration;
                const modeId = requested.kind === 'account'
                    ? (await persistence.accounts.readExact(requested.account))?.authenticationModeId : requested.modeId;
                const mode = known.descriptor.authentication.modes.find(candidate => candidate.id === modeId);
                if (!mode || !selected.selected?.runtime.authentication.modes[mode.id]) return machineId
                    ? nativeControl(machineId, command) : unavailable('connected_account_configuration_target_unavailable');
                const retained = await runtime(selected);
                const basis = { target: { ...requested, modeId: mode.id }, mode,
                    occurrenceId: known.occurrenceId, sourceCustody: known.sourceCustody };
                if (command.operation === 'readConfiguration') return { status: 'configuration', ...basis,
                    configuration: await retained.configuration.inspect(basis) };
                return unavailable('connected_account_configuration_unavailable');
            } catch (error) { return unavailable(failureCode(error)); }
        }
        if (machineId) return nativeControl(machineId, command);
        return unavailable('connected_account_configuration_unavailable');
    };
    return { authenticationCommand, controlCommand, readAccountAuthenticationModes, describeService };
}
