import { afterEach, describe, expect, it, vi } from 'vitest';

// HTTP is the boundary: exercise real page validation, decryption and turn reduction.
describe('Pending custody in a coherent activity page', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });
    it.each([
        { name: 'first provisional input refused before provider delivery', blockerCount: 0, accepted: false, proof: true, busy: false },
        { name: 'separate accepted turn survives provisional crossover', blockerCount: 0, accepted: true, proof: true, busy: true, turnStatus: 'in_progress' },
        { name: 'unmaterialized or uncertain primary input stays busy', blockerCount: 1, accepted: false, proof: true, busy: true },
        { name: 'missing requested activity proof is unavailable', blockerCount: 0, accepted: false, proof: false, busy: true, empty: true },
        { name: 'completed zero-output turn is idle beside a safely blocked provisional twin', blockerCount: 0, accepted: true, proof: true, busy: false, turnStatus: 'completed' },
    ])('$name', async ({ blockerCount, accepted, proof, busy, empty, turnStatus }) => {
        const axios = (await import('axios')).default;
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
            hasMore: false,
            messages: [
                ...(empty ? [] : [{ id: 'provisional', seq: 1, localId: 'queued-input', createdAt: 1,
                    ...(proof ? { pendingOwnsTranscript: true } : {}),
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'refused' } } } }]),
                ...(accepted ? [{ id: 'accepted', seq: 2, localId: 'accepted-input', createdAt: 2,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'accepted' } } } }] : []),
            ],
            ...(proof ? { activity: { pendingCount: 1 + blockerCount, pendingBlockedCount: 1,
                pendingBlockedNoEffectCount: 1, latestTurnStatus: turnStatus ?? null,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 } } : {}),
        } });
        const { detectSessionTurnActivity, SessionTurnActivityUnavailableError } = await import('./detectSessionTurnInFlight');
        const result = detectSessionTurnActivity({ token: 'token', sessionId: 'sess-1',
            encryptionMode: 'plain', encryptionKey: null, encryptionVariant: null,
        });
        if (!proof) {
            await expect(result).rejects.toBeInstanceOf(SessionTurnActivityUnavailableError);
            return;
        }
        const activity = await result;
        expect(activity.turnInFlight).toBe(busy);
        expect(activity.pendingInputCount).toBe(blockerCount);
    });
});
