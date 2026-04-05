import type { SystemTaskSpec } from '@happier-dev/protocol';

import { buildRelayAccessTailscaleSecureAccessSystemTaskSpec } from '@/components/systemTasks/specs/relayAccess/buildRelayAccessTailscaleSecureAccessSystemTaskSpec';

export function buildLocalTailscaleSecureAccessSystemTaskSpec(params: Readonly<{
    upstreamUrl: string;
    providerId?: 'tailscaleServe' | 'tailscaleFunnel';
}>): SystemTaskSpec {
    return buildRelayAccessTailscaleSecureAccessSystemTaskSpec({
        upstreamUrl: params.upstreamUrl,
        providerId: params.providerId ?? 'tailscaleServe',
    });
}
