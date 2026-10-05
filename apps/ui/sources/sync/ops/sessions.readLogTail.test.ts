import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sessionReadLogTail } from './sessions';
import { apiSocket } from '../api/session/apiSocket';
import '@/sync/syncEngine';
import {
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const sessionRPCSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({
    success: true, path: '/tmp/happier/logs/session.log', tail: 'hello',
});
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
beforeAll(async () => { account = await restoreServerAccountForTest({ serverUrl: 'http://session-log.test' }); });
afterAll(async () => { await account?.dispose(); });

describe('sessionReadLogTail', () => {
    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        sessionRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionReadLogTail('s1');
        expect(res).toMatchObject({ success: false });
        expect(typeof res.error).toBe('string');
    });

    it('passes maxBytes to session.log.tail RPC', async () => {
        await sessionReadLogTail('s1', { maxBytes: 32_000 });
        expect(sessionRPCSpy).toHaveBeenCalledWith('s1', 'session.log.tail', { maxBytes: 32_000 }, expect.any(Object));
    });
});
