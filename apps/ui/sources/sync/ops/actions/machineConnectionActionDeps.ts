import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { MACHINE_CAPABILITIES_DETECT_ACTION_ID, MACHINE_DOCTOR_SNAPSHOT_ACTION_ID, MACHINE_RUN_MARKERS_LIST_ACTION_ID } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { MACHINE_SECURITY_INSPECT_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { startPairingForHome, type StartedHomePairing, type StartPairingForHomeResult } from '@/auth/pairing/startPairingForHome';
import { buildMachineAddCommand, resolveWebDesktopSetupHandoffTarget } from '@/components/machines/add/machineAddCommand';
import { readMachineAddHomeTargetForServerId } from '@/components/machines/add/machineAddHomeTarget';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { areServerProfileIdentifiersEquivalent, getServerProfileById, getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { retryActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { connectHomeAtAddress, type ConnectHomeAtAddressInput, type ConnectHomeAtAddressResult } from '@/sync/ops/home/connectHomeAtAddress';
import { machineTerminalEnsure, machineTerminalList, machineTerminalStreamReadBytes, machineTerminalStreamSendInput, machineTerminalClose, machineTerminalRestart, trackPendingMachineTerminalCreation } from '@/sync/ops/machineTerminal';
import { MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { canUsePrivateProjectAccountAction } from '@/sync/api/projects/projectAccountRowsClient';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { createMachineAddSshTaskAction } from '@/components/machines/add/machineAddSshTaskAction';
import { createLocalDaemonServiceAction } from './localDaemonServiceAction';
import { createMachineAddLocalSetupAction, createMachineAddLocalCancelAction } from '@/components/machines/add/machineAddLocalSetupAction';
import { MachineCapabilityInstallInputSchema, MachineMetadataUpdateInputSchema, MachineReplacementSetInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { projectMachineActionRpcFailure } from '@/sync/domains/machines/machineDaemonRpcErrors';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentMachineUpdateItem } from '@/updates/updatesActionRuntime';
import { observeMachineToolItemUpdate } from '@/updates/machineUpdateRuns';
import { machineStopDaemon, machineUpdateMetadata } from '@/sync/ops/machines';
import { machineRevokeWithProviderCleanup, machineReplaceInAccount, machineClearReplacementFromAccount } from '@/sync/ops/machineAccount';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { createManagedMachineInstallationRespond } from './managedMachineInstallationAction';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createPersonalHomeCreateAction, type PersonalHomeSshDraftSecrets } from '@/components/personalHome/bootstrap/personalHomeCreateAction';

/** Mounted presentation and lifecycle custody, never Action operands or results. */
export type UiHomePairingDelivery = Pick<Parameters<typeof startPairingForHome>[0],
    'isCurrent' | 'onStatus' | 'onCompleting' | 'onRetrying'> & Readonly<{
    onResult: (result: StartPairingForHomeResult) => void;
}>;

/** Local prompts and presentation details for one mounted Home connection. */
export type UiHomeAddressDelivery = Pick<ConnectHomeAtAddressInput, 'confirmInsecureHttp' | 'confirmCanonicalUrl'> & Readonly<{
    onResult: (result: ConnectHomeAtAddressResult) => void;
}>;

// Address the issuing client's existing live lifecycle without retaining its link or QR secret here.
const livePairingCancels = new Map<string, Readonly<{
    accountId: string; serverId: string; cancel: StartedHomePairing['cancel'];
}>>();

export function createMachineConnectionActionDeps(options: Readonly<{ runner?: SystemTaskRunner; account?: LazyActionAccountContext;
    homePairingDelivery?: UiHomePairingDelivery; homeAddressDelivery?: UiHomeAddressDelivery;
    personalHomeSshDraftSecrets?: PersonalHomeSshDraftSecrets }> = {}): Pick<ActionExecutorDeps, 'homeConnect' | 'homeReconnect' | 'personalHomeCreate' | 'localDaemonServiceAction' | 'machineAddCommand' | 'machinePairingCreate' | 'machinePairingCancel' | 'machineTerminalAction' | 'machineAddSshTaskAction' | 'machineAddLocalStart' | 'machineAddLocalCancel' | 'machinePageAction' | 'machineManagedInstallationRespond'> {
    return {
        ...(options.account ? { personalHomeCreate: createPersonalHomeCreateAction(options.account, options.runner, options.personalHomeSshDraftSecrets) } : {}),
        machinePageAction: async ({ actionId, input, context }) => {
            const serverId = input.serverId ?? context.serverId ?? getActiveServerId();
            if (actionId === MACHINE_DOCTOR_SNAPSHOT_ACTION_ID || actionId === MACHINE_SECURITY_INSPECT_ACTION_ID_V1) {
                return readMachineActionRpcResult(await machineRpcWithServerScope({ machineId: input.machineId,
                    serverId, accountId: options.account?.accountId ?? context.runtimeAccountId,
                    method: actionId === MACHINE_SECURITY_INSPECT_ACTION_ID_V1 ? RPC_METHODS.MACHINES_SECURITY_INSPECT : RPC_METHODS.MACHINES_DOCTOR_SNAPSHOT,
                    payload: input, ...(context.signal ? { signal: context.signal } : {}) }));
            }
            if (actionId === MACHINE_RUN_MARKERS_LIST_ACTION_ID) {
                return readMachineActionRpcResult(await machineRpcWithServerScope({ machineId: input.machineId,
                    serverId, accountId: options.account?.accountId ?? context.runtimeAccountId,
                    method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST,
                    payload: {}, ...(context.signal ? { signal: context.signal } : {}) }));
            }
            if (!serverId || !areServerProfileIdentifiersEquivalent(serverId, getActiveServerId())) {
                return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
            }
            const scope = getActiveServerAccountScope();
            if (!scope || !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)
                || context.expectedAccountId && context.expectedAccountId !== scope.accountId
                || context.runtimeAccountId && context.runtimeAccountId !== scope.accountId) {
                return { ok: false, errorCode: 'account_settings_scope_changed', error: 'account_settings_scope_changed' };
            }
            if (actionId === 'machines.daemon.stop') {
                return readMachineActionRpcResult(await machineStopDaemon(input.machineId, { serverId, signal: context.signal }));
            }
            if (actionId === MACHINE_CAPABILITIES_DETECT_ACTION_ID) {
                const accountLifetime = captureActiveServerAccountScopeLifetime();
                await prefetchMachineCapabilities({ machineId: input.machineId, serverId,
                    request: CAPABILITIES_REQUEST_MACHINE_DETAILS, fresh: true,
                    accountLifetime: accountLifetime ?? undefined, signal: context.signal });
                const state = getMachineCapabilitiesCacheState(input.machineId, serverId, undefined, scope.accountId);
                if (state?.status === 'loaded') return { status: 'completed' };
                if (state?.status === 'not-supported') return { status: 'failed', reason: 'not-supported' };
                return { status: 'failed', reason: state?.status === 'idle' ? 'server-switch-abort' : 'error',
                    ...(state?.status === 'error' && state.error ? { error: state.error } : {}) };
            }
            if (actionId === 'machines.capabilities.install') {
                const request = MachineCapabilityInstallInputSchema.parse(input);
                const item = request.method === 'upgrade' ? readCurrentMachineUpdateItem(scope, request.machineId,
                    { kind: 'installable', capabilityId: request.capabilityId }) : null;
                const invoke = () => machineCapabilitiesInvoke(request.machineId, { id: request.capabilityId, method: request.method },
                    { serverId, accountId: scope.accountId, timeoutMs: 5 * 60_000, signal: context.signal });
                const result = item?.action.kind === 'run'
                    ? await observeMachineToolItemUpdate(item.id, scope, request.machineId, invoke)
                    : await invoke();
                return !result.supported && result.actionFailure ? projectMachineActionRpcFailure(result.actionFailure) : result;
            }
            if (actionId === 'machines.remove') return machineRevokeWithProviderCleanup(input.machineId, scope);
            if (actionId === 'machines.replacement.set' || actionId === 'machines.replacement.clear') {
                const account = await captureLazyActionAccountContext(serverId, context.signal);
                try {
                    account.assertCurrent();
                    if (account.accountId !== scope.accountId) {
                        return { ok: false, errorCode: 'account_settings_scope_changed', error: 'account_settings_scope_changed' };
                    }
                    if (actionId === 'machines.replacement.clear') return await machineClearReplacementFromAccount(input.machineId, account.request);
                    const request = MachineReplacementSetInputSchema.parse(input);
                    return await machineReplaceInAccount({ oldMachineId: request.machineId,
                        replacementMachineId: request.replacementMachineId,
                        ...(request.confirmActiveOldMachine === undefined ? {} : { confirmActiveOldMachine: request.confirmActiveOldMachine }),
                    }, account.request);
                } finally { account.dispose(); }
            }
            const request = MachineMetadataUpdateInputSchema.parse(input);
            const machine = storage.getState().machines[request.machineId];
            if (!machine?.metadata || machine.availability?.kind === 'locked') {
                return { ok: false, errorCode: 'machine_metadata_unavailable', error: 'machine_metadata_unavailable' };
            }
            if (request.patch.windowsRemoteSessionLaunchMode !== undefined && machine.metadata.platform !== 'win32') {
                return { ok: false, errorCode: 'machine_platform_mismatch', error: 'machine_platform_mismatch' };
            }
            return machineUpdateMetadata(request.machineId, request.patch, request.expectedVersion ?? machine.metadataVersion, context.signal);
        },
        machineManagedInstallationRespond: createManagedMachineInstallationRespond(options.account),
        machineAddSshTaskAction: createMachineAddSshTaskAction(options.runner),
        localDaemonServiceAction: createLocalDaemonServiceAction(options),
        machineAddLocalStart: createMachineAddLocalSetupAction(options.runner),
        machineAddLocalCancel: createMachineAddLocalCancelAction(options.runner),
        homeReconnect: async (input, context) => {
            context.signal?.throwIfAborted();
            if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, input.serverId)) {
                return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
            }
            const target = getActiveServerSnapshot();
            if (!areServerProfileIdentifiersEquivalent(target.serverId, input.serverId)) {
                return { ok: false, errorCode: 'home_not_focused', error: 'home_not_focused' };
            }
            options.account?.assertCurrent();
            await retryActiveServerConnection();
            context.signal?.throwIfAborted();
            const current = getActiveServerSnapshot();
            if (current.generation !== target.generation || !areServerProfileIdentifiersEquivalent(current.serverId, input.serverId)) {
                return { ok: false, errorCode: 'home_not_focused', error: 'home_not_focused' };
            }
            return { serverId: input.serverId };
        },
        homeConnect: async (input, context) => {
            const delivery = options.homeAddressDelivery;
            const outcome = await connectHomeAtAddress({ serverUrl: input.address, displayName: input.displayName,
                signal: context.signal, confirmInsecureHttp: delivery?.confirmInsecureHttp ?? (async () => input.acceptInsecureHttp),
                confirmCanonicalUrl: delivery?.confirmCanonicalUrl ?? (async (change) => change ? false : input.acceptCanonicalUrl),
            });
            delivery?.onResult(outcome);
            if (outcome.kind === 'connected') return { kind: 'connected', serverId: outcome.profile.id,
                serverUrl: outcome.profile.serverUrl, name: outcome.profile.name };
            if (outcome.kind === 'identity_mismatch') return {
                ok: false, errorCode: 'home_identity_mismatch', error: 'The address answered as a different Home.',
            };
            if (outcome.kind === 'unreachable') return { kind: 'unreachable' };
            return outcome;
        },
        machineAddCommand: async (input, context) => {
            const policy = resolveSetupSurfacePolicy().machine;
            if (input.method === 'ssh' ? !policy.allowRemoteSshMachineSetup : !policy.allowLocalMachineSetup) {
                return { ok: false, errorCode: 'machine_enroll_unavailable', error: 'Machine enrollment is unavailable' };
            }
            const homeTarget = await readMachineAddHomeTargetForServerId(input.serverId, context.signal);
            if (!homeTarget) return { ok: false, errorCode: 'target_unavailable', error: 'Home not found' };
            const target = { ...homeTarget, remote: true, os: input.os };
            const handoff = resolveWebDesktopSetupHandoffTarget(target);
            if (handoff.kind === 'unavailable') return { ok: false, errorCode: handoff.code, error: 'message' in handoff ? handoff.message
                : 'This Home is not reachable from other machines. Add a public HTTPS, tailnet, or Iroh endpoint.' };
            const command = buildMachineAddCommand({ ...target, ...(input.method === 'ssh' ? {
                kind: 'sshMachine', enrollmentIdentity: input.enrollmentIdentity, sshDraft: { ...createDefaultSshCredentialsDraft(input.authMode), host: input.host,
                    username: input.username ?? '', port: input.port === undefined ? '' : String(input.port), identityFilePath: input.identityFilePath ?? '' },
            } : { kind: 'joinHome' }) }, handoff);
            return { command, descriptorFileRequired: handoff.kind === 'descriptor_file_required' };
        },
        machinePairingCreate: async (input, context) => {
            if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, input.serverId)) {
                return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
            }
            // This existing Account lifetime must outlive the short Action invocation:
            // the trusted device continues approving the issued invite until settlement.
            const account = await captureLazyActionAccountContext(input.serverId, context.signal);
            let lifecycleOwnsAccount = false;
            try {
                const delivery = options.homePairingDelivery;
                const started = await startPairingForHome({ targetProfileId: account.serverId,
                    signal: context.signal ?? new AbortController().signal,
                    isCurrent: () => account.accountLifetime.isCurrent() && (delivery?.isCurrent?.() ?? true),
                    onStatus: delivery?.onStatus, onCompleting: delivery?.onCompleting, onRetrying: delivery?.onRetrying });
                if (started.kind === 'started' && !account.accountLifetime.isCurrent()) await started.cancel();
                account.assertCurrent();
                if (started.kind === 'started') {
                    const { pairId } = started.invite;
                    const binding = { accountId: account.accountId, serverId: account.serverId, cancel: started.cancel };
                    livePairingCancels.set(pairId, binding);
                    const remove = () => {
                        if (livePairingCancels.get(pairId) === binding) livePairingCancels.delete(pairId);
                    };
                    const retirement = account.accountLifetime.onRetire(() => { remove(); void binding.cancel(); });
                    lifecycleOwnsAccount = true;
                    const release = () => { remove(); retirement.dispose(); account.dispose(); };
                    void started.completion.then(release, release);
                    delivery?.onResult(started);
                    return { pairId: started.invite.pairId, link: started.link, expiresAtMs: started.invite.expiresAtMs };
                }
                delivery?.onResult(started);
                const errorCode = started.kind === 'failed' ? started.cause : started.kind;
                return { ok: false, errorCode, error: errorCode };
            } finally { if (!lifecycleOwnsAccount) account.dispose(); }
        },
        machinePairingCancel: async ({ serverId, pairId }, context) => {
            const unavailable = { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
            if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, serverId)) return unavailable;
            const scope = getActiveServerAccountScope();
            const live = livePairingCancels.get(pairId);
            if (!scope || !live || scope.accountId !== live.accountId
                || !areServerProfileIdentifiersEquivalent(scope.serverId, live.serverId)
                || !areServerProfileIdentifiersEquivalent(serverId, live.serverId)
                || context.expectedAccountId && context.expectedAccountId !== live.accountId
                || context.runtimeAccountId && context.runtimeAccountId !== live.accountId) return unavailable;
            const result = await live.cancel();
            return result.ok ? { pairId, outcome: result.outcome }
                : { ok: false, errorCode: 'action_failed', error: 'Pairing cancellation could not be confirmed.' };
        },
        machineTerminalAction: async ({ actionId, input, context, signal }) => {
            if (options.account && !context.externalActionCredential && !context.externalActionExecutionAuthorization
                && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host')) {
                const account = options.account;
                const request = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                if (!areServerProfileIdentifiersEquivalent(account.serverId, request.serverId)
                    || account.credentialAuthorityKind !== 'account'
                    || !context.actionRequestId || !canUsePrivateProjectAccountAction(account, context)) {
                    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                }
                const requestId = context.actionRequestId;
                const invocation = projectExternalActionRequesterInvocationV1({ actionId, account,
                    target: { kind: 'machine', machineId: request.machineId },
                    context: { ...context, actionCaller: context.actionCaller ?? { kind: 'host' },
                        surface: context.surface ?? 'rpc', authority: context.authority ?? 'account_automation' } });
                if (!invocation) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                const run = () => executeOriginalAccountMachineAction({ account, actionId,
                        input: request, machineId: request.machineId,
                        requestId, authority: invocation.authority, invocation, foreignTargetOnly: true, ...(signal ? { signal } : {}) });
                const execution = 'terminalKey' in request && typeof request.terminalKey === 'string'
                    ? await trackPendingMachineTerminalCreation(request.machineId, request.terminalKey, run,
                        { serverId: account.serverId, accountId: account.accountId, signal })
                    : await run();
                account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
                if (execution) return execution.ok ? execution.result : execution;
            }
            switch (actionId) {
                case 'machines.terminal.open': {
                    const { machineId, serverId, ...request } = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                    return await machineTerminalEnsure(machineId, request, { serverId, accountId: context.runtimeAccountId, signal });
                }
                case 'machines.terminal.list': {
                    const { machineId, serverId, ...request } = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                    return await machineTerminalList(machineId, { ...request, serverId, accountId: context.runtimeAccountId, signal });
                }
                case 'machines.terminal.read': {
                    const { machineId, serverId, ...request } = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                    return await machineTerminalStreamReadBytes(machineId, request, { serverId, accountId: context.runtimeAccountId, signal });
                }
                case 'machines.terminal.write': {
                    const { machineId, serverId, ...request } = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                    try {
                        return await machineTerminalStreamSendInput(machineId, request, { serverId, accountId: context.runtimeAccountId, signal });
                    } catch (error) {
                        if (readRpcRequestDisposition(error) !== 'notSent') throw error;
                        const errorCode = readRpcErrorCode(error) ?? 'terminal_input_failed';
                        return { ok: false, errorCode, error: error instanceof Error ? error.message : errorCode, effectAttempted: false };
                    }
                }
                case 'machines.terminal.close': {
                    const { machineId, serverId, ...request } = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                    return await machineTerminalClose(machineId, request, { serverId, accountId: context.runtimeAccountId, signal });
                }
                case 'machines.terminal.restart': {
                    const { machineId, serverId, ...request } = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                    return await machineTerminalRestart(machineId, request, { serverId, accountId: context.runtimeAccountId, signal });
                }
            }
        },
    };
}
