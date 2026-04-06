import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

export type SerializedRelayAccessTaskTarget =
    | Readonly<{ kind: 'local' }>
    | Readonly<{
        kind: 'ssh';
        ssh: Readonly<{
            target: string;
            auth: 'agent' | 'keyfile' | 'password';
            port?: number;
            identityFile?: string;
            password?: string;
            sshConfigFile?: string;
            knownHostsPath?: string;
            trustedHostKey?: string;
        }>;
    }>;

export function serializeRelayAccessTaskTarget(target?: RelayAccessTaskTarget): SerializedRelayAccessTaskTarget {
    if (!target || target.kind === 'local') {
        return { kind: 'local' };
    }

    return {
        kind: 'ssh',
        ssh: {
            target: String(target.ssh.target ?? '').trim(),
            auth: target.ssh.auth,
            ...(typeof target.ssh.port === 'number' && Number.isFinite(target.ssh.port)
                ? { port: Math.trunc(target.ssh.port) }
                : {}),
            ...(typeof target.ssh.identityFile === 'string' && target.ssh.identityFile.trim()
                ? { identityFile: target.ssh.identityFile.trim() }
                : {}),
            ...(typeof target.ssh.password === 'string' && target.ssh.password.length > 0
                ? { password: target.ssh.password }
                : {}),
            ...(typeof target.ssh.sshConfigFile === 'string' && target.ssh.sshConfigFile.trim()
                ? { sshConfigFile: target.ssh.sshConfigFile.trim() }
                : {}),
            ...(typeof target.ssh.knownHostsPath === 'string' && target.ssh.knownHostsPath.trim()
                ? { knownHostsPath: target.ssh.knownHostsPath.trim() }
                : {}),
            ...(typeof target.ssh.trustedHostKey === 'string' && target.ssh.trustedHostKey.trim()
                ? { trustedHostKey: target.ssh.trustedHostKey.trim() }
                : {}),
        },
    };
}
