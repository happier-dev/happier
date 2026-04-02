import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayAccessConfig, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess';

type LocalRelayAccessTaskKind =
    | 'relay.access.status.v1'
    | 'relay.access.configure.v1'
    | 'relay.access.disable.v1';

const LOCAL_RELAY_ACCESS_TARGET = {
    target: { kind: 'local' as const },
};

export function buildLocalRelayAccessStatusSystemTaskSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.status.v1',
        params: LOCAL_RELAY_ACCESS_TARGET,
    };
}

export function buildLocalRelayAccessDisableSystemTaskSpec(): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.disable.v1',
        params: LOCAL_RELAY_ACCESS_TARGET,
    };
}

export function buildLocalRelayAccessConfigureSystemTaskSpec(params: Readonly<{
    providerId: RelayAccessProviderId;
    config: RelayAccessConfig;
    upstreamUrl?: string | null;
}>): SystemTaskSpec {
    const upstreamUrlRaw = typeof params.upstreamUrl === 'string' ? params.upstreamUrl.trim() : '';
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.configure.v1',
        params: {
            ...LOCAL_RELAY_ACCESS_TARGET,
            ...(upstreamUrlRaw ? { upstreamUrl: upstreamUrlRaw } : {}),
            providerId: params.providerId,
            config: params.config,
        },
    };
}
