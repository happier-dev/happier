import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sync } from '@/sync/sync';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { resetScopedSessionDataKeyCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';

import { useSessionListTranscriptSearch } from './useSessionListTranscriptSearch';

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
// The only mocked execution boundary is HTTP; query parsing, paging, decryption and orchestration stay real.
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: Parameters<typeof fetch>) => fetchMock(...args),
}));
const token = `e30.${btoa(JSON.stringify({ sub: 'search-account' }))}.signature`;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
function item(id: string): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session', serverId: getActiveServerSnapshot().serverId,
        groupKey: 'project:/repo', groupKind: 'project', section: 'inactive',
        session: {
            id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, agentStateVersion: 0, metadata: { name: 'Unopened', path: '/repo' },
            thinking: false, thinkingAt: 0, presence: 0,
        },
    };
}
function respond(url: RequestInfo | URL) {
    const parsed = new URL(String(url));
    const id = parsed.pathname.split('/')[3];
    if (parsed.pathname.startsWith('/v2/sessions/')) return json({ session: {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadata: '{}', metadataVersion: 1, agentState: null,
        agentStateVersion: 0, dataEncryptionKey: null, encryptionMode: 'plain',
    } });
    if (parsed.pathname.endsWith('/messages')) return json({
        messages: [{ id: `message-${id}`, seq: 1, createdAt: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'needle umbrella pigs' } } } }],
        hasMore: false,
    });
    return json({ status: 'ok' });
}
async function settle() {
    await flushHookEffects({ advanceTimersMs: 300, cycles: 2 });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    upsertAndActivateServer({ serverUrl: 'https://transcript-search.example.test', name: 'Search test', scope: 'device' });
    // Credential persistence is a system boundary; use genuine keyless Account credentials.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
    fetchMock.mockImplementation(async (url) => respond(url));
});
afterEach(async () => {
    await standardCleanup();
    vi.restoreAllMocks();
    fetchMock.mockReset();
    resetScopedSessionDataKeyCacheForTests();
    await resetServerReachabilitySupervisors();
    vi.useRealTimers();
});

describe('useSessionListTranscriptSearch', () => {
    it('does not subscribe a hidden search to server changes', async () => {
        const props = { searchQuery: 'needle', items: [item('saved')], searchableTextBySessionKey: {}, enabled: false };
        let renders = 0;
        await renderHook(() => {
            renders += 1;
            return useSessionListTranscriptSearch(props);
        });
        const beforeSwitch = renders;
        await act(async () => {
            upsertAndActivateServer({ serverUrl: 'https://other-search.example.test', name: 'Other test', scope: 'device' });
        });
        expect(getActiveServerSnapshot().serverUrl).toBe('https://other-search.example.test');
        expect(renders).toBe(beforeSwitch);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('finds more than fifty unopened sessions and reuses unchanged verdicts while the list refreshes', async () => {
        const items = Array.from({ length: 60 }, (_, index) => item(`saved-${index}`));
        const props = { searchQuery: 'needle', items, searchableTextBySessionKey: {}, loadHistory: sync.fetchSessionListSearchHistory, enabled: true };
        const messagesRead = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages')).length;
        const hook = await renderHook(useSessionListTranscriptSearch, { initialProps: props });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
            await vi.waitFor(() => expect(messagesRead()).toBe(60));
        });
        await flushHookEffects();
        expect(hook.getCurrent().isSearching).toBe(false);
        const keys = hook.getCurrent().transcriptMatchedSessionKeys;
        expect(keys.size).toBe(60);
        expect(hook.getCurrent().hasError).toBe(false);
        expect(messagesRead()).toBe(60);
        await hook.rerender({ ...props, items: items.map((entry) => ({ ...entry, session: { ...entry.session, activeAt: 999 } })) });
        await settle();
        expect(messagesRead()).toBe(60);
        expect(hook.getCurrent().transcriptMatchedSessionKeys).toBe(keys);
        await hook.rerender({ ...props, items: [...items, item('saved-extra')] });
        await settle();
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(61);
        expect(messagesRead()).toBe(61);
        await hook.rerender({ ...props, items: items.map((entry, index) => index === 0
            ? { ...entry, session: { ...entry.session, seq: 2 } } : entry) });
        await settle();
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(60);
        expect(messagesRead()).toBe(62);
    });

    it('does no transcript work without demand and cancels stale query results through blur and resume', async () => {
        const props = { searchQuery: 'needle', items: [item('saved')], searchableTextBySessionKey: {}, loadHistory: sync.fetchSessionListSearchHistory, enabled: false };
        const hook = await renderHook(useSessionListTranscriptSearch, { initialProps: props });
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        await hook.rerender({ ...props, enabled: true, searchQuery: '' });
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();

        let resolveOld!: (response: Response) => void;
        let oldSignal: AbortSignal | null | undefined;
        fetchMock.mockImplementation(async (url, init) => {
            if (String(url).includes('/messages')) {
                oldSignal = init?.signal;
                return await new Promise<Response>((resolve) => { resolveOld = resolve; });
            }
            return respond(url);
        });
        await hook.rerender({ ...props, enabled: true });
        await settle();
        expect(hook.getCurrent().isSearching).toBe(true);
        expect(oldSignal?.aborted).toBe(false);
        await hook.rerender(props);
        expect(oldSignal?.aborted).toBe(true);
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(0);
        resolveOld(respond('https://transcript-search.example.test/v1/sessions/saved/messages'));
        await flushHookEffects();
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(0);
        fetchMock.mockImplementation(async (url) => respond(url));
        await hook.rerender({ ...props, enabled: true, searchQuery: 'needle -"umbrella pigs"' });
        await settle();
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(0);
        expect([...hook.getCurrent().transcriptExcludedSessionKeys]).toEqual([`${getActiveServerSnapshot().serverId}:saved`]);
        await hook.rerender({ ...props, enabled: true });
        await settle();
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(1);
    });

    it('offers retry for failed saved-message reads and clears the error after recovery', async () => {
        fetchMock.mockImplementation(async (url) => String(url).includes('/messages')
            ? new Response('', { status: 503 }) : respond(url));
        const props = { searchQuery: 'needle', items: [item('saved')], searchableTextBySessionKey: {}, loadHistory: sync.fetchSessionListSearchHistory, enabled: true };
        const hook = await renderHook(useSessionListTranscriptSearch, { initialProps: props });
        await settle();
        expect(hook.getCurrent().hasError).toBe(true);
        expect(hook.getCurrent().isSearching).toBe(false);
        fetchMock.mockImplementation(async (url) => respond(url));
        await act(async () => hook.getCurrent().retry());
        await settle();
        expect(hook.getCurrent().hasError).toBe(false);
        expect(hook.getCurrent().transcriptMatchedSessionKeys.size).toBe(1);
    });
});
