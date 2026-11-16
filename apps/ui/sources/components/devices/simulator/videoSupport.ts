import { resolveBrowserLiveStreamWebCodecsSupport } from '@/sync/domains/machines/peer/mediation/stream/webCodecs';
import type { SimulatorPreviewStreamState } from '@/sync/domains/devices/simulator/types';

/**
 * Why this browser cannot play the device's video, or null when it can. H.264 plays through the
 * browser's video decoder (the same support check the player's decoder runs), so its absence is a
 * typed cause rather than a blank player.
 */
export function resolveSimulatorVideoUnsupportedReason(stream: Pick<SimulatorPreviewStreamState, 'selectedCodec'>): string | null {
    if (stream.selectedCodec !== 'h264.avcc') return null;
    const support = resolveBrowserLiveStreamWebCodecsSupport();
    return support.ok ? null : support.reasonCode;
}
