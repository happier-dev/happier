import type { SimulatorPreviewStreamState } from '@/sync/domains/devices/simulator/types';

/** The native app plays H.264 through its own renderer, so the browser decoder never limits it. */
export function resolveSimulatorVideoUnsupportedReason(_stream: Pick<SimulatorPreviewStreamState, 'selectedCodec'>): string | null {
    return null;
}
