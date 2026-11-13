import { SYSTEM_TASK_PROTOCOL_VERSION, SystemTaskJsonValueSchema, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { SSH_TUNNEL_SYSTEM_TASK_KINDS, type SshTunnelEnsureRequest } from '@happier-dev/protocol/ssh/tunnels';

export const REMOTE_HOST_SSH_TUNNEL_REMOTE_HOST = '127.0.0.1';
export const REMOTE_HOST_SSH_TUNNEL_REMOTE_PORT = 3005;

export function buildSshTunnelEnsureSystemTaskSpec(request: SshTunnelEnsureRequest): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure,
        params: SystemTaskJsonValueSchema.parse(request),
    };
}

export function buildSshTunnelListSystemTaskSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: SSH_TUNNEL_SYSTEM_TASK_KINDS.list,
        params: {},
    };
}

export function buildSshTunnelReleaseSystemTaskSpec(leaseId: string): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: SSH_TUNNEL_SYSTEM_TASK_KINDS.release,
        params: { leaseId },
    };
}

export function buildSshTunnelStopSystemTaskSpec(tunnelKey: string): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: SSH_TUNNEL_SYSTEM_TASK_KINDS.stop,
        params: { tunnelKey },
    };
}
