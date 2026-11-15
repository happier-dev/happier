import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import * as serverLogging from '@/utils/logging/log';
import { DISCUSSION_UPLOAD_CONTENT_TYPE_V1 } from '@happier-dev/transfers';
import { createAttachmentApp, discussionAttachmentContracts } from './discussionAttachments.testkit';
import * as storageDb from '@/storage/db';
import { createDbTransactionMock, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFiniteTransferConfig } from '@happier-dev/transfers/node';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';

describe('Discussion attachment transport diagnostics (no database)', () => {
    it('logs one content-free unexpected frame error and no error for a typed transport refusal', async () => {
        const { app, restoreEnvironment } = createAttachmentApp(() => 'unused-account');
        const provider = process.env.HAPPIER_DB_PROVIDER;
        process.env.HAPPIER_DB_PROVIDER = 'postgres';
        // Only Home singleton persistence is substituted, using its canonical boundary fixture.
        const tables = { ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock,
            homeSettings: { findUnique: async () => null }, homeGovernancePolicy: { findUnique: async () => null } };
        const homeDatabase = createDbTransactionMock(() => tables).wrapDb(tables);
        // This narrow Prisma fixture implements only the admitted Home snapshot read; other DB access fails.
        const databaseBoundary = vi.spyOn(storageDb, 'db', 'get').mockReturnValue(homeDatabase as unknown as typeof storageDb.db);
        // Observe the external diagnostic sink; the route/parser/helper stay real.
        const diagnosticLog = vi.spyOn(serverLogging, 'log');
        const unexpectedLogs = () => diagnosticLog.mock.calls.filter(([entry]) =>
            entry?.level === 'error' && entry?.module === 'fastify-error');
        const privateMarker = 'owned-private-filename-do-not-log.png';
        const malformedMetadata = `{"privateMarker":"${privateMarker}", broken}\n`;
        try {
            const typedRefusal = await app.inject({ method: 'POST', url: '/v1/discussions/upload', payload: {} });
            expect(typedRefusal.statusCode, typedRefusal.body).toBe(400);
            expect(typedRefusal.json()).toEqual({ error: 'discussion_invalid_content' });
            expect(unexpectedLogs()).toHaveLength(0);
            const malformed = await app.inject({ method: 'POST', url: '/v1/discussions/upload',
                headers: { 'content-type': DISCUSSION_UPLOAD_CONTENT_TYPE_V1 }, payload: malformedMetadata });
            expect(malformed.statusCode, malformed.body).toBe(400);
            expect(malformed.json()).toEqual({ error: 'discussion_invalid_content' });
            expect(unexpectedLogs()).toHaveLength(1);
            const diagnostic = unexpectedLogs()[0]!;
            expect(diagnostic[0]).toMatchObject({ level: 'error', module: 'fastify-error' });
            expect(diagnostic.some(value => value instanceof Error)).toBe(false);
            expect(JSON.stringify(diagnostic)).not.toContain(privateMarker);
            expect(JSON.stringify(diagnostic)).not.toContain(malformedMetadata);
        } finally {
            diagnosticLog.mockRestore();
            await app.close();
            databaseBoundary.mockRestore();
            if (provider === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = provider;
            restoreEnvironment();
        }
    });
});

describe('Discussion committed private attachments (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-files-', initAuth: false, initEncrypt: true, initFiles: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    it('keeps a request-owned attachment alive while awaiting bytes beyond the transfer TTL', async () => {
        const owner = await storageDb.db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await storageDb.db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const bytes = Buffer.from('slow Discussion attachment');
        const blobId = randomUUID();
        const metadata = { operation: 'create', input: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Slow attachment' } },
            participants: [{ kind: 'account', accountId: reader.id }], firstMessage: {
                localId: randomUUID(), mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' }],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'attachment', attachment: {
                    kind: 'file', id: blobId, name: 'slow.txt', file: { blobId, mime: 'text/plain',
                        sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
                } }] } },
            } }, attachments: [{ blobId, t: 'plain', storedSizeBytes: bytes.length }] };
        const ttlMs = readFiniteTransferConfig(process.env).ttlMs;
        const clock = vi.spyOn(Date, 'now');
        const stream = new Readable({ read() {} });
        // The socket boundary produces its next bytes after the real segment
        // receiver is opened, exposing inactivity between request-owned chunks.
        Object.defineProperty(stream, Symbol.asyncIterator, { value: async function* () {
            yield Buffer.from(`${JSON.stringify(metadata)}\n`);
            clock.mockReturnValue(Date.now() + ttlMs + 1);
            yield bytes;
        } });
        const { app, restoreEnvironment } = createAttachmentApp(() => owner.id);
        app.addHook('preHandler', async request => {
            if (request.url === '/v1/discussions/upload') request.body = stream;
        });
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/discussions/upload',
                headers: { 'content-type': DISCUSSION_UPLOAD_CONTENT_TYPE_V1 }, payload: '' });
            expect(response.statusCode, response.body).toBe(200);
            const created = response.json();
            const read = await app.inject({ method: 'GET',
                url: `/v1/discussions/${created.discussion.id}/messages/${created.firstMessage.id}/attachments/${blobId}` });
            expect(read.statusCode, read.body).toBe(200);
            expect(Buffer.from(read.json().content.v, 'base64')).toEqual(bytes);
        } finally { await app.close(); clock.mockRestore(); stream.destroy(); restoreEnvironment(); }
    });
    discussionAttachmentContracts();
});
