import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { sealProviderAccountUsageSnapshot, openSealedProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol/connect/account-usage-primitives';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

async function activateTestHome() {
    const { upsertAndActivateServer, setAccountServiceEndpoint } = await import('@/sync/domains/server/serverRuntime');
    // This node harness has no browser sessionStorage; use the durable selection.
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
    await setAccountServiceEndpoint({ url: 'https://api.example.test', displayName: 'Test service', source: 'user' });
}

function makeSnapshot(): ProviderAccountUsageSnapshotV1 {
    const recordKey = {
        providerId: 'codex',
        accountSubjectId: 'acct_stable',
        subjectKind: 'account',
        quotaScope: 'account',
    } satisfies ProviderAccountUsageSnapshotV1['recordKey'];
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: {
            kind: 'providerSubject',
            id: 'acct_stable',
        },
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 2,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: null,
        accountLabel: null,
        meters: [],
        recoveryCreditDetails: { saved: { remainingCount: 2, appliesToProviderLimitIds: ['seven_day'], unavailableReason: 'paused' } },
    });
}

async function loadApi() {
    return await import('./apiProviderAccountUsage');
}

describe('apiProviderAccountUsage', () => {
    it('borrows the quota record acquisition from the snapshot row owner without borrowing its cancellation', async () => {
        await activateTestHome();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { createCapturedServerReadTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport');
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
        const serverId = getActiveServerSnapshot().serverId;
        const profile = getServerProfileById(serverId);
        if (!profile) throw new Error('Expected the activated Home profile');
        const readTransport = createCapturedServerReadTransport({ serverId, profile, credentials });
        const held = createDeferred<void>();
        const snapshot = makeSnapshot();
        const source = { bindingKind: 'account' as const,
            ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' } };
        let records = 0;
        let sources = 0;
        const purposes: Array<string | null> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
            purposes.push(new Headers(init?.headers).get('X-Happier-Request-Purpose'));
            if (String(input).includes('/sources/resolve')) {
                sources += 1;
                return Response.json({ source, recordId: snapshot.recordId,
                    providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 });
            }
            records += 1;
            await held.promise;
            return Response.json({ content: { t: 'plain', v: snapshot },
                metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] });
        }));
        const { getProviderAccountUsageQuota, getProviderAccountUsageSnapshotPlain } = await loadApi();
        const abort = new AbortController();
        const rowOptions = { readTransport, retry: 'none' as const, signal: abort.signal };
        const row = getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId }, rowOptions);
        void row.catch(() => {});
        let quota: ReturnType<typeof getProviderAccountUsageQuota> | undefined;
        try {
            await vi.waitFor(() => expect(records).toBe(1));
            quota = getProviderAccountUsageQuota(credentials, { source },
                { accountMode: 'plain', readTransport, includePendingWork: false });
            await vi.waitFor(() => expect(sources).toBe(1));
            await flushHookEffects({ cycles: 20 });
            expect(records).toBe(1);
            abort.abort();
            held.resolve();
            await expect(row).rejects.toMatchObject({ name: 'AbortError' });
            expect((await quota).current).toEqual(snapshot);
            expect(purposes).toEqual(['connected-accounts:quota-qualification', 'connected-accounts:quota-qualification']);
        } finally { held.resolve(); await Promise.allSettled([quota, row]); }
    });

    it('shares admitted source and record transport across current and history demand without caching a result', async () => {
        await activateTestHome();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { createCapturedServerReadTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport');
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const serverId = getActiveServerSnapshot().serverId;
        const profile = getServerProfileById(serverId);
        if (!profile) throw new Error('Expected the activated Home profile');
        const readTransport = createCapturedServerReadTransport({ serverId, profile, credentials });
        const held = createDeferred<void>();
        const snapshot = makeSnapshot();
        const source = { bindingKind: 'account' as const,
            ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' } };
        const record = { content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        const counts = new Map<string, number>();
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
            const path = new URL(String(input)).pathname;
            counts.set(path, (counts.get(path) ?? 0) + 1);
            await held.promise;
            return Response.json(path.endsWith('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 }
                : path.endsWith('/history') ? { entries: [{ id: 'accepted', observedAtMs: 1, record }], nextCursor: null } : record);
        }));
        const { getProviderAccountUsageQuota } = await loadApi();
        const options = { accountMode: 'plain' as const, readTransport, includePendingWork: false };
        const current = getProviderAccountUsageQuota(credentials, { source }, options);
        const history = getProviderAccountUsageQuota(credentials, { source,
            history: { range: { startAtMs: 0, endAtMs: 5 }, pageSize: 1 } }, options);
        try {
            await vi.waitFor(() => expect(counts.size).toBeGreaterThan(0));
            held.resolve();
            expect((await current).current).toEqual(snapshot);
            expect((await history).history?.entries[0]?.snapshot).toEqual(snapshot);
            expect(counts.get('/v4/connect/qualified/provider-account-usage/sources/resolve')).toBe(1);
            expect(counts.get('/v4/connect/qualified/provider-account-usage/record')).toBe(1);
            expect(counts.get('/v4/connect/qualified/provider-account-usage/history')).toBe(1);
            await getProviderAccountUsageQuota(credentials, { source }, options);
            expect(counts.get('/v4/connect/qualified/provider-account-usage/record')).toBe(2);
        } finally { held.resolve(); await Promise.allSettled([current, history]); }
    });

    it.each(['plain', 'e2ee'] as const)('returns a %s snapshot failure to its observation owner without an adapter retry', async mode => {
        await activateTestHome();
        let reads = 0;
        const snapshot = makeSnapshot();
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
            if (++reads === 1) return Response.json({ error: 'storage_unavailable' }, { status: 503 });
            return Response.json({ content: mode === 'plain' ? { t: 'plain', v: snapshot }
                : { t: 'encrypted', c: 'ciphertext' }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [] });
        }));
        const api = await loadApi();
        const read = mode === 'plain' ? api.getProviderAccountUsageSnapshotPlain : api.getProviderAccountUsageSnapshotSealed;
        await expect(read(credentials, { recordId: snapshot.recordId }, { retry: 'none' })).rejects.toThrow();
        expect(reads).toBe(1);
        await expect(read(credentials, { recordId: snapshot.recordId }, { retry: 'none' })).resolves.not.toBeNull();
        expect(reads).toBe(2);
        // Standalone callers still own the established finite backoff.
        reads = 0;
        await expect(read(credentials, { recordId: snapshot.recordId })).resolves.not.toBeNull();
        expect(reads).toBe(2);
    });

    it.each(['plain', 'e2ee'] as const)('deduplicates concurrent %s backfill publication without holding independent reads', async accountMode => {
        await activateTestHome();
        const { ProviderAccountUsagePageProjectionWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
        const snapshot = makeSnapshot();
        const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' } };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
        const record = { content: accountMode === 'plain' ? { t: 'plain', v: snapshot }
            : { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails },
            metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        let persisted: ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse> | null = null;
        let writes = 0;
        let failedHeads = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path.includes('/sources/resolve')) return Response.json({ source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 });
            if (path.includes('/record?')) return Response.json(record);
            if (init?.method === 'HEAD') {
                if (failedHeads > 0) { failedHeads--; return new Response(null, { status: 500 }); }
                return new Response(null, { headers: {
                    'x-happier-usage-projection-complete': String(persisted !== null), ...(persisted ? { etag: '"one"' } : {}),
                } });
            }
            if (init?.method === 'PUT') {
                writes++; persisted = ProviderAccountUsagePageProjectionWriteV1Schema.parse(JSON.parse(String(init.body)));
                return Response.json({ success: true }, { headers: { etag: '"one"' } });
            }
            const query = JSON.parse(new URL(path, 'https://test.invalid').searchParams.get('query')!);
            return Response.json(query.projection ? { projection: persisted, complete: persisted !== null }
                : { entries: [{ id: 'accepted', observedAtMs: 1, record }], nextCursor: null });
        };
        const { getProviderAccountUsageQuota } = await loadApi();
        const projectionDocuments: import('./apiProviderAccountUsage').ProviderAccountUsageProjectionDocuments = new Map();
        const input = { source, projection: { range: { startAtMs: 0, endAtMs: 5 }, resolution: 'accepted_observations' as const } };
        const options = { accountMode, material, request, nowMs: 1, includePendingWork: false, projectionDocuments };
        // Randomness is the crypto boundary: an identical locally accepted
        // publication must not repack/seal a second ciphertext that is discarded.
        const cryptoRandom = await import('@/platform/cryptoRandom');
        const randomBytes = vi.spyOn(cryptoRandom, 'getRandomBytes');
        try {
            const values = await Promise.all([getProviderAccountUsageQuota({ token: 'test-token' }, input, options),
                getProviderAccountUsageQuota({ token: 'test-token' }, input, options)]);
            expect(values.map(value => value.pageFacts?.resetWitness?.id)).toEqual(['accepted', 'accepted']);
            expect(writes).toBe(1);
            expect(randomBytes).toHaveBeenCalledTimes(accountMode === 'e2ee' ? 1 : 0);
        } finally { randomBytes.mockRestore(); }
        await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        expect(writes).toBe(1);
        const narrow = await getProviderAccountUsageQuota({ token: 'test-token' }, { ...input,
            projection: { ...input.projection, range: { startAtMs: 2, endAtMs: 5 } } }, options);
        expect(narrow.pageFacts?.resetWitness).toBeNull();
        failedHeads = 1;
        const recovered = await Promise.allSettled([getProviderAccountUsageQuota({ token: 'test-token' }, input, options),
            getProviderAccountUsageQuota({ token: 'test-token' }, input, options)]);
        expect(recovered.map(value => value.status)).toEqual(['rejected', 'fulfilled']);
    });
    it.each(['plain', 'e2ee'] as const)('retains admitted %s page facts across unchanged ETags and independent facets', async accountMode => {
        await activateTestHome();
        const { buildProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
        const { sealProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto');
        const snapshot = { ...makeSnapshot(), subscription: { status: 'subscribed' as const, renewal: 'on' as const,
            observedAtMs: 1, staleAfterMs: 2 } };
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const range = { startAtMs: 0, endAtMs: 5 };
        let etag = '"one"';
        let mode = accountMode;
        let headStatus = 200;
        let bodyReads = 0;
        let includeCurrent = true;
        const record = () => {
            const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
            return { content: mode === 'plain' ? { t: 'plain', v: snapshot } : { t: 'encrypted', c: sealed.ciphertext,
                subscription: sealed.subscription, recoveryCreditDetails: sealed.recoveryCreditDetails },
                metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        };
        const request = async (path: string, init?: RequestInit) => {
            if (path.includes('/history')) {
                if (init?.method === 'HEAD') return new Response(null, { status: headStatus,
                    headers: { etag, 'x-happier-usage-projection-complete': 'true' } });
                bodyReads++;
                const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range,
                    history: { entries: [{ id: 'accepted', observedAtMs: 1, snapshot }], nextCursor: null } });
                return Response.json({ projection: { recordId: snapshot.recordId, demand: { range, resolution: 'accepted_observations' },
                    observationCount: 1, frontier: { id: 'accepted', observedAtMs: 1 },
                    content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode,
                        material, randomBytes: length => new Uint8Array(length).fill(9) }) }, complete: true }, { headers: { etag } });
            }
            if (path.includes('/record?') && !includeCurrent) return new Response(null, { status: 404 });
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : record());
        };
        const { getProviderAccountUsageQuota } = await loadApi();
        const projectionDocuments: import('./apiProviderAccountUsage').ProviderAccountUsageProjectionDocuments = new Map();
        const options = { accountMode, material, request, projectionDocuments, nowMs: 1, includePendingWork: false };
        const input = { source, projection: { range, resolution: 'accepted_observations' as const } };
        const first = await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        expect(first.pageFacts?.resetWitness?.id).toBe('accepted');
        headStatus = 304;
        const second = await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        expect(bodyReads).toBe(1);
        expect(second.pageFacts).toBe(first.pageFacts);
        expect(second.unusedCapacity).toBe(first.unusedCapacity);
        const targets = [{ id: 'target', scope: { kind: 'personal' as const }, utilizationFraction: 0.75 }];
        const changedTargets = await getProviderAccountUsageQuota({ token: 'test-token' }, input, { ...options,
            readPacingTargets: async () => targets });
        expect(changedTargets.targets).toEqual(targets);
        expect(changedTargets.pageFacts).toBe(first.pageFacts);
        expect(changedTargets.unusedCapacity).toBe(first.unusedCapacity);
        const enteredMonthlyPrice = { amount: 25, currency: 'USD', enteredAtMs: 1 };
        const changedPrice = await getProviderAccountUsageQuota({ token: 'test-token' }, input, { ...options,
            readEnteredMonthlyPrice: async () => enteredMonthlyPrice });
        expect(changedPrice.current?.subscription?.enteredMonthlyPrice).toEqual(enteredMonthlyPrice);
        expect(changedPrice.pageFacts).toBe(first.pageFacts);
        expect(changedPrice.unusedCapacity).toBe(first.unusedCapacity);
        const advancedClock = await getProviderAccountUsageQuota({ token: 'test-token' }, input, { ...options, nowMs: 2 });
        expect(advancedClock.pageFacts).toBe(first.pageFacts);
        const narrower = await getProviderAccountUsageQuota({ token: 'test-token' }, { ...input,
            projection: { ...input.projection, range: { startAtMs: 2, endAtMs: 5 } } }, options);
        expect(narrower.pageFacts?.resetWitness).toBeNull();
        etag = '"two"'; headStatus = 200;
        const replaced = await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        expect(bodyReads).toBe(2);
        expect(replaced.pageFacts).not.toBe(first.pageFacts);
        if (accountMode === 'e2ee') {
            // With no current record, only the retained projection can enforce
            // the material fence; a current-record decrypt must not mask it.
            includeCurrent = false;
            await expect(getProviderAccountUsageQuota({ token: 'test-token' }, input, { ...options,
                material: { type: 'legacy', secret: new Uint8Array(32).fill(8) } }))
                .rejects.toThrow('provider_account_usage_content_unavailable');
            includeCurrent = true;
        }
        headStatus = 401;
        await expect(getProviderAccountUsageQuota({ token: 'test-token' }, input, options)).rejects.toMatchObject({ code: 'denied' });
        headStatus = 304;
        mode = accountMode === 'plain' ? 'e2ee' : 'plain';
        await expect(getProviderAccountUsageQuota({ token: 'test-token' }, input, { ...options, accountMode: mode }))
            .rejects.toThrow('provider_account_usage_content_mode_mismatch');
    });

    it.each(['plain', 'e2ee'] as const)('derives unchanged %s observations once across rolling range and clock reads, but keeps reset and stale transitions', async accountMode => {
        await activateTestHome();
        const { buildProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
        const { sealProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto');
        let snapshot: ProviderAccountUsageSnapshotV1 = { ...makeSnapshot(), staleAfterMs: 1_000,
            meters: [{ meterId: 'quota', label: 'Quota', used: 20, limit: 100, utilizationPct: 20,
                unit: 'requests', status: 'ok', resetsAt: 100, resetAtMs: 100, windowDurationMs: 100, details: {} }] };
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const range = { startAtMs: 0, endAtMs: 500 };
        const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range,
            history: { entries: [{ id: 'accepted', observedAtMs: 1, snapshot }], nextCursor: null } });
        const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode, material,
            randomBytes: length => new Uint8Array(length).fill(9) });
        let bodyReads = 0;
        let backfill = false;
        let writes = 0;
        let etag = '"one"';
        const request = async (path: string, init?: RequestInit) => {
            if (path.includes('/history')) {
                if (init?.method === 'PUT') { writes++; etag = '"two"'; return Response.json({ ok: true }, { headers: { etag } }); }
                if (init?.method === 'HEAD') return new Response(null, { status: bodyReads ? 304 : 200,
                    headers: { etag, 'x-happier-usage-projection-complete': backfill ? 'false' : 'true' } });
                if (backfill) return Response.json({ entries: [], nextCursor: null });
                bodyReads++;
                return Response.json({ projection: { recordId: snapshot.recordId, demand: { range, resolution: 'accepted_observations' },
                    observationCount: 1, frontier: { id: 'accepted', observedAtMs: 1 }, content }, complete: true }, { headers: { etag: '"one"' } });
            }
            const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs }
                : { content: accountMode === 'plain' ? { t: 'plain', v: snapshot } : { t: 'encrypted', c: sealed.ciphertext,
                    subscription: sealed.subscription, recoveryCreditDetails: sealed.recoveryCreditDetails },
                    metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] });
        };
        const { getProviderAccountUsageQuota } = await loadApi();
        const projectionDocuments: import('./apiProviderAccountUsage').ProviderAccountUsageProjectionDocuments = new Map();
        const options = { accountMode, material, request, projectionDocuments, includePendingWork: false };
        const read = (nowMs: number, startAtMs = 0, endAtMs = 5) => getProviderAccountUsageQuota({ token: 'test-token' },
            { source, projection: { range: { startAtMs, endAtMs }, resolution: 'accepted_observations' } }, { ...options, nowMs });
        const first = await read(1);
        expect(first.pace[0]?.value.status).toBe('available');
        const admittedSnapshot = projectionDocuments.get(snapshot.recordId)!.admitted!.opened.history.entries[0]!.snapshot;
        const meters = admittedSnapshot.meters;
        let historyMeterReads = 0;
        // Transparent access instrumentation preserves the real admitted history and derivation logic.
        Object.defineProperty(admittedSnapshot, 'meters', { configurable: true, get() { historyMeterReads++; return meters; } });
        for (let nowMs = 2; nowMs <= 6; nowMs++) {
            const repeated = await read(nowMs, 0, nowMs + 5);
            expect(repeated.pageFacts).toBe(first.pageFacts);
            expect(repeated.pace).toBe(first.pace);
            expect(repeated.unusedCapacity).toBe(first.unusedCapacity);
        }
        expect(historyMeterReads).toBe(0);
        expect(bodyReads).toBe(1);
        // Re-admitting an empty tail changes publication custody, not its observations.
        backfill = true;
        const extended = await read(7, 0, 501);
        backfill = false;
        expect(writes).toBe(1);
        expect(extended.pageFacts).toBe(first.pageFacts);
        expect(extended.pace).toBe(first.pace);
        expect(extended.unusedCapacity).toBe(first.unusedCapacity);
        const reset = await read(100);
        expect(reset.pace[0]?.value).toEqual({ status: 'unavailable', reason: 'outside_window' });
        expect(reset.unusedCapacity?.windows).toHaveLength(1);
        const stale = await read(1_001);
        expect(stale.pace[0]?.value).toEqual({ status: 'unavailable', reason: 'stale' });
        const reversed = await read(2);
        expect(reversed.pace).toEqual(first.pace);
        expect(reversed.unusedCapacity?.windows).toHaveLength(0);
        snapshot = { ...snapshot, observedAtMs: 2, fetchedAtMs: 2,
            meters: snapshot.meters.map(meter => ({ ...meter, used: 30, utilizationPct: 30 })) };
        const changed = await read(3);
        expect(changed.pace).not.toEqual(first.pace);
        expect(changed.current?.fetchedAtMs).toBe(2);
        const narrower = await read(3, 2);
        expect(narrower.pageFacts?.resetWitness).toBeNull();
        expect(bodyReads).toBe(1);
    });

    it('derives pace and unused capacity once per read: later facets of the same read share its instant', async () => {
        await activateTestHome();
        const { buildProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
        const { sealProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto');
        const snapshot = makeSnapshot();
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const range = { startAtMs: 0, endAtMs: 5 };
        const request = async (path: string, init?: RequestInit) => {
            if (path.includes('/history')) {
                if (init?.method === 'HEAD') return new Response(null, { headers: { etag: '"one"', 'x-happier-usage-projection-complete': 'true' } });
                const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range,
                    history: { entries: [{ id: 'accepted', observedAtMs: 1, snapshot }], nextCursor: null } });
                return Response.json({ projection: { recordId: snapshot.recordId, demand: { range, resolution: 'accepted_observations' },
                    observationCount: 1, frontier: { id: 'accepted', observedAtMs: 1 },
                    content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain',
                        material: undefined, randomBytes: length => new Uint8Array(length).fill(9) }) }, complete: true }, { headers: { etag: '"one"' } });
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 }
                : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] });
        };
        // The wall clock advances between any two reads, as it does live.
        let clock = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => clock += 1_000);
        const progress: ConnectedServiceQuotaGetResultV1[] = [];
        const { getProviderAccountUsageQuota } = await loadApi();
        const final = await getProviderAccountUsageQuota({ token: 'test-token' }, { source, projection: { range, resolution: 'accepted_observations' as const } }, {
            accountMode: 'plain', request, projectionDocuments: new Map(), includePendingWork: false,
            readPacingTargets: async () => [], readEnteredMonthlyPrice: async () => undefined,
            readAllHistory: { onProgress: value => { progress.push(value); } },
        });
        const withFacts = progress.filter(value => value.pageFacts);
        expect(withFacts.length).toBeGreaterThan(0);
        expect(final.unusedCapacity).toBe(withFacts.at(-1)!.unusedCapacity);
        expect(final.pace).toBe(withFacts.at(-1)!.pace);
    });

    it.each(['plain', 'e2ee'] as const)('rereads a %s projection conflict and never republishes unchanged idle reads', async accountMode => {
        const { ProviderAccountUsagePageProjectionWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
        const snapshot = makeSnapshot();
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
        const record = { content: accountMode === 'plain' ? { t: 'plain', v: snapshot } : { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails },
            metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        let persisted: ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse> | null = null;
        let puts = 0;
        let projectionReads = 0;
        let exactReads = 0;
        let headStatus = 200;
        let invalidateAfterHead = false;
        const projectionBodyUrls: string[] = [];
        const request = async (path: string, init?: RequestInit) => {
            if (path.includes('/history')) {
                if (init?.method === 'HEAD') return new Response(null, { status: headStatus, headers: {
                    'x-happier-usage-projection-complete': persisted !== null ? 'true' : 'false',
                    ...(persisted ? { etag: '"held-document"' } : {}),
                } });
                if (path.includes('/history/document?')) {
                    projectionReads++;
                    projectionBodyUrls.push(path);
                    // A backdated accepted observation can invalidate the
                    // stored prefix after HEAD admitted the previous one.
                    if (invalidateAfterHead) { persisted = null; invalidateAfterHead = false; }
                    return Response.json({ projection: persisted, complete: persisted !== null }, {
                        headers: persisted ? { etag: '"held-document"' } : {},
                    });
                }
                if (init?.method === 'PUT') {
                    puts++;
                    // Another tab committed this same accepted coverage while
                    // this producer was backfilling. Its result is authoritative.
                    persisted = ProviderAccountUsagePageProjectionWriteV1Schema.parse(JSON.parse(String(init.body)));
                    return Response.json({ error: 'provider_account_usage_projection_conflict' }, { status: 409 });
                }
                const query = JSON.parse(new URL(path, 'https://test.invalid').searchParams.get('query')!);
                if (query.projection) {
                    projectionReads++;
                    projectionBodyUrls.push(path);
                    return Response.json({ projection: persisted, complete: persisted !== null });
                }
                exactReads++;
                return Response.json({ entries: [{ id: 'accepted', observedAtMs: 1, record }], nextCursor: null });
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : record);
        };
        const { getProviderAccountUsageQuota } = await loadApi();
        const input = { source, projection: { range: { startAtMs: 0, endAtMs: 5 }, resolution: 'accepted_observations' as const } };
        const options = { accountMode, material, request, nowMs: 1, includePendingWork: false };
        const first = await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        expect(first.pageFacts?.historyStatus).toBe('complete');
        expect(projectionReads).toBe(2);
        projectionBodyUrls.length = 0; // Compare stable URLs after the initial absent-document read.
        for (let index = 0; index < 10; index++) expect(await getProviderAccountUsageQuota({ token: 'test-token' }, {
            ...input, projection: { ...input.projection, range: { ...input.projection.range, endAtMs: 5 + index } },
        }, options)).toEqual(first);
        expect(new Set(projectionBodyUrls).size).toBe(1);
        expect(puts).toBe(1);
        expect(exactReads).toBe(1);
        invalidateAfterHead = true;
        expect((await getProviderAccountUsageQuota({ token: 'test-token' }, input, options)).pageFacts?.historyStatus).toBe('complete');
        expect(exactReads).toBe(2);
        expect(puts).toBe(2);
        const bodyReadsBeforeDenial = projectionReads;
        headStatus = 401;
        await expect(getProviderAccountUsageQuota({ token: 'test-token' }, input, options)).rejects.toMatchObject({ code: 'denied' });
        headStatus = 409;
        await expect(getProviderAccountUsageQuota({ token: 'test-token' }, input, options)).rejects.toMatchObject({
            code: 'provider_account_usage_content_mode_mismatch',
        });
        expect(projectionReads).toBe(bodyReadsBeforeDenial);
    });

    it.each(['plain', 'e2ee'] as const)('backfills a protected %s page projection once and reuses it without replaying exact history', async accountMode => {
        await activateTestHome();
        const { ProviderAccountUsagePageProjectionWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
        const { openProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto');
        const { parseQualifiedConnectedAccountV4StructuredQueryValue } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec');
        const { QualifiedProviderAccountUsageHistoryRequestV4Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
        const snapshot = makeSnapshot();
        const observations = [1, 2, 3, 4].map(at => ({ ...snapshot, observedAtMs: at, fetchedAtMs: at }));
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
        const record = { content: accountMode === 'plain' ? { t: 'plain', v: snapshot } : { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails },
            metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        const persisted: { value: ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse> | null } = { value: null };
        let exactPages = 0;
        let complete = true;
        const cursors: unknown[] = [];
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            if (path.includes('/history')) {
                if (init?.method === 'PUT') {
                    persisted.value = ProviderAccountUsagePageProjectionWriteV1Schema.parse(JSON.parse(String(init.body)));
                    return Response.json({ success: true });
                }
                const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
                    new URL(path, 'https://test.invalid').searchParams.get('query')!);
                if ('projection' in query) return Response.json({ projection: persisted.value, complete: persisted.value !== null && complete });
                if (!('history' in query)) throw new Error('Expected the exact tail reader');
                cursors.push(query.history.cursor);
                exactPages++;
                return Response.json({ entries: observations.filter(value => value.fetchedAtMs > (query.history.cursor?.observedAtMs ?? 0)).map(value => {
                    const sealed = sealProviderAccountUsageSnapshot({ snapshot: value, material, randomBytes: length => new Uint8Array(length).fill(9) });
                    return { id: `witness-${value.fetchedAtMs}`, observedAtMs: value.fetchedAtMs, record: {
                        ...record, content: accountMode === 'plain' ? { t: 'plain', v: value }
                            : { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails },
                        metadata: { ...record.metadata, fetchedAt: value.fetchedAtMs },
                    } };
                }), nextCursor: null });
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : record);
        });
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
            isServerFetchConnectivityProbeRequest(input) ? Response.json({ ok: true }) : request(String(input), init));
        const { getProviderAccountUsageQuota } = await loadApi();
        const input = { source, projection: { range: { startAtMs: 0, endAtMs: 5 }, resolution: 'accepted_observations' as const } };
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const price = createDeferred<undefined>();
        const progress: ConnectedServiceQuotaGetResultV1[] = [];
        const options = { accountMode, material, nowMs: 1, includePendingWork: false,
            readEnteredMonthlyPrice: () => price.promise,
            readAllHistory: { onProgress: (value: ConnectedServiceQuotaGetResultV1) => {
                progress.push(value);
                if (value.pageFacts) price.resolve(undefined);
            } } };
        const first = await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        const projected = progress.filter(value => value.pageFacts);
        expect(projected.length).toBeGreaterThan(1);
        // Price/Pending settlement and the terminal result do not add accepted
        // observations. Their projection must reuse the already derived page facts.
        for (const value of projected) expect(value.pageFacts).toBe(projected[0]!.pageFacts);
        expect(first.pageFacts).toBe(progress.at(-1)?.pageFacts);
        expect(first.history).toBeUndefined();
        expect(first.pageProjection).toBeUndefined();
        expect(openProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, accountMode, material,
            content: persisted.value!.content }).history).toEqual({ entries: observations.map(value => ({
            id: `witness-${value.fetchedAtMs}`, observedAtMs: value.fetchedAtMs, snapshot: value,
        })), nextCursor: null });
        expect(persisted.value?.content.t).toBe(accountMode === 'plain' ? 'plain' : 'encrypted');
        const before = exactPages;
        const second = await getProviderAccountUsageQuota({ token: 'test-token' }, input, options);
        expect(second).toEqual(first);
        expect(exactPages).toBe(before);
        complete = false;
        observations.push({ ...snapshot, observedAtMs: 5, fetchedAtMs: 5, planLabel: 'changed' });
        const extended = await getProviderAccountUsageQuota({ token: 'test-token' }, { ...input,
            projection: { ...input.projection, range: { startAtMs: 0, endAtMs: 6 } } }, options);
        expect(cursors.at(-1)).toEqual({ id: 'witness-4', observedAtMs: 4 });
        expect(extended.pageFacts?.historyStatus).toBe('complete');
        expect(openProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, accountMode, material,
            content: persisted.value!.content }).history.entries.map(entry => entry.id))
            .toEqual(['witness-1', 'witness-2', 'witness-3', 'witness-4', 'witness-5']);
    });
    it.each(['plain', 'e2ee'] as const)('releases the event loop before publishing a large admitted %s history page', async accountMode => {
        const { DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE } = await import('@/sync/encryption/cryptoBatchYield');
        const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const samples = Array.from({ length: DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE * 3 }, (_, index) => ({
            ...makeSnapshot(), observedAtMs: index + 1, fetchedAtMs: index + 1, planLabel: String(index),
        }));
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => {
            const sealed = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                randomBytes: length => new Uint8Array(length).fill(9) }) : null;
            return { content: sealed ? { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails }
                : { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        };
        let heartbeat = false;
        let heartbeatAtPublication = false;
        let abortDuringOpening = false;
        const controller = new AbortController();
        let releaseHeartbeat!: () => void;
        const heartbeatFinished = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
        const request = vi.fn(async (path: string) => {
            if (path.includes('/history')) {
                const response = Response.json({ entries: samples.map(snapshot => ({ id: String(snapshot.observedAtMs),
                    observedAtMs: snapshot.observedAtMs, record: record(snapshot) })), nextCursor: null });
                // A real event-loop task represents input/layout waiting behind the opening batch.
                setTimeout(() => {
                    heartbeat = true;
                    if (abortDuringOpening) controller.abort();
                    releaseHeartbeat();
                }, 0);
                return response;
            }
            const current = samples.at(-1)!;
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: current.recordId,
                providerAccountId: current.recordKey.accountSubjectId, fetchedAt: current.fetchedAtMs, staleAfterMs: 2 } : record(current));
        });
        try {
            const { getProviderAccountUsageQuota } = await loadApi();
            const started = performance.now();
            const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
                history: { range: { startAtMs: 0, endAtMs: samples.length + 1 }, pageSize: samples.length } }, {
                accountMode, material: accountMode === 'e2ee' ? material : undefined, request, nowMs: samples.length,
                includePendingWork: false, readAllHistory: { onProgress(value) {
                    if (value.history?.entries.length === samples.length) heartbeatAtPublication = heartbeat;
                } },
            });
            console.info(`history owner benchmark ${accountMode}: ${samples.length} entries, ${(performance.now() - started).toFixed(1)} ms, event-loop released=${heartbeatAtPublication}`);
            expect(result.history?.entries.map(entry => entry.snapshot)).toEqual(samples);
            expect(heartbeatAtPublication).toBe(true);
            abortDuringOpening = true;
            let cancelledHistoryPublished = false;
            await expect(getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
                history: { range: { startAtMs: 0, endAtMs: samples.length + 1 }, pageSize: samples.length } }, {
                accountMode, material: accountMode === 'e2ee' ? material : undefined, request, nowMs: samples.length,
                signal: controller.signal, includePendingWork: false,
                readAllHistory: { onProgress(value) { if (value.history?.entries.length) cancelledHistoryPublished = true; } },
            })).rejects.toMatchObject({ name: 'AbortError' });
            expect(cancelledHistoryPublished).toBe(false);
        } finally { await heartbeatFinished; }
    });
    it.each(['plain', 'e2ee'] as const)('progressively drains accepted %s history with growing pages while opening current and Pending only once', async accountMode => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const samples = Array.from({ length: 10 }, (_, index) => ({ ...makeSnapshot(), fetchedAtMs: index + 1,
            observedAtMs: index + 1, planLabel: index < 5 ? 'Standard' : 'Premium' }));
        const current = samples.at(-1)!;
        const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => {
            const sealed = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                randomBytes: length => new Uint8Array(length).fill(9) }) : null;
            return { content: sealed ? { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails }
                : { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        };
        const seen = new Set<string>();
        const request = vi.fn(async (path: string) => {
            if (!path.includes('/history')) {
                // Repeated source/current/Pending reads are refused at the real transport boundary.
                const key = path.split('?')[0]!;
                if (seen.has(key)) return new Response('repeat refused', { status: 403 });
                seen.add(key);
            }
            if (path.includes('/history')) {
                const query = JSON.parse(new URL(path, 'https://qa.test').searchParams.get('query')!);
                const start = query.history.cursor ? Number(query.history.cursor.id) + 1 : 0;
                const entries = samples.slice(start, start + query.history.pageSize).map((snapshot, index) => ({
                    id: String(start + index), observedAtMs: snapshot.fetchedAtMs, record: record(snapshot) }));
                const last = entries.at(-1)!;
                return Response.json({ entries, nextCursor: start + entries.length < samples.length
                    ? { id: last.id, observedAtMs: last.observedAtMs } : null });
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: current.recordId,
                providerAccountId: current.recordKey.accountSubjectId, fetchedAt: 10, staleAfterMs: 2 }
                : path.includes('/reset-starts/read') ? { entries: [] } : record(current));
        });
        const progress: ConnectedServiceQuotaGetResultV1[] = [];
        let releasePrice!: () => void;
        const priceGate = new Promise<void>(resolve => { releasePrice = resolve; });
        const options = { accountMode, material: accountMode === 'e2ee' ? material : undefined, request, nowMs: 10,
            readEnteredMonthlyPrice: async () => { await priceGate; return undefined; },
            readAllHistory: { onProgress: (value: (typeof progress)[number]) => { progress.push(value); releasePrice(); } } };
        const { getProviderAccountUsageQuota } = await loadApi();
        const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
            history: { range: { startAtMs: 0, endAtMs: 11 }, pageSize: 1 } }, options);
        expect(progress[0]).toMatchObject({ current });
        expect(progress[0]?.history).toBeUndefined();
        expect(progress.some(value => value.history?.nextCursor != null)).toBe(true);
        const historyProgress = progress.filter(value => value.history?.entries.length);
        const firstWitness = historyProgress[0]!.history!.entries[0]!;
        // The HTTP opener already admitted this immutable witness. Later pages
        // must not clone every unchanged accepted snapshot on each publication.
        expect(historyProgress.length).toBeGreaterThan(1);
        for (const value of historyProgress.slice(1)) {
            expect(value.history!.entries.find(entry => entry.id === firstWitness.id)?.snapshot).toBe(firstWitness.snapshot);
        }
        expect(result.history?.entries.map(entry => entry.id)).toEqual(['0', '4', '5', '9']);
        expect(result.history?.nextCursor).toBeNull();
        expect(result.waitingWork).toEqual({ status: 'available', entries: [] });
    });
    it('stops a progressive history producer after its parallel price read fails', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        const history = createDeferred<Response>();
        const price = createDeferred<undefined>();
        const enteredHistory = createDeferred<void>();
        const consumedHistory = createDeferred<void>();
        const page = { entries: [{ id: 'first', observedAtMs: 1, record }], nextCursor: { id: 'first', observedAtMs: 1 } };
        const lateHistory: ConnectedServiceQuotaGetResultV1[] = [];
        let settled = false;
        let continuationIssued = false;
        const request = async (path: string) => {
            if (path.includes('/history')) {
                const query = JSON.parse(new URL(path, 'https://qa.test').searchParams.get('query')!);
                if (query.history.cursor) { continuationIssued = true; return Response.json({ entries: [], nextCursor: null }); }
                enteredHistory.resolve();
                const response = await history.promise;
                const json = response.json.bind(response);
                response.json = async () => { const result = await json(); consumedHistory.resolve(); return result; };
                return response;
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : record);
        };
        const { getProviderAccountUsageQuota } = await loadApi();
        const reading = getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
            history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, {
            accountMode: 'plain', request, nowMs: 1, includePendingWork: false,
            readEnteredMonthlyPrice: () => price.promise,
            readAllHistory: { onProgress(value) { if (settled && value.history) lateHistory.push(value); } },
        });
        const rejected = expect(reading).rejects.toMatchObject({ message: 'price authority unavailable' });
        try {
            await enteredHistory.promise;
            price.reject(new Error('price authority unavailable'));
            await rejected;
            settled = true;
            history.resolve(Response.json(page));
            await consumedHistory.promise;
            // Flush the completed HTTP body's microtasks and the page-opening task.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(lateHistory).toEqual([]);
            expect(continuationIssued).toBe(false);
        } finally { history.resolve(Response.json(page)); price.resolve(undefined); await reading.catch(() => {}); }
    });
    it('reads reset admission facts without unrelated Account-wide Pending work', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const forbiddenRequests: string[] = [];
        const request = vi.fn(async (path: string) => {
            if (path.includes('/reset-starts/read')) {
                forbiddenRequests.push(path);
                return new Response(JSON.stringify({ error: 'denied' }), { status: 403 });
            }
            return new Response(JSON.stringify(path.includes('/sources/resolve')
                ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 }
                : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] }), { status: 200 });
        });
        const { getProviderAccountUsageQuota } = await loadApi();
        const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, {
            accountMode: 'plain', request, nowMs: 1, includePendingWork: false,
        });
        expect(result.current).toEqual(snapshot);
        // The signed reset-admission grant authorizes only B; attempting the
        // Account-wide POST would broaden that authority even if it were denied.
        expect(forbiddenRequests).toEqual([]);
    });
    it.each(['pending', 'witness'] as const)('samples completion time after held %s HTTP without changing explicit as-of reads', async held => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const witness = ProviderAccountUsageSnapshotV1Schema.parse({ ...makeSnapshot(), observedAtMs: 500, fetchedAtMs: 500, staleAfterMs: 2000, meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, utilizationPct: 50, unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
        const current = { ...witness, observedAtMs: 1250, fetchedAtMs: 1250, staleAfterMs: 500, meters: [{ ...witness.meters[0]!, resetsAt: 2000 }] };
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => ({ content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] });
        let nowMs = 1250;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        let release!: () => void;
        const heldResponse = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const responseEntered = new Promise<void>(resolve => { entered = resolve; });
        const request = vi.fn(async (path: string) => {
            if (path.includes(held === 'pending' ? '/reset-starts/read' : '/history')) { entered(); await heldResponse; }
            const value = path.includes('/sources/resolve') ? { source, recordId: current.recordId, providerAccountId: current.recordKey.accountSubjectId, fetchedAt: 1250, staleAfterMs: 500 }
                : path.includes('/reset-starts/read') ? { entries: [{ sessionId: 'session', localId: 'held', reset: { source, recordId: witness.recordId, meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 500 } }, authorityCurrent: true }] }
                : path.includes('/history') ? { entries: [{ id: 'accepted', observedAtMs: 500, record: record(witness) }], nextCursor: null } : record(current);
            return new Response(JSON.stringify(value), { status: 200 });
        });
        try {
            const { getProviderAccountUsageQuota } = await loadApi();
            const options = { accountMode: 'plain' as const, request };
            const reading = getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, options);
            await responseEntered;
            nowMs = 2251;
            release();
            const result = await reading;
            expect(result.current).toEqual(current);
            expect(result.pace).toMatchObject([{ value: { status: 'unavailable', reason: 'stale' } }]);
            expect(result.waitingWork).toMatchObject({ status: 'available', entries: [{ readiness: { status: 'waiting', reason: 'quota_stale' } }] });
            const deterministic = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, { ...options, nowMs: 1250 });
            expect(deterministic.pace).toMatchObject([{ value: { status: 'available', pace: 2 } }]);
            expect(deterministic.waitingWork).toMatchObject({ status: 'available', entries: [{ readiness: { status: 'ready' } }] });
        } finally { release(); clock.mockRestore(); }
    });
    it('does not report requested history as empty when its admitted source has an unavailable history route', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        let historyAvailable = false;
        const request = vi.fn(async (path: string) => path.includes('/history')
            ? new Response(JSON.stringify(historyAvailable ? { entries: [], nextCursor: null } : {}), { status: historyAvailable ? 200 : 404 })
            : new Response(JSON.stringify(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : path.includes('/reset-starts/read') ? { entries: [] } : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] }), { status: 200 }));
        const { getProviderAccountUsageQuota } = await loadApi();
        await expect(getProviderAccountUsageQuota({ token: 'plain-token' }, { source, history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, { accountMode: 'plain', request, nowMs: 1 })).rejects.toMatchObject({ code: 'provider_account_usage_content_unavailable' });
        historyAvailable = true;
        expect((await getProviderAccountUsageQuota({ token: 'plain-token' }, { source, history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, { accountMode: 'plain', request, nowMs: 1 })).history).toEqual({ entries: [], nextCursor: null });
    });
    it('projects actual held work only after the canonical Pending metadata and exact immutable B witness are opened', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const base = makeSnapshot();
        const witness = ProviderAccountUsageSnapshotV1Schema.parse({ ...base, observedAtMs: 500, fetchedAtMs: 500, staleAfterMs: 2000, meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, utilizationPct: 50, unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
        const current = ProviderAccountUsageSnapshotV1Schema.parse({ ...witness, observedAtMs: 1250, fetchedAtMs: 1250, meters: [{ ...witness.meters[0]!, resetsAt: 2000 }] });
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => ({ content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] });
        const request = vi.fn(async (path: string) => {
            const value = path.includes('/sources/resolve') ? { source, recordId: current.recordId, providerAccountId: current.recordKey.accountSubjectId, fetchedAt: 1250, staleAfterMs: 2000 }
                : path.includes('/reset-starts/read') ? { entries: [{ sessionId: 'session', localId: 'held', reset: { source, recordId: witness.recordId, meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 500 } }, authorityCurrent: true }] }
                : path.includes('/history') ? { entries: [{ id: 'accepted', observedAtMs: 500, record: record(witness) }], nextCursor: null } : record(current);
            return new Response(JSON.stringify(value), { status: 200 });
        });
        const { getProviderAccountUsageQuota } = await loadApi();
        expect((await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, { accountMode: 'plain', request, nowMs: 1250 })).waitingWork).toEqual({ status: 'available', entries: [{ sessionId: 'session', localId: 'held', recordId: witness.recordId, meterId: 'weekly', readiness: { status: 'ready' } }] });
    });
    it('opens qualified current and history facts through the captured request in keyless plain mode', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const unboundEntries = [
            { sessionId: 'session', localId: 'queued', authorityCurrent: true },
            { sessionId: 'offline-session', localId: 'queued', authorityCurrent: false },
        ];
        const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        const request = vi.fn(async (path: string) => new Response(JSON.stringify(
            path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 }
                : path.includes('/reset-starts/read') ? { entries: [], unboundEntries }
                : path.includes('/history') ? { entries: [{ id: 'saved-observation', observedAtMs: 1, record }], nextCursor: null }
                : record,
        ), { status: 200 }));
        const { getProviderAccountUsageQuota } = await loadApi();
        const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source, history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, { accountMode: 'plain', request, nowMs: 1 });
        expect(result.current).toEqual(snapshot);
        expect(result.history?.entries[0]?.snapshot).toEqual(snapshot);
        expect(result.waitingWork).toEqual({ status: 'available', entries: [], unboundEntries });
    });
    it.each([false, true])('gets a plaintext provider account usage snapshot by record id (retained extras: %s)', async retainedExtras => {
        await activateTestHome();
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const snapshot = openSealedProviderAccountUsageSnapshot({ material, sealed: sealProviderAccountUsageSnapshot({
            material, snapshot: makeSnapshot(), randomBytes: length => new Uint8Array(length).fill(9),
        }) });
        if (!snapshot) throw new Error('Canonical usage writer did not produce readable content');
        let servedSnapshot = false;
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            if (servedSnapshot) return new Response(null, { status: 404 });
            servedSnapshot = true;
            return Response.json({
                    content: { t: 'plain', v: retainedExtras ? { ...snapshot, retired: true,
                        recordKey: { ...snapshot.recordKey, retired: true },
                        accountSubject: { ...snapshot.accountSubject, retired: true } } : snapshot },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                    sources: [],
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotPlain } = await loadApi();
        const result = await getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId });

        expect(result).toEqual(snapshot);
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it.each(['mode', 'identity', 'metadata', 'malformed'] as const)('refuses a saved plain snapshot with %s mismatch', async mismatch => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
            return Response.json({
                content: mismatch === 'mode' ? { t: 'encrypted', c: 'opaque' } : { t: 'plain', v: {
                    ...snapshot,
                    ...(mismatch === 'identity' ? { recordKey: { ...snapshot.recordKey, accountSubjectId: 'foreign' } } : {}),
                    ...(mismatch === 'malformed' ? { fetchedAtMs: 'invalid' } : {}),
                } },
                metadata: { fetchedAt: mismatch === 'metadata' ? 2 : 1, staleAfterMs: 2, status: 'ok' },
                sources: [],
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const { getProviderAccountUsageSnapshotPlain } = await loadApi();
        await expect(getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId })).rejects.toMatchObject({
            code: mismatch === 'mode' ? 'provider_account_usage_content_mode_mismatch'
                : mismatch === 'metadata' ? 'provider_account_usage_identity_mismatch' : 'provider_account_usage_content_unavailable',
        });
    });

    it('gets a sealed provider account usage snapshot by record id', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            return Response.json({
                    content: { t: 'encrypted', c: 'ciphertext', recoveryCreditDetails: { ciphertext: 'details-ciphertext' } },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                    sources: [],
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotSealed } = await loadApi();
        const result = await getProviderAccountUsageSnapshotSealed(credentials, { recordId: snapshot.recordId });

        expect(result?.content).toEqual({ t: 'encrypted', c: 'ciphertext', recoveryCreditDetails: { ciphertext: 'details-ciphertext' } });
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it('normalizes canonical storage-mode conflicts for plain and sealed reads', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            return Response.json({
                    error: 'provider_account_usage_storage_mode_mismatch',
            }, { status: 409 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const {
            getProviderAccountUsageSnapshotPlain,
            getProviderAccountUsageSnapshotSealed,
        } = await loadApi();
        const expected = {
            code: 'provider_account_usage_content_mode_mismatch',
            status: 409,
            kind: 'server',
            canTryAgain: false,
        };

        await expect(getProviderAccountUsageSnapshotPlain(
            credentials,
            { recordId: snapshot.recordId },
        )).rejects.toMatchObject(expected);
        await expect(getProviderAccountUsageSnapshotSealed(
            credentials,
            { recordId: snapshot.recordId },
        )).rejects.toMatchObject(expected);
    });

    it('requests a provider account usage refresh through the V4 record owner', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            return Response.json({ success: true });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { requestProviderAccountUsageSnapshotRefresh } = await loadApi();
        await expect(requestProviderAccountUsageSnapshotRefresh(
            credentials,
            { recordId: snapshot.recordId },
        )).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v4/connect/qualified/provider-account-usage/record/refresh',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ recordId: snapshot.recordId }),
                headers: expect.any(Headers),
            }),
        );
    });
});
