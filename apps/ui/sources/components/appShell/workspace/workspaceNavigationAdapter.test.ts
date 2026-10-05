import { describe, expect, it, vi } from 'vitest';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

function harness(pages: Parameters<typeof resolveCompactAppDestinations>[0]['pages'] = [], scope?: Readonly<{ serverId: string; accountId: string }>) {
    let state = createWorkspaceState({ id: 'A', target: { kind: 'session', params: { id: 'A1', serverId: 'home-a' } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages });
    const commits: Array<{ href: string; entry: { tabId: string; groupId: string; target: typeof state.tabs.A.target }; replace: boolean }> = [];
    const publications: Array<typeof state> = [];
    let id = 0;
    const adapter = createWorkspaceNavigationAdapter({
        getState: () => state, getCatalog: () => catalog,
        dispatch: (action) => { state = reduceWorkspaceState(state, action); publications.push(state); },
        transport: { commit: (href, entry, replace) => { commits.push({ href, entry, replace }); } },
        createId: () => `generated:${++id}`, onChange: () => {},
        ...(scope ? { getScope: () => scope } : {}),
    });
    const active = () => state.tabs[state.groups[state.focusedGroupId].activeTabId];
    return { adapter, commits, publications, active, state: () => state };
}

describe('workspace navigation adapter', () => {
    it('qualifies implicit current-realm Session destinations without conflating another Account or Home', () => {
        const h = harness([], { serverId: 'home-a', accountId: 'account-a' });
        h.adapter.dispatch({ type: 'setTarget', tabId: 'A', target: { kind: 'session', params: { id: 'A1' } } });
        expect(h.adapter.findOpenHref('/session/A1?serverId=home-a&accountId=account-a')).toEqual({ tabId: 'A', groupId: 'group:1' });
        expect(h.adapter.findOpenHref('/session/A1?serverId=home-a&accountId=account-b')).toBeNull();
        expect(h.adapter.findOpenHref('/session/A1?serverId=home-b&accountId=account-a')).toBeNull();
        h.adapter.openHref('/session/A1?serverId=home-a&accountId=account-a', { mode: 'newTab', reuseExisting: true });
        expect(Object.keys(h.state().tabs)).toEqual(['A']);
    });
    it('publishes a destination edge as one admitted layout without exposing an intermediate centre tab', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/session/edge?serverId=home-a', { mode: 'splitRight',
            availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
        const edge = h.active().id;
        const publishedWithEdge = h.publications.filter(state => state.tabs[edge]);
        expect(publishedWithEdge.length).toBeGreaterThan(0);
        expect(publishedWithEdge.every(state => !state.groups['group:1'].tabIds.includes(edge))).toBe(true);
    });

    it('preserves explicit preview disposition when reusing its qualified destination', () => {
        const h = harness();
        h.adapter.openHref('/session/preview?serverId=home-a');
        const id = h.active().id;
        h.adapter.openHref('/session/preview?serverId=home-a', { mode: 'preview', reuseExisting: true });
        expect(h.active()).toMatchObject({ id, preview: true });
    });

    it('keeps destination drops before a live tab anchor and focuses qualified already-open destinations across groups', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'splitRight',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const secondGroup = h.state().focusedGroupId;
        const b = h.active().id;
        h.adapter.setParams(b, { right: 'files', anchor: 'saved-position' });
        h.adapter.openHref('/session/C1?serverId=home-a', { groupId: secondGroup, mode: 'newTab', beforeTabId: b, reuseExisting: true });
        const c = h.active().id;
        expect(h.state().groups[secondGroup].tabIds).toEqual([c, b]);
        h.adapter.openHref('/session/B1?serverId=home-b', { groupId: 'group:1', mode: 'newTab', reuseExisting: true });
        expect(h.active().id).toBe(b);
        expect(h.active().target.params.right).toBe('files');
        expect(h.adapter.findOpenHref('/session/%42%31?serverId=home-b')).toEqual({ tabId: b, groupId: secondGroup });
        expect(h.adapter.findOpenHref('/session/B1?serverId=home-c')).toBeNull();
        expect(h.state().focusedGroupId).toBe(secondGroup);
        expect(h.state().groups[secondGroup].tabIds).toEqual([c, b]);
        h.adapter.openHref('/session/B1?serverId=home-a', { groupId: 'group:1', mode: 'newTab', reuseExisting: true });
        expect(h.active().id).not.toBe(b);
        expect(h.state().tabs.A).toBeDefined();
        expect(h.state().tabs[c]).toBeDefined();
    });

    it('reopens through URL history and reuses an already open catalog singleton', () => {
        const h = harness([{
            id: 'plugin:acme.notes:notes', pluginId: 'acme.notes', descriptorId: 'notes', localId: 'notes',
            label: 'Notes', icon: 'note', order: 40, disabledReason: null,
            placement: {} as NonNullable<Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]>['placement'],
            routePath: '/plugins/acme.notes/notes',
        }]);
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
        const closedId = h.active().id;
        h.adapter.closeTab('group:1', closedId);
        h.adapter.openHref('/plugins/acme.notes/notes/second', { mode: 'newTab' });
        const existingId = h.active().id;
        expect(h.adapter.reopenTab(closedId)).toBe(true);
        expect(h.active().id).toBe(existingId);
        expect(h.active().target.params.subPath).toBe('first');
        expect(Object.values(h.state().tabs).filter(tab => tab.target.kind === 'plugin:acme.notes:notes')).toHaveLength(1);
        expect(h.commits.at(-1)?.href).toBe('/plugins/acme.notes/notes/first');
        expect(h.state().recentlyClosed).toEqual([]);
    });
    it('promotes an existing preview through new-tab intent without duplicating its identity or pinning it', () => {
        const h = harness();
        h.adapter.openHref('/session/B1?serverId=home-b');
        const previewId = h.active().id;
        expect(h.active().preview).toBe(true);
        h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'newTab' });
        expect(h.active().id).toBe(previewId);
        expect(h.active()).toMatchObject({ pinned: false, preview: false });
        expect(Object.values(h.state().tabs).filter((tab) => tab.target.params.id === 'B1')).toHaveLength(1);
        h.adapter.openHref('/session/C1?serverId=home-c');
        const explicitId = h.active().id;
        h.adapter.openHref('/session/C1?serverId=home-c', { tabId: explicitId, mode: 'newTab' });
        expect(h.active()).toMatchObject({ id: explicitId, pinned: false, preview: false });
        h.adapter.openHref('/session/D1?serverId=home-d');
        expect(h.state().tabs[previewId].target.params.id).toBe('B1');
        expect(h.state().tabs[explicitId].target.params.id).toBe('C1');
        h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'newTab' });
        expect(h.active().id).not.toBe(previewId);
        expect(Object.values(h.state().tabs).filter((tab) => tab.target.params.id === 'B1')).toHaveLength(2);
    });

    it.each([false, true])('restores a singleton into its existing visible group after the historical tab was closed: %s', (closed) => {
        const h = harness([{
            id: 'plugin:acme.notes:notes', pluginId: 'acme.notes', descriptorId: 'notes', localId: 'notes',
            label: 'Notes', icon: 'note', order: 40, disabledReason: null,
            placement: {} as NonNullable<Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]>['placement'],
            routePath: '/plugins/acme.notes/notes',
        }]);
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/plugins/acme.notes/notes/first');
        h.adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
        expect(h.active().preview).toBe(false);
        const historicalTabId = h.active().id;
        h.adapter.openHref('/session/A2?serverId=home-a', { tabId: historicalTabId });
        if (closed) h.adapter.closeTab('group:1', historicalTabId);
        h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'splitRight',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        h.adapter.openHref('/plugins/acme.notes/notes/second', { mode: 'newTab' });
        const liveTabId = h.active().id;
        const liveGroupId = h.state().focusedGroupId;
        while (h.adapter.history.index > 1) h.adapter.step(-1);
        expect(h.active()).toMatchObject({ id: liveTabId, target: { params: { subPath: 'first' } } });
        expect(h.state().focusedGroupId).toBe(liveGroupId);
        expect(Object.values(h.state().tabs).filter((tab) => tab.target.kind === 'plugin:acme.notes:notes')).toHaveLength(1);
        expect(Object.keys(h.state().groups)).toHaveLength(2);
        expect(h.commits.at(-1)?.entry.tabId).toBe(liveTabId);
        h.adapter.step(1);
        expect(h.active().target.params.id).toBe('A2');
        expect(h.state().focusedGroupId).toBe('group:1');
    });

    it('rejects an explicit missing tab without opening a different tab', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        const before = h.state();
        expect(h.adapter.openHref('/session/B1?serverId=home-b', { tabId: 'missing' })).toBe(false);
        expect(h.state()).toBe(before);
        expect(h.adapter.history.entries).toHaveLength(1);
    });
    it('updates background params without stealing focus or overwriting the focused URL', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'newTab' });
        const visits = h.commits.length;
        h.adapter.setParams('A', { right: 'files', unused: undefined });
        expect(h.active().target.params.id).toBe('B1');
        expect(h.state().tabs.A.target.params).toEqual({ id: 'A1', serverId: 'home-a', right: 'files' });
        expect(h.commits).toHaveLength(visits);
        h.adapter.activateTab('group:1', 'A');
        h.adapter.setParams('A', { right: undefined, anchor: 'line-2' });
        expect(h.commits.at(-1)).toMatchObject({ href: '/session/A1?serverId=home-a#line-2', replace: true });
    });

    it('keeps plugin app pages singleton across reopen, new-tab and split intents', () => {
        const h = harness([{
            id: 'plugin:acme.notes:notes', pluginId: 'acme.notes', descriptorId: 'notes', localId: 'notes',
            label: 'Notes', icon: 'note', order: 40, disabledReason: null,
            placement: {} as NonNullable<Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]>['placement'],
            routePath: '/plugins/acme.notes/notes',
        }]);
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
        const pluginTabId = h.active().id;
        h.adapter.openHref('/session/A1?serverId=home-a');
        h.adapter.openHref('/plugins/acme.notes/notes/second', { mode: 'splitRight',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        expect(h.active().id).toBe(pluginTabId);
        expect(h.active().target.params.subPath).toBe('second');
        expect(Object.values(h.state().tabs).filter((tab) => tab.target.kind === 'plugin:acme.notes:notes')).toHaveLength(1);
        expect(Object.keys(h.state().groups)).toHaveLength(1);
        h.adapter.openHref('/plugins/acme.notes/notes/third', { tabId: 'A' });
        expect(h.active().id).toBe(pluginTabId);
        expect(h.state().tabs.A.target.kind).toBe('session');
        expect(Object.values(h.state().tabs).filter((tab) => tab.target.kind === 'plugin:acme.notes:notes')).toHaveLength(1);
    });
    it('does not traverse beyond the known global history', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.step(-1);
        expect(h.adapter.history.index).toBe(0);
        expect(h.commits).toHaveLength(1);
    });
    it('projects one history including tab switches and restores A2/A1/A2/B1', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/session/A2?serverId=home-a', { tabId: 'A' });
        h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'newTab' });
        for (const [direction, id, serverId] of [[-1, 'A2', 'home-a'], [-1, 'A1', 'home-a'], [1, 'A2', 'home-a'], [1, 'B1', 'home-b']] as const) {
            h.adapter.step(direction);
            expect(h.active().target.params).toEqual({ id, serverId });
            expect(h.commits.at(-1)?.href).toBe(`/session/${id}?serverId=${serverId}`);
        }
        expect(h.adapter.history.entries.map((entry) => entry.target.params.id)).toEqual(['A1', 'A2', 'B1']);
    });

    it('reopens closed history tabs as previews and applies a reload URL after restored layout', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/settings/appearance', { mode: 'newTab' });
        h.adapter.closeTab('group:1', 'A');
        h.adapter.step(-1);
        expect(h.active()).toMatchObject({ id: 'A', preview: true, target: { params: { id: 'A1', serverId: 'home-a' } } });
        h.adapter.openHref('/settings/account', { replace: true });
        expect(h.active().target).toEqual({ kind: 'settings', params: { pageId: 'account' } });
        expect(h.adapter.canGoForward).toBe(true);
        h.adapter.step(1);
        expect(h.active().target).toEqual({ kind: 'settings', params: { pageId: 'appearance' } });
    });

    it('uses the exact browser entry position when a destination was revisited', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        h.adapter.openHref('/session/A2?serverId=home-a', { tabId: 'A' });
        h.adapter.openHref('/session/A1?serverId=home-a', { tabId: 'A' });
        const last = h.adapter.history.entries[2];
        h.adapter.acceptUrl('/session/A1?serverId=home-a', last, 2);
        expect(h.adapter.history.index).toBe(2);
        h.adapter.step(-1);
        expect(h.active().target.params.id).toBe('A2');
    });

    it('leaves the layout and history intact when a measured split cannot fit', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        const before = h.state();
        expect(h.adapter.openHref('/settings/appearance', {
            mode: 'splitRight', availableSizePx: 400,
            minimumFirstSizePx: 300, minimumSecondSizePx: 300,
        })).toBe(false);
        expect(h.state()).toBe(before);
        expect(h.adapter.history.entries).toHaveLength(1);
    });

    it('does not push another browser entry when accepting an external deep link', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        const commitsBefore = h.commits.length;
        h.adapter.acceptUrl('/settings/appearance');
        expect(h.active().target).toEqual({ kind: 'settings', params: { pageId: 'appearance' } });
        expect(h.commits).toHaveLength(commitsBefore);
    });

    it('opens a server-qualified destination in a measured split when it fits', () => {
        const h = harness();
        h.adapter.initialize('/session/A1?serverId=home-a');
        expect(h.adapter.openHref('/session/B1?serverId=home-b', {
            mode: 'splitRight', availableSizePx: 900,
            minimumFirstSizePx: 300, minimumSecondSizePx: 300,
        })).toBe(true);
        expect(Object.keys(h.state().groups)).toHaveLength(2);
        expect(h.active().target.params).toEqual({ id: 'B1', serverId: 'home-b' });
        h.adapter.step(-1);
        expect(h.state().focusedGroupId).toBe('group:1');
        expect(h.active().target.params).toEqual({ id: 'A1', serverId: 'home-a' });
    });
});
