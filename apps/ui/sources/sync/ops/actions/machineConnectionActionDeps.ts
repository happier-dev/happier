import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { startPairingForHome } from '@/auth/pairing/startPairingForHome';
import { buildMachineAddCommand, resolveWebDesktopSetupHandoffTarget } from '@/components/machines/add/machineAddCommand';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById, getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { retryActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { machineTerminalEnsure, machineTerminalList, machineTerminalStreamReadBytes, machineTerminalStreamSendInput, machineTerminalClose, machineTerminalRestart, trackPendingMachineTerminalCreation } from '@/sync/ops/machineTerminal';
import { MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { canUsePrivateProjectAccountAction } from '@/sync/api/projects/projectAccountRowsClient';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { createMachineAddSshTaskAction } from '@/components/machines/add/machineAddSshTaskAction';
import { createLocalDaemonServiceAction } from './localDaemonServiceAction';
import { MachineCapabilityInstallInputSchema, MachineMetadataUpdateInputSchema, MachineReplacementSetInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { readCurrentMachineUpdateItem } from '@/updates/updatesActionRuntime';
import { runMachineItemUpdate } from '@/updates/machineUpdateRuns';
import { machineStopDaemon, machineUpdateMetadata } from '@/sync/ops/machines';
import { machineRevokeWithProviderCleanup, machineReplaceInAccount, machineClearReplacementFromAccount } from '@/sync/ops/machineAccount';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

export function createMachineConnectionActionDeps(options: Readonly<{ runner?: SystemTaskRunner; account?: LazyActionAccountContext }> = {}): Pick<ActionExecutorDeps, 'homeConnect' | 'homeReconnect' | 'localDaemonServiceAction' | 'machineAddCommand' | 'machinePairingCreate' | 'machineTerminalAction' | 'machineAddSshTaskAction' | 'machinePageAction'> {
    return {
        machinePageAction: async ({ actionId, input, context }) => {
            const serverId = input.serverId ?? context.serverId ?? getActiveServerId();
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
                return machineStopDaemon(input.machineId, { serverId, signal: context.signal });
            }
            if (actionId === 'machines.capabilities.install') {
                const request = MachineCapabilityInstallInputSchema.parse(input);
                const item = request.method === 'upgrade' ? readCurrentMachineUpdateItem(scope, request.machineId,
                    { kind: 'installable', capabilityId: request.capabilityId }) : null;
                if (item) {
                    if (item.action.kind !== 'run') return { ok: false, errorCode: 'update_target_unavailable', error: 'update_target_unavailable' };
                    return await runMachineItemUpdate(item, { scope }) ?? { ok: false, errorCode: 'update_target_unavailable', error: 'update_target_unavailable' };
                }
                return machineCapabilitiesInvoke(request.machineId, { id: request.capabilityId, method: request.method },
                    { serverId, accountId: scope.accountId, timeoutMs: 5 * 60_000, signal: context.signal });
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
            const { displayName, windowsRemoteSessionLaunchMode } = request.patch;
            if (windowsRemoteSessionLaunchMode !== undefined && machine.metadata.platform !== 'win32') {
                return { ok: false, errorCode: 'machine_platform_mismatch', error: 'machine_platform_mismatch' };
            }
            const { windowsRemoteSessionLaunchMode: _priorMode, windowsRemoteSessionConsole: _legacy, ...metadataWithoutMode } = machine.metadata;
            const metadata = windowsRemoteSessionLaunchMode === undefined ? machine.metadata : metadataWithoutMode;
            const result = await machineUpdateMetadata(request.machineId, {
                ...metadata,
                ...(displayName !== undefined ? { displayName: displayName?.trim() || undefined } : {}),
                ...(windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode } : {}),
            }, request.expectedVersion ?? machine.metadataVersion);
            return { version: result.version };
        },
        machineAddSshTaskAction: createMachineAddSshTaskAction(options.runner),
        localDaemonServiceAction: createLocalDaemonServiceAction(options),
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
            const outcome = await connectHomeAtAddress({ serverUrl: input.address, displayName: input.displayName,
                signal: context.signal, confirmInsecureHttp: async () => input.acceptInsecureHttp,
                confirmCanonicalUrl: async () => input.acceptCanonicalUrl,
            });
            if (outcome.kind === 'connected') return { kind: 'connected', serverId: outcome.profile.id,
                serverUrl: outcome.profile.serverUrl, name: outcome.profile.name };
            if (outcome.kind === 'identity_mismatch') return {
                ok: false, errorCode: 'home_identity_mismatch', error: 'The address answered as a different Home.',
            };
            if (outcome.kind === 'unreachable') return { kind: 'unreachable' };
            return outcome;
        },
        machineAddCommand: async (input) => {
            const profile = getServerProfileById(input.serverId);
            if (!profile) return { ok: false, errorCode: 'target_unavailable', error: 'Home not found' };
            const policy = resolveSetupSurfacePolicy().machine;
            if (input.method === 'ssh' ? !policy.allowRemoteSshMachineSetup : !policy.allowLocalMachineSetup) {
                return { ok: false, errorCode: 'machine_setup_unavailable', error: 'Machine setup is unavailable' };
            }
            const target = { descriptor: buildHomeConnectionDescriptorForProfile(profile), profileSource: profile.source ?? null, fallbackHomeUrl: profile.serverUrl };
            const command = buildMachineAddCommand({ ...target, os: input.os, ...(input.method === 'ssh' ? {
                kind: 'sshMachine', sshDraft: { ...createDefaultSshCredentialsDraft(input.authMode), host: input.host,
                    username: input.username ?? '', port: input.port === undefined ? '' : String(input.port), identityFilePath: input.identityFilePath ?? '' },
            } : { kind: 'joinHome' }) });
            return { command, descriptorFileRequired: resolveWebDesktopSetupHandoffTarget(target).kind === 'descriptor_file_required' };
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
                const started = await startPairingForHome({ targetProfileId: account.serverId,
                    signal: context.signal ?? new AbortController().signal, isCurrent: account.accountLifetime.isCurrent });
                if (started.kind === 'started' && !account.accountLifetime.isCurrent()) await started.cancel();
                account.assertCurrent();
                if (started.kind === 'started') {
                    const retirement = account.accountLifetime.onRetire(() => { void started.cancel(); });
                    lifecycleOwnsAccount = true;
                    const release = () => { retirement.dispose(); account.dispose(); };
                    void started.completion.then(release, release);
                    return { pairId: started.invite.pairId, link: started.link, expiresAtMs: started.invite.expiresAtMs };
                }
                const errorCode = started.kind === 'failed' ? started.cause : started.kind;
                return { ok: false, errorCode, error: errorCode };
            } finally { if (!lifecycleOwnsAccount) account.dispose(); }
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
                const run = () => executeOriginalAccountMachineAction({ account, actionId,
                        input: { ...request, serverId: account.serverId }, machineId: request.machineId,
                        requestId, authority: context.authority ?? 'account_automation', foreignTargetOnly: true, ...(signal ? { signal } : {}) });
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
