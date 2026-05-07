import type { ActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import type { RemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { buildRemoteSshBootstrapMachineSystemTaskSpec } from '@/components/systemTasks/remoteSshBootstrap/buildRemoteSshBootstrapMachineSystemTaskSpec';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { parseSshTarget, type SshTunnelEnsureRequest } from '@happier-dev/protocol';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { NativeSshTunnelRequest } from '@/sync/runtime/nativeSshTunnels/types';
import type { NativeSshTunnelCredentialResolution } from '@/sync/runtime/nativeSshTunnels/adapter';
import { isEncryptedPrivateKeyPem } from '@/components/ssh/isEncryptedPrivateKeyPem';
import {
    REMOTE_HOST_SSH_TUNNEL_REMOTE_HOST,
    REMOTE_HOST_SSH_TUNNEL_REMOTE_PORT,
} from '@/components/systemTasks/specs/localControl/buildSshTunnelSystemTaskSpec';

export type RemoteHostOutcomeActionId =
    | 'setupAsMachine'
    | 'connectFromThisDevice'
    | 'useAsRelayHost'
    | 'configureAccess'
    | 'openDetails';

export type RemoteHostMaintenanceActionId =
    | 'testConnection'
    | 'installOrUpdateCli'
    | 'daemonService.installOrUpdate'
    | 'daemonService.start'
    | 'daemonService.stop'
    | 'daemonService.restart'
    | 'relayRuntime.status'
    | 'relayRuntime.installOrUpdate'
    | 'relayRuntime.start'
    | 'relayRuntime.stop'
    | 'relayRuntime.restart'
    | 'edit'
    | 'remove';

export const pinnedRemoteHostOutcomeActionIds = [
    'setupAsMachine',
    'connectFromThisDevice',
    'useAsRelayHost',
    'configureAccess',
] satisfies RemoteHostOutcomeActionId[];

export function resolveRemoteHostBootstrapRelayUrls(activeServerSnapshot: ActiveServerSnapshot): Readonly<{
    relayUrl: string;
    webappUrl: string;
    publicRelayUrl: string | null;
}> | null {
    const shareableUrl = String(activeServerSnapshot.activeShareableServerUrl ?? '').trim();
    const serverUrl = String(activeServerSnapshot.serverUrl ?? '').trim();
    const relayUrl = shareableUrl || serverUrl;
    if (!relayUrl) return null;
    return {
        relayUrl,
        webappUrl: serverUrl || relayUrl,
        publicRelayUrl: shareableUrl || null,
    };
}

export function buildRemoteHostBootstrapSystemTaskSpec(params: Readonly<{
    remoteHostId: string;
    config: RemoteHostEffectiveSshConfig;
    activeServerSnapshot: ActiveServerSnapshot;
}>) {
    const relay = resolveRemoteHostBootstrapRelayUrls(params.activeServerSnapshot);
    if (!relay) return null;

    const spec = buildRemoteSshBootstrapMachineSystemTaskSpec({
        relayUrl: relay.relayUrl,
        webappUrl: relay.webappUrl,
        publicRelayUrl: relay.publicRelayUrl ?? undefined,
        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
        sshTarget: params.config.sshTarget,
        sshPort: params.config.sshPort ? String(params.config.sshPort) : '',
        sshAuth: params.config.sshAuth,
        identityFilePath: params.config.identityFilePath,
        identityPrivateKey: params.config.identityPrivateKey,
        sshConfigFilePath: params.config.sshConfigFilePath,
        sshPassword: params.config.password,
        serviceMode: 'user',
    });
    return {
        ...spec,
        params: {
            ...(spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {}),
            remoteHostId: params.remoteHostId,
        },
    };
}

export function buildRelayAccessSshTargetFromRemoteHostConfig(
    config: RemoteHostEffectiveSshConfig,
): RelayAccessTaskTarget | null {
    if (config.sshAuth === 'keyfile' && !config.identityFilePath) {
        return null;
    }

    return {
        kind: 'ssh',
        ssh: {
            target: config.sshTarget,
            ...(config.sshPort ? { port: config.sshPort } : {}),
            auth: config.sshAuth,
            ...(config.sshAuth === 'keyfile' && config.identityFilePath
                ? { identityFile: config.identityFilePath }
                : {}),
            ...(config.sshAuth === 'password' && config.password
                ? { password: config.password }
                : {}),
            ...(config.sshConfigFilePath ? { sshConfigFile: config.sshConfigFilePath } : {}),
        },
    };
}

export function buildSshTunnelEnsureRequestFromRemoteHostConfig(params: Readonly<{
    remoteHostId: string;
    serverId?: string | null;
    config: RemoteHostEffectiveSshConfig;
}>): SshTunnelEnsureRequest {
    return {
        remoteHostId: params.remoteHostId,
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ssh: {
            target: params.config.sshTarget,
            ...(params.config.sshPort ? { port: params.config.sshPort } : {}),
            auth: params.config.sshAuth,
            ...(params.config.sshAuth === 'keyfile' && params.config.identityFilePath
                ? { identityFile: params.config.identityFilePath }
                : {}),
            ...(params.config.sshAuth === 'password' && params.config.password
                ? { password: params.config.password }
                : {}),
            ...(params.config.sshConfigFilePath ? { sshConfigFile: params.config.sshConfigFilePath } : {}),
        },
        remoteHost: REMOTE_HOST_SSH_TUNNEL_REMOTE_HOST,
        remotePort: REMOTE_HOST_SSH_TUNNEL_REMOTE_PORT,
        purpose: 'remote-host-access',
    };
}

export function buildNativeSshTunnelRequestFromRemoteHostConfig(params: Readonly<{
    remoteHostId: string;
    config: RemoteHostEffectiveSshConfig;
}>): NativeSshTunnelRequest {
    return {
        remoteHostId: params.remoteHostId,
        sshTarget: params.config.sshTarget,
        ...(params.config.sshPort ? { sshPort: params.config.sshPort } : {}),
        destinationHost: REMOTE_HOST_SSH_TUNNEL_REMOTE_HOST,
        destinationPort: REMOTE_HOST_SSH_TUNNEL_REMOTE_PORT,
        purpose: 'server-http',
        credentialsRef: {
            remoteHostId: params.remoteHostId,
            credentialId: `remote-host:${params.remoteHostId}:ssh`,
            storage: 'session-memory',
        },
    };
}

export function buildNativeSshTunnelCredentialsFromRemoteHostConfig(
    config: RemoteHostEffectiveSshConfig,
): NativeSshTunnelCredentialResolution | null {
    const username = parseSshTarget(config.sshTarget).username.trim();
    if (!username) {
        return null;
    }
    if (config.sshAuth === 'password' && config.password) {
        return {
            auth: {
                username,
                password: config.password,
            },
        };
    }
    if (config.sshAuth === 'keyfile' && config.identityPrivateKey && !isEncryptedPrivateKeyPem(config.identityPrivateKey)) {
        return {
            auth: {
                username,
                privateKeyPem: config.identityPrivateKey,
            },
        };
    }
    return null;
}

export function buildSshCredentialsDraftFromRemoteHostConfig(
    config: RemoteHostEffectiveSshConfig,
): SshCredentialsDraft {
    const parsed = parseSshTarget(config.sshTarget);
    return {
        username: String(parsed.username ?? '').trim(),
        host: String(parsed.host ?? '').trim(),
        port: config.sshPort ? String(config.sshPort) : '',
        authMode: config.sshAuth,
        identityFilePath: config.identityFilePath,
        password: config.password,
    };
}
