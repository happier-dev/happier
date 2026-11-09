import { describe, expect, it, vi } from 'vitest';

import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

// Pass-through observation of the catalog's href normalizer: the real implementation runs for every
// call; the count is the work a lookup does.
const normalizer = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../destinations/compactAppDestinationCatalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../destinations/compactAppDestinationCatalog')>();
    return {
        ...actual,
        resolveDestinationRefFromHref: (...args: Parameters<typeof actual.resolveDestinationRefFromHref>) => {
            normalizer.calls += 1;
            return actual.resolveDestinationRefFromHref(...args);
        },
    };
});
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return {
        createSessionDataKeyEnvelopeClient: unavailable,
        readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable,
        prepareSessionDataKeyEnvelopesDetached: unavailable,
    };
});
installPanelCommonModuleMocks();

const { resolveCompactAppDestinations } = await import('../destinations/compactAppDestinationCatalog');
const { createWorkspaceState, reduceWorkspaceState } = await import('./workspaceState');
const { createWorkspaceNavigationAdapter } = await import('./workspaceNavigationAdapter');

function workspaceWithSessionTabs(tabCount: number) {
    let state = createWorkspaceState({ id: 'A', target: { kind: 'session', params: { id: 'A1', serverId: 'home-a' } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({
        builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [],
    });
    let id = 0;
    const adapter = createWorkspaceNavigationAdapter({
        getState: () => state,
        getCatalog: () => catalog,
        getScope: () => ({ serverId: 'home-a', accountId: 'alice' }),
        dispatch: (action) => { state = reduceWorkspaceState(state, action); },
        transport: { commit: () => {} },
        createId: () => `generated:${++id}`,
        onChange: () => {},
    });
    adapter.initialize('/session/A1?serverId=home-a');
    for (let index = 2; index <= tabCount; index += 1) adapter.openHref(`/session/S${index}?serverId=home-a`, { mode: 'newTab' });
    expect(Object.keys(state.tabs)).toHaveLength(tabCount);
    return adapter;
}

/** Normalizations per lookup while the same not-yet-open Session is asked about once per drag frame. */
function normalizationsPerFrame(adapter: ReturnType<typeof workspaceWithSessionTabs>, frames: number): number {
    const query = '/session/NOT-OPEN?serverId=home-a';
    expect(adapter.findOpenHref(query)).toBeNull();
    normalizer.calls = 0;
    for (let frame = 0; frame < frames; frame += 1) expect(adapter.findOpenHref(query)).toBeNull();
    return normalizer.calls / frames;
}

describe('workspace open-tab lookup during a carry', () => {
    it('does not re-normalize every unchanged open tab on each drag frame', () => {
        // A carried Session re-admits over a pane on every pointer frame and asks whether it is already
        // open. That frame's cost must not grow with the number of open tabs.
        const few = normalizationsPerFrame(workspaceWithSessionTabs(2), 50);
        const many = normalizationsPerFrame(workspaceWithSessionTabs(60), 50);
        expect(many).toBe(few);
    });

    it('still finds an open tab, and answers for a retargeted tab by its new target only', () => {
        const adapter = workspaceWithSessionTabs(30);
        const open = adapter.findOpenHref('/session/S20?serverId=home-a');
        expect(open).not.toBeNull();
        expect(adapter.findOpenHref('/session/S20?serverId=home-a')).toEqual(open);
        adapter.dispatch({ type: 'setTarget', tabId: open!.tabId, target: { kind: 'session', params: { id: 'MOVED', serverId: 'home-a' } } });
        expect(adapter.findOpenHref('/session/S20?serverId=home-a')).toBeNull();
        expect(adapter.findOpenHref('/session/MOVED?serverId=home-a')).toEqual(open);
    });
});
