import { expect, it, vi } from 'vitest';
import { resolveGalleryChatJump } from './showGalleryItemInChat';

it('uses a loaded sequence, otherwise reads the exact local id once and ignores capture items', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ message: { localId: 'm #1', seq: 18 } })));
    const destination = { sessionId: 'session/id', serverId: 'home' };
    const item = { messageLocalId: 'm #1' };
    expect(await resolveGalleryChatJump({ ...destination, item, loadedMessages: [{ localId: 'm #1', seq: 14 }], request }))
        .toEqual({ ok: true, query: { jumpSeq: 14 } });
    expect(await resolveGalleryChatJump({ ...destination, item: {}, loadedMessages: [], request }))
        .toEqual({ ok: false, code: 'no_message' });
    expect(request).not.toHaveBeenCalled();
    expect(await resolveGalleryChatJump({ ...destination, item, loadedMessages: [], request }))
        .toEqual({ ok: true, query: { jumpSeq: 18 } });
    expect(request).toHaveBeenCalledExactlyOnceWith('/v2/sessions/session%2Fid/messages/by-local-id/m%20%231',
        { method: 'GET', signal: undefined }, { retry: 'none' });
    request.mockResolvedValueOnce(new Response(JSON.stringify({ message: { localId: 'wrong', seq: 18 } })));
    expect(await resolveGalleryChatJump({ ...destination, item, loadedMessages: [], request }))
        .toEqual({ ok: false, code: 'invalid_message' });
});
