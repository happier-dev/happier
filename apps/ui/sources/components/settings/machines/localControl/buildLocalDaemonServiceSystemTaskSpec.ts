import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

type LocalDaemonServiceTaskKind =
    | 'daemon.service.status.v1'
    | 'daemon.service.start.v1';

const LOCAL_DAEMON_SERVICE_PARAMS = {
    target: { kind: 'local' as const },
    surface: 'desktop.ui' as const,
    mode: 'user' as const,
};

export function buildLocalDaemonServiceSystemTaskSpec(kind: LocalDaemonServiceTaskKind): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind,
        params: LOCAL_DAEMON_SERVICE_PARAMS,
    };
}
