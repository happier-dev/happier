import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { getRelayAccessProviderDescriptor, parseRelayAccessConfig, type RelayAccessConfig } from '@happier-dev/cli-common/relayAccess/catalog';
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
    config: RelayAccessConfig;
    upstreamUrl?: string | null;
}>): SystemTaskSpec {
    const upstreamUrl = typeof params.upstreamUrl === 'string' ? params.upstreamUrl.trim() : '';
    const config = parseRelayAccessConfig(params.config);
    if (!config) throw new Error('invalid_access_provider_selection');
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.access.configure.v1',
        params: {
            target: serializeRelayAccessTaskTarget(params.target),
            ...(upstreamUrl ? { upstreamUrl } : {}),
            config,
        },
    };
}

export function buildRelayAccessExecutionSystemTaskSpec(params: Readonly<{
    target?: RelayAccessTaskTarget;
    config: RelayAccessConfig;
    upstreamUrl?: string | null;
}>): SystemTaskSpec {
    const target = params.target ?? { kind: 'local' as const };
    const config = parseRelayAccessConfig(params.config);
    if (!config) throw new Error('invalid_access_provider_selection');
    const descriptor = getRelayAccessProviderDescriptor(config.provider);
    if (descriptor.homeSetupTaskKind === 'secureAccess.tailscale.v1') {
        return buildTailscaleSecureAccessRelayAccessSystemTaskSpec({
            providerId: descriptor.id,
            upstreamUrl: params.upstreamUrl ?? '',
            target,
        });
    }

    return buildRelayAccessConfigureSystemTaskSpec({ ...params, config });
}
