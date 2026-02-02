import { describe, expect, it } from 'vitest';
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
});

