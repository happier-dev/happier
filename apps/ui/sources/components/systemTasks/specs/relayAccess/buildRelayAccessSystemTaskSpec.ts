import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayAccessConfig, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { buildRelayAccessTailscaleSecureAccessSystemTaskSpec as buildTailscaleSecureAccessRelayAccessSystemTaskSpec } from './buildRelayAccessTailscaleSecureAccessSystemTaskSpec';

const DEFAULT_RELAY_ACCESS_TARGET: RelayAccessTaskTarget = {
    kind: 'local',
};

function resolveRelayAccessTarget(target?: RelayAccessTaskTarget): RelayAccessTaskTarget {
    return target ?? DEFAULT_RELAY_ACCESS_TARGET;
}

function serializeRelayAccessTarget(target?: RelayAccessTaskTarget): Readonly<{
    kind: 'local';
}> | Readonly<{
    kind: 'ssh';
    ssh: Record<string, string | number | boolean | null | undefined>;
}> {
    const resolved = resolveRelayAccessTarget(target);
    if (resolved.kind === 'local') {
        return { kind: 'local' };
    }
    return {
        kind: 'ssh',
        ssh: { ...resolved.ssh },
    };
}

export function buildRelayAccessStatusSystemTaskSpec(params: Readonly<{
    target?: RelayAccessTaskTarget;
}> = {}): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.status.v1',
        params: {
            target: serializeRelayAccessTarget(params.target),
        },
    };
}

export function buildRelayAccessDisableSystemTaskSpec(params: Readonly<{
    target?: RelayAccessTaskTarget;
}> = {}): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.disable.v1',
        params: {
            target: serializeRelayAccessTarget(params.target),
        },
    };
}

export function buildRelayAccessConfigureSystemTaskSpec(params: Readonly<{
    target?: RelayAccessTaskTarget;
    providerId: RelayAccessProviderId;
    config: RelayAccessConfig;
    upstreamUrl?: string | null;
}>): SystemTaskSpec {
    const upstreamUrl = typeof params.upstreamUrl === 'string' ? params.upstreamUrl.trim() : '';
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.configure.v1',
        params: {
            target: serializeRelayAccessTarget(params.target),
            ...(upstreamUrl ? { upstreamUrl } : {}),
            providerId: params.providerId,
            config: params.config,
        },
    };
}

export function buildRelayAccessExecutionSystemTaskSpec(params: Readonly<{
    target?: RelayAccessTaskTarget;
    providerId: RelayAccessProviderId;
    config: RelayAccessConfig;
    upstreamUrl?: string | null;
}>): SystemTaskSpec {
    const target = params.target ?? { kind: 'local' as const };
    if (target.kind !== 'ssh' && (params.providerId === 'tailscaleServe' || params.providerId === 'tailscaleFunnel')) {
        return buildTailscaleSecureAccessRelayAccessSystemTaskSpec({
            providerId: params.providerId,
            upstreamUrl: params.upstreamUrl ?? '',
        });
    }

    return buildRelayAccessConfigureSystemTaskSpec(params);
}
