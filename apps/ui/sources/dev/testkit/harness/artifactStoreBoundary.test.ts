import { describe, expect, it, vi } from 'vitest';

import { createArtifactStoreBoundary } from './artifactStoreBoundary';

describe('Artifact store HTTP boundary', () => {
    it('pages headers in the server cursor order without repeating tied timestamps or returning bodies', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1234);
        try {
            const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
            for (const id of ['a', 'b', 'c']) await boundary.handle('/v1/artifacts', { method: 'POST',
                body: JSON.stringify({ id, header: 'header', body: 'body', dataEncryptionKey: '' }) });
            const first = await (await boundary.handle('/v1/artifacts?limit=2'))!.json();
            expect(first.map((row: { id: string }) => row.id)).toEqual(['c', 'b']);
            expect(first[0]).not.toHaveProperty('body');
            const cursor = Buffer.from(JSON.stringify({ updatedAt: 1234, id: 'b' })).toString('base64url');
            const last = await (await boundary.handle(`/v1/artifacts?limit=2&cursor=${cursor}&includeBody=true`))!.json();
            expect(last).toMatchObject([{ id: 'a', body: 'body', bodyVersion: 1 }]);
            expect(last).toHaveLength(1);
        } finally { clock.mockRestore(); }
    });
});
