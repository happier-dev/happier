import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

type LocalRelayRuntimeTaskKind =
    | 'relay.runtime.status.v1'
    | 'relay.runtime.installOrUpdate.v1'
    | 'relay.runtime.start.v1'
    | 'relay.runtime.stop.v1';

const LOCAL_RELAY_RUNTIME_PARAMS = {
    target: { kind: 'local' as const },
    channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
    mode: 'user' as const,
};

export function buildLocalRelayRuntimeSystemTaskSpec(kind: LocalRelayRuntimeTaskKind): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind,
        params: LOCAL_RELAY_RUNTIME_PARAMS,
    };
}
