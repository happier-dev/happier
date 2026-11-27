import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionMessageByLocalId } from '@/sync/api/session/readSessionMessageByLocalId';
import type { GalleryMediaItem } from './galleryModel';

type MessageSequence = Readonly<{ localId: string | null; seq?: number }>;
export type GalleryChatJump =
    | Readonly<{ ok: true; query: { jumpSeq: number } }>
    | Readonly<{ ok: false; code: 'no_message' | 'invalid_message' | 'not_found' | 'read_failed' | 'cancelled'; status?: number; reason?: string }>;

function isSequence(seq: unknown): seq is number {
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;
}

export async function resolveGalleryChatJump(input: SessionAddress & Readonly<{
    item: Pick<GalleryMediaItem, 'messageLocalId'>;
    loadedMessages: readonly MessageSequence[];
    request: Parameters<typeof readSessionMessageByLocalId>[0];
    signal?: AbortSignal;
}>): Promise<GalleryChatJump> {
    const localId = input.item.messageLocalId;
    if (!localId) return { ok: false, code: 'no_message' };
    if (input.signal?.aborted) return { ok: false, code: 'cancelled' };
    const loadedSeq = input.loadedMessages.find(message => message.localId === localId && isSequence(message.seq))?.seq;
    if (isSequence(loadedSeq)) return { ok: true, query: { jumpSeq: loadedSeq } };
    const response = await readSessionMessageByLocalId(input.request, input.sessionId, localId, input.signal);
    if (input.signal?.aborted) return { ok: false, code: 'cancelled' };
    if (response.status === 404) return { ok: false, code: 'not_found' };
    const body: unknown = await response.json().catch(() => null);
    if (input.signal?.aborted) return { ok: false, code: 'cancelled' };
    if (!response.ok) return { ok: false, code: 'read_failed', status: response.status,
        ...(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? { reason: body.error } : {}) };
    const message = body && typeof body === 'object' && 'message' in body ? body.message : null;
    if (!message || typeof message !== 'object' || !('localId' in message) || message.localId !== localId
        || !('seq' in message) || !isSequence(message.seq)) return { ok: false, code: 'invalid_message' };
    return { ok: true, query: { jumpSeq: message.seq } };
}
