import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { startPairingForHome } from '@/auth/pairing/startPairingForHome';
import { buildMachineAddCommand, resolveWebDesktopSetupHandoffTarget } from '@/components/machines/add/machineAddCommand';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { machineTerminalEnsure, machineTerminalList } from '@/sync/ops/machineTerminal';
import { captureLazyActionAccountContext } from './actionAccountContext';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { createMachineAddSshTaskAction } from '@/components/machines/add/machineAddSshTaskAction';

export function createMachineConnectionActionDeps(options: Readonly<{ runner?: SystemTaskRunner }> = {}): Pick<ActionExecutorDeps, 'homeConnect' | 'machineAddCommand' | 'machinePairingCreate' | 'machineTerminalOpen' | 'machineTerminalList' | 'machineAddSshTaskAction'> {
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
        machineTerminalOpen: async ({ machineId, serverId, signal, ...request }) =>
            await machineTerminalEnsure(machineId, request, { serverId, signal }),
        machineTerminalList: async ({ machineId, serverId, signal }) =>
            await machineTerminalList(machineId, { serverId, signal }),
    };
}
