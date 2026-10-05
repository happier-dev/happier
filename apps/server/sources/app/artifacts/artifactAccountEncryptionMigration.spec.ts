import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createInTxHarness } from '@/app/api/testkit/txHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Tx } from '@/storage/inTx';

let transaction: Tx;
vi.mock('@/storage/inTx', () => createInTxHarness(() => transaction));
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';

describe('Account Artifact transition inventory HTTP', () => {
    beforeEach(() => { process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = 'none'; });
    const row = (id: string) => ({ id, accountId: 'owner', header: Buffer.from(encodePlainArtifactStoredContent({ title: 'Document' }), 'base64'),
        headerVersion: 0, body: Buffer.from(encodePlainArtifactStoredContent({ body: 'Content' }), 'base64'), bodyVersion: 2,
        dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'), seq: 0, currentBlobId: null,
        revisions: [{ bodyVersion: 1, body: Buffer.from(encodePlainArtifactStoredContent({ body: 'Retained' }), 'base64'), blobId: null }],
        blobs: [], pluginUiArtifact: null, packageAssetRelease: null });

    it('pages every Account-owned row with complete retained history', async () => {
        const rows = Array.from({ length: 501 }, (_, index) => row(`id-${String(index).padStart(4, '0')}`));
        // Prisma is the persistence boundary; the real census, mode opener and HTTP owner remain live.
        transaction = { account: { findUnique: async () => ({ encryptionMode: 'plain' }) },
            artifact: { findMany: async (input: { where: { accountId: string; id?: { gt: string } }; take?: number }) =>
                input.where.accountId !== 'owner' ? [] : rows.filter(row => !input.where.id || row.id > input.where.id.gt).slice(0, input.take) },
        } as unknown as Tx;
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': 'owner' };
            const first = await app.inject({ method: 'GET', url: '/v1/account/encryption/artifacts?limit=500', headers });
            expect(first.statusCode, first.body).toBe(200);
            const page = first.json();
            expect(page.items).toHaveLength(500);
            expect(page.items[0]).toMatchObject({ id: rows[0]!.id, ownership: { kind: 'ordinary' },
                revisions: [{ bodyVersion: 1, body: rows[0]!.revisions[0]!.body.toString('base64') }] });
            const next = await app.inject({ method: 'GET', url: `/v1/account/encryption/artifacts?afterId=${page.nextCursor}`, headers });
            expect(next.statusCode, next.body).toBe(200);
            expect(next.json()).toMatchObject({ nextCursor: null, items: [{ id: rows[500]!.id }] });
            const other = await app.inject({ method: 'GET', url: '/v1/account/encryption/artifacts', headers: { 'x-test-user-id': 'other' } });
            expect(other.json()).toMatchObject({ ownerAccountId: 'other', items: [] });
        });
    });

    it.each(['head', 'history', 'mode', 'foreign-plugin'] as const)('refuses %s inconsistency without disclosing an inventory', async mismatch => {
        const stored = { ...row('id'),
            ...(mismatch === 'head' ? { header: Buffer.from('cipher') } : {}),
            ...(mismatch === 'history' ? { revisions: [{ bodyVersion: 1, body: Buffer.from('cipher'), blobId: null }] } : {}),
            ...(mismatch === 'foreign-plugin' ? { packageAssetRelease: { accountId: 'other', pluginId: 'com.acme.archive', version: '1.0.0' } } : {}) };
        // Prisma is the persistence boundary; invalid stored state exercises real admission.
        transaction = { account: { findUnique: async () => ({ encryptionMode: mismatch === 'mode' ? 'e2ee' : 'plain' }) },
            artifact: { findMany: async () => [stored] } } as unknown as Tx;
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/account/encryption/artifacts', headers: { 'x-test-user-id': 'owner' } });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'artifact_content_unavailable' });
        });
    });
});
