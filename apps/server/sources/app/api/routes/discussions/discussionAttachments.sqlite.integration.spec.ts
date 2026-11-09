import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import * as serverLogging from '@/utils/logging/log';
import { DISCUSSION_UPLOAD_CONTENT_TYPE_V1 } from '@happier-dev/transfers';
import { createAttachmentApp, discussionAttachmentContracts } from './discussionAttachments.testkit';
import * as storageDb from '@/storage/db';
import { createDbTransactionMock, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';

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
    discussionAttachmentContracts();
});
