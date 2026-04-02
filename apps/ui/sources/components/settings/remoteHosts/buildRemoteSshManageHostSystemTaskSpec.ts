import type { SystemTaskSpec } from '@happier-dev/protocol';
import { buildSshTarget, parseSshTarget } from '@happier-dev/protocol';

export function buildRemoteSshManageHostSystemTaskSpec(params: Readonly<{
    action:
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
        | 'relayRuntime.restart';
    sshTarget?: string;
    sshUsername?: string;
    sshHost?: string;
    sshPort?: string;
    sshAuth: 'agent' | 'keyfile' | 'password';
    sshPassword?: string;
    sshConfigFilePath?: string;
    identityFilePath?: string;
    identityPrivateKey?: string;
    knownHostsMode?: 'app' | 'system';
    serviceMode?: 'user' | 'none';
    channel: 'stable' | 'preview' | 'dev';
    relayRuntime?: Readonly<{
        channel?: 'stable' | 'preview' | 'dev';
        mode?: 'user' | 'system';
    }>;
}>): SystemTaskSpec {
    const parsedTarget = parseSshTarget(params.sshTarget ?? '');
    const username = String(params.sshUsername ?? parsedTarget.username ?? '').trim();
    const host = String(params.sshHost ?? parsedTarget.host ?? '').trim();
    const portText = String(params.sshPort ?? '').trim();
    const target = buildSshTarget({
        username,
        host,
    });
    const port = portText ? Number.parseInt(portText, 10) : Number.NaN;
    const password = String(params.sshPassword ?? '').trim();
    const identityPrivateKey = String(params.identityPrivateKey ?? '').trim();
    const identityFile = String(params.identityFilePath ?? '').trim();

    return {
        protocolVersion: 1,
        kind: 'remote.ssh.manageHost.v1',
        params: {
            action: params.action,
            channel: params.channel,
            ssh: {
                target,
                ...(Number.isInteger(port) && port > 0 ? { port } : {}),
                auth: params.sshAuth,
                ...(params.sshAuth === 'keyfile' && identityFile
                    ? { identityFile }
                    : (params.sshAuth === 'keyfile' && identityPrivateKey
                        ? { identityPrivateKey }
                        : {})),
                ...(params.sshAuth === 'password' && password
                    ? { password }
                    : {}),
                ...(params.sshConfigFilePath?.trim()
                    ? { sshConfigFile: params.sshConfigFilePath.trim() }
                    : {}),
            },
            knownHostsMode: params.knownHostsMode === 'system' ? 'system' : 'app',
            serviceMode: params.serviceMode === 'none' ? 'none' : 'user',
            ...(params.relayRuntime
                ? {
                    relayRuntime: {
                        channel: params.relayRuntime.channel === 'preview' || params.relayRuntime.channel === 'dev'
                            ? params.relayRuntime.channel
                            : 'stable',
                        mode: params.relayRuntime.mode === 'system' ? 'system' : 'user',
                    },
                }
                : {}),
        },
    };
}
