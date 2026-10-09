import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { startPairingForHome } from '@/auth/pairing/startPairingForHome';
import { buildMachineAddCommand, resolveWebDesktopSetupHandoffTarget } from '@/components/machines/add/machineAddCommand';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById } from '@/sync/domains/server/serverProfiles';
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

export function createMachineConnectionActionDeps(options: Readonly<{ runner?: SystemTaskRunner; account?: LazyActionAccountContext }> = {}): Pick<ActionExecutorDeps, 'homeConnect' | 'machineAddCommand' | 'machinePairingCreate' | 'machineTerminalAction' | 'machineAddSshTaskAction'> {
    return {
        machineAddSshTaskAction: createMachineAddSshTaskAction(options.runner),
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
            if ((actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart')
                && options.account && !context.externalActionCredential && !context.externalActionExecutionAuthorization
                && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host')) {
                const account = options.account;
                const request = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(input);
                if (!areServerProfileIdentifiersEquivalent(account.serverId, request.serverId)
                    || context.surface !== 'ui' || context.authority !== 'present_user'
                    || !context.actionRequestId || !canUsePrivateProjectAccountAction(account, context)) {
                    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                }
                const requestId = context.actionRequestId;
                const execution = await trackPendingMachineTerminalCreation(request.machineId, request.terminalKey,
                    () => executeOriginalAccountMachineAction({ account, actionId,
                        input: { ...request, serverId: account.serverId }, machineId: request.machineId,
                        requestId, foreignTargetOnly: true, ...(signal ? { signal } : {}) }),
                    { serverId: account.serverId, accountId: account.accountId, signal });
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
                    return await machineTerminalStreamSendInput(machineId, request, { serverId, accountId: context.runtimeAccountId, signal });
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
