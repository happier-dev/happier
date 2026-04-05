import type { SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayAccessConfig, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';

import {
    buildRelayAccessConfigureSystemTaskSpec,
    buildRelayAccessDisableSystemTaskSpec,
    buildRelayAccessStatusSystemTaskSpec,
} from '@/components/systemTasks/specs/relayAccess/buildRelayAccessSystemTaskSpec';

export function buildLocalRelayAccessStatusSystemTaskSpec(): SystemTaskSpec {
    return buildRelayAccessStatusSystemTaskSpec({ target: { kind: 'local' } });
}

export function buildLocalRelayAccessDisableSystemTaskSpec(): SystemTaskSpec {
    return buildRelayAccessDisableSystemTaskSpec({ target: { kind: 'local' } });
}

export function buildLocalRelayAccessConfigureSystemTaskSpec(params: Readonly<{
    providerId: RelayAccessProviderId;
    config: RelayAccessConfig;
    upstreamUrl?: string | null;
}>): SystemTaskSpec {
    return buildRelayAccessConfigureSystemTaskSpec({
        target: { kind: 'local' },
        providerId: params.providerId,
        config: params.config,
        upstreamUrl: params.upstreamUrl,
    });
}
