import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionMessagesFixture, flushHookEffects, renderHook } from '@/dev/testkit';
import { createReducer } from "@happier-dev/session-core/reducer";
import { storage } from '@/sync/domains/state/storageStore';
import { fetchUserMessageHistoryPage } from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
import { useUserMessageHistoryEntries } from './useUserMessageHistoryEntries';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import {
    USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS,
    resetUserMessageHistoryRemoteEntriesForTests,
    useUserMessageHistory,
    useUserMessageHistoryRemoteEntries,
} from './useUserMessageHistory';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchUserMessageHistoryPageMock = vi.hoisted(() => vi.fn());
const roleQuerySupportedState = vi.hoisted(() => ({ supported: true }));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchUserMessageHistoryPage: (...args: unknown[]) => fetchUserMessageHistoryPageMock(...args),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: {
            capabilities: {
                session: {
                    messages: {
                        role: roleQuerySupportedState.supported,
                    },
                },
            },
        },
    }),
}));

describe('useUserMessageHistory server role query', () => {
    beforeEach(() => {
        storage.setState((state) => ({
            ...state,
            profileScope: { serverId: 'server-1', accountId: 'account-1' },
            sessionMessages: {},
            sessions: {},
            sessionListRowsByServerId: {},
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        resetUserMessageHistoryRemoteEntriesForTests();
        roleQuerySupportedState.supported = true;
        storage.setState((state) => ({
            ...state,
            profileScope: { serverId: 'server-1', accountId: 'account-1' },
            sessionMessages: {},
        }));
    });

    it('pages global sent history from unhydrated sessions in recency order, one page per demand', async () => {
        storage.setState({
            sessions: {
                older: createSessionFixture({ id: 'older', serverId: 'server-1', updatedAt: 100, meaningfulActivityAt: 10 }),
                newer: createSessionFixture({ id: 'newer', serverId: 'server-1', updatedAt: 20, meaningfulActivityAt: 20 }),
                otherHome: createSessionFixture({ id: 'otherHome', serverId: 'server-2', updatedAt: 30 }),
            },
            sessionListRowsByServerId: {},
        });
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 90, role: 'user', text: 'repeat' },
                { messageId: 'a9', routeMessageId: 'server:a9', seq: 10, createdAt: 91, role: 'assistant', text: 'answer' },
            ], hasMore: true, nextBeforeSeq: 9 })
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 40, role: 'user', text: 'repeat' },
            ], hasMore: false, nextBeforeSeq: null })
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 9, role: 'user', text: 'older session' },
            ], hasMore: false, nextBeforeSeq: null });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'global', enabled: true }));
        expect(fetchUserMessageHistoryPageMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().coverage).toBe('loaded');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        expect(fetchUserMessageHistoryPageMock).toHaveBeenNthCalledWith(1, 'newer', { limit: 40 });
        expect(hook.getCurrent().entries).toEqual([
            { serverId: 'server-1', sessionId: 'newer', messageId: 'm9', seq: 9, createdAtMs: 90, text: 'repeat' },
        ]);
        expect(hook.getCurrent().coverage).toBe('partial');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenNthCalledWith(2, 'newer', { limit: 40, beforeSeq: 9 });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenNthCalledWith(3, 'older', { limit: 40 });
        expect(hook.getCurrent().entries.map((entry) => [entry.sessionId, entry.messageId, entry.text])).toEqual([
            ['newer', 'm9', 'repeat'], ['newer', 'm4', 'repeat'], ['older', 'm9', 'older session'],
        ]);
        expect(hook.getCurrent().progress).toEqual({ pagesLoaded: 3, sessionsSearched: 2, totalSessions: 2 });
        expect(hook.getCurrent().hasMore).toBe(false);
        // Ordinary/archived/query membership is paged and cannot attest an entire Account inventory.
        expect(hook.getCurrent().coverage).toBe('partial');
        await hook.unmount();
    });

    it('keeps disabled history inert and Stop rejects late publication while leaving the shared page usable', async () => {
        const page = createDeferred<Awaited<ReturnType<typeof fetchUserMessageHistoryPage>>>();
        fetchUserMessageHistoryPageMock.mockReturnValueOnce(page.promise);
        const hook = await renderHook(
            (props: { enabled: boolean }) => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1', enabled: props.enabled }),
            { initialProps: { enabled: false } },
        );
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).not.toHaveBeenCalled();
        await hook.rerender({ enabled: true });
        let pending!: Promise<void>;
        await act(async () => { pending = hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().isLoading).toBe(true);
        await act(async () => {
            hook.getCurrent().stop();
            page.resolve({ status: 'loaded', rows: [
                { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: 'late' },
            ], hasMore: false, nextBeforeSeq: null });
            await pending;
        });
        expect(hook.getCurrent().entries).toEqual([]);
        expect(hook.getCurrent().isLoading).toBe(false);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries[0]?.text).toBe('late');
        expect(hook.getCurrent().coverage).toBe('complete');
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('does not publish an old Account page into the newly addressed history', async () => {
        const page = createDeferred<Awaited<ReturnType<typeof fetchUserMessageHistoryPage>>>();
        fetchUserMessageHistoryPageMock.mockReturnValueOnce(page.promise);
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        let pending!: Promise<void>;
        await act(async () => { pending = hook.getCurrent().loadMore(); });
        await act(async () => {
            storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-2' } });
            await hook.rerender();
            page.resolve({ status: 'loaded', rows: [
                { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: 'private old Account' },
            ], hasMore: false, nextBeforeSeq: null });
            await pending;
        });
        expect(hook.getCurrent().entries).toEqual([]);
        expect(hook.getCurrent().coverage).toBe('loaded');
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({ status: 'loaded', rows: [], hasMore: false, nextBeforeSeq: null });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().coverage).toBe('complete');
        await hook.unmount();
    });

    it('retains readable records and partial coverage through a failed older page, then retries its cursor', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 9, role: 'user', text: 'readable' },
            ], hasMore: true, nextBeforeSeq: 9 })
            .mockResolvedValueOnce({ status: 'error' })
            .mockResolvedValueOnce({ status: 'loaded', rows: [], hasMore: false, nextBeforeSeq: null });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries[0]?.text).toBe('readable');
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().isLoading).toBe(false);
        vi.setSystemTime(Date.now() + USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS);
        await act(async () => { await hook.getCurrent().retry(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenLastCalledWith('s1', { limit: 40, beforeSeq: 9 });
        expect(hook.getCurrent().entries[0]?.text).toBe('readable');
        expect(hook.getCurrent().coverage).toBe('complete');
        expect(hook.getCurrent().error).toBe(false);
        await hook.unmount();
    });

    it('reuses already read history when the picker reopens without issuing another page request', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({ status: 'loaded', rows: [
            { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: 'retained prompt' },
        ], hasMore: false, nextBeforeSeq: null });
        const first = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await first.getCurrent().loadMore(); });
        await first.unmount();
        const reopened = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        expect(reopened.getCurrent().entries[0]?.text).toBe('retained prompt');
        expect(reopened.getCurrent().coverage).toBe('complete');
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        await reopened.unmount();
    });

    it('projects local display text and merges by message identity while old servers remain partial', async () => {
        storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
            messageIdsOldestFirst: ['internal-1'],
            messagesById: { 'internal-1': { kind: 'user-text', id: 'internal-1', realID: 'm1', localId: null, seq: 1,
                createdAt: 1, text: 'expanded body', displayText: '  readable prompt\n' } },
        }) } });
        roleQuerySupportedState.supported = false;
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().entries).toEqual([
            { serverId: 'server-1', sessionId: 's1', messageId: 'm1', seq: 1, createdAtMs: 1, text: '  readable prompt\n' },
        ]);
        roleQuerySupportedState.supported = true;
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({ status: 'loaded', rows: [
            { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 1, role: 'user', text: '  readable prompt\n' },
        ], hasMore: false, nextBeforeSeq: null });
        await hook.rerender();
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().entries).toHaveLength(1);
        expect(hook.getCurrent().coverage).toBe('complete');
        await hook.unmount();
    });

    it('keeps an explicitly addressed Home isolated from another active Home inventory', async () => {
        storage.setState({
            sessions: { s1: createSessionFixture({ id: 's1', serverId: 'server-1' }) },
            sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: ['m1'], messagesById: {
                m1: { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'private active Home' },
            } }) },
        });
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'global', serverId: 'server-2' }));
        expect(hook.getCurrent().entries).toEqual([]);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().coverage).toBe('partial');
        expect(hook.getCurrent().error).toBe(true);
        await hook.unmount();
    });

    it('reads the latest history before certifying a shared cache that began below a loaded transcript window', async () => {
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 4, role: 'user', text: 'older navigation cache' },
            ], hasMore: false, nextBeforeSeq: null })
            .mockResolvedValueOnce({ status: 'loaded', rows: [
                { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 9, role: 'user', text: 'latest prompt' },
            ], hasMore: true, nextBeforeSeq: 9 })
            .mockResolvedValueOnce({ status: 'loaded', rows: [], hasMore: false, nextBeforeSeq: null });
        const navigation = await renderHook(() => useUserMessageHistoryRemoteEntries({ sessionId: 's1', initialBeforeSeq: 20 }));
        await act(async () => { navigation.getCurrent().requestNextPage(); await flushHookEffects(); });
        await navigation.unmount();
        const hook = await renderHook(() => useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1' }));
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenNthCalledWith(2, 's1', { limit: 40 });
        expect(hook.getCurrent().entries.map((entry) => entry.text)).toEqual(['latest prompt', 'older navigation cache']);
        expect(hook.getCurrent().coverage).toBe('partial');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenNthCalledWith(3, 's1', { limit: 40, beforeSeq: 9 });
        expect(hook.getCurrent().coverage).toBe('complete');
        await hook.unmount();
    });

    it('shares one in-flight remote history page across same-scope consumers', async () => {
        const page = createDeferred<{
            status: 'loaded';
            rows: Array<{ messageId: string; routeMessageId: string; seq: number; createdAt: number; role: 'user'; text: string }>;
            hasMore: boolean;
            nextBeforeSeq: number | null;
        }>();
        fetchUserMessageHistoryPageMock.mockReturnValueOnce(page.promise);

        const hook = await renderHook(() => {
            const first = useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            });
            const second = useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            });
            return { first, second };
        });

        await act(async () => {
            hook.getCurrent().first.requestNextPage();
            hook.getCurrent().second.requestNextPage();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('s1', { limit: 40 });

        await act(async () => {
            page.resolve({
                status: 'loaded',
                rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'shared prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });
            await page.promise;
            await flushHookEffects();
        });

        expect(hook.getCurrent().first.rows).toEqual([{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'shared prompt' }]);
        expect(hook.getCurrent().second.rows).toEqual([{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'shared prompt' }]);
        await hook.unmount();
    });

    it('keys shared remote history by active server account scope', async () => {
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'account one prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'account two prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['account one prompt']);

        await act(async () => {
            storage.setState((state) => ({
                ...state,
                profileScope: { serverId: 'server-1', accountId: 'account-2' },
            }));
            await hook.rerender();
        });

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['account two prompt']);
        await hook.unmount();
    });

    it('reuses shared remote entries when composer history warms up later', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({
            status: 'loaded',
            rows: [{ messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'cached remote prompt' }],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const remoteHook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );
        await act(async () => {
            remoteHook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        await remoteHook.unmount();

        const historyHook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );
        await act(async () => {
            historyHook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        expect(historyHook.getCurrent().moveUp('draft')).toBe('cached remote prompt');
        await historyHook.unmount();
    });

    it('preserves repeated remote prompt text as distinct seq-backed entries', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({
            status: 'loaded',
            rows: [
                { messageId: 'm8', routeMessageId: 'server:m8', seq: 8, createdAt: 80, role: 'user' as const, text: 'repeat this' },
                { messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 40, role: 'user' as const, text: 'repeat this' },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(hook.getCurrent().rows.map((entry) => entry.seq)).toEqual([8, 4]);
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['repeat this', 'repeat this']);
        await hook.unmount();
    });

    it('extends the cached record when the transcript cursor moves older instead of refetching from scratch', async () => {
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 90, role: 'user' as const, text: 'first page' }],
                hasMore: true,
                nextBeforeSeq: 9,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm4', routeMessageId: 'server:m4', seq: 4, createdAt: 40, role: 'user' as const, text: 'second page' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(
            (props: { initialBeforeSeq: number }) =>
                useUserMessageHistoryRemoteEntries({
                    enabled: true,
                    initialBeforeSeq: props.initialBeforeSeq,
                    sessionId: 's1',
                }),
            { initialProps: { initialBeforeSeq: 20 } },
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().rows.map((row) => row.text)).toEqual(['first page']);

        // Loading older transcript messages moves the cursor the host would seed with.
        await hook.rerender({ initialBeforeSeq: 12 });
        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenNthCalledWith(2, 's1', { limit: 40, beforeSeq: 9 });
        expect(hook.getCurrent().rows.map((row) => row.text)).toEqual(['first page', 'second page']);
        await hook.unmount();
    });

    it('keeps agent rows out of composer history while sharing one fetched page', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({
            status: 'loaded',
            rows: [
                { messageId: 'm5', routeMessageId: 'server:m5', seq: 5, createdAt: 50, role: 'user' as const, text: 'a prompt' },
                { messageId: 'm6', routeMessageId: 'server:m6', seq: 6, createdAt: 60, role: 'assistant' as const, text: 'an answer' },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('a prompt');
        expect(hook.getCurrent().moveUp('a prompt')).toBe('a prompt');
        await hook.unmount();
    });

    it('walks the newest remote prompt first when the real history fetch produces the page', async () => {
        // Composed on purpose: the mock stops at the HTTP transport so the real page pipeline,
        // the real row builder and the real merge decide the order the composer navigates.
        const serverPage = {
            // A `beforeSeq` page comes back newest-first from the server.
            messages: [3, 2, 1].map((seq) => ({
                id: `m${seq}`,
                seq,
                localId: null,
                messageRole: 'user' as const,
                content: { t: 'plain' as const, v: {
                    role: 'user', content: { type: 'text', text: `expanded prompt ${seq}` },
                    meta: { displayText: `  prompt ${seq}\n` },
                } },
                createdAt: seq * 10,
            })),
            hasMore: false,
            nextBeforeSeq: null,
        };
        fetchUserMessageHistoryPageMock.mockImplementation((
            sessionId: string,
            options?: Readonly<{ beforeSeq?: number | null; limit?: number }>,
        ) => fetchUserMessageHistoryPage({
            sessionId,
            sessionEncryptionMode: 'plain',
            beforeSeq: options?.beforeSeq ?? null,
            limit: options?.limit,
            // Narrow transport fixture: only the network response shape is faked.
            request: async () => ({ ok: true, status: 200, json: async () => serverPage } as Response),
            getSessionEncryption: () => null,
        }));

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('  prompt 3\n');
        expect(hook.getCurrent().moveUp('  prompt 3\n')).toBe('  prompt 2\n');
        expect(hook.getCurrent().moveUp('  prompt 2\n')).toBe('  prompt 1\n');
        await hook.unmount();
    });

    it('keeps the cursor retryable when session keys are not ready yet', async () => {
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({ status: 'not_ready' })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'decrypted later' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().pendingEncryption).toBe(true);
        expect(hook.getCurrent().hasMore).toBe(true);

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(hook.getCurrent().rows.map((row) => row.text)).toEqual(['decrypted later']);
        expect(hook.getCurrent().pendingEncryption).toBe(false);
        await hook.unmount();
    });

    it('loads server user messages on warmup when no local per-session history is loaded', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({
            status: 'loaded',
            rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'from server' }],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('s1', {
            limit: 40,
        });
        expect(hook.getCurrent().moveUp('draft')).toBe('from server');
        await hook.unmount();
    });

    it('does not query old servers without session message role capability', async () => {
        roleQuerySupportedState.supported = false;
        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('cools a failing remote history cursor down before retrying it', async () => {
        // Only the clock is faked: the retry floor is wall-clock based and the rest of the
        // hook still runs on real microtasks.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({ status: 'error' })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'retried prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);

        // A failed page leaves the cursor unchanged, so the transcript-navigation continuation
        // effect re-drives it on every transcript store update. Those must not reach the wire.
        await act(async () => {
            hook.getCurrent().requestNextPage();
            hook.getCurrent().requestNextPage();
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS);
        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().rows.map((entry) => entry.text)).toEqual(['retried prompt']);
        await hook.unmount();
    });

    it('cools the cursor down when the remote history request rejects outright', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        fetchUserMessageHistoryPageMock.mockRejectedValueOnce(new Error('offline'));

        const hook = await renderHook(() =>
            useUserMessageHistoryRemoteEntries({
                enabled: true,
                initialBeforeSeq: null,
                sessionId: 's1',
            }),
        );

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        await act(async () => {
            hook.getCurrent().requestNextPage();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().hasMore).toBe(true);
        await hook.unmount();
    });

    it('prefetches before reaching the oldest loaded user message and stops after exhaustion', async () => {
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [
                    { messageId: 'm10', routeMessageId: 'server:m10', seq: 10, createdAt: 100, role: 'user' as const, text: 'ten' },
                    { messageId: 'm9', routeMessageId: 'server:m9', seq: 9, createdAt: 90, role: 'user' as const, text: 'nine' },
                    { messageId: 'm8', routeMessageId: 'server:m8', seq: 8, createdAt: 80, role: 'user' as const, text: 'eight' },
                    { messageId: 'm7', routeMessageId: 'server:m7', seq: 7, createdAt: 70, role: 'user' as const, text: 'seven' },
                ],
                hasMore: true,
                nextBeforeSeq: 7,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                rows: [],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('ten');

        await act(async () => {
            expect(hook.getCurrent().moveUp('ten')).toBe('nine');
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenLastCalledWith('s1', {
            limit: 40,
            beforeSeq: 7,
        });

        await act(async () => {
            expect(hook.getCurrent().moveUp('nine')).toBe('eight');
            expect(hook.getCurrent().moveUp('eight')).toBe('seven');
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('ignores a remote history page that resolves after switching sessions', async () => {
        const stalePage = createDeferred<{
            status: 'loaded';
            rows: Array<{ messageId: string; routeMessageId: string; seq: number; createdAt: number; role: 'user'; text: string }>;
            hasMore: boolean;
            nextBeforeSeq: number | null;
        }>();
        fetchUserMessageHistoryPageMock.mockReturnValueOnce(stalePage.promise);

        const hook = await renderHook(
            (props: { sessionId: string }) =>
                useUserMessageHistory({ scope: 'perSession', sessionId: props.sessionId, maxEntries: 20 }),
            { initialProps: { sessionId: 's1' } },
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                s2: {
                    messageIdsOldestFirst: ['s2-user'],
                    messagesById: {
                        's2-user': {
                            kind: 'user-text',
                            id: 's2-user',
                            localId: null,
                            createdAt: 40,
                            text: 'session two prompt',
                        },
                    },
                    messagesMap: {
                        's2-user': {
                            kind: 'user-text',
                            id: 's2-user',
                            localId: null,
                            createdAt: 40,
                            text: 'session two prompt',
                        },
                    },
                    reducerState: createReducer(),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: null,
                    isLoaded: true,
                },
            },
        }));
        await hook.rerender({ sessionId: 's2' });

        await act(async () => {
            stalePage.resolve({
                status: 'loaded',
                rows: [{ messageId: 'm3', routeMessageId: 'server:m3', seq: 3, createdAt: 30, role: 'user' as const, text: 'stale session one prompt' }],
                hasMore: false,
                nextBeforeSeq: null,
            });
            await stalePage.promise;
            await flushHookEffects();
        });

        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({
            status: 'loaded',
            rows: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
        expect(hook.getCurrent().moveUp('draft')).toBe('session two prompt');
        await hook.unmount();
    });

    it('keeps active browsing state when role-query support becomes ready', async () => {
        roleQuerySupportedState.supported = false;
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                s1: {
                    messageIdsOldestFirst: ['older', 'newer'],
                    messagesById: {
                        older: { kind: 'user-text', id: 'older', localId: null, createdAt: 10, text: 'older prompt' },
                        newer: { kind: 'user-text', id: 'newer', localId: null, createdAt: 20, text: 'newer prompt' },
                    },
                    messagesMap: {
                        older: { kind: 'user-text', id: 'older', localId: null, createdAt: 10, text: 'older prompt' },
                        newer: { kind: 'user-text', id: 'newer', localId: null, createdAt: 20, text: 'newer prompt' },
                    },
                    reducerState: createReducer(),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: null,
                    isLoaded: true,
                },
            },
        }));

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        expect(hook.getCurrent().moveUp('draft')).toBe('newer prompt');

        roleQuerySupportedState.supported = true;
        fetchUserMessageHistoryPageMock.mockResolvedValue({
            status: 'loaded',
            rows: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
        await hook.rerender();

        expect(hook.getCurrent().moveUp('newer prompt')).toBe('older prompt');
        await hook.unmount();
    });
});
