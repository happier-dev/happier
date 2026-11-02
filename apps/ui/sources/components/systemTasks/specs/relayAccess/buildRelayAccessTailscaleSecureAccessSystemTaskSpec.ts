import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { createTailscaleSecureAccessTaskSpec } from '@happier-dev/protocol/system/tasks/tailscaleSecureAccessTaskContract';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { serializeRelayAccessTaskTarget } from './serializeRelayAccessTaskTarget';

export function buildRelayAccessTailscaleSecureAccessSystemTaskSpec(params: Readonly<{
    upstreamUrl: string;
    providerId: string;
    target?: RelayAccessTaskTarget;
}>): SystemTaskSpec {
    if (params.providerId !== 'tailscaleServe' && params.providerId !== 'tailscaleFunnel') {
        throw new Error('invalid_tailscale_secure_access_provider');
    }
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        ...createTailscaleSecureAccessTaskSpec({
            upstreamUrl: params.upstreamUrl,
            providerId: params.providerId,
            servePath: '/',
            installPolicy: 'installIfMissing',
            loginPolicy: 'interactive',
            mode: 'normalUser',
            target: serializeRelayAccessTaskTarget(params.target),
        }),
    };
}
