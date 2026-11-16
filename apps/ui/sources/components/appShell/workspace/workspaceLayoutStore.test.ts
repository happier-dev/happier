import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState, type WorkspaceTab } from './workspaceState';
import { parseWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutScopeKey } from './workspacePersistence';

const tab = (id: string): WorkspaceTab => ({ id, target: { kind: 'session', params: { id, serverId: 'home-a' } }, pinned: true, preview: false });

function layoutWith(count: number): WorkspaceState {
    let state = createWorkspaceState(tab('tab-0'));
    for (let index = 1; index < count; index += 1) {
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(`tab-${index}`),
            fallbackTitle: `Session ${index}` });
    }
    return state;
}

/** Device storage is the boundary: count what reaches it, keyed writes and bytes. */
function storageWrites(run: () => void): Readonly<{ keys: number; bytes: number; deletes: number }> {
    const storage = getPersistenceStorage();
    const set = vi.spyOn(storage, 'set');
    const remove = vi.spyOn(storage, 'delete');
    try {
        run();
        return {
            keys: set.mock.calls.length,
            bytes: set.mock.calls.reduce((total, [, value]) => total + String(value).length, 0),
            deletes: remove.mock.calls.length,
        };
    } finally {
        set.mockRestore();
        remove.mockRestore();
    }
}

const scopes: string[] = [];
afterEach(() => { for (const key of scopes.splice(0)) workspaceLayoutsState.remove(key); });

function measure(count: number) {
    const key = workspaceLayoutScopeKey({ serverId: 'home-a', accountId: 'alice', windowId: `window-${count}` });
    scopes.push(key);
    let state = layoutWith(count);
    workspaceLayoutsState.set(key, serializeWorkspaceLayout(state));
    const save = (action: Parameters<typeof reduceWorkspaceState>[1]) => storageWrites(() => {
        state = reduceWorkspaceState(state, action);
        workspaceLayoutsState.set(key, serializeWorkspaceLayout(state));
    });
    const switched = save({ type: 'activateTab', groupId: 'group:1', tabId: 'tab-3' });
    const switchedBack = save({ type: 'activateTab', groupId: 'group:1', tabId: `tab-${count - 1}` });
    const edited = save({ type: 'setPinned', tabId: 'tab-5', pinned: false });
    const opened = save({ type: 'openTab', groupId: 'group:1', tab: tab('opened') });
    const closed = save({ type: 'closeTab', groupId: 'group:1', tabId: 'tab-7', newTab: tab('blank') });
    // A fresh read (as after a reload) restores exactly the saved layout, MRU order included.
    const restored = parseWorkspaceLayout(workspaceLayoutsState.readStrict(key, value => value));
    return { switched, switchedBack, edited, opened, closed, restored, state };
}

describe('workspace layout persistence', () => {
    it('writes only what a tab switch, edit, open or close changed, independent of the tab count', () => {
        const small = measure(40);
        const large = measure(400);
        for (const result of [small, large]) {
            expect(result.restored).toEqual({ ...result.state, recentlyClosed: [] });
            expect(result.restored?.groups['group:1'].mru.slice(0, 2)).toEqual(['opened', `tab-${result === small ? 39 : 399}`]);
        }
        const counts = JSON.stringify(Object.fromEntries((['switched', 'switchedBack', 'edited', 'opened', 'closed'] as const)
            .map(name => [name, { small: small[name], large: large[name] }])));
        // A switch writes the active-tab fact (and that tab's recency), never the layout.
        expect(large.switched.bytes - small.switched.bytes, counts).toBeLessThan(16);
        expect({ keys: large.switched.keys, deletes: large.switched.deletes }).toEqual({ keys: small.switched.keys, deletes: 0 });
        expect(large.switched.keys).toBeLessThanOrEqual(2);
        expect(large.switched.bytes - small.switched.bytes).toBeLessThan(16);
        expect(large.switchedBack.bytes - small.switchedBack.bytes).toBeLessThan(16);
        // An edit writes that tab's entry, and the head.
        expect(large.edited.keys).toBeLessThanOrEqual(2);
        expect(large.edited.bytes - small.edited.bytes).toBeLessThan(16);
        // Open and close write that tab's entry plus the tab list; only the list grows with the count.
        expect(large.opened.keys).toBeLessThanOrEqual(3);
        expect(large.closed.keys).toBeLessThanOrEqual(2);
        expect(large.closed.deletes).toBe(1);
    });
});
