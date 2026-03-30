import type { SystemTaskSpec } from '@happier-dev/protocol';

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
    sshTarget: string;
    sshAuth: 'agent' | 'keyfile';
    identityFilePath?: string;
    installRelayRuntime?: boolean;
    promptResolution?: RemoteSshPromptResolution;
}>): SystemTaskSpec {
    return {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
            ssh: {
                target: params.sshTarget.trim(),
                auth: params.sshAuth,
                ...(params.sshAuth === 'keyfile' && params.identityFilePath?.trim()
                    ? { identityFile: params.identityFilePath.trim() }
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
