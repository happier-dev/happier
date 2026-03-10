import type { tracking as trackingClient } from '@/track/tracking';

type FlushableTrackingClient = Pick<NonNullable<typeof trackingClient>, 'flush'> | null;

export function flushTrackingClient(client: FlushableTrackingClient): void {
    if (!client?.flush) return;

    try {
        const flushResult = client.flush();
        if (flushResult && typeof flushResult === 'object' && 'catch' in flushResult && typeof flushResult.catch === 'function') {
            void flushResult.catch(() => {});
        }
    } catch {
        // ignore analytics transport errors
    }
}
