import type { FeaturesResponse as ServerFeatures, SessionHandoffTransportStrategy } from '@happier-dev/protocol';
import { resolveMachineTransferRoute } from '@happier-dev/transfers';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';

type SessionHandoffTransportError = Readonly<{
    ok: false;
    errorCode: string;
    errorMessage: string;
}>;

type SessionHandoffTransportAvailability = Readonly<{
    ok: true;
    negotiatedTransportStrategy: SessionHandoffTransportStrategy;
    allowServerRoutedFallback: boolean;
}>;

function resolveServerFeaturesPayload(serverFeatures: unknown): ServerFeatures | null {
    const payload = (serverFeatures as { features?: unknown } | null)?.features;
    if (!payload || typeof payload !== 'object') return null;
    if (!('features' in payload) || !('capabilities' in payload)) return null;
    return payload as ServerFeatures;
}

export function resolveMachineTransferAvailability(input: Readonly<{
    serverFeatures: unknown;
    preferredTransportStrategies: readonly SessionHandoffTransportStrategy[];
}>): SessionHandoffTransportError | SessionHandoffTransportAvailability {
    const features = resolveServerFeaturesPayload(input.serverFeatures);
    if (!features) {
        return {
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        };
    }

    const handoffEnabled = readServerEnabledBit(features, 'sessions.handoff') === true;
    if (!handoffEnabled) {
        return {
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        };
    }

    const route = resolveMachineTransferRoute({
        serverFeatures: features,
        preferredStrategies: input.preferredTransportStrategies,
        directPeerAvailable: true,
    });
    if (route.kind === 'unavailable') {
        return {
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        };
    }

    return {
        ok: true,
        negotiatedTransportStrategy: route.strategy === 'server_relay_stream'
            ? 'server_routed_stream'
            : route.strategy,
        allowServerRoutedFallback: route.allowServerRoutedFallback,
    };
}
