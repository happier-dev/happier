import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createQualifiedQuotaTestHarness, quotaTestResponse, quotaTestSnapshot } from './qualifiedConnectedAccountQuotaTestHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import * as legacy from './connectedServiceQuotaSnapshotStore';
import * as qualified from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();

describe('explicit quota refresh supersession through HTTP', () => {
    let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
    const releases: Array<() => void> = [];

    afterEach(async () => {
        for (const release of releases.splice(0)) release();
        legacy.__resetConnectedServiceQuotaSnapshotStore();
        qualified.__resetQualifiedConnectedAccountQuotaSnapshotStore();
        await boundary?.dispose();
        vi.restoreAllMocks();
    });

    it.each(['legacy', 'qualified'] as const)('%s refresh supersedes a hung GET while ordinary observers share it and late results stay retired', async kind => {
        let settleOldRead!: (response: Response) => void;
        const oldRead = new Promise<Response>(resolve => { settleOldRead = resolve; });
        let reads = 0;
        let refreshes = 0;
        function response(fetchedAt: number): Response {
            if (kind === 'qualified') return Response.json(quotaTestResponse({ ...quotaTestSnapshot, fetchedAt }));
            return Response.json({
                content: { t: 'plain', v: { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt,
                    staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] } },
                metadata: { fetchedAt, staleAfterMs: 60_000, status: 'ok' },
            });
        }
        boundary = await createQualifiedQuotaTestHarness({
            request: async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v3/connect/openai-codex/profiles/work/quotas/refresh') {
                    refreshes++;
                    return Response.json({ success: true });
                }
                if (path !== '/v3/connect/openai-codex/profiles/work/quotas') return null;
                reads++;
                return reads === 2 ? oldRead : response(reads === 1 ? 1 : 3);
            },
        });
        boundary.read.mockImplementation(async () => {
            reads++;
            return reads === 2 ? oldRead : response(reads === 1 ? 1 : 3);
        });
        boundary.refresh.mockImplementation(async () => { refreshes++; return Response.json({ success: true }); });
        const context = boundary.context();
        const legacyContext = { ...context, serviceId: 'openai-codex' as const, profileId: 'work',
            resolveAccountMode: async () => 'plain' as const,
            assertOperationAllowed: async () => {},
        };
        const key = kind === 'qualified'
            ? qualified.buildQualifiedQuotaSnapshotScopeKey(context)
            : legacy.buildQuotaSnapshotScopeKey(context.credentialScope, legacyContext.serviceId, legacyContext.profileId);
        const retain = () => kind === 'qualified'
            ? qualified.retainQualifiedQuotaSnapshotPolling(key, context)
            : legacy.retainQuotaSnapshotPolling(key, legacyContext);
        const view = () => kind === 'qualified' ? qualified.getQualifiedQuotaSnapshotEntry(key) : legacy.getQuotaSnapshotEntry(key);
        releases.push(retain());
        await vi.waitFor(() => expect(view()).toMatchObject({ snapshot: { fetchedAt: 1 }, loading: false }));
        publishHomeAccountChange(context.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.waitFor(() => expect(reads).toBe(2));
        releases.push(retain());
        expect(reads).toBe(2);
        expect(view()).toMatchObject({ snapshot: { fetchedAt: 1 }, loading: true, error: null });

        const refresh = kind === 'qualified'
            ? qualified.refreshQualifiedQuotaSnapshot(key, context)
            : legacy.refreshQuotaSnapshot(key, legacyContext);
        expect(view()).toMatchObject({ snapshot: { fetchedAt: 1 }, refreshing: true });
        await vi.waitFor(() => expect(refreshes).toBe(1));
        await refresh;
        expect(view()).toMatchObject({ snapshot: { fetchedAt: 3 }, loading: false, refreshing: false, error: null });
        expect(reads).toBe(3);

        settleOldRead(response(2));
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(view()).toMatchObject({ snapshot: { fetchedAt: 3 }, loading: false, refreshing: false });
        expect(reads).toBe(3);
    });

    it.each(['POST', 'GET body'] as const)('keeps legacy refresh cancellation through its pending %s transport', async phase => {
        let refreshIssued = false;
        let pendingSignal: AbortSignal | null | undefined;
        boundary = await createQualifiedQuotaTestHarness({
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v3/connect/openai-codex/profiles/work/quotas/refresh') {
                    refreshIssued = true;
                    if (phase === 'POST') {
                        pendingSignal = init?.signal;
                        return new Promise<Response>((_resolve, reject) => pendingSignal?.addEventListener('abort',
                            () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
                    }
                    return Response.json({ success: true });
                }
                if (path !== '/v3/connect/openai-codex/profiles/work/quotas') return null;
                if (refreshIssued && phase === 'GET body') {
                    pendingSignal = init?.signal;
                    return new Response(new ReadableStream({ start(controller) {
                        pendingSignal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
                    } }));
                }
                return Response.json({ content: { t: 'plain', v: { v: 1, serviceId: 'openai-codex', profileId: 'work',
                    fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] } },
                    metadata: { fetchedAt: 1, staleAfterMs: 60_000, status: 'ok' } });
            },
        });
        const context = { ...boundary.context(), serviceId: 'openai-codex' as const, profileId: 'work',
            resolveAccountMode: async () => 'plain' as const, assertOperationAllowed: async () => {},
        };
        const key = legacy.buildQuotaSnapshotScopeKey(context.credentialScope, context.serviceId, context.profileId);
        const release = legacy.retainQuotaSnapshotPolling(key, context);
        releases.push(release);
        await vi.waitFor(() => expect(legacy.getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, snapshot: { fetchedAt: 1 } }));
        const refresh = legacy.refreshQuotaSnapshot(key, context);
        await vi.waitFor(() => expect(pendingSignal).toBeInstanceOf(AbortSignal));
        expect(legacy.getQuotaSnapshotEntry(key)).toMatchObject({ snapshot: { fetchedAt: 1 }, refreshing: true });
        release();
        expect(pendingSignal?.aborted).toBe(true);
        await refresh;
        expect(legacy.getQuotaSnapshotEntry(key).refreshing).toBe(false);
    });
});
