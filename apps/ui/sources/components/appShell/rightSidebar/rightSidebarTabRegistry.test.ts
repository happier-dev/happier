import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
  getRightSidebarBuiltinTab,
  resolveRightSidebarActiveTab,
  resolveRightSidebarTabSelection,
  resolveRightSidebarMobileSurface,
  resolveRightSidebarTabs,
  resolveRightSidebarTabPlacement,
} from './rightSidebarTabRegistry';
import { resolveRightSidebarMobileProjection } from './rightSidebarMobileProjection';
import { resolveNavigationPlacements } from '@/sync/domains/settings/mobileSurfacePinning';
import { createPluginProjectContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';

describe('right-sidebar catalog defaults', () => {
  it('keeps Skills in More while hidden placement still permits opening the same destination', () => {
    const tabs = resolveRightSidebarTabs({ scope: 'session', browserFeatureEnabled: true });
    expect(tabs.find(tab => tab.id === 'skills')).toMatchObject({ defaultPlacement: 'overflow', railGroup: 'session' });
    const placement = resolveNavigationPlacements(tabs, { orderedIds: [], placements: { skills: 'hidden' } });
    expect([...placement.pinned, ...placement.overflow].some(tab => tab.id === 'skills')).toBe(false);
    expect(resolveRightSidebarTabSelection({ activeTabId: 'skills', tabs, projectionPhase: 'current', scope: 'session' }))
      .toMatchObject({ kind: 'available', tab: { id: 'skills' } });
    expect(resolveRightSidebarTabs({ scope: 'project', browserFeatureEnabled: true }).some(tab => tab.id === 'skills')).toBe(false);
  });
  it('pins the Session essentials before code and machine groups without changing Git-first selection', () => {
    const tabs = resolveRightSidebarTabs({ scope: 'session', browserFeatureEnabled: true, terminalTabAvailable: true, boardFeatureEnabled: true, sessionSharingAvailable: true, sessionProjectCheckoutAvailable: true, codeIntelligenceAvailable: true });
    expect(resolveNavigationPlacements(tabs.map(({ id, defaultPlacement, allowedPlacements }) => ({ id, defaultPlacement, allowedPlacements }))).pinned.map(tab => tab.id)).toEqual(['info', 'agents', 'collaboration', 'git', 'files', 'terminal']);
    expect(getRightSidebarBuiltinTab('info').allowedPlacements).toEqual(['pinned', 'overflow']);
    expect(resolveRightSidebarTabSelection({ activeTabId: null, tabs, projectionPhase: 'current', scope: 'session' })).toMatchObject({ kind: 'available', tab: { id: 'git' } });
    expect(resolveRightSidebarTabSelection({ activeTabId: 'removed', tabs, projectionPhase: 'current', scope: 'session' })).toMatchObject({ kind: 'available', tab: { id: 'git' } });
  });

  it('uses only explicit held content for automatic candidates and retains Discussion defaults', () => {
    const empty = { runningServices: false, problems: false, references: false, runningScripts: false, boardItems: false };
    const unknown = { runningServices: null, problems: null, references: null, runningScripts: null, boardItems: null };
    const full = { runningServices: true, problems: true, references: true, runningScripts: true, boardItems: true };
    for (const id of ['services', 'problems', 'references', 'scripts', 'board'] as const) {
      const tab = getRightSidebarBuiltinTab(id);
      expect(tab.defaultPlacement).toBe('auto');
      expect(tab.readContent?.(empty)).toBe(false);
      expect(tab.readContent?.(unknown)).toBeNull();
      expect(tab.readContent?.(full)).toBe(true);
    }
    expect(resolveNavigationPlacements(resolveRightSidebarTabs({ scope: 'discussion' }).map(({ id, defaultPlacement, allowedPlacements }) => ({ id, defaultPlacement, allowedPlacements }))).pinned.map(tab => tab.id))
      .toEqual(['discussionParticipants', 'discussionAgents', 'discussionDetails']);
    expect(resolveRightSidebarTabs({ scope: 'project', browserFeatureEnabled: true }).some(tab => tab.id === 'info')).toBe(false);
  });
});

describe('right-sidebar tab placement', () => {
  it('presents the session catalog group beside the composer only in Editor first', () => {
    const context = { scope: 'session', browserFeatureEnabled: true, arrangement: 'editor' } as const;
    const tabs = resolveRightSidebarTabs({ ...context, boardFeatureEnabled: true, sessionSharingAvailable: true });
    const placements = tabs.map(tab => [tab.id, resolveRightSidebarTabPlacement(tab, context)]);
    expect(placements.filter(([, placement]) => placement === 'main').map(([id]) => id).sort()).toEqual(['agents', 'board', 'collaboration', 'info', 'navigation']);
    for (const input of [{ scope: 'session', browserFeatureEnabled: true, arrangement: 'session' }, { scope: 'session', browserFeatureEnabled: true, arrangement: 'editor', presentation: 'mobile' }, { scope: 'project', browserFeatureEnabled: true, arrangement: 'editor' }] as const) {
      for (const tab of resolveRightSidebarTabs(input)) expect(resolveRightSidebarTabPlacement(tab, input)).toBe('side');
    }
  });
});

const REVIEW_PLUGIN_ID = 'acme.review';
const APP_PLUGIN_ID = 'acme.panels';
const BROWSER_PLUGIN_ID = 'acme.browser';

function rightSidebarBinding(
  pluginId: string,
  destinationId: string,
  targetKind: 'app' | 'session' | 'project',
): PluginUiSurfacePlacementProjection['binding'] {
  const binding = normalizePluginUiDestinationBindingV1({
    pluginId,
    destinationId,
    rendererId: `${destinationId}-renderer`,
    container: 'rightSidebarTab',
    target: { kind: targetKind },
  });
  if (!binding) {
    throw new Error(
      'test fixture must use an admitted V2 right-sidebar binding',
    );
  }
  return binding;
}

const reviewSidebarBinding = rightSidebarBinding(
  REVIEW_PLUGIN_ID,
  'review-panel',
  'session',
);
const disabledReviewSidebarBinding = rightSidebarBinding(
  REVIEW_PLUGIN_ID,
  'blocked-review',
  'session',
);
const appSidebarBinding = rightSidebarBinding(
  APP_PLUGIN_ID,
  'app-panel',
  'app',
);

const reviewSidebarPlacement = {
  id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
  pluginId: REVIEW_PLUGIN_ID,
  occurrenceId: 'acme-review-occurrence',
  contributionKind: 'surfacePlacement',
  descriptorId: 'review-panel',
  binding: reviewSidebarBinding,
  target: reviewSidebarBinding.target,
  renderer: { kind: 'host', rendererId: 'review.panel' },
  display: { developerFallback: 'Review' },
  availability: { state: 'available', reason: 'available', diagnostics: [] },
  headerActions: [],
} satisfies PluginUiSurfacePlacementProjection;

it('uses the canonical Project facts when resolving companion tabs', () => {
  const binding = rightSidebarBinding(REVIEW_PLUGIN_ID, 'project-review', 'project');
  const placement = { ...reviewSidebarPlacement, binding, target: binding.target,
    availability: { ...reviewSidebarPlacement.availability, when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } } };
  const context = createPluginProjectContextFixture({ repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' } });
  expect(resolveRightSidebarTabs({ scope: 'project', browserFeatureEnabled: true, pluginPlacements: [placement], policyContext: context.policyContext })
    .some(tab => tab.owner === 'plugin')).toBe(true);
  expect(resolveRightSidebarTabs({ scope: 'project', browserFeatureEnabled: true, pluginPlacements: [placement], policyContext: createPluginProjectContextFixture().policyContext })
    .some(tab => tab.owner === 'plugin')).toBe(false);
});

const disabledReviewSidebarPlacement = {
  ...reviewSidebarPlacement,
  id: `surfacePlacement:${REVIEW_PLUGIN_ID}:blocked-review`,
  descriptorId: 'blocked-review',
  binding: disabledReviewSidebarBinding,
  target: disabledReviewSidebarBinding.target,
  availability: {
    state: 'disabled',
    reason: 'feature_disabled',
    diagnostics: ['feature_disabled'],
  },
} satisfies PluginUiSurfacePlacementProjection;

const appSidebarPlacement = {
  id: `surfacePlacement:${APP_PLUGIN_ID}:app-panel`,
  pluginId: APP_PLUGIN_ID,
  occurrenceId: 'acme-app-occurrence',
  contributionKind: 'surfacePlacement',
  descriptorId: 'app-panel',
  binding: appSidebarBinding,
  target: appSidebarBinding.target,
  renderer: { kind: 'host', rendererId: 'app.panel' },
  display: { developerFallback: 'App panel' },
  availability: { state: 'available', reason: 'available', diagnostics: [] },
  headerActions: [],
  // This is exactly the canonical app-union stamp. It models a selected
  // current app contribution while another eligible machine is establishing.
  hostOrigin: {
    machineId: 'machine-a',
    serverId: 'server-1',
    phase: 'current',
    interactionEnabled: true,
    executionOrigin: {
      serverIdentityId: 'srv_test',
      materializationRef: {
        pluginId: APP_PLUGIN_ID,
        machineId: 'machine-a',
        materializationId: 'machine-a:acme.panels',
      },
    },
  },
} satisfies PluginUiSurfacePlacementProjection;

describe('rightSidebarTabRegistry', () => {
  it('orders session built-in tabs deterministically and gates terminal availability', () => {
    // The Session viewer docks its retained Browser source into this desktop destination.
    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: true,
        sessionSharingAvailable: true,
      }).map((tab) => tab.id),
    ).toEqual(['chat', 'tabs', 'companion', 'info', 'agents', 'collaboration', 'navigation', 'skills', 'git', 'review', 'files', 'terminal', 'browser', 'services']);

    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: false,
        sessionSharingAvailable: true,
      }).map((tab) => tab.id),
    ).toEqual(['chat', 'tabs', 'companion', 'info', 'agents', 'collaboration', 'navigation', 'skills', 'git', 'review', 'files', 'browser', 'services']);

    // Mobile keeps the full-screen Browser surface tab.
    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: true,
        presentation: 'mobile',
        sessionSharingAvailable: true,
      }).map((tab) => tab.id),
    ).toEqual([
      'chat', 'tabs', 'companion',
      'info',
      'agents',
      'collaboration',
      'navigation',
      'skills',
      'git',
      'review',
      'files',
      'terminal',
      'browser',
      'services',
    ]);

    expect(resolveRightSidebarTabs({ scope: 'session', browserFeatureEnabled: true }).map((tab) => tab.id)).not.toContain('collaboration');
    expect(resolveRightSidebarTabs({ scope: 'session', browserFeatureEnabled: true, sessionSharingAvailable: false }).map((tab) => tab.id)).not.toContain('collaboration');
  });

  it('offers Scripts beside a Session only when it works in an accepted Project checkout', () => {
    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: false,
        sessionProjectCheckoutAvailable: true,
        sessionSharingAvailable: true,
      }).map((tab) => tab.id),
    ).toEqual(['chat', 'tabs', 'companion', 'info', 'agents', 'collaboration', 'navigation', 'skills', 'git', 'review', 'files', 'scripts', 'browser', 'services']);
    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: false,
      }).map((tab) => tab.id),
    ).not.toContain('scripts');
  });

  it('publishes the Board destination only from the exact-Home feature decision, including an empty Board', () => {
    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: false,
        boardFeatureEnabled: false,
      }).map((tab) => tab.id),
    ).not.toContain('board');

    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: false,
        boardFeatureEnabled: true,
        sessionSharingAvailable: true,
      }).map((tab) => tab.id),
    ).toEqual(['chat', 'tabs', 'companion', 'info', 'agents', 'collaboration', 'navigation', 'board', 'skills', 'git', 'review', 'files', 'browser', 'services']);
  });

  it('orders project built-in tabs without session-only entries', () => {
    // Project Browser has a real workspace producer on desktop and mobile.
    expect(
      resolveRightSidebarTabs({
        scope: 'project', browserFeatureEnabled: true,
        terminalTabAvailable: true,
      }).map((tab) => tab.id),
    ).toEqual([
      'git',
      'files',
      'scripts',
      'widgets',
      'terminal',
      'browser',
      'services',
    ]);

    // A phone reads the Project's widgets on its Project page, below the checkout.
    expect(
      resolveRightSidebarTabs({
        scope: 'project', browserFeatureEnabled: true,
        terminalTabAvailable: true,
        presentation: 'mobile',
      }).map((tab) => tab.id),
    ).toEqual(['git', 'files', 'scripts', 'terminal', 'browser', 'services']);
  });

  it('gives a Discussion Chat and its three companions, keeping Discussion companions out of Session and Project rails', () => {
    expect(resolveRightSidebarTabs({ scope: 'discussion' }).map((tab) => tab.id))
      .toEqual(['chat', 'discussionParticipants', 'discussionAgents', 'discussionDetails']);
    expect(resolveRightSidebarTabs({ scope: 'discussion', presentation: 'mobile' }).map((tab) => tab.id))
      .toEqual(['chat', 'discussionParticipants', 'discussionAgents', 'discussionDetails']);
    const sessionIds = resolveRightSidebarTabs({ scope: 'session', browserFeatureEnabled: true, boardFeatureEnabled: true, terminalTabAvailable: true }).map((tab) => tab.id);
    const projectIds = resolveRightSidebarTabs({ scope: 'project', browserFeatureEnabled: true, terminalTabAvailable: true }).map((tab) => tab.id);
    for (const id of ['discussionParticipants', 'discussionAgents', 'discussionDetails']) {
      expect(sessionIds).not.toContain(id);
      expect(projectIds).not.toContain(id);
    }
  });

  it('launches Project Terminal only for an accepted checkout without replacing its retained destination', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'project', browserFeatureEnabled: true,
      presentation: 'mobile',
      terminalTabAvailable: true,
    });
    expect(
      resolveRightSidebarMobileProjection({ scope: 'project', tabs }).map(
        (entry) => entry.tabId,
      ),
    ).toContain('terminal');
    const unavailable = resolveRightSidebarTabs({
      scope: 'project', browserFeatureEnabled: true,
      presentation: 'mobile',
      terminalTabAvailable: false,
    });
    expect(unavailable.find((tab) => tab.id === 'terminal')).toMatchObject({
      hiddenInLauncher: true,
    });
    expect(
      resolveRightSidebarMobileProjection({
        scope: 'project',
        tabs: unavailable,
      }).map((entry) => entry.tabId),
    ).not.toContain('terminal');
    expect(
      resolveRightSidebarTabSelection({
        activeTabId: 'terminal',
        tabs: unavailable,
        projectionPhase: 'current',
      }),
    ).toMatchObject({ kind: 'available', tab: { id: 'terminal' } });
    expect(
      resolveRightSidebarTabs({
        scope: 'session', browserFeatureEnabled: true,
        terminalTabAvailable: false,
      }).some((tab) => tab.id === 'terminal'),
    ).toBe(false);
  });

  it('falls back to the first available built-in tab when persisted state is stale', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: false,
    });

    expect(resolveRightSidebarActiveTab('terminal', tabs)).toBe('git');
    expect(resolveRightSidebarActiveTab('browser', tabs)).toBe('browser');
    expect(resolveRightSidebarActiveTab(null, tabs)).toBe('git');

    // On mobile the Browser surface tab is still selectable.
    const mobileTabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: false,
      presentation: 'mobile',
    });
    expect(resolveRightSidebarActiveTab('browser', mobileTabs)).toBe('browser');
  });

  it('keeps a restored plugin selection unresolved until its projection is current, then tombstones it when absent', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: false,
    });

    expect(
      resolveRightSidebarTabSelection({
        activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
        tabs,
        projectionPhase: 'current',
        hasEstablishingMembers: true,
        scope: 'app',
      }),
    ).toEqual({
      kind: 'unresolved',
      tabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
    });

    expect(
      resolveRightSidebarTabSelection({
        activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
        tabs,
        projectionPhase: 'current',
      }),
    ).toEqual({
      kind: 'unavailable',
      tabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
      reason: 'plugin_destination_unavailable',
    });
  });

  it('returns no app-scope plugin selection until a user or qualified opener selects one', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'app',
      pluginPlacements: [appSidebarPlacement],
    });

    expect(
      resolveRightSidebarTabSelection({
        activeTabId: null,
        tabs,
        projectionPhase: 'current',
        scope: 'app',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('keeps an already-published app tab available while another app member is establishing', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'app',
      pluginPlacements: [appSidebarPlacement],
    });

    // The aggregate catalog is incomplete, but this selected tab has an
    // exact current origin. Treating it as unresolved would unnecessarily
    // blank a known-current surface while machine-b describes another one.
    expect(
      resolveRightSidebarTabSelection({
        activeTabId: `plugin:${APP_PLUGIN_ID}:app-panel`,
        tabs,
        projectionPhase: 'establishing',
      }),
    ).toMatchObject({
      kind: 'available',
      tab: { id: `plugin:${APP_PLUGIN_ID}:app-panel` },
    });
  });

  it('admits Browser alongside Services for Session and Project on both presentations', () => {
    const desktopSession = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: true,
      presentation: 'desktop',
    }).map((tab) => tab.id);
    const desktopProject = resolveRightSidebarTabs({
      scope: 'project', browserFeatureEnabled: true,
      presentation: 'desktop',
    }).map((tab) => tab.id);
    expect(desktopSession).toContain('browser');
    expect(desktopProject).toContain('browser');
    // Both scopes retain Services; Project also exposes its workspace Browser.
    expect(desktopSession).toContain('services');
    expect(desktopProject).toContain('services');

    const mobileSession = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: true,
      presentation: 'mobile',
    }).map((tab) => tab.id);
    const mobileProject = resolveRightSidebarTabs({
      scope: 'project', browserFeatureEnabled: true,
      presentation: 'mobile',
    }).map((tab) => tab.id);
    expect(mobileSession).toContain('browser');
    expect(mobileProject).toContain('browser');
  });

  it('hides only the matching Project page launcher while retaining its selected companion', () => {
    for (const [activePage, suppressedTabId] of [
      ['code', 'files'],
      ['changes', 'git'],
      ['scripts', 'scripts'],
      ['services', 'services'],
    ] as const) {
      const tabs = resolveRightSidebarTabs({
        scope: 'project', browserFeatureEnabled: true,
        activePage,
        presentation: 'mobile',
      });
      expect(tabs.find((tab) => tab.id === suppressedTabId)).toMatchObject({
        hiddenInLauncher: true,
      });
      expect(
        resolveRightSidebarMobileProjection({ scope: 'project', tabs }).map(
          (entry) => entry.tabId,
        ),
      ).toEqual(
        ['git', 'files', 'scripts', 'browser', 'services'].filter(
          (id) => id !== suppressedTabId,
        ),
      );
      expect(
        resolveRightSidebarTabSelection({
          activeTabId: suppressedTabId,
          tabs,
          projectionPhase: 'current',
        }),
      ).toMatchObject({ kind: 'available', tab: { id: suppressedTabId } });
    }
    for (const activePage of ['overview', 'context'] as const) {
      const tabs = resolveRightSidebarTabs({
        scope: 'project', browserFeatureEnabled: true,
        activePage,
        presentation: 'mobile',
      });
      expect(
        resolveRightSidebarMobileProjection({ scope: 'project', tabs }).map(
          (entry) => entry.tabId,
        ),
      ).toEqual(['git', 'files', 'scripts', 'browser', 'services']);
    }
  });

  it('keeps the Browser mobile-surface projection for both scopes', () => {
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('browser'),
        'session',
      ),
    ).toBe('browser');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('browser'),
        'project',
      ),
    ).toBe('browser');
  });

  it('projects Browser and Services to mobile through the shared registry metadata', () => {
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('git'),
        'session',
      ),
    ).toBe('git');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('files'),
        'session',
      ),
    ).toBe('browse');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('terminal'),
        'session',
      ),
    ).toBe('terminal');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('browser'),
        'session',
      ),
    ).toBe('browser');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('services'),
        'session',
      ),
    ).toBe('services');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('browser'),
        'project',
      ),
    ).toBe('browser');
    expect(
      resolveRightSidebarMobileSurface(
        getRightSidebarBuiltinTab('services'),
        'project',
      ),
    ).toBe('services');
  });

  it('merges validated plugin tabs into host-owned ordering without shadowing built-ins', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: false,
      sessionSharingAvailable: true,
      pluginPlacements: [reviewSidebarPlacement],
    });

    expect(tabs.map((tab) => tab.id)).toEqual([
      'chat', 'tabs', 'companion',
      'info',
      'agents',
      'collaboration',
      'navigation',
      'skills',
      'git',
      'review',
      'files',
      'browser',
      'services',
      `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
    ]);
    expect(
      tabs.find((tab) => tab.id === `plugin:${REVIEW_PLUGIN_ID}:review-panel`),
    ).toMatchObject({
      owner: 'plugin',
      label: 'Review',
      plugin: {
        pluginId: REVIEW_PLUGIN_ID,
        descriptorId: 'review-panel',
      },
    });
  });

  it('falls back away from disabled plugin tabs that the current host policy hides', () => {
    const tabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: false,
      pluginPlacements: [disabledReviewSidebarPlacement],
    });

    expect(
      tabs.find(
        (tab) => tab.id === `plugin:${REVIEW_PLUGIN_ID}:blocked-review`,
      ),
    ).toBeUndefined();
    expect(
      resolveRightSidebarActiveTab(
        `plugin:${REVIEW_PLUGIN_ID}:blocked-review`,
        tabs,
      ),
    ).toBe('git');
  });

  it("lists the App's tabs after scoped tabs and admits them in the phone Session cockpit", () => {
    const sessionTabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      pluginPlacements: [reviewSidebarPlacement],
      appPluginPlacements: [appSidebarPlacement],
    });
    const ids = sessionTabs.map((tab) => tab.id);
    expect(ids.slice(-2)).toEqual([
      `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
      `plugin:${APP_PLUGIN_ID}:app-panel`,
    ]);
    const appTab = sessionTabs.find(
      (tab) => tab.id === `plugin:${APP_PLUGIN_ID}:app-panel`,
    );
    expect(appTab).toMatchObject({ owner: 'plugin', scopes: ['app'] });
    // Presentation beside a Session does not change the panel's App target binding.
    expect(
      appTab ? resolveRightSidebarMobileSurface(appTab, 'session') : 'missing',
    ).toBe('plugin');

    const projectTabs = resolveRightSidebarTabs({
      scope: 'project', browserFeatureEnabled: true,
      pluginPlacements: [],
      appPluginPlacements: [appSidebarPlacement],
    });
    expect(projectTabs.at(-1)?.id).toBe(`plugin:${APP_PLUGIN_ID}:app-panel`);
    // The App's own sidebar does not list them twice.
    expect(
      resolveRightSidebarTabs({
        scope: 'app',
        pluginPlacements: [appSidebarPlacement],
        appPluginPlacements: [appSidebarPlacement],
      }).map((tab) => tab.id),
    ).toEqual([`plugin:${APP_PLUGIN_ID}:app-panel`]);
  });

  it('resolves app-scope plugin right-sidebar tabs through the shared registry', () => {
    const appSidebarBinding = rightSidebarBinding(
      APP_PLUGIN_ID,
      'app-panel',
      'app',
    );
    const appSidebarPlacement = {
      ...reviewSidebarPlacement,
      id: `surfacePlacement:${APP_PLUGIN_ID}:app-panel`,
      pluginId: APP_PLUGIN_ID,
      descriptorId: 'app-panel',
      binding: appSidebarBinding,
      target: appSidebarBinding.target,
      renderer: { kind: 'host', rendererId: 'descriptorPanel' },
    } satisfies PluginUiSurfacePlacementProjection;

    const tabs = resolveRightSidebarTabs({
      scope: 'app',
      pluginPlacements: [appSidebarPlacement],
    });

    // No app-scope built-in tabs exist; only the plugin tab resolves for scope 'app'.
    expect(tabs.map((tab) => tab.id)).toEqual([
      `plugin:${APP_PLUGIN_ID}:app-panel`,
    ]);
    expect(
      tabs.find((tab) => tab.id === `plugin:${APP_PLUGIN_ID}:app-panel`),
    ).toMatchObject({
      owner: 'plugin',
      plugin: { pluginId: APP_PLUGIN_ID, descriptorId: 'app-panel' },
    });
  });

  // UI-D25: plugin tab ids are qualified `plugin:<pluginId>:<slug>`, so a plugin slug
  // spelled like a built-in tab id cannot collide with it. The tab must therefore stay
  // fully usable and merge alongside the built-in tab of the same NAME, not be reserved
  // away by a raw-slug guard.
  it('admits a plugin tab whose slug matches a built-in tab id, alongside that built-in tab', () => {
    const builtInNamedBinding = rightSidebarBinding(
      BROWSER_PLUGIN_ID,
      'browser',
      'session',
    );
    const builtInNamedPlacement = {
      ...reviewSidebarPlacement,
      id: `surfacePlacement:${BROWSER_PLUGIN_ID}:browser`,
      pluginId: BROWSER_PLUGIN_ID,
      descriptorId: 'browser',
      binding: builtInNamedBinding,
      target: builtInNamedBinding.target,
      display: { developerFallback: 'Acme Browser' },
    } satisfies PluginUiSurfacePlacementProjection;

    const tabs = resolveRightSidebarTabs({
      scope: 'session', browserFeatureEnabled: true,
      terminalTabAvailable: false,
      // Plugin and built-in Browser destinations retain distinct qualified identities.
      // so both ids are live at once here.
      presentation: 'mobile',
      pluginPlacements: [builtInNamedPlacement],
    });

    expect(tabs.map((tab) => tab.id)).toContain('browser');
    const pluginTab = tabs.find(
      (tab) => tab.id === `plugin:${BROWSER_PLUGIN_ID}:browser`,
    );
    expect(pluginTab).toMatchObject({
      owner: 'plugin',
      label: 'Acme Browser',
      plugin: { pluginId: BROWSER_PLUGIN_ID, descriptorId: 'browser' },
    });
    expect(pluginTab?.disabledReason).toBeUndefined();
    // It is selectable, which a reserved/disabled tab never is.
    expect(
      resolveRightSidebarActiveTab(`plugin:${BROWSER_PLUGIN_ID}:browser`, tabs),
    ).toBe(`plugin:${BROWSER_PLUGIN_ID}:browser`);
  });
});
