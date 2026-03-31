import type { SystemTaskSpec } from '@happier-dev/protocol';
import { buildSshTarget, parseSshTarget } from '@happier-dev/cli-common/systemTasks';

export type RemoteSshPromptResolution = Readonly<{
    hostTrust?: Readonly<{
        kind: 'ssh.trustHost' | 'ssh.replaceHostKey';
        fingerprint: string;
        existingFingerprint?: string | null;
    }>;
    authApproval?: Readonly<{
        publicKey: string;
    }>;
}>;

export function buildRemoteSshBootstrapMachineSystemTaskSpec(params: Readonly<{
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
    sshTarget?: string;
    sshUsername?: string;
    sshHost?: string;
    sshPort?: string;
    sshAuth: 'agent' | 'keyfile' | 'password';
    sshConfigFilePath?: string;
    identityFilePath?: string;
    installRelayRuntime?: boolean;
    promptResolution?: RemoteSshPromptResolution;
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

    return {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
            ssh: {
                target,
                ...(Number.isInteger(port) && port > 0 ? { port } : {}),
                auth: params.sshAuth,
                ...(params.sshAuth === 'keyfile' && params.identityFilePath?.trim()
                    ? { identityFile: params.identityFilePath.trim() }
                    : {}),
                ...(params.sshConfigFilePath?.trim()
                    ? { sshConfigFile: params.sshConfigFilePath.trim() }
                    : {}),
            },
            relay: {
                relayUrl: params.relayUrl.trim(),
                webappUrl: (params.webappUrl ?? params.relayUrl).trim(),
                ...(params.publicRelayUrl?.trim()
                    ? { publicRelayUrl: params.publicRelayUrl.trim() }
                    : {}),
            },
            serviceMode: 'user',
            knownHostsMode: 'app',
            ...(params.installRelayRuntime === true
                ? {
                    relayRuntime: {
                        enabled: true,
                        mode: 'user',
                    },
                }
                : {}),
            ...(hasPromptResolution(params.promptResolution)
                ? { promptResolution: params.promptResolution }
                : {}),
        },
    };
}

function hasPromptResolution(value: RemoteSshPromptResolution | undefined): value is RemoteSshPromptResolution {
    return Boolean(value && (value.hostTrust || value.authApproval));
}
