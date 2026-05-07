import { describe, expect, it, vi } from 'vitest';
import { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';

describe('socketParse', () => {
    it('parses a full update container (new-message)', () => {
        const res = parseUpdateContainer({
            id: 'u1',
            seq: 123,
            createdAt: 1000,
            body: {
                t: 'new-message',
                sid: 's1',
                message: {
                    id: 'm1',
                    seq: 1,
                    content: { t: 'encrypted', c: 'abc' },
                    localId: null,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
            },
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('new-message');
        expect((res!.body as any).sid).toBe('s1');
    });

    it('returns null for a non-container non-sharing update body', () => {
        const res = parseUpdateContainer({
            t: 'new-message',
            sid: 's1',
            message: { id: 'm1' },
        });
        expect(res).toBeNull();
    });

    it('accepts legacy sharing update bodies without a container', () => {
        const res = parseUpdateContainer({
            t: 'session-shared',
            sessionId: 's1',
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('session-shared');
        expect((res!.body as any).sessionId).toBe('s1');
        expect(res!.seq).toBe(0);
    });

    it('accepts legacy sharing update body nested under body', () => {
        const res = parseUpdateContainer({
            body: {
                t: 'session-share-updated',
                sessionId: 's1',
                shareId: 'sh1',
            },
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('session-share-updated');
        expect((res!.body as any).sessionId).toBe('s1');
        expect((res!.body as any).shareId).toBe('sh1');
        expect(res!.seq).toBe(0);
    });

    it('returns null for malformed legacy sharing payloads', () => {
        const res = parseUpdateContainer({
            t: 'session-shared',
            // missing sessionId
        });

        expect(res).toBeNull();
    });

    it('parses ephemeral activity updates', () => {
        const res = parseEphemeralUpdate({
            type: 'activity',
            id: 's1',
            active: true,
            activeAt: 1000,
            thinking: true,
        });

        expect(res).not.toBeNull();
        expect(res!.type).toBe('activity');
        expect((res as any).id).toBe('s1');
    });

    it('parses transcript stream segment ephemerals', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'message', message: 'Hello' },
                        },
                        meta: {
                            happierStreamSegmentV1: {
                                v: 1,
                                segmentKind: 'assistant',
                                segmentLocalId: 'segment-1',
                                segmentState: 'streaming',
                                startedAtMs: 1_000,
                                updatedAtMs: 1_010,
                            },
                        },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('transcript-stream-segment');
        expect((res as any)?.message?.localId).toBe('segment-1');
    });

    it('parses direct-session transcript delta ephemerals', () => {
        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1_000,
                    raw: { role: 'user', content: { type: 'text', text: 'Hello direct' } },
                },
            ],
            nextCursor: 'tail-cursor-1',
            truncated: false,
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('direct-session-transcript-delta');
        expect((res as any)?.nextCursor).toBe('tail-cursor-1');
    });

    it('returns null for invalid ephemeral payloads', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'activity',
            active: true,
            // missing required id
        });

        expect(res).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        consoleErrorSpy.mockRestore();
    });
});
