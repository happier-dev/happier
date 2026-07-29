import type { SessionViewportAnchorSnapshot } from '@/sync/sync';
import { sync } from '@/sync/sync';
import type { TranscriptViewportAnchorIdentity } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export function normalizeRestoreAnchorIdentity(
    anchor: Pick<SessionViewportAnchorSnapshot, 'kind' | 'itemId' | 'messageId'>,
): TranscriptViewportAnchorIdentity | null {
    if (typeof anchor.itemId !== 'string' || anchor.itemId.length === 0) return null;
    return {
        kind: anchor.kind,
        itemId: anchor.itemId,
        messageId: anchor.messageId ?? null,
    };
}

export function normalizeDurableViewportSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const seq = Math.trunc(value);
    return seq > 0 ? seq : null;
}

export function readSessionViewportForEntry(sessionId: string) {
    return typeof sync.getSessionViewport === 'function' ? sync.getSessionViewport(sessionId) : null;
}
