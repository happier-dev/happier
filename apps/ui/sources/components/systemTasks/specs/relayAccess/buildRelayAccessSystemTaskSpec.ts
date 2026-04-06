import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayAccessConfig, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { buildRelayAccessTailscaleSecureAccessSystemTaskSpec as buildTailscaleSecureAccessRelayAccessSystemTaskSpec } from './buildRelayAccessTailscaleSecureAccessSystemTaskSpec';
import { serializeRelayAccessTaskTarget } from './serializeRelayAccessTaskTarget';

export function buildRelayAccessStatusSystemTaskSpec(params: Readonly<{
    target?: RelayAccessTaskTarget;
}> = {}): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.status.v1',
        params: {
            target: serializeRelayAccessTaskTarget(params.target),
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
            target: serializeRelayAccessTaskTarget(params.target),
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
            target: serializeRelayAccessTaskTarget(params.target),
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
    if (params.providerId === 'tailscaleServe' || params.providerId === 'tailscaleFunnel') {
        return buildTailscaleSecureAccessRelayAccessSystemTaskSpec({
            providerId: params.providerId,
            upstreamUrl: params.upstreamUrl ?? '',
            target,
        });
    }

    return buildRelayAccessConfigureSystemTaskSpec(params);
}
