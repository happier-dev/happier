import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

/** The network boundary: a real `Response`, as the capabilities clients read its headers and body. */
function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const FULL_POLICY = {
    version: 2,
    enabled: true,
    complete: true,
    domains: [{ id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } }],
} as const;

type RetentionAnswer = () => Promise<Response>;

/**
 * A saved Home whose features snapshot knows only the older domains (deletion on, nothing it can
 * list), and whose `/v2/retention-policy` answers however `answer` says. Like a real `fetch`, the
 * stub rejects when its request is aborted.
 */
async function setUpHome(answer: { current: RetentionAnswer }) {
    const { buildServerFeaturesResponse } = await import('./serverFeaturesTestUtils');
    const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { resetServerRetentionPolicyClientForTests } = await import('@/sync/api/capabilities/serverRetentionPolicyClient');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');

    resetServerFeaturesClientForTests();
    resetServerRetentionPolicyClientForTests();

    const server = await upsertServerProfile({ serverUrl: 'https://retention.example', name: 'Retention', source: 'manual' });
    const features = buildServerFeaturesResponse();
    const keep = { mode: 'keep_forever' } as const;
    features.capabilities.server = {
        retention: {
            policyVersion: 1,
            enabled: true,
            sessions: keep,
            accountChanges: keep,
            usageEvents: keep,
            voiceSessionLeases: keep,
            userFeedItems: keep,
            publicShareAccessLogs: keep,
            terminalAuthRequests: keep,
            accountAuthRequests: keep,
            authPairingSessions: keep,
            repeatKeys: keep,
            globalLocks: keep,
            automationRuns: keep,
            automationRunEvents: keep,
        },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (!String(url).includes('/v2/retention-policy')) return jsonResponse(features);
        return await new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            answer.current().then(resolve, reject);
        });
    }) as any);
    const snapshot = await getServerFeaturesSnapshot({ serverId: server.id, force: true });
    expect(snapshot.status, 'features snapshot ready').toBe('ready');
    return server;
}

async function renderPolicyHook(serverId: string) {
    const { renderHook } = await import('@/dev/testkit');
    const { flushHookEffects } = await import('./serverFeatureHookHarness.testHelpers');
    const { useServerRetentionPolicy } = await import('./useServerRetentionPolicy');
    const harness = await renderHook(() => useServerRetentionPolicy(serverId));
    await flushHookEffects();
    return { harness, flush: flushHookEffects };
}

describe('useServerRetentionPolicy', () => {
    it('stays loading through a slow full read and never shows the features snapshot as a verdict', async () => {
        let answerFullPolicy: (() => void) | null = null;
        const server = await setUpHome({
            current: async () => {
                await new Promise<void>((resolve) => { answerFullPolicy = resolve; });
                return jsonResponse(FULL_POLICY);
            },
        });
        const { harness, flush } = await renderPolicyHook(server.id);
        expect(answerFullPolicy, 'full policy requested').not.toBeNull();
        expect(harness.getCurrent()).toMatchObject({ status: 'loading' });

        // Well past any local cutoff: a slow Home is still loading, not a partial verdict.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await flush();
        expect(harness.getCurrent()).toMatchObject({ status: 'loading' });

        answerFullPolicy!();
        await flush();
        expect(harness.getCurrent()).toMatchObject({
            status: 'ready',
            policy: { completeness: 'complete', domains: [{ id: 'sessionSidechainMessages' }] },
        });
        await harness.unmount();
    });

    it('reports a failed read with a retry that reads again', async () => {
        const answer: { current: RetentionAnswer } = { current: async () => jsonResponse({ error: 'unavailable' }, 503) };
        const server = await setUpHome(answer);
        const { harness, flush } = await renderPolicyHook(server.id);

        const failed = harness.getCurrent();
        expect(failed).toMatchObject({ status: 'failed' });

        answer.current = async () => jsonResponse(FULL_POLICY);
        const { act } = await import('react-test-renderer');
        await act(async () => { (failed as { retry: () => void }).retry(); });
        await flush();
        expect(harness.getCurrent()).toMatchObject({ status: 'ready', policy: { completeness: 'complete' } });
        await harness.unmount();
    });
});
