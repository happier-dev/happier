import { expect, it } from 'vitest';
import { USAGE_COLLABORATION_TOOL_LEAF_KEYS } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readSessionMessageEvidenceRowsInTx } from './readSessionMessageEvidenceRows';

it('projects every published message from a long plaintext Session', async () => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-evidence-' });
    try {
        const account = await db.account.create({ data: { publicKey: 'long-plaintext-evidence', encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'long-evidence',
            encryptionMode: 'plain', metadata: '{}' } });
        const publishedCount = 140_000;
        const content = JSON.stringify({ t: 'plain', v: { role: 'agent', content: { type: 'event' } } });
        await db.$executeRaw`
            WITH RECURSIVE messages(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM messages WHERE seq <= ${publishedCount})
            INSERT INTO "SessionMessage" ("id", "sessionId", "seq", "content", "createdAt", "updatedAt")
            SELECT 'evidence-' || seq, ${session.id}, seq, ${content}, seq, seq FROM messages`;
        const rows = await inReadSnapshot(tx => readSessionMessageEvidenceRowsInTx(tx,
            [{ id: session.id, maximumSeq: publishedCount }], USAGE_COLLABORATION_TOOL_LEAF_KEYS));
        expect(rows).toHaveLength(publishedCount);
        expect(rows[0]).toMatchObject({ id: `evidence-${publishedCount}`, envelopeType: 'plain' });
        expect(rows.at(-1)?.id).toBe('evidence-1');
    } finally {
        await harness.close();
    }
}, 120_000);
