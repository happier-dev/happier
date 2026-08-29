import { describe, expect, it, vi } from 'vitest';
import { AccountDirectorySession } from './accountDirectorySession';

function home(identity: string) {
    return {
        v: 1 as const,
        homeServerIdentityId: identity,
        canonicalServerUrl: `https://${identity}.test`,
        label: identity,
        connectionDescriptor: {
            v: 1 as const,
            homeServerIdentityId: identity,
            canonicalServerUrl: `https://${identity}.test`,
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: `https://${identity}.test` }],
        },
        createdAtMs: 1,
        updatedAtMs: 1,
        preferred: false,
    };
}

describe('AccountDirectorySession', () => {
    it('deduplicates concurrent refresh and retains cached homes during outage', async () => {
        let resolveList: ((value: { homes: ReturnType<typeof home>[] }) => void) | null = null;
        const client = {
            getMe: vi.fn(async () => ({ accountId: 'a' })),
            listHomes: vi.fn(() => new Promise<{ homes: ReturnType<typeof home>[] }>((resolve) => { resolveList = resolve; })),
        };
        const session = new AccountDirectorySession('https://directory.test', { client: client as never });
        const first = session.refresh();
        const second = session.refresh();
        expect(client.listHomes).toHaveBeenCalledTimes(1);
        resolveList!({ homes: [home('home-1')] });
        await Promise.all([first, second]);
        expect(session.snapshot.status).toBe('ready');

        client.listHomes.mockRejectedValueOnce(new Error('offline'));
        const stale = await session.refresh();
        expect(stale.status).toBe('stale');
        expect(stale.homes).toHaveLength(1);
    });
});
