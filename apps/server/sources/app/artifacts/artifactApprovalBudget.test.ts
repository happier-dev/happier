import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { createDbMocks } from '@/app/api/testkit/dbMocks';
import { APPROVAL_ARTIFACT_KINDS_V1, SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { encodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

// Only the database adapter is replaced; SQL construction and quota arithmetic stay real.
vi.mock('@/storage/prisma', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/prisma')>(),
    getActivePrismaRuntime: () => Prisma,
}));
import { checkArtifactStorageBudgetInTx } from './artifactStorageService';

function database() {
    const { db } = createDbMocks({ artifactBlob: ['findMany'] });
    const tx = { ...db, $queryRaw: vi.fn() };
    tx.artifactBlob.findMany.mockResolvedValue([]);
    tx.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
        query.sql.includes('AS "usedBytes"') ? [{ usedBytes: 100 }] : []);
    // Partial database boundary fixture: the owner only uses these two methods.
    return { tx: tx as unknown as Tx, queries: () => tx.$queryRaw.mock.calls.length + tx.artifactBlob.findMany.mock.calls.length };
}
const storedKind = (kindHint: string) => encodeArtifactKindV1({ kind: 'other', kindHint });
const write = (nextKind: string | null, nextBodyBytes = 10) => ({ accountId: 'owner', artifactId: 'record',
    nextKind, nextHeaderBytes: 0, nextBodyBytes, retainCurrentBody: false });

describe('approval Account exemption preserves document budget (owner R1, 2026-11-23)', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '100');
        vi.stubEnv('HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES', '20');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(Object.values(APPROVAL_ARTIFACT_KINDS_V1))('admits %s at the Account cap without reading Account usage', async kind => {
        const db = database();
        expect(await checkArtifactStorageBudgetInTx(db.tx, write(storedKind(kind)))).toBeNull();
        expect(db.queries()).toBe(2);
    });
    it('refuses an ordinary create at the Account cap with details', async () => {
        const db = database();
        expect(await checkArtifactStorageBudgetInTx(db.tx, write(null))).toEqual({ error: 'quota_exceeded',
            budget: 'account', limitBytes: 100, usedBytes: 110 });
        expect(db.queries()).toBe(3);
    });
    it('refuses an oversize ordinary create on document budget before reading Account usage', async () => {
        const db = database();
        expect(await checkArtifactStorageBudgetInTx(db.tx, write(null, 21))).toEqual({ error: 'quota_exceeded',
            budget: 'document', limitBytes: 20, usedBytes: 21 });
        expect(db.queries()).toBe(2);
    });
    it('refuses an oversize approval on document budget before reading Account usage', async () => {
        const db = database();
        expect(await checkArtifactStorageBudgetInTx(db.tx, write(storedKind(APPROVAL_ARTIFACT_KINDS_V1.builtIn), 21)))
            .toEqual({ error: 'quota_exceeded', budget: 'document', limitBytes: 20, usedBytes: 21 });
        expect(db.queries()).toBe(2);
    });
    it('keeps a non-approval internal consent under the Account budget', async () => {
        const db = database();
        expect(await checkArtifactStorageBudgetInTx(db.tx, write(storedKind(SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1))))
            .toEqual({ error: 'quota_exceeded', budget: 'account', limitBytes: 100, usedBytes: 110 });
        expect(db.queries()).toBe(3);
    });
});
