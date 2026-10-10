import type { SystemTaskSpec } from '@happier-dev/protocol';
import type { RemoteHostRecordV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { buildSshTunnelEnsureSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildSshTunnelSystemTaskSpec';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import type { RemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { getNativeSshTunnelRuntime, setNativeSshTunnelCredentialResolution } from '@/sync/runtime/nativeSshTunnels/runtime';
import { persistSavedRemoteHostAfterRemoteSshCompletion } from '@/components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion';
import { Modal } from '@/modal';
import { t } from '@/text';
import { buildRemoteHostBootstrapSystemTaskSpec, buildSshTunnelEnsureRequestFromRemoteHostConfig,
    buildNativeSshTunnelCredentialsFromRemoteHostConfig, buildNativeSshTunnelRequestFromRemoteHostConfig,
    buildRelayAccessSshTargetFromRemoteHostConfig } from './remoteHostOutcomeActions';

export type RemoteHostMaintenanceTaskAction = Parameters<typeof buildRemoteSshManageHostSystemTaskSpec>[0]['action'];
type TaskAdmission = Readonly<{ runner: SystemTaskRunner; config: RemoteHostEffectiveSshConfig;
    assertCurrent(): void; signal?: AbortSignal }>;
type TaskStarted = Readonly<{ status: 'task_started'; taskId: string }>;
type Unavailable = Readonly<{ status: 'unavailable'; reason: string }>;

export async function startAdmittedRemoteHostSystemTask(input: Pick<TaskAdmission, 'runner' | 'assertCurrent' | 'signal'>, spec: SystemTaskSpec): Promise<TaskStarted> {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const taskId = await input.runner.start(spec);
    try {
        input.signal?.throwIfAborted();
        input.assertCurrent();
    } catch (error) {
        await input.runner.cancel(taskId);
        throw error;
    }
    return { status: 'task_started', taskId };
}

/** Menus and Actions start the same admitted task; native trust remains runner-owned. */
export async function startRemoteHostMaintenanceTask(input: TaskAdmission & Readonly<{
    action: RemoteHostMaintenanceTaskAction;
}>): Promise<TaskStarted | Unavailable> {
    if (input.runner.mode !== 'tauri') return { status: 'unavailable', reason: 'remote_host_maintenance_unavailable' };
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    return startAdmittedRemoteHostSystemTask(input, buildRemoteSshManageHostSystemTaskSpec({
        action: input.action, channel,
        sshTarget: input.config.sshTarget, sshPort: input.config.sshPort ? String(input.config.sshPort) : '',
        sshAuth: input.config.sshAuth, identityFilePath: input.config.identityFilePath,
        identityPrivateKey: input.config.identityPrivateKey, sshConfigFilePath: input.config.sshConfigFilePath,
        sshPassword: input.config.password, knownHostsMode: 'app', serviceMode: 'user',
        relayRuntime: { channel, mode: 'user' },
    }));
}

export async function startRemoteHostSetupTask(input: TaskAdmission & Readonly<{
    scope: ServerAccountScope; host: RemoteHostRecordV1; expectedRevision: number | 'absent';
    remoteHostId: string; homeTarget: ResolvedHomeTarget; shareableServerUrl: string | null;
}>): Promise<TaskStarted | Unavailable> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, input.scope)) {
        return { status: 'unavailable', reason: 'action_account_scope_changed' };
    }
    const spec = buildRemoteHostBootstrapSystemTaskSpec(input);
    const started = await startAdmittedRemoteHostSystemTask(input, spec);
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let retirement: Readonly<{ dispose(): void }> | undefined;
    const release = () => { unsubscribe?.(); retirement?.dispose(); };
    const observe = () => {
        const result = input.runner.getSnapshot(started.taskId)?.result;
        if (!result || settled) return;
        settled = true;
        release();
        if (!result.ok || !lifetime.isCurrent()) return;
        const data = result.data;
        const completion = {
            machineId: data && typeof data === 'object' && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : null,
            relayRuntimeUrl: data && typeof data === 'object' && 'relayRuntimeUrl' in data && typeof data.relayRuntimeUrl === 'string' ? data.relayRuntimeUrl : null,
        };
        void persistSavedRemoteHostAfterRemoteSshCompletion({ scope: input.scope, host: input.host,
            expectedRevision: input.expectedRevision, completion, assertCurrent: () => {
                if (!lifetime.isCurrent()) throw new Error('action_account_scope_changed');
            } }).then(outcome => {
                if (!outcome.ok && lifetime.isCurrent()) Modal.alert(t('common.error'), t('settings.remoteHostsSetupAsMachineFailed'));
            }, () => {
                if (lifetime.isCurrent()) Modal.alert(t('common.error'), t('settings.remoteHostsSetupAsMachineFailed'));
            });
    };
    unsubscribe = input.runner.subscribe(started.taskId, observe);
    retirement = lifetime.onRetire(() => {
        release();
        void input.runner.cancel(started.taskId).catch(() => undefined);
    });
    observe();
    if (settled) release();
    return started;
}

export async function connectRemoteHostFromDevice(input: TaskAdmission & Readonly<{
    remoteHostId: string; serverId: string;
}>): Promise<TaskStarted | Unavailable | Readonly<{ status: 'connected' }>> {
    input.assertCurrent();
    input.signal?.throwIfAborted();
    if (input.runner.mode === 'native') {
        const credentials = buildNativeSshTunnelCredentialsFromRemoteHostConfig(input.config);
        if (!credentials || input.runner.capabilities?.nativeSsh?.available !== true
            || input.runner.capabilities.nativeSsh.supportsLoopbackTunnel !== true) {
            return { status: 'unavailable', reason: 'native_ssh_tunnel_unavailable' };
        }
        const request = buildNativeSshTunnelRequestFromRemoteHostConfig(input);
        setNativeSshTunnelCredentialResolution(request.credentialsRef, credentials);
        const runtime = getNativeSshTunnelRuntime();
        const lease = await runtime.ensureTunnel(request);
        try {
            input.signal?.throwIfAborted();
            input.assertCurrent();
        } catch (error) {
            await runtime.releaseTunnel(lease.leaseId);
            throw error;
        }
        return { status: 'connected' };
    }
    if (input.runner.mode !== 'tauri') return { status: 'unavailable', reason: 'remote_host_connection_unavailable' };
    return startAdmittedRemoteHostSystemTask(input, buildSshTunnelEnsureSystemTaskSpec(buildSshTunnelEnsureRequestFromRemoteHostConfig({
        ...input, serverId: input.serverId,
    })));
}

/** This target is transient task input, never a durable catalog or Action observation. */
export function resolveRemoteHostRelayAccess(input: Readonly<{
    config: RemoteHostEffectiveSshConfig; homeTarget: ResolvedHomeTarget;
}>) {
    const target = buildRelayAccessSshTargetFromRemoteHostConfig(input.config);
    return target ? { status: 'relay_ready' as const, target,
        upstreamUrl: input.homeTarget.canonicalAuthUrl }
        : { status: 'unavailable' as const, reason: 'relay_access_identity_file_required' };
}
