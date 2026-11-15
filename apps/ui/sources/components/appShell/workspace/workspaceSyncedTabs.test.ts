import { describe, expect, it } from 'vitest';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { applyWorkspaceTabIntents, collectWorkspaceTabIntents, reconcileWorkspaceSyncedTabs, emptyWorkspaceTabs } from './workspaceSyncedTabs';
import { parseWorkspaceLayout, serializeWorkspaceLayout } from './workspacePersistence';

const tab = (id: string) => ({ id, target: { kind: 'session', params: { id, serverId: 'home' } }, pinned: false, preview: false });
const record = (...ids: string[]) => ({ v: 1 as const, tabsById: Object.fromEntries(ids.map(id => [id, tab(id)])), order: ids, pairs: [] });

describe('workspace synced tab intent owner', () => {
    it('does not enumerate tab entries for an empty replay and still applies a real pin edit', () => {
        const original = record('a', 'b', 'c');
        let enumeratedEntries = 0;
        // Forward native table enumeration, including replay copies and equality serialization.
        const observed = { ...original, tabsById: new Proxy(original.tabsById, {
            ownKeys: target => {
                const keys = Reflect.ownKeys(target);
                enumeratedEntries += keys.length;
                return keys;
            },
        }) };
        expect(applyWorkspaceTabIntents(observed, [])).toBe(observed);
        expect(enumeratedEntries).toBe(0);
        const changed = applyWorkspaceTabIntents(observed, [{ type: 'patch', tabId: 'a', pinned: true }]);
        expect(changed.tabsById.a.pinned).toBe(true);
        expect(changed.order).toEqual(original.order);
        expect(observed.tabsById.a.pinned).toBe(false);
    });
    it('reconciles a shared record with membership work linear in the tab count', () => {
        // Elements scanned by array membership lookups during one reconcile of a remote reorder.
        const scanned = (count: number) => {
            const ids = Array.from({ length: count }, (_, index) => `t${index}`);
            let state = createWorkspaceState(tab(ids[0]!));
            for (const id of ids.slice(1)) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
            const remote = { ...record(...ids), order: [...ids.slice(1), ids[0]!] };
            const { includes, indexOf } = Array.prototype;
            let elements = 0;
            Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) { elements += this.length; return includes.apply(this, args); };
            Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof indexOf>) { elements += this.length; return indexOf.apply(this, args); };
            let reconciled;
            try { reconciled = reconcileWorkspaceSyncedTabs(state, remote, () => 'blank'); }
            finally { Array.prototype.includes = includes; Array.prototype.indexOf = indexOf; }
            expect(reconciled.groups['group:1'].tabIds).toEqual(remote.order);
            return elements;
        };
        const small = scanned(100);
        const large = scanned(1000);
        expect({ small, large, linear: large <= 12 * Math.max(small, 1000) }).toMatchObject({ linear: true });
    });
    // Elements scanned by array lookups and filters while `run` executes (counts O(T) vs O(T²) work, not time).
    const scannedElements = (run: () => void) => {
        const { includes, indexOf, filter } = Array.prototype;
        let elements = 0;
        Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) { elements += this.length; return includes.apply(this, args); };
        Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof indexOf>) { elements += this.length; return indexOf.apply(this, args); };
        Array.prototype.filter = function (this: unknown[], ...args: Parameters<typeof filter>) { elements += this.length; return filter.apply(this, args as never); } as typeof filter;
        try { run(); } finally { Array.prototype.includes = includes; Array.prototype.indexOf = indexOf; Array.prototype.filter = filter; }
        return elements;
    };
    const openTabs = (count: number) => {
        const ids = Array.from({ length: count }, (_, index) => `t${index}`);
        let state = createWorkspaceState(tab(ids[0]!));
        for (const id of ids.slice(1)) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
        return { ids, state };
    };
    it('restores a saved layout with membership work linear in the tab count', () => {
        const scanned = (count: number) => {
            const { state } = openTabs(count);
            const saved: unknown = JSON.parse(JSON.stringify(serializeWorkspaceLayout(state)));
            let parsed: ReturnType<typeof parseWorkspaceLayout> = null;
            const elements = scannedElements(() => { parsed = parseWorkspaceLayout(saved); });
            expect(parsed).toEqual(state);
            return elements;
        };
        const small = scanned(100);
        const large = scanned(1000);
        expect({ small, large, linear: large <= 12 * Math.max(small, 1000) }).toMatchObject({ linear: true });
    });
    it('collects and replays a local reorder with order work linear in the tab count', () => {
        const scanned = (count: number) => {
            const { ids, state } = openTabs(count);
            const reordered = reduceWorkspaceState(state, { type: 'reorderTab', groupId: 'group:1', tabId: ids[0]!, index: count - 1 });
            const shared = record(...ids);
            let replayed: ReturnType<typeof applyWorkspaceTabIntents> = shared;
            const elements = scannedElements(() => { replayed = applyWorkspaceTabIntents(shared, collectWorkspaceTabIntents(state, reordered)); });
            expect(replayed.order).toEqual([...ids.slice(1), ids[0]]);
            return elements;
        };
        const small = scanned(100);
        const large = scanned(1000);
        expect({ small, large, linear: large <= 12 * Math.max(small, 1000) }).toMatchObject({ linear: true });
    });
    it('keeps the device active destination when another client retargets its shared tab', () => {
        const local = createWorkspaceState({ ...tab('workflows'), pinned: true, target: {
            kind: 'workflows', params: { workspacePathname: '/workflows/new', definitionDraftSeedId: 'SECOND' },
        } });
        const remote = { ...record('workflows', 'remote'), tabsById: {
            ...record('workflows', 'remote').tabsById,
            workflows: { id: 'workflows', pinned: true, target: { kind: 'workflows', params: { workspacePathname: '/workflows/QA-FIN30' } } },
        } };
        const reconciled = reconcileWorkspaceSyncedTabs(local, remote, () => 'blank');
        expect(reconciled.tabs.workflows.target).toBe(local.tabs.workflows.target);
        expect(reconciled.groups['group:1'].activeTabId).toBe('workflows');
        expect(reconciled.tabs.remote).toBeDefined();
        expect(collectWorkspaceTabIntents(reconciled, reduceWorkspaceState(reconciled, {
            type: 'activateTab', groupId: 'group:1', tabId: 'remote',
        }))).toEqual([]);
    });

    it.each([false, true])('keeps each visible pane when another client closes its shared tab (split: %s)', split => {
        let local = createWorkspaceState(tab('a'));
        local = reduceWorkspaceState(local, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        if (split) local = reduceWorkspaceState(local, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const groupId = split ? 'group:2' : 'group:1';
        const reconciled = reconcileWorkspaceSyncedTabs(local, record('a', 'remote'), () => 'blank');
        expect(reconciled.groups[groupId].activeTabId).toBe('b');
        expect(reconciled.root).toBe(local.root);
        expect(reconciled.focusedGroupId).toBe(local.focusedGroupId);
        expect(reconciled.tabs.b.target).toBe(local.tabs.b.target);
        expect(reconciled.tabs.b).toBe(local.tabs.b);
        expect(reconcileWorkspaceSyncedTabs(reconciled, record('a', 'remote'), () => 'blank')).toBe(reconciled);
        if (split) {
            const closedBoth = reconcileWorkspaceSyncedTabs(reconciled, record('remote'), () => 'blank');
            expect(closedBoth.groups['group:1'].activeTabId).toBe('a');
            expect(closedBoth.tabs.a).toBe(local.tabs.a);
            expect(closedBoth.root).toBe(local.root);
        }
        const left = reduceWorkspaceState(reconciled, { type: 'openTab', groupId, tab: tab('replacement') });
        expect(reconcileWorkspaceSyncedTabs(left, record('a', 'remote'), () => 'blank').tabs.b).toBeUndefined();
    });
    it('rebases a close and a reorder without dropping a concurrent open or resurrecting a closed tab', () => {
        const winner = record('a', 'c', 'remote');
        const next = applyWorkspaceTabIntents(winner, [
            { type: 'close', tabId: 'a' }, { type: 'patch', tabId: 'b', pinned: true },
            { type: 'move', tabId: 'c', beforeId: 'remote' }, { type: 'open', tab: tab('local') },
        ]);
        expect(next.order).toEqual(['c', 'remote', 'local']);
        expect(next.tabsById.b).toBeUndefined();
        expect(Object.keys(next.tabsById).sort()).toEqual(['c', 'local', 'remote']);
        const paired = applyWorkspaceTabIntents(next, [{ type: 'pairs', pairs: [['c', 'c'], ['c', 'remote']] }]);
        expect(paired.pairs).toEqual([['c', 'remote']]);
    });

    it('preserves focus, geometry, local previews and reference identity for duplicate remote echoes', () => {
        let local = createWorkspaceState(tab('a'));
        local = reduceWorkspaceState(local, { type: 'openTab', groupId: 'group:1', tab: { ...tab('preview'), preview: true } });
        const root = local.root;
        const synced = reconcileWorkspaceSyncedTabs(local, record('a', 'remote'), () => 'blank');
        expect(synced.root).toBe(root);
        expect(synced.groups['group:1'].activeTabId).toBe('preview');
        expect(synced.tabs.preview).toBe(local.tabs.preview);
        expect(synced.groups['group:1'].tabIds).toEqual(['a', 'remote', 'preview']);
        expect(reconcileWorkspaceSyncedTabs(synced, record('a', 'remote'), () => 'blank')).toBe(synced);
    });

    it('publishes only intentional tab mutations and never focus, resize, preview or titles', () => {
        const before = createWorkspaceState(tab('a'));
        const preview = reduceWorkspaceState(before, { type: 'openTab', groupId: 'group:1', tab: { ...tab('p'), preview: true } });
        expect(collectWorkspaceTabIntents(before, preview)).toEqual([]);
        const next = reduceWorkspaceState(before, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        const intents = collectWorkspaceTabIntents(before, next);
        expect(applyWorkspaceTabIntents(emptyWorkspaceTabs(), intents).order).toEqual(['b']);
        expect(collectWorkspaceTabIntents(next, reduceWorkspaceState(next, { type: 'activateTab', groupId: 'group:1', tabId: 'a' }))).toEqual([]);
        expect(collectWorkspaceTabIntents(next, reduceWorkspaceState(next, { type: 'setFallbackTitle', tabId: 'b', title: 'Private name' }))).toEqual([]);
    });

    it.each(['preview', 'newTab'])('keeps a reordered local %s in its saved position after reload and a shared echo', kind => {
        let local = createWorkspaceState(tab('a'));
        local = reduceWorkspaceState(local, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        local = reduceWorkspaceState(local, { type: 'openTab', groupId: 'group:1', tab: {
            ...tab('local'), preview: kind === 'preview', target: kind === 'newTab' ? { kind: 'newTab', params: {} } : tab('local').target,
        } });
        const reordered = reduceWorkspaceState(local, { type: 'reorderTab', groupId: 'group:1', tabId: 'local', index: 1 });
        expect(collectWorkspaceTabIntents(local, reordered)).toEqual([]);
        const restored = parseWorkspaceLayout(serializeWorkspaceLayout(reordered));
        expect(restored).not.toBeNull();
        const echoed = reconcileWorkspaceSyncedTabs(restored!, record('a', 'b'), () => 'blank');
        expect(echoed.groups['group:1'].tabIds).toEqual(['a', 'local', 'b']);
        expect(echoed.groups['group:1'].activeTabId).toBe('local');
        expect(echoed.tabs.local).toEqual(reordered.tabs.local);
        expect(echoed).toBe(restored);
        const updated = reconcileWorkspaceSyncedTabs(echoed, record('b', 'a', 'remote'), () => 'blank');
        expect(updated.groups['group:1'].tabIds).toEqual(['b', 'local', 'a', 'remote']);
        expect(updated.groups['group:1'].activeTabId).toBe('local');
    });
});
