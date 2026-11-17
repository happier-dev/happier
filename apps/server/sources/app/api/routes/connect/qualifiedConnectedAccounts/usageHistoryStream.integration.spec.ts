import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QualifiedProviderAccountUsageHistoryResponseV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePrimitives';

import { db } from '@/storage/db';
import { withSqliteReadSnapshot } from '@/storage/prisma';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createProviderAccountUsageRecordKey, createUsageSnapshot } from '../providerAccountUsageTestkit';
import { mutateQualifiedConnectedServiceCredential } from './credentialRepository';
import { readQualifiedProviderAccountUsageHistory, writeQualifiedProviderAccountUsageRecord } from './usageRepository';
import { streamQualifiedProviderAccountUsageHistory } from './usageHistoryStream';
import { ProviderAccountUsagePayloadInvariantError } from '../providerAccountUsage/types';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';

describe('qualified provider usage finite history stream', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-history-stream-', initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness.close(); });
    afterEach(async () => { await db.serviceAccountToken.deleteMany(); await db.account.deleteMany(); });

    async function seed(encrypted: boolean) {
        const account = await db.account.create({ data: encrypted
            ? { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }
            : { publicKey: null, encryptionMode: 'plain' } });
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'history-stream' }, accountId: 'stream-account' };
        const credential = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            authenticationModeId: 'api-key', expectedCredentialRevision: null,
            content: encrypted ? { t: 'encrypted', c: 'opaque-test-credential' } : { t: 'plain', v: { token: 'test' } },
            metadata: { scopes: [], providerIdentity: { accountId: 'stream-subject' } } });
        if (credential.status !== 'written') throw new Error('Expected credential create');
        const start = Date.now() - 10_000;
        const snapshots = Array.from({ length: 7 }, (_, index) => createUsageSnapshot({ fetchedAt: start + index * 100,
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: 'stream-subject' }), planLabel: `sample-${index}` }));
        for (const snapshot of snapshots) {
            await writeQualifiedProviderAccountUsageRecord({ accountId: account.id, source: { ref, bindingKind: 'account' },
                expectedCredentialRevision: credential.credentialRevision, expectedConfigurationRevision: null,
                recordId: snapshot.recordId, recordKey: snapshot.recordKey, status: 'ok',
                fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
                ...(encrypted ? { payloadMode: 'sealed_account_scoped_v1', sealedPayload: sealProviderAccountUsageSnapshot({
                    material: { type: 'legacy', secret: new Uint8Array(32).fill(7) }, snapshot,
                    randomBytes: length => new Uint8Array(length).fill(3),
                }) } : { payloadMode: 'plain_json_v1', snapshot }),
            });
        }
        return { account, snapshots, recordId: snapshots[0]!.recordId,
            history: { range: { startAtMs: start, endAtMs: start + 1000 }, pageSize: 2 } };
    }

    it.each([false, true])('drains exact bounded pages with a terminal frame and preserves JSON/witness reads (encrypted=%s)', async encrypted => {
        const fixture = await seed(encrypted);
        const headers = { 'x-test-user-id': fixture.account.id };
        const path = (query: unknown) => '/v4/connect/qualified/provider-account-usage/history?' + new URLSearchParams({ query: JSON.stringify(query) });
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const query = { recordId: fixture.recordId, history: fixture.history };
            const json = await app.inject({ method: 'GET', url: path(query), headers });
            expect(json.statusCode, json.body).toBe(200);
            const first = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(json.json());
            expect(first.entries).toHaveLength(2);
            expect(first.nextCursor).not.toBeNull();
            const expected = [first];
            while (expected.at(-1)!.nextCursor) {
                const next = await app.inject({ method: 'GET', url: path({ ...query,
                    history: { ...fixture.history, cursor: expected.at(-1)!.nextCursor } }), headers });
                expect(next.statusCode, next.body).toBe(200);
                expected.push(QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(next.json()));
            }

            const response = await app.inject({ method: 'GET', url: path(query), headers: { ...headers, accept: 'application/x-ndjson' } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.headers['content-type']).toContain('application/x-ndjson');
            const frames: ReturnType<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema.parse>[] = response.body.trim().split('\n').map((line: string) => QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(JSON.parse(line)));
            expect(frames.map(frame => frame.entries.length)).toEqual([2, 2, 2, 1]);
            expect(frames).toEqual(expected);
            expect(frames.at(-1)?.nextCursor).toBeNull();
            expect(frames.slice(0, -1).every(frame => frame.nextCursor !== null)).toBe(true);
            const exact = await db.providerAccountUsageHistory.findMany({ where: { accountId: fixture.account.id, recordId: fixture.recordId },
                orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], select: { id: true, observedAt: true } });
            const entries = frames.flatMap(frame => frame.entries);
            expect(entries.map(entry => ({ id: entry.id, observedAtMs: entry.observedAtMs }))).toEqual(
                exact.map(row => ({ id: row.id, observedAtMs: row.observedAt.getTime() })));
            expect(new Set(entries.map(entry => entry.id)).size).toBe(7);
            const continuation = await app.inject({ method: 'GET', url: path({ ...query, history: { ...fixture.history, cursor: first.nextCursor } }),
                headers: { ...headers, accept: 'application/x-ndjson' } });
            const rest: ReturnType<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema.parse>[] = continuation.body.trim().split('\n').map((line: string) => QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(JSON.parse(line)));
            expect(rest.flatMap(frame => frame.entries)).toEqual(entries.slice(2));
            if (encrypted) {
                expect(entries.every(entry => entry.record.content.t === 'encrypted')).toBe(true);
                expect(response.body).not.toContain('sample-');
            } else {
                expect(entries.map(entry => entry.record.content.t === 'plain' ? ProviderAccountUsageSnapshotV1Schema.parse(entry.record.content.v).planLabel : null))
                    .toEqual(fixture.snapshots.map(snapshot => snapshot.planLabel));
            }
            const witness = await app.inject({ method: 'GET', url: path({ recordId: fixture.recordId,
                witness: { id: entries[0]!.id, observedAtMs: entries[0]!.observedAtMs } }), headers: { ...headers, accept: 'application/x-ndjson' } });
            expect(witness.headers['content-type']).toContain('application/json');
            expect(QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(witness.json())).toEqual({ entries: [entries[0]], nextCursor: null });
            const stranger = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const refused = await app.inject({ method: 'GET', url: path(query), headers: { 'x-test-user-id': stranger.id, accept: 'application/x-ndjson' } });
            expect(refused.statusCode).toBe(404);
            expect(refused.headers['content-type']).toContain('application/json');
        });
    });

    it('continues one admitted read in autocommit after source removal and stops page reads when cancelled', async () => {
        const fixture = await seed(false);
        const params = { accountId: fixture.account.id, recordId: fixture.recordId, history: fixture.history };
        const first = await readQualifiedProviderAccountUsageHistory(params);
        if (first.status !== 'resolved' || !('entries' in first)) throw new Error('Expected admitted exact history');
        let cancelled = false;
        let leased = false;
        let reads = 0;
        let decoded = 0;
        let restore = () => {};
        await withSqliteReadSnapshot(async reader => {
            const originalExecute = reader.$executeRawUnsafe;
            const originalFind = reader.providerAccountUsageHistory.findMany;
            const execute = originalExecute.bind(reader);
            const find = originalFind.bind(reader.providerAccountUsageHistory);
            reader.$executeRawUnsafe = (async (query: string, ...values: unknown[]) => {
                const result = await execute(query, ...values);
                if (query === 'BEGIN DEFERRED;') leased = true;
                if (query === 'ROLLBACK;') leased = false;
                return result;
            }) as typeof reader.$executeRawUnsafe;
            // Observe real database rows, preserving the internal parser and pager.
            reader.providerAccountUsageHistory.findMany = (async (args: Parameters<typeof find>[0]) => {
                reads++;
                expect(leased, 'one-statement history continuation must not acquire an interactive transaction').toBe(false);
                const rows = await find(args);
                for (const row of rows) {
                    const payload: unknown = row.payload;
                    Object.defineProperty(row, 'payload', { get() {
                        decoded++;
                        expect(leased, 'stream decoding must release its read snapshot').toBe(false);
                        return payload;
                    } });
                }
                return rows;
            }) as unknown as typeof reader.providerAccountUsageHistory.findMany;
            restore = () => {
                reader.$executeRawUnsafe = originalExecute;
                reader.providerAccountUsageHistory.findMany = originalFind;
            };
        });
        try {
            const stream = streamQualifiedProviderAccountUsageHistory({ ...params, firstPage: first, isCancelled: () => cancelled });
            expect((await stream.next()).done).toBe(false);
            expect(reads).toBe(0);
            await db.serviceAccountToken.deleteMany({ where: { accountId: fixture.account.id } });
            const second = await stream.next();
            expect(second.done).toBe(false);
            const frame = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(JSON.parse(second.value!));
            expect(frame.entries).toHaveLength(2);
            expect(reads).toBe(1);
            expect(decoded).toBe(2);
            cancelled = true;
            expect(await stream.next()).toEqual({ done: true, value: undefined });
            expect(reads).toBe(1);
        } finally { restore(); }
    });

    it('fails without a completion frame when a later stored payload disagrees with the admitted identity', async () => {
        const fixture = await seed(false);
        const params = { accountId: fixture.account.id, recordId: fixture.recordId, history: fixture.history };
        const first = await readQualifiedProviderAccountUsageHistory(params);
        if (first.status !== 'resolved' || !('entries' in first)) throw new Error('Expected admitted exact history');
        const stream = streamQualifiedProviderAccountUsageHistory({ ...params, firstPage: first, isCancelled: () => false });
        const initial = await stream.next();
        expect(QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(JSON.parse(initial.value!)).nextCursor).not.toBeNull();
        const later = await db.providerAccountUsageHistory.findMany({ where: { accountId: fixture.account.id, recordId: fixture.recordId },
            orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], select: { id: true, payload: true } });
        const payload = later[2]!.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected persisted history payload');
        await db.providerAccountUsageHistory.update({ where: { id: later[2]!.id }, data: { payload: { ...payload, accountId: 'other-account' } } });
        await expect(stream.next()).rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        expect(await stream.next()).toEqual({ done: true, value: undefined });
    });
});
