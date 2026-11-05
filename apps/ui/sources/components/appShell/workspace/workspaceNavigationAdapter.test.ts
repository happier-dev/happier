import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  hrefForDestinationRef,
  resolveCompactAppDestinations,
} from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { normalizeWorkspaceSingletonTabs } from './workspaceDestinationPolicy';
import { projectWorkspaceSharedTabs } from './workspaceSyncedTabs';
import {
  applyCloseDetailsTab,
  applyOpenDetailsTab,
  createEmptyPaneDetailsState,
} from '../panes/details/workspace/detailsWorkspaceReducer';
import {
  removeServerProfile,
  setServerProfileIdentityForUrl,
  upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
  readScopedWorkspaceLayout,
  workspaceLayoutScopeKey,
  writeScopedWorkspaceLayout,
} from './workspacePersistence';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createWorkspaceFileDetailsTab } from '../panes/details/fileDetailsTab';
import {
  buildSessionDetailsTabHref,
  parseSessionPaneUrlState,
  serializeSessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
  const unavailable = () => {
    throw new Error(
      'Unexpected recipient-envelope API in workspace owner test',
    );
  };
  return {
    createSessionDataKeyEnvelopeClient: unavailable,
    readSessionDataKeyEnvelopeCollectionPage: unavailable,
    prepareSessionDataKeyEnvelopesForScope: unavailable,
    prepareSessionDataKeyEnvelopesDetached: unavailable,
  };
});

function harness(
  pages: Parameters<typeof resolveCompactAppDestinations>[0]['pages'] = [],
  scope?: Readonly<{ serverId: string; accountId: string }>,
) {
  let state = createWorkspaceState({
    id: 'A',
    target: { kind: 'session', params: { id: 'A1', serverId: 'home-a' } },
    pinned: false,
    preview: false,
  });
  const catalog = resolveCompactAppDestinations({
    builtins: {
      externalSessions: false,
      inbox: true,
      workflows: true,
      friends: false,
    },
    pages,
  });
  const commits: Array<{
    href: string;
    entry: {
      tabId: string;
      groupId: string;
      target: typeof state.tabs.A.target;
    };
    replace: boolean;
  }> = [];
  const publications: Array<typeof state> = [];
  let id = 0;
  const adapter = createWorkspaceNavigationAdapter({
    getState: () => state,
    getCatalog: () => catalog,
    dispatch: (action) => {
      state = reduceWorkspaceState(state, action);
      publications.push(state);
    },
    transport: {
      commit: (href, entry, replace) => {
        commits.push({ href, entry, replace });
      },
    },
    createId: () => `generated:${++id}`,
    onChange: () => {},
    ...(scope ? { getScope: () => scope } : {}),
  });
  const active = () =>
    state.tabs[state.groups[state.focusedGroupId].activeTabId];
  return {
    adapter,
    catalog,
    commits,
    publications,
    active,
    state: () => state,
  };
}

describe('workspace navigation adapter', () => {
  it('replaces ordinary Machine previews while browsing the rail', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    for (const machineId of ['machine-a', 'machine-b', 'machine-c']) {
      expect(h.adapter.openHref(`/machines/${machineId}`)).toBe(true);
      const machines = Object.values(h.state().tabs).filter(tab => tab.target.kind === 'machines');
      expect(machines).toHaveLength(1);
      expect(machines[0]).toMatchObject({ preview: true, pinned: false, target: { params: { id: machineId } } });
      expect(Object.keys(h.state().tabs)).toHaveLength(2);
    }
  });

  it('retains the unpinned Machine page while the person goes through Settings to its other door', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.openHref('/machines/machine-a?tab=processes');
    const retainedId = h.active().id;
    h.adapter.openHref('/settings');
    h.adapter.openHref('/settings/machines');
    h.adapter.openHref('/settings/machines/machine-a');
    expect(h.active().id).toBe(retainedId);
    expect(h.active().pinned).toBe(false);
    expect(Object.values(h.state().tabs).filter(tab => tab.target.kind === 'machines'
      || tab.target.params.id === 'machine-a')).toHaveLength(1);
  });

  it.each([
    ['/settings/machines/machine-a', '/machines/machine-a?tab=processes&sort=memory'],
    ['/machines/machine-a?tab=processes', '/settings/machines/machine-a'],
  ])('keeps one mounted Machine destination across the two doors: %s → %s', (first, second) => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.openHref(first);
    const retainedId = h.active().id;
    h.adapter.openHref(second);
    expect(h.active().id).toBe(retainedId);
    expect(hrefForDestinationRef(h.catalog, h.active().target)).toBe(`${second}${second.includes('?') ? '&' : '?'}serverId=home-a`);
    expect(Object.values(h.state().tabs).filter(tab => tab.id !== 'A')).toHaveLength(1);
    h.adapter.openHref('/settings/machines/machine-a?serverId=home-b');
    expect(h.active().id).not.toBe(retainedId);
  });

  it.each([
    ['/machines/machine-a', '/machines/machine-a?serverId=home-a'],
    ['/machines/machine-a?serverId=home-a', '/machines/machine-a'],
  ])(
    'admits the current Home once and reuses %s from %s',
    (retainedHref, href) => {
      const h = harness([], { serverId: 'home-a', accountId: 'alice' });
      h.adapter.openHref(retainedHref, { mode: 'newTab' });
      const retainedId = h.active().id;
      h.adapter.openHref('/inbox', { mode: 'newTab' });
      expect(h.adapter.openHref(href)).toBe(true);
      expect(h.active().id).toBe(retainedId);
      expect(h.active().target.params.serverId).toBe('home-a');
      expect(h.active().preview).toBe(false);
      expect(
        Object.values(h.state().tabs).filter(
          (tab) => tab.target.kind === 'machines',
        ),
      ).toHaveLength(1);
      h.adapter.openHref('/machines/machine-a?serverId=home-b');
      expect(h.active().id).not.toBe(retainedId);
      expect(h.active().target.params.serverId).toBe('home-b');
    },
  );

  it('keeps explicit Machine new-tab and split intent after resolving the implicit Home', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.openHref('/machines/machine-a', { mode: 'newTab' });
    const retainedId = h.active().id;
    h.adapter.openHref('/machines/machine-a?serverId=home-a', {
      mode: 'newTab',
    });
    expect(h.active().id).not.toBe(retainedId);
    const secondId = h.active().id;
    expect(
      h.adapter.openHref('/machines/machine-a', {
        mode: 'splitRight',
        availableSizePx: 1200,
        minimumFirstSizePx: 300,
      }),
    ).toBe(true);
    expect(h.active().id).not.toBe(secondId);
    expect(h.active().id).not.toBe(retainedId);
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'machines',
      ),
    ).toHaveLength(3);
    expect(Object.keys(h.state().groups)).toHaveLength(2);
  });

  it('retains the admitted Machine Home when current scope changes and never guesses an unavailable scope', () => {
    const scope = { serverId: 'home-a', accountId: 'alice' };
    const h = harness([], scope);
    h.adapter.openHref('/machines/machine-a', { mode: 'newTab' });
    const retainedId = h.active().id;
    scope.serverId = 'home-b';
    h.adapter.openHref('/machines/machine-a');
    expect(h.active().id).not.toBe(retainedId);
    expect(h.state().tabs[retainedId]?.target.params.serverId).toBe('home-a');
    expect(h.active().target.params.serverId).toBe('home-b');

    const unscoped = harness();
    unscoped.adapter.openHref('/machines/machine-a', { mode: 'newTab' });
    const unqualifiedId = unscoped.active().id;
    unscoped.adapter.openHref('/machines/machine-a?serverId=home-b');
    expect(unscoped.active().id).not.toBe(unqualifiedId);
  });

  it.each([
    ['rail All machines', '/machines?serverId=home-a', '/machines'],
    [
      'popover machine row',
      '/machines/machine-a/agents?serverId=home-a',
      '/machines/machine-a?serverId=home-a',
    ],
    ['list-column All machines', '/machines', '/machines?serverId=home-a'],
    [
      'Details deep link',
      '/machines/machine-a/agents?serverId=home-a',
      '/machines/machine-a?serverId=home-a&page=details',
    ],
    ['palette Machines', '/machines?serverId=home-a', '/machines'],
  ])(
    'reuses a retained destination through the shared %s admission path',
    (_entry, retainedHref, href) => {
      const h = harness();
      h.adapter.openHref(retainedHref, { mode: 'newTab' });
      const retainedId = h.active().id;
      h.adapter.openHref('/inbox', { mode: 'newTab' });
      expect(
        _entry === 'Details deep link'
          ? h.adapter.acceptUrl(href)
          : h.adapter.openHref(href),
      ).toBe(true);
      expect(h.active().id).toBe(retainedId);
      expect(h.active().preview).toBe(false);
      expect(h.active().target).toEqual(h.adapter.resolveOpenTarget(href));
      expect(
        Object.values(h.state().tabs).filter(
          (tab) => tab.target.kind === 'machines',
        ),
      ).toHaveLength(1);
    },
  );

  it('keeps different machines, Homes and All machines distinct and preserves explicit new tabs through portable admission', () => {
    const h = harness();
    const hrefs = [
      '/machines/machine-a?serverId=home-a',
      '/machines/machine-b?serverId=home-a',
      '/machines/machine-a?serverId=home-b',
      '/machines',
      '/machines/machine-a?serverId=home-a',
    ];
    const ids: string[] = [];
    for (const href of hrefs) {
      h.adapter.openHref(href, { mode: 'newTab' });
      ids.push(h.active().id);
    }
    expect(new Set(ids).size).toBe(5);
    const record = projectWorkspaceSharedTabs(h.state());
    expect(normalizeWorkspaceSingletonTabs(record, h.catalog)).toBe(record);
    h.adapter.openHref('/machines/machine-b?serverId=home-a&page=details');
    expect(h.active().id).toBe(ids[1]);
    expect(h.active().target.params.page).toBe('details');
  });

  it.each(['file-tree', 'file-recent', 'git-review'] as const)(
    'reuses the addressed phone Details destination rather than the Session for %s', (entry) => {
      const h = harness([], { serverId: 'home-a', accountId: 'alice' });
      h.adapter.initialize('/session/A1?serverId=home-a');
      const session = h.state().tabs.A.target;
      const tab = entry === 'git-review'
        ? createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' } })
        : createWorkspaceFileDetailsTab(entry === 'file-tree' ? 'tree.txt' : 'recent.txt');
      const href = buildSessionDetailsTabHref({ sessionId: 'A1', serverId: 'home-a', tab })!;
      const options = { mode: entry === 'file-recent' ? 'newTab' as const : 'preview' as const, reuseExisting: true };
      expect(h.adapter.findOpenHref(href)).toBeNull();
      expect(h.adapter.openHref(href, options)).toBe(true);
      const opened = h.active().id;
      expect(opened).not.toBe('A');
      expect(h.active().target).toEqual(h.adapter.resolveOpenTarget(href));
      expect(h.active().target.kind).toBe('sessionDetails');
      expect(h.state().tabs.A.target).toEqual(session);
      h.adapter.activateTab(h.state().focusedGroupId, 'A');
      expect(h.adapter.openHref(href, options)).toBe(true);
      expect(h.active().id).toBe(opened);
      expect(Object.keys(h.state().tabs)).toHaveLength(2);
    },
  );

  it('keeps an already selected Computer pane when phone chrome projects Details and returns to Chat', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.initialize('/session/A1?serverId=home-a');
    const selection = serializeSessionPaneUrlState({
      details: { kind: 'computerScreen', machineId: 'machine-a' },
    });
    h.adapter.setParams('A', selection);
    h.adapter.acceptUrl(
      `/session/A1/details?serverId=home-a&${new URLSearchParams(selection)}`,
    );
    expect(h.active().id).toBe('A');
    expect(Object.keys(h.state().tabs)).toEqual(['A']);
    expect(h.active().target.kind).toBe('sessionDetails');
    h.adapter.acceptUrl('/session/A1?serverId=home-a&mobileSurface=chat');
    expect(h.active().id).toBe('A');
    expect(h.active().target.kind).toBe('session');
    h.adapter.step(-1);
    expect(h.active().id).toBe('A');
    expect(h.active().target.kind).toBe('sessionDetails');
  });

  it('keeps the current File pane when its phone route updates or drops the Track anchor', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.initialize('/session/A1/details?serverId=home-a&details=file&path=src%2Fa.ts&source=file&anchor=fileLine&startLine=14');
    const tabId = h.active().id;
    const tabIds = Object.keys(h.state().tabs);
    h.adapter.acceptUrl('/session/A1/details?serverId=home-a&details=file&path=src%2Fa.ts');
    expect(h.active().id).toBe(tabId);
    expect(Object.keys(h.state().tabs)).toEqual(tabIds);
    h.adapter.acceptUrl('/session/A1/details?serverId=home-a&details=file&path=src%2Fa.ts&source=file&anchor=fileLine&startLine=20');
    expect(h.active().id).toBe(tabId);
    expect(parseSessionPaneUrlState(h.active().target.params)?.details).toMatchObject({ anchor: { kind: 'fileLine', startLine: 20 } });
    // An independent resource or Home still gets its own destination, not this File's memory.
    h.adapter.acceptUrl('/session/A1/details?serverId=home-a&details=file&path=src%2Fb.ts');
    expect(h.active().id).not.toBe(tabId);
    const otherFileTab = h.active().id;
    h.adapter.acceptUrl('/session/A1/details?serverId=home-b&details=file&path=src%2Fb.ts');
    expect(h.active().id).not.toBe(otherFileTab);
  });

  it('does not adopt a different Machine or Home Details link as the current pane projection', () => {
    for (const [serverId, machineId] of [
      ['home-b', 'machine-a'],
      ['home-a', 'machine-b'],
    ] as const) {
      const h = harness([], { serverId: 'home-a', accountId: 'alice' });
      h.adapter.initialize('/session/A1?serverId=home-a');
      h.adapter.setParams(
        'A',
        serializeSessionPaneUrlState({
          details: { kind: 'computerScreen', machineId: 'machine-a' },
        }),
      );
      h.adapter.acceptUrl(
        `/session/A1/details?${new URLSearchParams({
          serverId,
          ...serializeSessionPaneUrlState({
            details: { kind: 'computerScreen', machineId },
          }),
        })}`,
      );
      expect(h.active().id).not.toBe('A');
    }
  });

  it('keeps a phone Session in its retained tab when the cockpit URL selects a plugin surface', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.initialize('/session/A1?serverId=home-a&mobileSurface=chat');
    h.adapter.dispatch({ type: 'promoteTab', tabId: 'A' });
    for (const surface of ['plugin:acme.review:review-panel', 'chat']) {
      h.adapter.acceptUrl(
        `/session/A1?serverId=home-a&mobileSurface=${encodeURIComponent(surface)}`,
      );
      expect(h.active().id).toBe('A');
      expect(Object.keys(h.state().tabs)).toEqual(['A']);
      expect(h.active().target.params.mobileSurface).toBe(surface);
    }
  });
  it('reuses the retained terminal when a phone scene re-admits changed Session pane parameters', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.initialize('/session/A1?serverId=home-a&bottom=terminal');
    h.adapter.dispatch({ type: 'promoteTab', tabId: 'A' });
    h.adapter.acceptUrl(
      '/session/A1?serverId=home-a&bottom=terminal&right=terminal',
    );
    expect(h.active().id).toBe('A');
    expect(Object.keys(h.state().tabs)).toEqual(['A']);
    expect(h.active().target.params.right).toBe('terminal');
    h.adapter.acceptUrl(
      '/session/A1?serverId=home-a&bottom=terminal&right=terminal&details=file&path=src%2Findex.ts',
    );
    expect(
      h.active().id,
      'A retained Details selection must not give the same terminal a new pane',
    ).toBe('A');
    expect(Object.keys(h.state().tabs)).toEqual(['A']);
  });
  it('keeps the Session terminal resource in its original tab through responsive route remounts', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.initialize('/session/A1?serverId=home-a&bottom=terminal');
    h.adapter.dispatch({ type: 'promoteTab', tabId: 'A' });
    for (const href of [
      '/session/A1/terminal?serverId=home-a&bottom=terminal&right=terminal',
      '/session/A1?serverId=home-a&bottom=terminal&right=terminal',
      '/session/A1/terminal?serverId=home-a&right=terminal',
    ]) {
      h.adapter.initialize(href);
      expect.soft(h.active().id, href).toBe('A');
      expect.soft(Object.keys(h.state().tabs), href).toEqual(['A']);
      const projected = hrefForDestinationRef(h.catalog, h.active().target);
      expect(new URL(projected!, 'https://workspace.test').pathname).toBe(
        new URL(href, 'https://workspace.test').pathname,
      );
    }
    expect(
      h.adapter.findOpenHref(
        '/session/A1/terminal?serverId=home-a&accountId=bob',
      ),
    ).toBeNull();
    expect(
      h.adapter.findOpenHref(
        '/session/A1/terminal?serverId=home-b&accountId=alice',
      ),
    ).toBeNull();
    expect(
      h.adapter.findOpenHref('/session/A2/terminal?serverId=home-a'),
    ).toBeNull();
  });
  it('keeps the retained Session pane through the live cockpit Chat and Terminal URL sequence', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'alice' });
    h.adapter.initialize('/session/A1?serverId=home-a&bottom=terminal');
    h.adapter.dispatch({ type: 'promoteTab', tabId: 'A' });
    for (const href of [
      '/session/A1?mobileSurface=chat&serverId=home-a&bottom=terminal',
      '/session/A1?mobileSurface=chat&serverId=home-a&bottom=terminal&right=terminal',
      '/session/A1?mobileSurface=chat&serverId=home-a',
      '/session/A1/terminal?serverId=home-a&bottom=terminal',
    ]) {
      h.adapter.acceptUrl(href);
      expect.soft(h.active().id, href).toBe('A');
      expect.soft(Object.keys(h.state().tabs), href).toEqual(['A']);
    }
  });
  it('publishes bulk closure as one layout and one navigation commit while keeping pinned tabs', () => {
    const h = harness();
    h.adapter.openHref('/projects', { mode: 'newTab' });
    const pinnedId = h.active().id;
    h.adapter.dispatch({ type: 'setPinned', tabId: pinnedId, pinned: true });
    h.adapter.openHref('/settings/account', { mode: 'newTab' });
    const closingId = h.active().id;
    const beforePublications = h.publications.length;
    const beforeCommits = h.commits.length;
    h.adapter.closeTabs('group:1', ['A', closingId, pinnedId, closingId]);
    expect(h.publications.slice(beforePublications)).toHaveLength(1);
    expect(h.commits.slice(beforeCommits)).toHaveLength(1);
    expect(h.state().groups['group:1'].tabIds).toEqual([pinnedId]);
    expect(h.active().id).toBe(pinnedId);
    const survivingState = h.state();
    h.adapter.closeTabs('group:1', [pinnedId, 'missing']);
    expect(h.state()).toBe(survivingState);
    expect(h.commits.slice(beforeCommits)).toHaveLength(1);
  });

  it('hands a pane destination off only after its main tab is admitted', () => {
    const h = harness();
    let sidebar = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
      tab: {
        key: 'board',
        kind: 'board',
        title: 'Board',
        resource: { kind: 'board' },
      },
      openAs: 'pinned',
    });
    const onOpened = () => {
      sidebar = applyCloseDetailsTab(sidebar, 'board');
    };
    expect(
      h.adapter.openHref('/settings/usage', {
        mode: 'splitRight',
        availableSizePx: 100,
        minimumFirstSizePx: 320,
        minimumSecondSizePx: 320,
        onOpened,
      }),
    ).toBe(false);
    expect(sidebar.tabsByKey.board).toBeDefined();
    expect(
      h.adapter.openHref('/session/A1/details?serverId=home-a&details=board', {
        mode: 'newTab',
        onOpened,
      }),
    ).toBe(true);
    expect(sidebar.tabsByKey.board).toBeUndefined();
    expect(sidebar.isOpen).toBe(false);
    expect(h.active().target.kind).toBe('sessionDetails');
  });

  it('adopts a cold Usage deep link without replacing the navigator route being mounted', () => {
    const h = harness();
    h.adapter.initialize('/settings/usage');
    expect(h.active().target).toMatchObject({
      kind: 'settings',
      params: { pageId: 'usage' },
    });
    expect(h.commits).toEqual([]);
    expect(h.adapter.canGoBack).toBe(false);
    h.adapter.openHref('/settings/account');
    expect(h.commits.map((commit) => commit.href)).toEqual([
      '/settings/account',
    ]);
    expect(h.adapter.canGoBack).toBe(true);
  });

  it('adopts the saved terminal pane for an exact cold alias URL without merging other presentations or Accounts', async () => {
    const endpoint = 'http://happier-agent-qa-find-search.localhost:3009';
    const alias = (await upsertServerProfile({ serverUrl: endpoint })).id;
    const home = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const profile = await setServerProfileIdentityForUrl(endpoint, home);
    if (!profile) throw new Error('Home identity missing');
    onTestFinished(async () => {
      await removeServerProfile(profile.id);
    });
    const scope = { serverId: profile.id, accountId: 'alice' };
    const sessionId = 'cmv88vp4l0062m2i1pvpsyc0i';
    const paneId = 'be022062-19f9-45a6-9adb-3fc5a79208d0';
    const original = createWorkspaceState({
      id: paneId,
      target: {
        kind: 'session',
        params: {
          id: sessionId,
          serverId: home,
          bottom: 'terminal',
          right: 'terminal',
        },
      },
      preview: false,
      pinned: false,
    });
    const key = workspaceLayoutScopeKey({ ...scope, windowId: 'main' });
    const saved = readScopedWorkspaceLayout(
      JSON.parse(JSON.stringify(writeScopedWorkspaceLayout({}, key, original))),
      key,
    );
    if (!saved) throw new Error('Written layout was not admitted');
    let state = saved;
    const catalog = resolveCompactAppDestinations({
      builtins: {
        externalSessions: false,
        inbox: true,
        workflows: false,
        friends: false,
      },
      pages: [],
    });
    const adapter = createWorkspaceNavigationAdapter({
      getState: () => state,
      getCatalog: () => catalog,
      getScope: () => scope,
      dispatch: (action) => {
        state = reduceWorkspaceState(state, action);
      },
      transport: { commit: () => {} },
      createId: () => crypto.randomUUID(),
      onChange: () => {},
    });
    adapter.initialize(
      `/session/${sessionId}?serverId=${alias}&bottom=terminal`,
    );
    const active = () =>
      state.tabs[state.groups[state.focusedGroupId].activeTabId];
    expect(active()).toEqual(original.tabs[paneId]);
    expect(Object.keys(state.tabs)).toEqual([paneId]);
    adapter.acceptUrl(`/session/${sessionId}?serverId=${alias}&right=files`);
    expect(active().id).not.toBe(paneId);
    expect(active().target.params.right).toBe('files');
    adapter.initialize(
      `/session/${sessionId}?serverId=${alias}&bottom=terminal&accountId=bob`,
    );
    expect(active().id).not.toBe(paneId);
    adapter.initialize(
      `/session/${sessionId}?serverId=unrelated-home&bottom=terminal`,
    );
    expect(active().id).not.toBe(paneId);
    adapter.initialize(
      `/session/${sessionId}?serverId=${home}&bottom=terminal&right=files`,
    );
    expect(active().id).toBe(paneId);
    expect(active().target.params.right).toBe('files');
    // An intentional second view remains its own current pane even when
    // the unchanged URL is re-admitted using the equivalent Home label.
    adapter.openHref(
      `/session/${sessionId}?serverId=${home}&bottom=terminal&right=files`,
      { mode: 'newTab' },
    );
    const secondPaneId = active().id;
    expect(secondPaneId).not.toBe(paneId);
    adapter.acceptUrl(
      `/session/${sessionId}?serverId=${alias}&bottom=terminal&right=files`,
    );
    expect(active().id).toBe(secondPaneId);
  });

  it('contracts restored duplicate Workflows hubs without dropping distinct workflow details', () => {
    const catalog = resolveCompactAppDestinations({
      builtins: {
        externalSessions: false,
        inbox: true,
        workflows: true,
        friends: false,
      },
      pages: [],
    });
    const normalized = normalizeWorkspaceSingletonTabs(
      {
        v: 1,
        order: ['hub-1', 'detail', 'hub-2'],
        pairs: [],
        tabsById: {
          'hub-1': {
            id: 'hub-1',
            target: { kind: 'workflows', params: {} },
            pinned: false,
          },
          detail: {
            id: 'detail',
            target: { kind: 'workflow', params: { id: 'workflow-1' } },
            pinned: false,
          },
          'hub-2': {
            id: 'hub-2',
            target: { kind: 'workflows', params: { subPath: '/runs' } },
            pinned: true,
          },
        },
      },
      catalog,
    );
    expect(normalized.order).toEqual(['hub-1', 'detail']);
    expect(normalized.tabsById['hub-1']).toMatchObject({
      pinned: true,
      target: { kind: 'workflows', params: { subPath: '/runs' } },
    });
    expect(normalized.tabsById.detail.target.kind).toBe('workflow');
  });
  it('reuses the Workflows hub across repeated entrances while keeping distinct workflow details', () => {
    const h = harness();
    h.adapter.openHref('/workflows', { mode: 'newTab' });
    const hub = h.active().id;
    h.adapter.openHref('/projects', { mode: 'newTab' });
    h.adapter.openHref('/workflows/runs', { mode: 'newTab' });
    h.adapter.openHref('/workflows', { mode: 'newTab' });
    expect(h.active().id).toBe(hub);
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'workflows',
      ),
    ).toHaveLength(1);
    h.adapter.openHref('/workflows/first', { mode: 'newTab' });
    h.adapter.openHref('/workflows/second', { mode: 'newTab' });
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'workflow',
      ),
    ).toHaveLength(2);
  });
  it('gives each Import entrance its own editor instead of reusing the singleton Workflows tab', () => {
    const h = harness();
    h.adapter.openHref('/workflows', { mode: 'newTab' });
    const library = h.active().id;
    h.adapter.openHref('/workflows/new?importJson=1', { mode: 'newTab' });
    const first = h.active();
    expect(first.id).not.toBe(library);
    h.adapter.openHref('/workflows/new?importJson=1', { mode: 'newTab' });
    expect(h.active().id).not.toBe(first.id);
    expect(h.state().tabs[first.id]).toBe(first);
    expect(h.state().tabs[library].target).toEqual({ kind: 'workflows', params: {} });
    expect(hrefForDestinationRef(h.catalog, h.active().target)).toBe('/workflows/new?importJson=1');
    const shared = projectWorkspaceSharedTabs(h.state());
    expect(normalizeWorkspaceSingletonTabs(shared, h.catalog)).toBe(shared);
  });
  it('opens the Workflows library without retargeting an independently opened Import draft', () => {
    const h = harness();
    h.adapter.openHref('/workflows/new?importJson=1', { mode: 'newTab' });
    const draft = h.active();
    h.adapter.openHref('/workflows', { mode: 'newTab' });
    expect(h.active().id).not.toBe(draft.id);
    expect(h.state().tabs[draft.id]).toBe(draft);
    expect(h.active().target).toEqual({ kind: 'workflows', params: {} });
  });
  it('qualifies implicit current-realm Session destinations without conflating another Account or Home', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'account-a' });
    h.adapter.dispatch({
      type: 'setTarget',
      tabId: 'A',
      target: { kind: 'session', params: { id: 'A1' } },
    });
    expect(
      h.adapter.findOpenHref('/session/A1?serverId=home-a&accountId=account-a'),
    ).toEqual({ tabId: 'A', groupId: 'group:1' });
    expect(
      h.adapter.findOpenHref('/session/A1?serverId=home-a&accountId=account-b'),
    ).toBeNull();
    expect(
      h.adapter.findOpenHref('/session/A1?serverId=home-b&accountId=account-a'),
    ).toBeNull();
    h.adapter.openHref('/session/A1?serverId=home-a&accountId=account-a', {
      mode: 'newTab',
      reuseExisting: true,
    });
    expect(Object.keys(h.state().tabs)).toEqual(['A']);
    expect(h.active().target.params).toEqual({
      id: 'A1',
      serverId: 'home-a',
      accountId: 'account-a',
    });
    expect(h.commits.at(-1)?.href).toBe(
      '/session/A1?serverId=home-a&accountId=account-a',
    );
  });
  it('goes to an open Project instead of opening it again, keeping its page unless a resource is addressed', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'account-a' });
    h.adapter.openHref(
      '/projects/wr_1/code?serverId=home-a&initialFile=src%2Fa.ts',
      { mode: 'newTab', reuseExisting: true },
    );
    const project = h.active().id;
    h.adapter.openHref('/inbox', { mode: 'newTab' });
    // The Projects list opens the Project at its default page: the open tab comes forward as it was left.
    h.adapter.openHref('/projects/wr_1/overview?serverId=home-a', {
      mode: 'newTab',
      reuseExisting: true,
    });
    expect(h.active().id).toBe(project);
    expect(h.active().target.params).toMatchObject({
      pageId: 'code',
      initialFile: 'src/a.ts',
    });
    // An addressed resource (a file, a commit) retargets that same tab.
    h.adapter.openHref(
      '/projects/wr_1/code?serverId=home-a&initialFile=src%2Fb.ts',
      { mode: 'newTab', reuseExisting: true },
    );
    expect(h.active().id).toBe(project);
    expect(h.active().target.params.initialFile).toBe('src/b.ts');
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'project',
      ),
    ).toHaveLength(1);
    // The same Project id on another Home is another Project.
    h.adapter.openHref('/projects/wr_1/overview?serverId=home-b', {
      mode: 'newTab',
      reuseExisting: true,
    });
    expect(h.active().id).not.toBe(project);
    // An explicit new tab stays a new tab.
    h.adapter.openHref('/projects/wr_1/overview?serverId=home-a', {
      mode: 'newTab',
      reuseExisting: false,
    });
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'project',
      ),
    ).toHaveLength(3);
  });
  it('reuses a retained unqualified Session when the legacy workspace has no Account scope', () => {
    const h = harness();
    h.adapter.openHref('/session/legacy', {
      mode: 'newTab',
      reuseExisting: true,
    });
    const original = h.active().id;
    h.adapter.openHref('/session/legacy', {
      mode: 'newTab',
      reuseExisting: true,
    });
    expect(h.active().id).toBe(original);
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.params.id === 'legacy',
      ),
    ).toHaveLength(1);
  });
  it('adopts a Session URL into its retained pane without discarding terminal presentation', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'account-a' });
    h.adapter.setParams('A', { bottom: 'terminal' });
    h.adapter.openHref('/inbox', { mode: 'newTab' });
    expect(h.adapter.acceptUrl('/session/A1?serverId=home-a')).toBe(true);
    expect(h.active()).toMatchObject({
      id: 'A',
      target: { params: { bottom: 'terminal' } },
    });
    expect(h.adapter.acceptUrl('/session/A1?serverId=home-a&right=files')).toBe(
      true,
    );
    expect(h.active().target.params.right).toBe('files');
  });
  it('replaces explicitly addressed Session file state without replaying the previous file hints', () => {
    const h = harness();
    h.adapter.setParams('A', {
      bottom: 'terminal',
      right: 'files',
      details: 'board',
      boardItemId: 'item-a',
    });
    const fileA = {
      kind: 'file' as const,
      path: 'src/a.ts',
      anchor: {
        kind: 'range' as const,
        filePath: 'src/a.ts',
        startLine: 3,
        endLine: 8,
      },
      anchorSource: 'diff' as const,
      view: 'changes' as const,
      blame: true,
      openAs: 'pinned' as const,
      changes: { kind: 'branch' as const, head: 'feature', base: 'main' },
    };
    const openFile = (
      details: Parameters<typeof serializeSessionPaneUrlState>[0]['details'],
    ) =>
      h.adapter.openHref(
        `/session/A1?${new URLSearchParams({ serverId: 'home-a', ...serializeSessionPaneUrlState({ details }) })}`,
        { reuseExisting: true },
      );
    expect(openFile(fileA)).toBe(true);
    expect(h.active().id).toBe('A');
    expect(h.active().target.params.boardItemId).toBeUndefined();
    expect(parseSessionPaneUrlState(h.active().target.params)).toEqual({
      rightTabId: 'files',
      bottomTabId: 'terminal',
      details: fileA,
    });
    expect(openFile({ kind: 'file', path: 'src/b.ts' })).toBe(true);
    expect(h.active().id).toBe('A');
    expect(h.active().target.params).toEqual({
      id: 'A1',
      serverId: 'home-a',
      right: 'files',
      bottom: 'terminal',
      details: 'file',
      path: 'src/b.ts',
    });
    expect(
      h.adapter.openHref('/session/A1?serverId=home-a', {
        reuseExisting: true,
      }),
    ).toBe(true);
    expect(parseSessionPaneUrlState(h.active().target.params)).toEqual({
      rightTabId: 'files',
      bottomTabId: 'terminal',
      details: { kind: 'file', path: 'src/b.ts' },
    });
    expect(Object.keys(h.state().tabs)).toEqual(['A']);
  });
  it('returns from a pane-scoped Inbox router and Session list to the retained Session', () => {
    const h = harness([], { serverId: 'home-a', accountId: 'account-a' });
    h.adapter.setParams('A', { bottom: 'terminal' });
    for (const source of ['/inbox', '/projects']) {
      expect(h.adapter.openHref(source, { mode: 'newTab' })).toBe(true);
      const sourceTabId = h.active().id;
      expect(
        h.adapter.openHref('/session/A1?serverId=home-a', {
          tabId: sourceTabId,
        }),
      ).toBe(true);
      expect(h.active()).toMatchObject({
        id: 'A',
        target: { params: { bottom: 'terminal' } },
      });
      expect(
        Object.values(h.state().tabs).filter(
          (tab) => tab.target.kind === 'session',
        ),
      ).toHaveLength(1);
    }
  });
  it('keeps explicit-group Session previews in that group while intentional new tabs stay distinct', () => {
    const h = harness();
    h.adapter.openHref('/session/B1?serverId=home-b', {
      mode: 'splitRight',
      availableSizePx: 1000,
      minimumFirstSizePx: 320,
      minimumSecondSizePx: 320,
    });
    const groupId = h.state().focusedGroupId;
    h.adapter.openHref('/session/A1?serverId=home-a', {
      mode: 'preview',
      groupId,
    });
    const second = h.active().id;
    expect(second).not.toBe('A');
    expect(h.state().focusedGroupId).toBe(groupId);
    h.adapter.setParams(second, { bottom: 'terminal' });
    h.adapter.openHref('/session/A1?serverId=home-a', {
      mode: 'preview',
      groupId,
    });
    expect(h.active().id).toBe(second);
    expect(h.active().target.params.bottom).toBe('terminal');
    h.adapter.openHref('/session/A1?serverId=home-a', {
      mode: 'newTab',
      groupId,
    });
    expect(h.active().id).not.toBe(second);
    expect(h.active().id).not.toBe('A');
  });
  it('publishes a destination edge as one admitted layout without exposing an intermediate centre tab', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.openHref('/session/edge?serverId=home-a', {
      mode: 'splitRight',
      availableSizePx: 1200,
      minimumFirstSizePx: 420,
      minimumSecondSizePx: 420,
    });
    const edge = h.active().id;
    const publishedWithEdge = h.publications.filter(
      (state) => state.tabs[edge],
    );
    expect(publishedWithEdge.length).toBeGreaterThan(0);
    expect(
      publishedWithEdge.every(
        (state) => !state.groups['group:1'].tabIds.includes(edge),
      ),
    ).toBe(true);
  });

  it('preserves explicit preview disposition when reusing its qualified destination', () => {
    const h = harness();
    h.adapter.openHref('/session/preview?serverId=home-a');
    const id = h.active().id;
    h.adapter.openHref('/session/preview?serverId=home-a', {
      mode: 'preview',
      reuseExisting: true,
    });
    expect(h.active()).toMatchObject({ id, preview: true });
  });

  it('keeps destination drops before a live tab anchor and focuses qualified already-open destinations across groups', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.openHref('/session/B1?serverId=home-b', {
      mode: 'splitRight',
      availableSizePx: 1000,
      minimumFirstSizePx: 320,
      minimumSecondSizePx: 320,
    });
    const secondGroup = h.state().focusedGroupId;
    const b = h.active().id;
    h.adapter.setParams(b, { right: 'files', anchor: 'saved-position' });
    h.adapter.openHref('/session/C1?serverId=home-a', {
      groupId: secondGroup,
      mode: 'newTab',
      beforeTabId: b,
      reuseExisting: true,
    });
    const c = h.active().id;
    expect(h.state().groups[secondGroup].tabIds).toEqual([c, b]);
    h.adapter.openHref('/session/B1?serverId=home-b', {
      groupId: 'group:1',
      mode: 'newTab',
      reuseExisting: true,
    });
    expect(h.active().id).toBe(b);
    expect(h.active().target.params.right).toBe('files');
    expect(h.adapter.findOpenHref('/session/%42%31?serverId=home-b')).toEqual({
      tabId: b,
      groupId: secondGroup,
    });
    expect(h.adapter.findOpenHref('/session/B1?serverId=home-c')).toBeNull();
    expect(h.state().focusedGroupId).toBe(secondGroup);
    expect(h.state().groups[secondGroup].tabIds).toEqual([c, b]);
    h.adapter.openHref('/session/B1?serverId=home-a', {
      groupId: 'group:1',
      mode: 'newTab',
      reuseExisting: true,
    });
    expect(h.active().id).not.toBe(b);
    expect(h.state().tabs.A).toBeDefined();
    expect(h.state().tabs[c]).toBeDefined();
  });

  it('reopens through URL history and reuses an already open catalog singleton', () => {
    const h = harness([
      {
        id: 'plugin:acme.notes:notes',
        pluginId: 'acme.notes',
        descriptorId: 'notes',
        localId: 'notes',
        label: 'Notes',
        icon: 'note',
        order: 40,
        disabledReason: null,
        placement: {} as NonNullable<
          Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]
        >['placement'],
        routePath: '/plugins/acme.notes/notes',
      },
    ]);
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
    const closedId = h.active().id;
    h.adapter.closeTab('group:1', closedId);
    h.adapter.openHref('/plugins/acme.notes/notes/second', { mode: 'newTab' });
    const existingId = h.active().id;
    expect(h.adapter.reopenTab(closedId)).toBe(true);
    expect(h.active().id).toBe(existingId);
    expect(h.active().target.params.subPath).toBe('first');
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'plugin:acme.notes:notes',
      ),
    ).toHaveLength(1);
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
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.params.id === 'B1',
      ),
    ).toHaveLength(1);
    h.adapter.openHref('/session/C1?serverId=home-c');
    const explicitId = h.active().id;
    h.adapter.openHref('/session/C1?serverId=home-c', {
      tabId: explicitId,
      mode: 'newTab',
    });
    expect(h.active()).toMatchObject({
      id: explicitId,
      pinned: false,
      preview: false,
    });
    h.adapter.openHref('/session/D1?serverId=home-d');
    expect(h.state().tabs[previewId].target.params.id).toBe('B1');
    expect(h.state().tabs[explicitId].target.params.id).toBe('C1');
    h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'newTab' });
    expect(h.active().id).not.toBe(previewId);
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.params.id === 'B1',
      ),
    ).toHaveLength(2);
  });

  it.each([false, true])(
    'restores a singleton into its existing visible group after the historical tab was closed: %s',
    (closed) => {
      const h = harness([
        {
          id: 'plugin:acme.notes:notes',
          pluginId: 'acme.notes',
          descriptorId: 'notes',
          localId: 'notes',
          label: 'Notes',
          icon: 'note',
          order: 40,
          disabledReason: null,
          placement: {} as NonNullable<
            Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]
          >['placement'],
          routePath: '/plugins/acme.notes/notes',
        },
      ]);
      h.adapter.initialize('/session/A1?serverId=home-a');
      h.adapter.openHref('/plugins/acme.notes/notes/first');
      h.adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
      expect(h.active().preview).toBe(false);
      const historicalTabId = h.active().id;
      h.adapter.openHref('/session/A2?serverId=home-a', {
        tabId: historicalTabId,
      });
      if (closed) h.adapter.closeTab('group:1', historicalTabId);
      h.adapter.openHref('/session/B1?serverId=home-b', {
        mode: 'splitRight',
        availableSizePx: 1000,
        minimumFirstSizePx: 320,
        minimumSecondSizePx: 320,
      });
      h.adapter.openHref('/plugins/acme.notes/notes/second', {
        mode: 'newTab',
      });
      const liveTabId = h.active().id;
      const liveGroupId = h.state().focusedGroupId;
      while (h.adapter.history.index > 1) h.adapter.step(-1);
      expect(h.active()).toMatchObject({
        id: liveTabId,
        target: { params: { subPath: 'first' } },
      });
      expect(h.state().focusedGroupId).toBe(liveGroupId);
      expect(
        Object.values(h.state().tabs).filter(
          (tab) => tab.target.kind === 'plugin:acme.notes:notes',
        ),
      ).toHaveLength(1);
      expect(Object.keys(h.state().groups)).toHaveLength(2);
      expect(h.commits.at(-1)?.entry.tabId).toBe(liveTabId);
      h.adapter.step(1);
      expect(h.active().target.params.id).toBe('A2');
      expect(h.state().focusedGroupId).toBe('group:1');
    },
  );

  it('rejects an explicit missing tab without opening a different tab', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    const before = h.state();
    expect(
      h.adapter.openHref('/session/B1?serverId=home-b', { tabId: 'missing' }),
    ).toBe(false);
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
    expect(h.state().tabs.A.target.params).toEqual({
      id: 'A1',
      serverId: 'home-a',
      right: 'files',
    });
    expect(h.commits).toHaveLength(visits);
    h.adapter.activateTab('group:1', 'A');
    h.adapter.setParams('A', { right: undefined, anchor: 'line-2' });
    expect(h.commits.at(-1)).toMatchObject({
      href: '/session/A1?serverId=home-a#line-2',
      replace: true,
    });
  });

  it('keeps plugin app pages singleton across reopen, new-tab and split intents', () => {
    const h = harness([
      {
        id: 'plugin:acme.notes:notes',
        pluginId: 'acme.notes',
        descriptorId: 'notes',
        localId: 'notes',
        label: 'Notes',
        icon: 'note',
        order: 40,
        disabledReason: null,
        placement: {} as NonNullable<
          Parameters<typeof resolveCompactAppDestinations>[0]['pages'][number]
        >['placement'],
        routePath: '/plugins/acme.notes/notes',
      },
    ]);
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.openHref('/plugins/acme.notes/notes/first', { mode: 'newTab' });
    const pluginTabId = h.active().id;
    h.adapter.openHref('/session/A1?serverId=home-a');
    h.adapter.openHref('/plugins/acme.notes/notes/second', {
      mode: 'splitRight',
      availableSizePx: 1000,
      minimumFirstSizePx: 320,
      minimumSecondSizePx: 320,
    });
    expect(h.active().id).toBe(pluginTabId);
    expect(h.active().target.params.subPath).toBe('second');
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'plugin:acme.notes:notes',
      ),
    ).toHaveLength(1);
    expect(Object.keys(h.state().groups)).toHaveLength(1);
    h.adapter.openHref('/plugins/acme.notes/notes/third', { tabId: 'A' });
    expect(h.active().id).toBe(pluginTabId);
    expect(h.state().tabs.A.target.kind).toBe('session');
    expect(
      Object.values(h.state().tabs).filter(
        (tab) => tab.target.kind === 'plugin:acme.notes:notes',
      ),
    ).toHaveLength(1);
  });
  it('does not traverse beyond the known global history', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.step(-1);
    expect(h.adapter.history.index).toBe(0);
    expect(h.commits).toHaveLength(0);
  });
  it('projects one history including tab switches and restores A2/A1/A2/B1', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.openHref('/session/A2?serverId=home-a', { tabId: 'A' });
    h.adapter.openHref('/session/B1?serverId=home-b', { mode: 'newTab' });
    for (const [direction, id, serverId] of [
      [-1, 'A2', 'home-a'],
      [-1, 'A1', 'home-a'],
      [1, 'A2', 'home-a'],
      [1, 'B1', 'home-b'],
    ] as const) {
      h.adapter.step(direction);
      expect(h.active().target.params).toEqual({ id, serverId });
      expect(h.commits.at(-1)?.href).toBe(
        `/session/${id}?serverId=${serverId}`,
      );
    }
    expect(
      h.adapter.history.entries.map((entry) => entry.target.params.id),
    ).toEqual(['A1', 'A2', 'B1']);
  });

  it('reopens closed history tabs as previews and applies a reload URL after restored layout', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    h.adapter.openHref('/settings/appearance', { mode: 'newTab' });
    h.adapter.closeTab('group:1', 'A');
    h.adapter.step(-1);
    expect(h.active()).toMatchObject({
      id: 'A',
      preview: true,
      target: { params: { id: 'A1', serverId: 'home-a' } },
    });
    h.adapter.openHref('/settings/account', { replace: true });
    expect(h.active().target).toEqual({
      kind: 'settings',
      params: { pageId: 'account' },
    });
    expect(h.adapter.canGoForward).toBe(true);
    h.adapter.step(1);
    expect(h.active().target).toEqual({
      kind: 'settings',
      params: { pageId: 'appearance' },
    });
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
    expect(
      h.adapter.openHref('/settings/appearance', {
        mode: 'splitRight',
        availableSizePx: 400,
        minimumFirstSizePx: 300,
        minimumSecondSizePx: 300,
      }),
    ).toBe(false);
    expect(h.state()).toBe(before);
    expect(h.adapter.history.entries).toHaveLength(1);
  });

  it('does not push another browser entry when accepting an external deep link', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    const commitsBefore = h.commits.length;
    h.adapter.acceptUrl('/settings/appearance');
    expect(h.active().target).toEqual({
      kind: 'settings',
      params: { pageId: 'appearance' },
    });
    expect(h.commits).toHaveLength(commitsBefore);
  });

  it('opens a server-qualified destination in a measured split when it fits', () => {
    const h = harness();
    h.adapter.initialize('/session/A1?serverId=home-a');
    expect(
      h.adapter.openHref('/session/B1?serverId=home-b', {
        mode: 'splitRight',
        availableSizePx: 900,
        minimumFirstSizePx: 300,
        minimumSecondSizePx: 300,
      }),
    ).toBe(true);
    expect(Object.keys(h.state().groups)).toHaveLength(2);
    expect(h.active().target.params).toEqual({ id: 'B1', serverId: 'home-b' });
    h.adapter.step(-1);
    expect(h.state().focusedGroupId).toBe('group:1');
    expect(h.active().target.params).toEqual({ id: 'A1', serverId: 'home-a' });
  });
});
