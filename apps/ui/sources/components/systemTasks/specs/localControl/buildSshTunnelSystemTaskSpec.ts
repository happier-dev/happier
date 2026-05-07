import {
    SYSTEM_TASK_PROTOCOL_VERSION,
    SystemTaskJsonValueSchema,
    type SshTunnelEnsureRequest,
    type SystemTaskSpec,
} from '@happier-dev/protocol';

export const REMOTE_HOST_SSH_TUNNEL_REMOTE_HOST = '127.0.0.1';
export const REMOTE_HOST_SSH_TUNNEL_REMOTE_PORT = 3005;

export function buildSshTunnelEnsureSystemTaskSpec(request: SshTunnelEnsureRequest): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'daemon.sshTunnel.ensure.v1',
        params: SystemTaskJsonValueSchema.parse(request),
    };
}

export function buildSshTunnelListSystemTaskSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'daemon.sshTunnel.list.v1',
        params: {},
    };
}

export function buildSshTunnelReleaseSystemTaskSpec(leaseId: string): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'daemon.sshTunnel.release.v1',
        params: { leaseId },
    };
}

export function buildSshTunnelStopSystemTaskSpec(tunnelKey: string): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'daemon.sshTunnel.stop.v1',
        params: { tunnelKey },
    };
}
