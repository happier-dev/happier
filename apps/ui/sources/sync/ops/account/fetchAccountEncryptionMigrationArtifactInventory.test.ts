import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { fetchAccountEncryptionMigrationArtifactInventory } from './fetchAccountEncryptionMigrationArtifactInventory';

describe('Account transition Artifact inventory', () => {
    const scope = { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true };
    const credentials = { token: 'captured' };
    const row = (index: number) => ({ id: `artifact-${String(index).padStart(4, '0')}`, ownership: { kind: 'ordinary' as const },
        header: encodePlainArtifactStoredContent({ title: 'Document' }), headerVersion: 2,
        body: encodePlainArtifactStoredContent({ body: 'Body' }), bodyVersion: 3, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: 'Retained' }) }] });
    const page = (items: ReturnType<typeof row>[], nextCursor: string | null) => ({ ownerAccountId: 'account', encryptionMode: 'plain', items, nextCursor });

    it('drains every full page and retains the exact heads and revisions', async () => {
        const rows = Array.from({ length: 1001 }, (_, index) => row(index));
        const request = vi.fn(async (path: string) => {
            const query = new URL(path, 'https://home').searchParams;
            const remaining = rows.filter(row => !query.get('afterId') || row.id > query.get('afterId')!);
            const items = remaining.slice(0, Number(query.get('limit')));
            return Response.json(page(items, remaining.length > items.length ? items.at(-1)!.id : null));
        });
        expect(await fetchAccountEncryptionMigrationArtifactInventory({ credentials, request, scope, encryptionMode: 'plain' })).toEqual(rows);
    });

    it('refuses duplicate rows and cursor non-advancement instead of claiming complete inventory', async () => {
        const request = vi.fn(async () => Response.json(page([row(0)], row(0).id)));
        await expect(fetchAccountEncryptionMigrationArtifactInventory({ credentials, request, scope, encryptionMode: 'plain' })).rejects.toThrow();
    });

    it.each(['owner', 'mode', 'refused', 'content'] as const)('refuses %s response disagreement before returning content', async mismatch => {
        const request = vi.fn(async () => mismatch === 'refused' ? Response.json({ error: 'artifact_content_unavailable' }, { status: 503 })
            : Response.json({ ...page([{ ...row(0), ...(mismatch === 'content' ? { dataEncryptionKey: 'cipher' } : {}) }], null),
                ...(mismatch === 'owner' ? { ownerAccountId: 'other' } : { encryptionMode: mismatch === 'mode' ? 'e2ee' : 'plain' }) }));
        await expect(fetchAccountEncryptionMigrationArtifactInventory({ credentials, request, scope, encryptionMode: 'plain' })).rejects.toThrow();
    });

    it('retires captured scope after a pending read before admitting or fetching another page', async () => {
        let current = true;
        const request = vi.fn(async () => { current = false; return Response.json(page([row(0)], row(0).id)); });
        await expect(fetchAccountEncryptionMigrationArtifactInventory({ credentials, request, encryptionMode: 'plain',
            scope: { ...scope, isCurrent: () => current } })).rejects.toThrow('scope changed');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('refuses mixed-mode private metadata or client private keys on a Plain Account', async () => {
        for (const extra of [
            { provenance: 'encrypted-private-head' },
            { provenanceDataEncryptionKey: 'client-private-key' },
            { revisions: [{ ...row(0).revisions[0]!, provenance: 'encrypted-private-revision' }] },
        ]) {
            const request = async () => Response.json(page([{ ...row(0), ...extra }], null));
            await expect(fetchAccountEncryptionMigrationArtifactInventory({ credentials, request, scope, encryptionMode: 'plain' })).rejects.toThrow();
        }
    });

    it('requires separate E2EE private key custody for retained-only metadata before returning inventory', async () => {
        const item = { ...row(0), header: 'encrypted-header', body: 'encrypted-body', dataEncryptionKey: 'content-key',
            provenance: null, revisions: [{ bodyVersion: 1, body: 'encrypted-revision', provenance: 'encrypted-private-revision' }] };
        const request = async () => Response.json({ ...page([item], null), encryptionMode: 'e2ee' });
        await expect(fetchAccountEncryptionMigrationArtifactInventory({ credentials, request, scope, encryptionMode: 'e2ee' })).rejects.toThrow();
        const complete = { ...item, provenanceDataEncryptionKey: 'private-key' };
        const admitted = async () => Response.json({ ...page([complete], null), encryptionMode: 'e2ee' });
        await expect(fetchAccountEncryptionMigrationArtifactInventory({ credentials, request: admitted, scope, encryptionMode: 'e2ee' }))
            .resolves.toEqual([complete]);
    });
});
