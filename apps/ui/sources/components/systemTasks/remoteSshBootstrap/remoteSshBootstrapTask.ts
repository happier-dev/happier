import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskRunState, SystemTaskRunner } from '../types';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { buildRemoteSshManageHostSystemTaskSpec } from '../specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { buildRemoteSshBootstrapMachineSystemTaskSpec, type RemoteSshPromptResolution } from './buildRemoteSshBootstrapMachineSystemTaskSpec';
import type { RemoteSshBootstrapFormState, RemoteSshBootstrapPrompt } from './useRemoteSshBootstrapTask';

export type RemoteSshTaskTarget = Readonly<{
    runner: SystemTaskRunner; relayUrl: string; homeTarget?: ResolvedHomeTarget;
    webappUrl?: string; publicRelayUrl?: string; serviceMode?: 'user' | 'none';
    intent?: 'machineSetup' | 'personalHome.create';
    startSpec?: (spec: SystemTaskSpec) => Promise<string>;
}>;

/** One imperative task producer for the hook and the Action client. */
export async function startRemoteSshBootstrapTask(options: RemoteSshTaskTarget, form: RemoteSshBootstrapFormState, promptResolution: RemoteSshPromptResolution = {}): Promise<string> {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    const ssh = { sshUsername: form.sshUsername, sshHost: form.sshHost, sshPort: form.sshPort, sshAuth: form.sshAuth,
        sshPassword: form.sshPassword, identityFilePath: form.identityFilePath,
        identityPrivateKey: form.sshAuth === 'keyfile' ? form.identityPrivateKey : undefined };
    const startSpec = options.startSpec ?? ((spec: SystemTaskSpec) => options.runner.start(spec));
    return startSpec(options.intent === 'personalHome.create'
        ? buildRemoteSshManageHostSystemTaskSpec({ ...ssh, action: 'personalHome.create', channel,
            relayRuntime: { channel, mode: 'user' }, pairDevice: true, enrollInvokingClient: true, serviceMode: 'none' })
        : buildRemoteSshBootstrapMachineSystemTaskSpec({ ...ssh, relayUrl: options.relayUrl, webappUrl: options.webappUrl,
            publicRelayUrl: options.publicRelayUrl, homeTarget: options.homeTarget, serviceMode: options.serviceMode,
            channel, installRelayRuntime: form.installRelayRuntime, promptResolution }));
}

/** Preserves native live responses and desktop prompt-resolution restarts. */
export async function continueRemoteSshBootstrapTask(params: Readonly<{
    options: RemoteSshTaskTarget; form: RemoteSshBootstrapFormState; taskId: string;
    snapshot: SystemTaskRunState | null; prompt: RemoteSshBootstrapPrompt;
    resolution: RemoteSshPromptResolution; accept?: boolean;
}>): Promise<Readonly<{ taskId: string; resolution: RemoteSshPromptResolution }>> {
    const { options, form, taskId, snapshot, prompt } = params;
    const accepted = params.accept ?? true;
    if (prompt.kind === 'ssh.password') throw new Error('SSH password prompts require the present-user password owner.');
    if (prompt.kind === 'daemon.replaceRemoteBackgroundServices' || prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        await options.runner.respond(taskId, prompt.kind === 'daemon.replaceRemoteBackgroundServices'
            ? { replaceExistingServices: accepted } : { switchDefaultReleaseChannel: accepted });
        return { taskId, resolution: params.resolution };
    }
    if (!accepted) {
        await options.runner.cancel(taskId);
        return { taskId, resolution: params.resolution };
    }
    if ((options.runner.mode === 'native' || options.intent === 'personalHome.create') && snapshot?.result == null) {
        await options.runner.respond(taskId, prompt.kind === 'auth.approveRemoteProvisioning' ? { approved: true } : { trusted: true });
        return { taskId, resolution: params.resolution };
    }
    const resolution: RemoteSshPromptResolution = prompt.kind === 'auth.approveRemoteProvisioning'
        ? { ...params.resolution, ...(prompt.publicKey ? { authApproval: { publicKey: prompt.publicKey } } : {}) }
        : { ...params.resolution, hostTrust: { kind: prompt.kind, fingerprint: prompt.fingerprint,
            ...(prompt.kind === 'ssh.replaceHostKey' ? { existingFingerprint: prompt.existingFingerprint } : {}) } };
    if (snapshot?.result == null) await options.runner.cancel(taskId).catch(() => {});
    return { taskId: await startRemoteSshBootstrapTask(options, form, resolution), resolution };
}
