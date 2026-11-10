import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>>());
// Only the remote Session RPC is replaced; scope, store publication and catalog parsing stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return installServerScopedSessionRpcModuleMock({ sessionRpcWithServerScope: params => transport(params) as never })(importOriginal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { seedAutocompleteSessions } = await import('@/components/autocomplete/autocompleteTestFixtures');
const { ensureSessionSuggestionCatalogs } = await import('./sessionCatalogs');
const { useSessionComposerSuggestions } = await import('@/components/sessions/agentInput/useSessionComposerSuggestions');
const { useActiveSuggestions } = await import('@/components/autocomplete/useActiveSuggestions');

afterEach(() => { standardCleanup(); transport.mockReset(); });

it('refreshes changed native skills only for the matching open composer demand', async () => {
    const home = await createPlainArtifactHomeFixture('https://session-catalog-native-change.test');
    seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true,
        agentState: { nativeCatalogChangesV1: { skills: '100:1' } },
        metadata: { path: '/repo', sessionSkillCatalogV1: {
            skills: [{ name: 'old', origin: 'vendor', backendId: 'codex' }],
            observedNativeChangeToken: '100:1',
        } },
    } });
    transport.mockResolvedValueOnce(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'fresh', origin: 'vendor', backendId: 'codex' }] }))
        .mockResolvedValueOnce(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'newest', origin: 'vendor', backendId: 'codex' }] }));
    const options = { sessionId: 'shared', kinds: ['skill'] as const, composerReferenceHost: null,
        actionController: { listSlashCommands: () => [] }, skillSource: null };
    const hook = await renderHook(({ query }: { query: string | null }) => {
        const source = useSessionComposerSuggestions(options);
        return useActiveSuggestions(query, source);
    }, { initialProps: { query: null as string | null } });
    const publishToken = async (token: string) => act(async () => {
        const session = storage.getState().sessions.shared!;
        storage.getState().applySessions([{ ...session, agentState: {
            ...session.agentState, nativeCatalogChangesV1: { skills: token },
        } }], 'projection');
    });
    try {
        await publishToken('100:2');
        await flushHookEffects();
        expect(transport).not.toHaveBeenCalled();
        await hook.rerender({ query: '$' });
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toEqual([expect.objectContaining({ text: expect.stringContaining('fresh') })]));
        expect(transport).toHaveBeenCalledTimes(1);
        await publishToken('100:2');
        await flushHookEffects();
        expect(transport).toHaveBeenCalledTimes(1);
        await publishToken('100:3');
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toEqual([expect.objectContaining({ text: expect.stringContaining('newest') })]));
        expect(transport).toHaveBeenCalledTimes(2);
        await hook.rerender({ query: null });
        await publishToken('100:4');
        await flushHookEffects();
        expect(transport).toHaveBeenCalledTimes(2);
    } finally {
        await hook.unmount();
        await home.dispose();
    }
});

it.each([null, 'first', 'second'] as const)('shares simultaneous Session catalog reads and publications with independent cancellation (%s)', async cancel => {
    const home = await createPlainArtifactHomeFixture(`https://session-catalog-sharing-${cancel}.test`);
    seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true, metadata: { path: '/repo' } } });
    const answer = createDeferred<unknown>();
    transport.mockImplementation(() => answer.promise);
    const firstController = new AbortController();
    const secondController = new AbortController();
    let publications = 0;
    const unsubscribe = storage.subscribe((next, previous) => { if (next.sessions !== previous.sessions) publications++; });
    const first = ensureSessionSuggestionCatalogs('shared', { skills: true }, { signal: firstController.signal });
    const second = ensureSessionSuggestionCatalogs('shared', { skills: true }, { signal: secondController.signal });
    try {
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        if (cancel) {
            const cancelled = vi.fn();
            const pending = cancel === 'first' ? first : second;
            void pending.then(cancelled);
            (cancel === 'first' ? firstController : secondController).abort();
            await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
            expect(transport.mock.calls[0]![0].signal?.aborted).toBe(false);
            expect(publications).toBe(0);
        }
        answer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'review', origin: 'vendor', backendId: 'codex' }] }));
        await Promise.all([first, second]);
        expect(publications).toBe(1);
        expect(storage.getState().sessions.shared?.metadata?.sessionSkillCatalogV1).toMatchObject({ skills: [expect.objectContaining({ name: 'review' })] });
    } finally {
        answer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        await Promise.allSettled([first, second]);
        unsubscribe();
        await home.dispose();
    }
});

it('starts a fresh Session catalog read for changed inputs and ignores an older completion', async () => {
    const home = await createPlainArtifactHomeFixture('https://session-catalog-freshness.test');
    seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true, metadata: { path: '/old' } } });
    const oldAnswer = createDeferred<unknown>();
    const newAnswer = createDeferred<unknown>();
    transport.mockImplementationOnce(() => oldAnswer.promise).mockImplementationOnce(() => newAnswer.promise);
    const first = ensureSessionSuggestionCatalogs('shared', { skills: true });
    let second: Promise<void> | undefined;
    try {
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        seedAutocompleteSessions({ shared: { serverId: home.home.id, active: true, metadata: { path: '/new' } } });
        second = ensureSessionSuggestionCatalogs('shared', { skills: true });
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
        newAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'current', origin: 'vendor', backendId: 'codex' }] }));
        await second;
        oldAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{ name: 'obsolete', origin: 'vendor', backendId: 'codex' }] }));
        await first;
        expect(storage.getState().sessions.shared?.metadata?.sessionSkillCatalogV1).toMatchObject({ skills: [expect.objectContaining({ name: 'current' })] });
    } finally {
        oldAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        newAnswer.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        await Promise.allSettled([first, second]);
        await home.dispose();
    }
});
