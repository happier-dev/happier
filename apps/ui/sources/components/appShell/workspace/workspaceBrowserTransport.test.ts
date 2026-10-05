import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceBrowserTransport } from './workspaceBrowserTransport';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

installPanelCommonModuleMocks();
// Browser navigation never renders Markdown; fail on use of this vendor/native SDK boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace browser test'); },
}));
// Recipient-envelope HTTP/process APIs are outside this deterministic browser owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace browser test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

describe('workspace browser URL transport', () => {
    it('restores the current browser entry before a guard decision, then resumes the same traversal', () => {
        const entries = [{ state: { id: 'initial' }, href: '/session/A1' }];
        let position = 0;
        let nextId = 0;
        let allow: (() => void) | null = null;
        const accepted: string[] = [];
        const browser = {
            get state() { return entries[position].state; },
            pushState(state: { id: string }, _title: string, href?: string | URL | null) {
                entries.splice(position + 1);
                entries.push({ state, href: String(href) });
                position++;
            },
            replaceState(state: { id: string }, _title: string, href?: string | URL | null) {
                entries[position] = { state, href: String(href) };
            },
            go(delta: number) { position += delta; transport.acceptPopState(browser.state); },
        };
        const transport = createWorkspaceBrowserTransport({
            history: browser, getHref: () => entries[position].href,
            mirror: () => {}, createId: () => `id:${++nextId}`,
            accept: (href) => { accepted.push(href); },
            guard: (_direction, proceed) => { allow = proceed; },
        });
        const entry = { tabId: 'A', groupId: 'group:1', target: { kind: 'session', params: { id: 'A1' } } };
        transport.commit('/session/A1', entry, true, 0);
        transport.commit('/session/A2', { ...entry, target: { kind: 'session', params: { id: 'A2' } } }, false, 1);
        browser.go(-1);
        expect(entries[position].href).toBe('/session/A2');
        expect(accepted).toEqual([]);
        expect(allow).not.toBeNull();
        (allow as unknown as () => void)();
        expect(accepted).toEqual(['/session/A1']);
        expect(entries[position].href).toBe('/session/A1');
        expect(entries).toHaveLength(2);
    });
    it('uses browser Back and app Forward to restore exact entries, including a closed tab', () => {
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: false, workflows: false, friends: false }, pages: [{
            id: 'plugin:acme.notes:notes', pluginId: 'acme.notes', descriptorId: 'notes', localId: 'notes',
            label: 'Notes', icon: 'note', order: 40, disabledReason: null,
            placement: {} as NonNullable<Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]>['placement'],
            routePath: '/plugins/acme.notes/notes',
        }] });
        let layout = createWorkspaceState({ id: 'A', target: { kind: 'session', params: { id: 'A1', serverId: 'home-a' } }, pinned: false, preview: false });
        const entries: Array<{ state: unknown; href: string }> = [{ state: { id: 'expo-initial' }, href: '/session/A1?serverId=home-a' }];
        let position = 0;
        let id = 0;
        const mirrors: string[] = [];
        const browser = {
            get state() { return entries[position].state; },
            pushState(state: unknown, _title: string, href?: string | URL | null) {
                entries.splice(position + 1);
                entries.push({ state, href: String(href) });
                position++;
            },
            replaceState(state: unknown, _title: string, href?: string | URL | null) {
                entries[position] = { state, href: href ? String(href) : entries[position].href };
            },
            go(delta: number) {
                position += delta;
                transport.acceptPopState(entries[position].state);
            },
        };
        const transport = createWorkspaceBrowserTransport({
            history: browser, getHref: () => entries[position].href,
            createId: () => `browser:${++id}`,
            mirror: (href) => {
                mirrors.push(href);
                // React Navigation replaces history.state with { id }; the workspace
                // must still recognize this entry without owning a parallel browser stack.
                const state = browser.state as { id: string };
                browser.replaceState({ id: state.id }, '', href);
            },
            accept: (href, entry, index) => adapter.acceptUrl(href, entry, index),
        });
        const adapter = createWorkspaceNavigationAdapter({
            getCatalog: () => catalog, getState: () => layout,
            dispatch: (action) => { layout = reduceWorkspaceState(layout, action); },
            transport, createId: () => `tab:${++id}`, onChange: () => {},
        });
        adapter.initialize(entries[position].href);
        adapter.openHref('/session/A2?serverId=home-a', { tabId: 'A' });
        adapter.openHref('/settings/appearance', { mode: 'newTab' });
        adapter.openHref('/session/A1?serverId=home-a', { tabId: 'A' });
        expect(adapter.history.index).toBe(3);
        browser.go(-1);
        expect(layout.groups[layout.focusedGroupId].activeTabId).not.toBe('A');
        expect(entries[position].href).toBe('/settings/appearance');
        adapter.closeTab('group:1', 'A');
        browser.go(-1);
        expect(layout.tabs.A).toMatchObject({ preview: true, target: { params: { id: 'A2', serverId: 'home-a' } } });
        adapter.step(1);
        expect(entries[position].href).toBe('/settings/appearance');
        expect(entries).toHaveLength(4);
        expect(mirrors.at(-1)).toBe('/settings/appearance');
        expect(transport.acceptPopState({ id: 'foreign' })).toBe(false);
        // Expo may ingest a deep link before the provider observes its URL.
        browser.pushState({ id: 'external-link' }, '', '/session/C1?serverId=home-c');
        adapter.acceptUrl('/session/C1?serverId=home-c');
        expect(entries).toHaveLength(4);
        adapter.step(-1);
        expect(entries[position].href).toBe('/settings/appearance');
        adapter.step(1);
        expect(layout.tabs[layout.groups[layout.focusedGroupId].activeTabId].target.params).toEqual({ id: 'C1', serverId: 'home-c' });
        expect(adapter.history.index).toBe(3);
        adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
        const historicalTabId = layout.groups[layout.focusedGroupId].activeTabId;
        adapter.openHref('/session/D1?serverId=home-a', { tabId: historicalTabId });
        adapter.openHref('/session/E1?serverId=home-a', { mode: 'splitRight',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        adapter.openHref('/plugins/acme.notes/notes/second', { mode: 'newTab' });
        const liveTabId = layout.groups[layout.focusedGroupId].activeTabId;
        const liveGroupId = layout.focusedGroupId;
        browser.go(-3);
        expect(layout.focusedGroupId).toBe(liveGroupId);
        expect(layout.groups[liveGroupId].activeTabId).toBe(liveTabId);
        expect(layout.tabs[liveTabId].target.params.subPath).toBe('first');
        expect(Object.values(layout.tabs).filter((tab) => tab.target.kind === 'plugin:acme.notes:notes')).toHaveLength(1);
        expect(entries[position].href).toBe('/plugins/acme.notes/notes/first');
        adapter.step(1);
        expect(layout.tabs[layout.groups[layout.focusedGroupId].activeTabId].target.params.id).toBe('D1');
        expect(entries[position].href).toBe('/session/D1?serverId=home-a');
        adapter.closeTab('group:1', historicalTabId);
        browser.go(-2);
        expect(layout.groups[layout.focusedGroupId].activeTabId).toBe(liveTabId);
        expect(layout.tabs[historicalTabId]).toBeUndefined();
        expect(Object.values(layout.tabs).filter((tab) => tab.target.kind === 'plugin:acme.notes:notes')).toHaveLength(1);
    });
});
