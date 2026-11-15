import type { UsageEventIngestRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { log } from '@/utils/logging/log';
import { recordUsageEvent } from './usageWriteService';

export type UsageEventIngestOutcome =
    | Readonly<{ status: 200; body: Readonly<{ success: true; eventId: string; createdAt: number }> }>
    | Readonly<{ status: 400; body: Readonly<{ error: 'Invalid parameters' | 'Native Session link not found' }> }>
    | Readonly<{ status: 404; body: Readonly<{ error: 'Session not found' | 'Machine not found' }> }>
    | Readonly<{ status: 500; body: Readonly<{ error: 'Failed to save usage event' }> }>;

/** The one v2 usage-event ingest owner behind the HTTP route and the Session-socket event. */
export async function ingestUsageEvent(accountId: string, request: UsageEventIngestRequest): Promise<UsageEventIngestOutcome> {
    try {
        const result = await recordUsageEvent(accountId, request);
        if (result.ok) {
            return { status: 200, body: { success: true, eventId: result.event.id, createdAt: result.event.createdAt.getTime() } };
        }
        if (result.error === 'invalid-params') return { status: 400, body: { error: 'Invalid parameters' } };
        if (result.error === 'native-link-not-found') return { status: 400, body: { error: 'Native Session link not found' } };
        return { status: 404, body: { error: result.error === 'machine-not-found' ? 'Machine not found' : 'Session not found' } };
    } catch (error) {
        log({ module: 'api', level: 'error' }, `Failed to save usage event: ${error}`);
        return { status: 500, body: { error: 'Failed to save usage event' } };
    }
}
