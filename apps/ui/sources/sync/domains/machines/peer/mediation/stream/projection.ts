import type { MachineLiveStreamAvailability } from './availability';

export type MachineLiveStreamActiveState = Readonly<{
    status: 'streaming' | 'paused' | 'stopped';
    streamId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    reasonCode?: string;
    bytesReceived: number;
    framesReceived: number;
}>;

export function resolveMachineLiveStreamProjection(input: Readonly<{
    availability: MachineLiveStreamAvailability;
    activeStream: MachineLiveStreamActiveState | null;
}>): MachineLiveStreamAvailability | (MachineLiveStreamActiveState & Readonly<{ stale: boolean }>) {
    if (input.activeStream && input.availability.status === 'refreshing') {
        return { ...input.activeStream, stale: true };
    }
    if (input.activeStream && input.activeStream.status !== 'stopped') {
        return { ...input.activeStream, stale: false };
    }
    return input.availability;
}
