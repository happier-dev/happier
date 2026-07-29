import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from '@/api/offline/offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('returns an EventEmitter-compatible ApiSessionClient', () => {
        const session = createOfflineSessionStub('tag');

        let calls = 0;
        session.on('message', () => {
            calls += 1;
        });
        session.emit('message', { ok: true });

        expect(calls).toBe(1);
    });

    it('does not claim that committed transcript writes were persisted', async () => {
        const session = createOfflineSessionStub('tag');

        await expect(session.sendAgentMessageCommitted(
            'claude',
            { type: 'message', message: 'must survive reconnect' },
            { localId: 'offline-segment-1' },
        )).rejects.toThrow('Offline transcript write was not persisted');
    });
});
