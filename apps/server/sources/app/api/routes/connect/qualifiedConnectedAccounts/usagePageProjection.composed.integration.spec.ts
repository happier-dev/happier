import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Session } from 'node:inspector/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../../testkit/sqliteFastify';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { getProviderAccountUsageQuota, type ProviderAccountUsageQuotaReadOptions } from '../../../../../../../ui/sources/sync/api/account/apiProviderAccountUsage';
import { serveAccountHomes } from '../../../../../../../ui/sources/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '../../../../../../../ui/sources/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot } from '../../../../../../../ui/sources/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '../../../../../../../ui/sources/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore, readUiUsageQueryBatch } from '../../../../../../../ui/sources/sync/api/account/usageQueryResource';
import { TokenStorage } from '../../../../../../../ui/sources/auth/storage/tokenStorage';
import { getServerFeaturesSnapshot } from '../../../../../../../ui/sources/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '../../../../../../../ui/sources/dev/testkit/fixtures/featureFixtures';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } from '../../../../../../../ui/sources/sync/domains/connectedServices/connectedServiceRegistry';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openProviderAccountUsagePageProjectionV1, sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { buildProviderAccountUsagePageProjectionV1, StoredProviderAccountUsagePageProjectionV1Schema,
    ProviderAccountUsagePageProjectionV1Schema, PackedProviderAccountUsagePageProjectionV1Schema,
    ProviderAccountUsagePageProjectionContentV1Schema, ProviderAccountUsagePageProjectionReadV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageCoachEvaluationSchema } from '@happier-dev/protocol/usage/coach/coachFinding';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getProviderAccountUsageQuotaHistoryV1, QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { projectUsagePlanInsights } from '../../../../../../../../packages/protocol/src/usage/usagePlanInsights';
import { projectUsagePlans, projectUsagePastCycles, projectUsageEarlierCurves, summarizeUsagePlanFit,
    resolveUsageResetStartBinding, adviseUsageBankedReset } from '../../../../../../../ui/sources/components/settings/usage/widgets/plans/usagePlansModel';

describe('B page projection through producer, qualified HTTP/SQLite, Usage Resource and Plans', () => {
    async function profileCold<T>(name: string, run: () => Promise<T>): Promise<T> {
        const directory = process.env.USAGE_PERF_PROFILE_DIR;
        if (!directory) return run();
        // Observation only: spies delegate to the real validators, including HTTP/SQLite admission.
        const validators: ReadonlyArray<readonly [string, { parse(input: unknown): unknown; safeParse(input: unknown): unknown }]> = [
            ['expandedProjection', ProviderAccountUsagePageProjectionV1Schema],
            ['packedProjection', PackedProviderAccountUsagePageProjectionV1Schema],
            ['projectionContent', ProviderAccountUsagePageProjectionContentV1Schema],
            ['httpProjectionRead', ProviderAccountUsagePageProjectionReadV1Schema],
            ['storedProjection', StoredProviderAccountUsagePageProjectionV1Schema],
            ['usageBatch', UsageQueryBatchResultSchema], ['coachEvaluation', UsageCoachEvaluationSchema],
        ];
        const parsers = validators.flatMap(([schema, validator]) => (['parse', 'safeParse'] as const).map(method => ({
            schema, method, spy: vi.spyOn(validator, method),
        })));
        const session = new Session();
        session.connect();
        await session.post('Profiler.enable');
        await session.post('HeapProfiler.enable');
        await session.post('HeapProfiler.collectGarbage');
        const before = process.memoryUsage();
        await session.post('Profiler.start');
        await session.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        const started = performance.now();
        try { return await run(); }
        finally {
            const elapsedMs = performance.now() - started;
            const after = process.memoryUsage();
            const cpu = await session.post('Profiler.stop');
            const heap = await session.post('HeapProfiler.stopSampling');
            await session.post('HeapProfiler.collectGarbage');
            const retained = process.memoryUsage();
            await mkdir(directory, { recursive: true });
            await writeFile(`${directory}/${name}.cpuprofile`, JSON.stringify(cpu.profile));
            await writeFile(`${directory}/${name}.heapprofile`, JSON.stringify(heap.profile));
            await writeFile(`${directory}/${name}.json`, JSON.stringify({ elapsedMs, before, after, retained }));
            console.info(JSON.stringify({ profile: name, elapsedMs, before, after, retained }));
            const parseCensus = parsers.map(({ schema, method, spy }) => ({ schema, method, calls: spy.mock.calls.length }));
            await writeFile(`${directory}/${name}.parses.json`, JSON.stringify(parseCensus));
            console.info(JSON.stringify({ profile: name, parseCensus }));
            parsers.forEach(({ spy }) => spy.mockRestore());
            session.disconnect();
            // These outputs stay in this process; outward Action admission and
            // HTTP/E2EE input validation still execute their real schemas.
            for (const row of parseCensus) if (row.method === 'parse'
                && ['expandedProjection', 'usageBatch', 'coachEvaluation'].includes(row.schema)) {
                expect(row.calls, `${name}: ${row.schema} revalidated admitted data`).toBe(0);
            }
        }
    }
    const largeHistoryTestTimeoutMs = 300_000;
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-projection-', initAuth: true, initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('revalidates a %s demand and recovers when another reader replaces its accepted prefix', async accountMode => {
        const account = await db.account.create({ data: accountMode === 'plain'
            ? { publicKey: null, encryptionMode: 'plain' }
            : { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'novel-service' }, accountId: `replaced-${accountMode}` };
        const source = { ref, bindingKind: 'account' as const };
        const now = Date.now();
        const first = createUsageSnapshot({ fetchedAt: now - 20 });
        const late = { ...first, fetchedAtMs: now - 10, observedAtMs: now - 10,
            meters: first.meters.map(meter => ({ ...meter, used: 15, utilizationPct: 15 })) };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const demand = { range: { startAtMs: now - 25, endAtMs: now }, resolution: 'accepted_observations' as const };
        const earlierDemand = { ...demand, range: { startAtMs: now - 30, endAtMs: now - 15 } };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
                content: accountMode === 'plain' ? { t: 'plain', v: { token: 'test' } } : { t: 'encrypted', c: 'fixture-credential' },
                metadata: { scopes: [], providerIdentity: { accountId: first.recordKey.accountSubjectId } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            for (const snapshot of [first, late]) {
                const sealedPayload = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                    randomBytes: length => new Uint8Array(length).fill(9) }) : undefined;
                const written = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                    source, expectedCredentialRevision: credential.json().credentialRevision, expectedConfigurationRevision: null,
                    recordId: first.recordId, recordKey: first.recordKey,
                    payloadMode: accountMode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                    ...(sealedPayload ? { sealedPayload } : { snapshot }), fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
                } });
                expect(written.statusCode, written.body).toBe(200);
            }
            let exactReads = 0;
            const demandMethods: string[] = [];
            let writeEtag: string | undefined;
            const request = async (path: string, init?: RequestInit): Promise<Response> => {
                if (path.includes('/history?')) {
                    const query = JSON.parse(new URL(path, 'https://test.invalid').searchParams.get('query')!);
                    if (query.history) exactReads++;
                    else demandMethods.push(init?.method ?? 'GET');
                }
                const response = await app.inject({ method: init?.method === 'PUT' ? 'PUT' : init?.method === 'HEAD' ? 'HEAD' : 'GET',
                    url: path, headers: { ...headers, ...(init?.body ? { 'content-type': 'application/json' } : {}),
                        ...(new Headers(init?.headers).has('if-none-match') ? { 'if-none-match': new Headers(init?.headers).get('if-none-match')! } : {}) },
                    ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
                if (init?.method === 'PUT') writeEtag = String(response.headers.etag);
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, String(value));
                return new Response(response.statusCode === 304 ? null : response.body, { status: response.statusCode, headers: responseHeaders });
            };
            const read = (projection = demand) => getProviderAccountUsageQuota({ token: 'test' }, { source, projection },
                { accountMode, material, request, nowMs: now, includePendingWork: false });
            const complete = await read();
            expect(complete.pageFacts?.resetWitness?.observedAtMs).toBe(late.observedAtMs);
            expect(demandMethods).toEqual(['GET']);
            // One atomic demand GET owns both the protected body and coverage.
            // Revalidate its actual response, not a separate document or HEAD.
            const demandUrl = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({
                query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
                    { recordId: first.recordId, projection: demand }),
            }).toString()}`;
            const demandRead = await app.inject({ method: 'GET', url: demandUrl, headers });
            expect(demandRead.statusCode, demandRead.body).toBe(200);
            expect(ProviderAccountUsagePageProjectionReadV1Schema.parse(demandRead.json()))
                .toMatchObject({ complete: true, projection: { recordId: first.recordId } });
            expect(demandRead.headers.etag).toEqual(expect.any(String));
            const unchangedDemand = await app.inject({ method: 'GET', url: demandUrl,
                headers: { ...headers, 'if-none-match': String(demandRead.headers.etag) } });
            expect(unchangedDemand.statusCode, unchangedDemand.body).toBe(304);
            expect(unchangedDemand.body).toBe('');
            expect(unchangedDemand.headers.etag).toBe(demandRead.headers.etag);
            expect(unchangedDemand.headers['cache-control']).toBe('private, no-cache');
            expect(unchangedDemand.headers.vary).toContain('Authorization');
            const stored = ProviderAccountUsagePageProjectionReadV1Schema.parse(demandRead.json()).projection!;
            const opened = openProviderAccountUsagePageProjectionV1({ recordId: first.recordId, accountMode, material, content: stored.content });
            const resealed = { ...stored, content: sealProviderAccountUsagePageProjectionV1({ projection: opened, accountMode, material,
                randomBytes: length => new Uint8Array(length).fill(3) }) };
            const acknowledged = await app.inject({ method: 'PUT', url: '/v4/connect/qualified/provider-account-usage/history', headers, payload: resealed });
            expect(acknowledged.statusCode, acknowledged.body).toBe(200);
            expect(acknowledged.headers.etag).toBe(writeEtag); // Actual stored seal, not this client's new ciphertext.
            const retained = await app.inject({ method: 'GET', url: demandUrl, headers });
            expect(retained.json().projection).toEqual(stored);
            expect(retained.headers.etag).toBe(demandRead.headers.etag);
            expect(acknowledged.headers.etag).not.toBe(retained.headers.etag); // GET also validates complete coverage.
            const earlier = await read(earlierDemand);
            expect(earlier.pageFacts?.resetWitness?.observedAtMs).toBe(first.observedAtMs);
            exactReads = 0;
            const recovered = await read();
            expect(recovered.pageFacts?.historyStatus).toBe('complete');
            expect(recovered.pageFacts?.resetWitness).toEqual(complete.pageFacts?.resetWitness);
            expect(exactReads).toBe(1); // Recover only this reader's missing tail.
        });
    });

    it.each(['plain', 'e2ee'] as const)('extends a growing %s prefix for five reads and recovers a concurrent extension conflict', async accountMode => {
        const account = await db.account.create({ data: accountMode === 'plain'
            ? { publicKey: null, encryptionMode: 'plain' }
            : { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'novel-service' }, accountId: `growing-${accountMode}` };
        const source = { ref, bindingKind: 'account' as const };
        const now = Date.now();
        const base = createUsageSnapshot({ fetchedAt: now - 1000 });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const demand = { range: { startAtMs: base.fetchedAtMs - 100, endAtMs: base.fetchedAtMs + 1 }, resolution: 'accepted_observations' as const };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
                content: accountMode === 'plain' ? { t: 'plain', v: { token: 'test' } } : { t: 'encrypted', c: 'fixture-credential' },
                metadata: { scopes: [], providerIdentity: { accountId: base.recordKey.accountSubjectId } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            let accepted = 0;
            const append = async (offset = accepted) => {
                const snapshot = { ...base, fetchedAtMs: base.fetchedAtMs + offset, observedAtMs: base.observedAtMs + offset,
                    meters: base.meters.map(meter => ({ ...meter, used: accepted, utilizationPct: accepted })) };
                const sealedPayload = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                    randomBytes: length => new Uint8Array(length).fill(9) }) : undefined;
                if (offset < 0) {
                    // Seed a retained historical witness. The live current
                    // writer intentionally does not accept an older poll as
                    // a new current reading; its HTTP 200 is not an append.
                    await db.providerAccountUsageHistory.create({ data: { accountId: account.id, recordId: base.recordId,
                        observedAt: new Date(snapshot.fetchedAtMs), payload: {
                            accountId: account.id, recordId: base.recordId, recordKey: base.recordKey,
                            payloadMode: accountMode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                            ...(sealedPayload ? { sealedPayload } : { snapshot }), fetchedAt: snapshot.fetchedAtMs,
                            staleAfterMs: snapshot.staleAfterMs,
                        } } });
                    accepted++;
                    return;
                }
                const response = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                    source, expectedCredentialRevision: credential.json().credentialRevision, expectedConfigurationRevision: null,
                    recordId: base.recordId, recordKey: base.recordKey,
                    payloadMode: accountMode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                    ...(sealedPayload ? { sealedPayload } : { snapshot }), fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
                } });
                expect(response.statusCode, response.body).toBe(200);
                accepted++;
            };
            const traffic: { kind: 'projection' | 'exact' | 'put'; cursor?: { id: string; observedAtMs: number }; status: number }[] = [];
            let beforePut: (() => Promise<void>) | undefined;
            let afterExact: (() => Promise<void>) | undefined;
            // Forward actual 304s; Fetch body replay is not assumed. B retains
            // the already-admitted representation at its existing Resource.
            let documentBytes = 0;
            const projectionDocuments: NonNullable<ProviderAccountUsageQuotaReadOptions['projectionDocuments']> = new Map();
            let unchangedGets = 0;
            const request = async (path: string, init?: RequestInit): Promise<Response> => {
                const query = path.includes('/history?') && init?.method !== 'PUT'
                    ? JSON.parse(new URL(path, 'https://test.invalid').searchParams.get('query')!) : null;
                const hook = beforePut;
                if (init?.method === 'PUT' && hook) { beforePut = undefined; await hook(); }
                const response = await app.inject({ method: init?.method === 'PUT' ? 'PUT' : init?.method === 'HEAD' ? 'HEAD' : 'GET', url: path, headers: {
                    ...headers, ...(init?.body ? { 'content-type': 'application/json' } : {}),
                    ...(new Headers(init?.headers).has('if-none-match') ? { 'if-none-match': new Headers(init?.headers).get('if-none-match')! } : {}),
                }, ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
                if (path.includes('/history') && init?.method !== 'HEAD') traffic.push({ kind: init?.method === 'PUT' ? 'put' : query?.history ? 'exact' : 'projection',
                    ...(query?.history?.cursor ? { cursor: query.history.cursor } : {}), status: response.statusCode });
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, String(value));
                if (query?.projection) {
                    documentBytes += Buffer.byteLength(response.body);
                }
                if (query?.projection && response.statusCode === 304) unchangedGets++;
                if (query?.history && afterExact) {
                    const hook = afterExact; afterExact = undefined; await hook();
                }
                return new Response(response.statusCode === 304 ? null : response.body, { status: response.statusCode, headers: responseHeaders });
            };
            const read = (documents = projectionDocuments) => getProviderAccountUsageQuota({ token: 'test' }, { source, projection: demand },
                { accountMode, material, request, projectionDocuments: documents, nowMs: now, includePendingWork: false });
            const coverage = async () => {
                const row = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: account.id, recordId: base.recordId } } });
                const metadata = row.metadata;
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('pageProjection' in metadata)) throw new Error('Missing projection');
                return StoredProviderAccountUsagePageProjectionV1Schema.parse(metadata.pageProjection);
            };
            await append(); await read();
            const bytesAfterOwnPut = documentBytes;
            await read();
            expect(documentBytes).toBeGreaterThan(bytesAfterOwnPut); // Admit the actual stored winner after PUT.
            const admittedBytes = documentBytes;
            const getsBeforeRepeat = unchangedGets;
            await read();
            expect(unchangedGets - getsBeforeRepeat).toBe(1);
            expect(documentBytes).toBe(admittedBytes);
            const shortPrefix = projectionDocuments.get(base.recordId)!.projection;
            await append();
            await getProviderAccountUsageQuota({ token: 'test' }, { source,
                projection: { ...demand, range: { ...demand.range, endAtMs: base.fetchedAtMs + accepted } } },
                { accountMode, material, request, projectionDocuments: new Map(), nowMs: now, includePendingWork: false });
            const beforeWiderWriter = documentBytes;
            traffic.length = 0;
            const narrowRead = await read();
            expect(documentBytes).toBeGreaterThan(beforeWiderWriter);
            expect(traffic).toEqual([{ kind: 'projection', status: 200 },
                { kind: 'exact', cursor: shortPrefix.frontier, status: 200 }, { kind: 'put', status: 200 }]);
            expect(projectionDocuments.get(base.recordId)!.projection.observationCount).toBe(accepted);
            expect(narrowRead.pageFacts?.resetWitness?.observedAtMs).toBe(base.fetchedAtMs);
            for (let cycle = 0; cycle < 5; cycle++) {
                const prefix = await coverage();
                await append(); await append();
                demand.range.endAtMs = base.fetchedAtMs + accepted;
                traffic.length = 0;
                expect((await read()).pageFacts?.historyStatus).toBe('complete');
                expect(traffic).toEqual([
                    { kind: 'projection', status: 200 }, { kind: 'exact', cursor: prefix.frontier, status: 200 }, { kind: 'put', status: 200 },
                ]);
                expect((await coverage()).observationCount).toBe(accepted);
            }
            const prefix = await coverage();
            await append();
            demand.range.endAtMs = now;
            // A second tab publishes after the first acquired its tail. History
            // then grows again. The first tab retains its own admitted prefix
            // and must reconstruct the complete new tail after its conflict.
            beforePut = async () => {
                await append();
                // Both tabs hold the immutable prefix, with independent reads.
                await read(new Map(projectionDocuments));
                expect((await coverage()).frontier).not.toEqual(prefix.frontier);
                await append();
            };
            traffic.length = 0;
            expect((await read()).pageFacts?.historyStatus).toBe('complete');
            expect(traffic.filter(item => item.kind === 'put').map(item => item.status)).toEqual([200, 409, 200]);
            expect(traffic.filter(item => item.kind === 'projection')).toEqual([
                { kind: 'projection', status: 200 }, { kind: 'projection', status: 200 }, { kind: 'projection', status: 200 },
            ]);
            expect(traffic.filter(item => item.kind === 'exact')).toEqual([
                { kind: 'exact', cursor: prefix.frontier, status: 200 }, { kind: 'exact', cursor: prefix.frontier, status: 200 },
                { kind: 'exact', cursor: prefix.frontier, status: 200 },
            ]);
            expect((await coverage()).observationCount).toBe(accepted);
            await read(); // Admit the last published representation to HTTP.
            const beforeUnchanged = documentBytes;
            traffic.length = 0;
            for (let index = 0; index < 5; index++) {
                demand.range.endAtMs = now + index;
                expect((await read()).pageFacts?.historyStatus).toBe('complete');
            }
            expect(documentBytes - beforeUnchanged).toBe(0);
            expect(traffic).toEqual(Array.from({ length: 5 }, () => ({ kind: 'projection', status: 304 })));
            // Independent tabs share accepted history, not Resource custody.
            // A changed representation is one GET200, followed only by the
            // exact missing tail and server-admitted publication. Unchanged
            // reads remain GET304 without transferring a protected body.
            const otherDocuments: NonNullable<ProviderAccountUsageQuotaReadOptions['projectionDocuments']> = new Map();
            const otherRead = () => getProviderAccountUsageQuota({ token: 'test' }, { source, projection: demand },
                { accountMode, material, request, projectionDocuments: otherDocuments, nowMs: now, includePendingWork: false });
            await otherRead();
            for (let cycle = 0; cycle < 5; cycle++) {
                const heldPrefix = projectionDocuments.get(base.recordId)!.projection;
                await append(); await otherRead();
                demand.range.endAtMs++;
                const beforeOtherWriter = documentBytes;
                traffic.length = 0;
                const extended = await read();
                expect(extended.pageFacts?.historyStatus).toBe('complete');
                expect(documentBytes - beforeOtherWriter).toBeGreaterThan(0);
                expect(traffic).toEqual([{ kind: 'projection', status: 200 },
                    { kind: 'exact', cursor: heldPrefix.frontier, status: 200 }, { kind: 'put', status: 200 }]);
                expect(extended.pageFacts?.resetWitness).toEqual((await otherRead()).pageFacts?.resetWitness);
                traffic.length = 0;
                await read(); // Admit the actual server winner after our PUT.
                expect(traffic).toEqual([{ kind: 'projection', status: 200 }]);
                traffic.length = 0;
                const beforeRepeat = documentBytes;
                await read();
                expect(traffic).toEqual([{ kind: 'projection', status: 304 }]);
                expect(documentBytes).toBe(beforeRepeat);
            }
            // A newly accepted witness inside the held prefix invalidates it.
            // Even after the other tab has rebuilt, the stale reader must open
            // the full corrected body rather than silently append past it.
            await append(-1); await otherRead();
            const beforeBackdated = documentBytes;
            traffic.length = 0;
            expect((await read()).pageFacts?.historyStatus).toBe('complete');
            expect(documentBytes - beforeBackdated).toBeGreaterThan(0);
            expect(traffic).toEqual([{ kind: 'projection', status: 200 }]);
            // A backdated witness arrives after the exact tail is captured.
            // The server PUT must reject that superseded derivation; the same
            // canonical demand loop then opens the current accepted prefix.
            await append(); await otherRead();
            afterExact = async () => { await append(-2); await otherRead(); };
            await read();
            expect(projectionDocuments.get(base.recordId)!.projection.observationCount).toBe(accepted);
            const removed = projectionDocuments.get(base.recordId)!.admitted!.opened.history.entries[0]!;
            await db.providerAccountUsageHistory.delete({ where: { id: removed.id } });
            accepted--;
            await otherRead();
            const beforeRemoval = documentBytes;
            traffic.length = 0;
            await read();
            expect(documentBytes - beforeRemoval).toBeGreaterThan(0);
            expect(traffic).toEqual([{ kind: 'projection', status: 200 }]);
            expect(projectionDocuments.get(base.recordId)!.projection.observationCount).toBe(accepted);
        });
    });

    it.each(['plain', 'e2ee'] as const)('reuses current %s bodies without a metadata marker and refuses unsupported protected bodies', async accountMode => {
        const account = await db.account.create({ data: accountMode === 'plain'
            ? { publicKey: null, encryptionMode: 'plain' }
            : { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'novel-service' }, accountId: `cold-${accountMode}` };
        const source = { ref, bindingKind: 'account' as const };
        const now = Date.now();
        const snapshot = createUsageSnapshot({ fetchedAt: now - 1000 });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const input = { source, projection: { range: { startAtMs: 0, endAtMs: now }, resolution: 'accepted_observations' as const } };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
                content: accountMode === 'plain' ? { t: 'plain', v: { token: 'test' } } : { t: 'encrypted', c: 'fixture-credential' },
                metadata: { scopes: [], providerIdentity: { accountId: snapshot.recordKey.accountSubjectId } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            const sealedPayload = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                randomBytes: length => new Uint8Array(length).fill(9) }) : undefined;
            const written = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                source, expectedCredentialRevision: credential.json().credentialRevision, expectedConfigurationRevision: null,
                recordId: snapshot.recordId, recordKey: snapshot.recordKey,
                payloadMode: accountMode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                ...(sealedPayload ? { sealedPayload } : { snapshot }), fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
            } });
            expect(written.statusCode, written.body).toBe(200);
            let exactGets = 0;
            let puts = 0;
            const request = async (path: string, init?: RequestInit) => {
                if (path.includes('/history')) {
                    if (init?.method === 'PUT') puts++;
                    else if (init?.method !== 'HEAD' && path.includes('/history?')
                        && JSON.parse(new URL(path, 'https://test.invalid').searchParams.get('query')!).history) exactGets++;
                }
                const response = await app.inject({ method: init?.method === 'PUT' ? 'PUT' : init?.method === 'HEAD' ? 'HEAD' : 'GET', url: path, headers: {
                    ...headers, ...(init?.body ? { 'content-type': 'application/json' } : {}),
                }, ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, String(value));
                return new Response(init?.method === 'HEAD' ? null : response.body, { status: response.statusCode, headers: responseHeaders });
            };
            const options = { accountMode, material, request, nowMs: now, includePendingWork: false };
            const first = await getProviderAccountUsageQuota({ token: 'test' }, input, options);
            expect(first.pageFacts?.historyStatus).toBe('complete');
            expect({ exactGets, puts }).toEqual({ exactGets: 1, puts: 1 });
            const where = { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } };
            const row = await db.providerAccountUsageRecord.findUniqueOrThrow({ where });
            const metadata = JSON.parse(JSON.stringify(row.metadata));
            delete metadata.pageProjection.encoding;
            await db.providerAccountUsageRecord.update({ where, data: { metadata } });
            exactGets = 0; puts = 0;
            for (let index = 0; index < 5; index++) {
                const repeated = await getProviderAccountUsageQuota({ token: 'test' }, input, options);
                expect(repeated).toEqual(first);
            }
            expect({ exactGets, puts }).toEqual({ exactGets: 0, puts: 0 });
            // The P5 contract refuses authenticated unsupported bodies rather
            // than rebuilding them (docs/encryption.md, B page-projection format).
            const accepted = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id, recordId: snapshot.recordId } });
            const obsolete = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range: input.projection.range,
                history: { entries: [{ id: accepted.id, observedAtMs: accepted.observedAt.getTime(), snapshot }], nextCursor: null } });
            metadata.pageProjection.content = accountMode === 'plain' ? { t: 'plain', v: obsolete }
                : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection', material,
                    payload: obsolete, randomBytes: length => new Uint8Array(length).fill(3) }) };
            await db.providerAccountUsageRecord.update({ where, data: { metadata } });
            const retainedRetryOptions = { ...options, projectionDocuments: new Map() };
            await expect(getProviderAccountUsageQuota({ token: 'test' }, input, retainedRetryOptions)).rejects.toThrow();
            expect({ exactGets, puts }).toEqual({ exactGets: 0, puts: 0 });
            expect((await db.providerAccountUsageRecord.findUniqueOrThrow({ where })).metadata).toEqual(metadata);
        });
    });

    it('backfills once and preserves exact current, curve, ended-window, reset and price facts', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'novel-service' }, accountId: 'projection-account' };
        const source = { ref, bindingKind: 'account' as const };
        const now = Date.now();
        // Compare the same facts at one read clock; the large retained fixture
        // must not age out its genuine 60-second freshness while the test runs.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        onTestFinished(() => clock.mockRestore());
        const minute = 60_000;
        const week = 7 * 24 * 60 * minute;
        const period = { startMs: now - week, endMs: now + 1 };
        const base = createUsageSnapshot({ fetchedAt: now - 3 * minute });
        const observations = [0, 1, 2, 3].map(index => ({ ...base,
            observedAtMs: now + [-3, -2.5, -1, 0][index]! * minute,
            fetchedAtMs: now + [-3, -2.5, -1, 0][index]! * minute,
            diagnostics: [{ kind: 'provider_http' as const, observedAtMs: now + index,
                status: 200, headers: { 'x-request-id': `request-${index}` } }],
            meters: base.meters.map(meter => ({ ...meter, used: index % 2 ? 80 : 20,
                remaining: index % 2 ? 20 : 80, utilizationPct: index % 2 ? 80 : 20, usedPct: index % 2 ? 80 : 20,
                remainingPct: index % 2 ? 20 : 80,
                resetsAt: index < 2 ? now - 2 * minute : now - 2 * minute + week, windowDurationMs: week,
            })),
            subscription: { status: 'subscribed' as const, renewal: 'on' as const,
                observedAtMs: now, staleAfterMs: 60_000, currentPeriodStartAtMs: now - week - 8 * minute,
                currentPeriodEndAtMs: now + 2 * minute,
                monetaryFacts: [{ kind: 'list' as const, amount: 20, currency: 'USD',
                    source: { kind: 'published' as const, id: 'fixture-price', version: '1' },
                    period: { startAtMs: now - week - 8 * minute, endAtMs: now + 2 * minute }, effectiveAtMs: now - week - 8 * minute, asOfMs: now }],
            },
        }));
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null, content: { t: 'plain', v: { token: 'test' } },
                metadata: { scopes: [], providerIdentity: { accountId: base.recordKey.accountSubjectId } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            for (const snapshot of observations) {
                const written = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                    source, expectedCredentialRevision: credential.json().credentialRevision, expectedConfigurationRevision: null, recordId: base.recordId, recordKey: base.recordKey,
                    payloadMode: 'plain_json_v1', status: 'ok', snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
                } });
                expect(written.statusCode, written.body).toBe(200);
            }
            // Retained QA-shaped history: six days of near-identical 12-second
            // polls, including per-fetch diagnostics. The current writer above
            // and all projection acquisition/publication below use real HTTP.
            const earlier = Array.from({ length: 44_996 }, (_, index) => {
                const fetchedAt = now - 3 * minute - (44_996 - index) * 12_000 + index % 7;
                const used = Math.floor(index / 20) / 150;
                const snapshot = { ...observations[0]!, fetchedAtMs: fetchedAt, observedAtMs: fetchedAt - index % 3,
                    meters: observations[0]!.meters.map(meter => ({ ...meter, used, utilizationPct: used,
                        remaining: 100 - used, remainingPct: 100 - used, usedPct: used })) };
                return { accountId: account.id, recordId: base.recordId, observedAt: new Date(fetchedAt),
                    payload: { accountId: account.id, recordId: base.recordId, recordKey: base.recordKey,
                        payloadMode: 'plain_json_v1', status: 'ok', snapshot,
                        fetchedAt, staleAfterMs: snapshot.staleAfterMs } };
            });
            await db.providerAccountUsageHistory.createMany({ data: earlier });
            let exactPages = 0;
            let projectionReads = 0;
            let projectionWrites = 0;
            let projectionBytes = 0;
            let exactBytes = 0;
            let conditionalGets = 0;
            // Only network/authentication and unrelated A/feature services are fixture boundaries.
            // B reads and writes use the real registered handler, admission and disposable SQLite.
            const request = async (path: string, init?: RequestInit) => {
                const query = path.includes('/history?') && init?.method !== 'PUT'
                    ? JSON.parse(new URL(path, 'https://usage-projection.test').searchParams.get('query')!) : null;
                if (path.includes('/history') && init?.method === 'PUT') projectionWrites++;
                if (init?.method !== 'HEAD' && init?.method !== 'PUT') {
                    if (query?.history) exactPages++;
                }
                const response = await app.inject({ method: init?.method === 'PUT' ? 'PUT' : init?.method === 'HEAD' ? 'HEAD' : 'GET', url: path,
                    headers: { ...headers, ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}),
                        ...(new Headers(init?.headers).has('if-none-match') ? { 'if-none-match': new Headers(init?.headers).get('if-none-match')! } : {}) },
                    ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
                if (init?.method !== 'HEAD' && init?.method !== 'PUT') {
                    if (query?.history) exactBytes += Buffer.byteLength(response.body);
                    if (query?.projection) {
                        if (response.statusCode === 200) projectionReads++;
                        projectionBytes += Buffer.byteLength(response.body);
                    }
                }
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, String(value));
                if (query?.projection && response.statusCode === 304) conditionalGets++;
                return new Response(response.statusCode === 304 ? null : response.body, { status: response.statusCode, headers: responseHeaders });
            };
            const baseline = await getProviderAccountUsageQuota({ token: 'test' }, { source,
                history: { range: { startAtMs: period.startMs, endAtMs: period.endMs }, pageSize: 45_000 } },
            { accountMode: 'plain', request, nowMs: now, includePendingWork: false });
            expect(baseline.history?.entries).toHaveLength(45_000);
            const connectedAccountsV4 = [{ ref, status: 'connected' as const, authenticationModeId: 'manual', revisionSemantics: 'revisioned' as const,
                credentialRevision: credential.json().credentialRevision, configurationReady: false, configurationRevision: null, scopes: [] }];
            const home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-projection.test', accountId: account.id,
                profile: { connectedAccountsV4 } }],
                route: async received => {
                    if (received.path.startsWith('/v4/connect/qualified/')) return request(received.url.pathname + received.url.search, {
                        method: received.method, headers: received.headers, ...(received.body ? { body: JSON.stringify(received.body) } : {}),
                    });
                    if (received.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                    if (received.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                    if (received.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
                    if (received.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
                        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
                    return undefined;
                } });
            let release: (() => void) | undefined;
            let descriptorLifetime: Parameters<typeof retireConnectedAccountDescriptorProjection>[0] | undefined;
            try {
                publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
                const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
                let captured = captureUiUsageQueryAccountContext(credentials)!;
                const installUsageDeclaration = () => {
                    descriptorLifetime = captured.accountLifetime;
                    installConnectedAccountDescriptorProjection({
                        scopeKey: 'usage-projection', status: 'ready', conflicts: [], errorReason: null,
                        descriptors: [ConnectedAccountUiProjectionEntryV1Schema.parse({
                            id: ref.service.localId, serviceId: ref.service.localId, pluginId: ref.service.pluginId,
                            title: 'Fixture usage service', provenance: 'external', sourceKind: 'installed',
                            authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
                                outcomeReconciliation: 'none', fields: [] }] },
                            capabilities: ['usage'], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
                        })],
                    }, descriptorLifetime);
                };
                installUsageDeclaration();
                storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: account.id,
                    connectedAccountsV4 }) });
                await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
                let entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
                    normalizeUsageQuery({ period, includeSessionEvidence: false, includeWorkEvidence: false }),
                ] }) });
                await profileCold('resource-first', async () => {
                    release = entry.subscribe(() => {}, true);
                    // This source integration opens and persists 45k accepted samples.
                    await expect.poll(() => entry.getSnapshot().pending, { timeout: largeHistoryTestTimeoutMs }).toBe('idle');
                });
                expect(entry.getSnapshot().error).toBeUndefined();
                const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
                expect(slice.sources.find(row => row.source.startsWith('quota:'))?.status).toBe('available');
                const projected = slice.quota![0]!;
                expect(projected.history).toBeUndefined();
                expect(projected.pageProjection).toBeUndefined();
                const earlierCurve = projected.pageFacts!.earlierCurves[0]!.value;
                expect(earlierCurve.status).toBe('available');
                if (earlierCurve.status !== 'available') throw new Error('Expected all historical curve points');
                expect(earlierCurve.curves.flatMap(curve => curve.points)).toHaveLength(44_998);
                expect(baseline.history?.entries[0]?.snapshot.diagnostics).toEqual(observations[0]!.diagnostics);
                expect(getProviderAccountUsageQuotaHistoryV1(projected)).toBeUndefined();
                const facts = (read: typeof baseline) => {
                    const plans = projectUsagePlans([read], now, slice.pools, slice.sources);
                    const plan = plans.accounts[0]!;
                    const { read: _read, ...accountFacts } = plan;
                    return { account: accountFacts, events: plans.events,
                        past: projectUsagePastCycles(plan), curves: projectUsageEarlierCurves(plan, 'weekly'),
                        fit: summarizeUsagePlanFit(plan, null), reset: resolveUsageResetStartBinding(plan, 'weekly', now),
                        credits: adviseUsageBankedReset(plan), unused: read.unusedCapacity,
                        insights: projectUsagePlanInsights({ query: slice.requestedQuery, nowMs: now, quota: [read] }) };
                };
                expect(facts(projected)).toEqual(facts(baseline));
                expect(facts(projected).account.windows[0]?.pace).not.toBeNull();
                expect(facts(projected).past.cycles[0]?.value.status).toBe('available');
                expect(facts(projected).account.prices.list?.amount).toBe(20);
                expect(facts(projected).insights.accounts[0]?.pricePerReset[0]).toMatchObject({ status: 'available', recordedResetCount: 1 });
                const retainedMetadata = (await db.providerAccountUsageRecord.findUniqueOrThrow({
                    where: { accountId_recordId: { accountId: account.id, recordId: base.recordId } }, select: { metadata: true },
                })).metadata;
                if (!retainedMetadata || typeof retainedMetadata !== 'object' || Array.isArray(retainedMetadata)) throw new Error('Expected persisted projection');
                const { encoding: _hint, ...unmarked } = StoredProviderAccountUsagePageProjectionV1Schema.parse(retainedMetadata.pageProjection);
                await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: base.recordId } },
                    data: { metadata: { ...retainedMetadata, pageProjection: unmarked } } });
                // A cold batch has no previous Resource value. Persisted B serves
                // both distinct queries once, with no exact-page transfer.
                const beforeCold = { exactPages, exactBytes, projectionReads, projectionBytes, projectionWrites };
                release(); release = undefined;
                retireActiveServerAccountScopeLifetime();
                publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 1 });
                captured = captureUiUsageQueryAccountContext(credentials)!;
                installUsageDeclaration();
                entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
                    normalizeUsageQuery({ period, metric: 'tokens', includeSessionEvidence: false, includeWorkEvidence: false }),
                    normalizeUsageQuery({ period, metric: 'cost', includeSessionEvidence: false, includeWorkEvidence: false }),
                ] }) });
                await profileCold('cold-plans-coach', async () => {
                    release = entry.subscribe(() => {}, true);
                    await expect.poll(() => entry.getSnapshot().pending, { timeout: largeHistoryTestTimeoutMs }).toBe('idle');
                });
                expect(entry.getSnapshot().error).toBeUndefined();
                const cold = decodeUsageQueryResource(entry.getSnapshot().value!);
                expect(exactPages).toBe(beforeCold.exactPages);
                expect(exactBytes).toBe(beforeCold.exactBytes);
                expect(projectionWrites).toBe(beforeCold.projectionWrites);
                expect(projectionReads - beforeCold.projectionReads).toBe(1);
                expect(projectionBytes - beforeCold.projectionBytes).toBeLessThan(exactBytes / 3);
                const pageBytes = Buffer.byteLength(JSON.stringify(cold.results.map(row => row.quota)));
                const rawBytes = Buffer.byteLength(JSON.stringify(cold.results.map(() => [baseline])));
                expect(pageBytes).toBeLessThan(rawBytes);
                for (const row of cold.results) expect(facts(row.quota![0]!)).toEqual(facts(baseline));
                console.info(JSON.stringify({ coldQueries: cold.results.length, projectionReads: projectionReads - beforeCold.projectionReads,
                    exactPages: exactPages - beforeCold.exactPages, exactBytes: exactBytes - beforeCold.exactBytes,
                    projectionBytes: projectionBytes - beforeCold.projectionBytes, pageBytes, rawBytes }));
                // Concurrent batches share the Account Resource's held B
                // representation, without a document or Account-change echo.
                const beforeTabs = { exactPages, exactBytes, projectionReads, projectionWrites };
                const beforeCursor = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                const beforeRecord = await db.providerAccountUsageRecord.findUniqueOrThrow({
                    where: { accountId_recordId: { accountId: account.id, recordId: base.recordId } },
                    select: { metadata: true, updatedAt: true },
                });
                const tabs = await Promise.all([period, { ...period, endMs: period.endMs + minute }].map(tabPeriod =>
                    readUiUsageQueryBatch(captured, { queries: [
                        normalizeUsageQuery({ period: tabPeriod, metric: 'tokens', includeSessionEvidence: false, includeWorkEvidence: false }),
                        normalizeUsageQuery({ period: tabPeriod, metric: 'cost', includeSessionEvidence: false, includeWorkEvidence: false }),
                    ] })));
                expect(projectionReads - beforeTabs.projectionReads).toBe(0);
                expect(exactPages).toBe(beforeTabs.exactPages);
                expect(exactBytes).toBe(beforeTabs.exactBytes);
                expect(projectionWrites).toBe(beforeTabs.projectionWrites);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(beforeCursor);
                expect(await db.providerAccountUsageRecord.findUniqueOrThrow({
                    where: { accountId_recordId: { accountId: account.id, recordId: base.recordId } },
                    select: { metadata: true, updatedAt: true },
                })).toEqual(beforeRecord);
                for (const tab of tabs) for (const row of tab.results) expect(facts(row.quota![0]!)).toEqual(facts(baseline));
                const before = exactPages;
                await entry.refresh();
                expect(conditionalGets).toBeGreaterThan(0);
                expect(projectionReads).toBe(beforeTabs.projectionReads);
                expect(entry.getSnapshot().error).toBeUndefined();
                expect(entry.getSnapshot().pending).toBe('idle');
                expect(exactPages).toBe(before);
                expect(projectionWrites).toBe(beforeTabs.projectionWrites);
                expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.pending).toBe(false);
                expect(facts(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota![0]!)).toEqual(facts(baseline));
            } finally {
                release?.();
                if (descriptorLifetime) retireConnectedAccountDescriptorProjection(descriptorLifetime);
                await home.dispose();
            }
        }, { bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
    }, largeHistoryTestTimeoutMs);
});
