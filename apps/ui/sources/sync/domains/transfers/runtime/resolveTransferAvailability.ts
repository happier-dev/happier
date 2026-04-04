import type { FeaturesResponse as ServerFeatures, SessionHandoffTransportStrategy } from '@happier-dev/protocol';
import { readServerEnabledBit } from '@happier-dev/protocol';

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

    const transferEnabled = readServerEnabledBit(features, 'machines.transfer') === true;
    if (!transferEnabled) {
        return {
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        };
    }

    const directPeerEnabled = readServerEnabledBit(features, 'machines.transfer.directPeer') === true;
    const serverRoutedEnabled = readServerEnabledBit(features, 'machines.transfer.serverRouted') === true;
    if (!directPeerEnabled && !serverRoutedEnabled) {
        return {
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        };
    }

    for (const strategy of input.preferredTransportStrategies) {
        if (strategy === 'direct_peer' && directPeerEnabled) {
            return {
                ok: true,
                negotiatedTransportStrategy: 'direct_peer',
                allowServerRoutedFallback: serverRoutedEnabled,
            };
        }
        if (strategy === 'server_routed_stream' && serverRoutedEnabled) {
            return {
                ok: true,
                negotiatedTransportStrategy: 'server_routed_stream',
                allowServerRoutedFallback: true,
            };
        }
    }

    if (serverRoutedEnabled) {
        return {
            ok: true,
            negotiatedTransportStrategy: 'server_routed_stream',
            allowServerRoutedFallback: true,
        };
    }

    return {
        ok: true,
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
    };
}
