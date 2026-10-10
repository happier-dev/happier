import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

async function activateTestHome() {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    // This node harness has no browser sessionStorage; use the durable selection.
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
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
    });
}

async function loadApi() {
    try {
        return await import('./apiProviderAccountUsage');
    } catch (error) {
        expect.fail(`canonical provider account usage API is missing: ${String(error)}`);
    }
}

describe('apiProviderAccountUsage', () => {
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
    it('opens qualified current usage through the captured request in keyless plain mode', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const request = vi.fn(async (path: string) => new Response(JSON.stringify(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : path.includes('/reset-starts/read') ? { entries: [] } : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] }), { status: 200 }));
        const { getProviderAccountUsageQuota } = await loadApi();
        expect((await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, { accountMode: 'plain', request, nowMs: 1 })).current).toEqual(snapshot);
    });
    it('gets a plaintext provider account usage snapshot by record id', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    content: { t: 'plain', v: snapshot },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                    sources: [],
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotPlain } = await loadApi();
        const result = await getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId });

        expect(result?.recordId).toBe(snapshot.recordId);
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it('gets a sealed provider account usage snapshot by record id', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    content: { t: 'encrypted', c: 'ciphertext' },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                    sources: [],
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotSealed } = await loadApi();
        const result = await getProviderAccountUsageSnapshotSealed(credentials, { recordId: snapshot.recordId });

        expect(result?.content).toEqual({ t: 'encrypted', c: 'ciphertext' });
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
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: false,
                status: 409,
                json: async () => ({
                    error: 'provider_account_usage_storage_mode_mismatch',
                }),
            };
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
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true }),
            };
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
