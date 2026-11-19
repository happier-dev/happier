import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { runRetentionSweep } from '@/app/retention/runtime/runRetentionSweep';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('tool-output retention through the shared sweep', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'p03-tool-output-retention-' });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('expires pinned output strictly before the ingestion cutoff and preserves the inline and message rows', async () => {
        const now = new Date('2026-11-19T00:00:00Z');
        const cutoff = new Date('2026-10-20T00:00:00Z');
        const before = new Date(cutoff.getTime() - 1);
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: 'retention-fixture', metadata: '{}', seq: 3, encryptionMode: 'plain',
        } });
        await db.sessionPin.create({ data: { accountId: account.id, sessionId: session.id } });
        const shell = { t: 'plain' as const, v: { type: 'tool-result', callId: 'fixture' } };
        const body = new TextEncoder().encode(JSON.stringify({ t: 'plain', v: 'fixture body' }));
        const seeded = [];
        for (const [seq, createdAt, toolOutputBytes] of [
            [1, before, body], [2, cutoff, body], [3, before, null],
        ] as const) {
            seeded.push(await db.sessionMessage.create({ data: {
                sessionId: session.id, seq, localId: `fixture-${seq}`, content: shell,
                createdAt, sourceCreatedAt: now, toolOutputBytes,
            } }));
        }
        const env = {
            HAPPIER_SERVER_RETENTION__ENABLED: 'true',
            HAPPIER_SERVER_RETENTION__TOOL_OUTPUTS__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__TOOL_OUTPUTS__DAYS: '30',
            HAPPIER_SERVER_RETENTION__BATCH_SIZE: '1',
        };
        const policy = readRetentionPolicyFromEnv(env);
        expect((await runRetentionSweep({ policy: { ...policy, dryRun: true }, now })).byRule.toolOutputs).toBe(1);
        expect((await runRetentionSweep({ policy, now })).byRule.toolOutputs).toBe(1);
        const rows = await db.sessionMessage.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } });
        expect(rows).toEqual([
            { ...seeded[0], toolOutputBytes: null, toolOutputExpiredAfterDays: 30, rowRevision: seeded[0].rowRevision + 1n },
            seeded[1], seeded[2],
        ]);
        expect(await db.session.findUnique({ where: { id: session.id } })).toEqual(session);
        expect(await db.sessionPin.count({ where: { sessionId: session.id } })).toBe(1);
        expect((await runRetentionSweep({ policy, now })).byRule.toolOutputs).toBe(0);
    });
});
