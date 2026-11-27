import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    createSessionOwnerMetadataV1,
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionListQueryResponseV1Schema,
} from '@happier-dev/protocol';
import { buildSessionListServerQueryV1, SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { listSessionsForAccount } from './service';
import { createV2SessionListServerTiming } from './timing';

describe('metadata-owned Bot roster paging (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-bot-listing-', initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('reaches a sparse Bot after all structural candidate pages without moving its marker into server state', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const corpusSize = 600;
        const botId = randomUUID();
        await db.session.createMany({ data: Array.from({ length: corpusSize }, (_, index) => {
            const metadata = index === corpusSize - 1 ? { bot: { kind: 'bot' } } : {};
            const owner = createSessionOwnerMetadataV1({ metadata });
            if (!owner.ok) throw new Error('Bot listing fixture metadata was rejected');
            return {
                id: index === corpusSize - 1 ? botId : randomUUID(),
                accountId: account.id,
                tag: randomUUID(),
                encryptionMode: 'plain',
                metadataLayoutVersion: 1,
                metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
                ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)),
                meaningfulActivityAt: new Date(corpusSize - index),
            };
        }) });

        const query = buildSessionListServerQueryV1(SessionListQueryV1Schema.parse({
            v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
            attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, bot: 'bot',
        }));
        expect(query).not.toHaveProperty('bot');
        const sessionIds: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        let responseBytes = 0;
        const startedAt = performance.now();
        do {
            const page = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
                userId: account.id,
                authentication: createPresentUserSessionAccessAuthentication(),
                source: { kind: 'query', query: { ...query, ...(cursor ? { cursor } : {}) } },
                rowRepresentabilityWhere: {},
                timing: createV2SessionListServerTiming({}),
            }));
            pages += 1;
            responseBytes += Buffer.byteLength(JSON.stringify(page));
            sessionIds.push(...page.sessions.map(row => row.id));
            expect(page.sessions.every(row => row.documents === 'omitted' && row.metadata === undefined)).toBe(true);
            if (page.hasNext) {
                expect(page.nextCursor).toBeTruthy();
                expect(page.nextCursor).not.toBe(cursor);
            }
            cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
        } while (cursor);

        expect(sessionIds).toHaveLength(corpusSize);
        expect(new Set(sessionIds).size).toBe(corpusSize);
        expect(sessionIds.at(-1)).toBe(botId);
        console.info(`Bot roster synthetic real-SQLite corpus: ${corpusSize} candidates, ${pages} pages, ${responseBytes} JSON bytes, ${(performance.now() - startedAt).toFixed(1)} ms; excludes transport and client hydration`);
    });
});
