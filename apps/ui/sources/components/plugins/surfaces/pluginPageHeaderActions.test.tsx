import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const router = createExpoRouterMock();
installSettingsViewCommonModuleMocks({ router: () => router.module });

const { DestinationInstanceHost } =
  await import('@/components/appShell/workspace/DestinationInstanceHost');
const { Stack } =
  await import('@/components/appShell/workspace/destinationRoute');
const { SurfaceFreshnessLine } =
  await import('@/components/ui/surfaces/SurfaceFreshnessLine');
const { PluginSurfaceInteractionBoundary } =
  await import('@/components/plugins/shared/PluginSurfaceInteractionBoundary');
const { renderPluginNavigationActions, PluginArtifactHostingStatusProvider } =
  await import('./pluginPageHeaderActions');
const { PaneMainColumnContext } =
  await import('@/components/appShell/panes/mainColumn/usePaneMainColumn');
const { PaneRegionProvider } =
  await import('@/components/appShell/panes/paneRegion');
const { NavigationHeaderActions } =
  await import('@/components/ui/layout/NavigationHeaderActions');
const { NavigationTitleChromeProvider } =
  await import('@/components/ui/layout/PageHeader');

function isInside(node: ReactTestInstance, testID: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.props['data-testid'] === testID ||
      parent.props.testID === testID
    )
      return true;
  }
  return false;
}

/**
 * A plugin page whose header row takes the route's own control (the machine it runs on), the way a
 * Collection toolbar places `pageActions`.
 */
function page(online: boolean) {
  return (
    <DestinationInstanceHost
      tabId="prs"
      ref={{ kind: 'settings', params: {} }}
      pathname="/plugins/acme/page"
      focused
      visible
      phone={false}
      navigation={{ push: () => {}, replace: () => {}, back: () => {} }}
    >
      <Stack.Screen
        options={{
          headerRight: () => <button data-testid="run-on-chip">Run on</button>,
        }}
      />
      <PluginSurfaceInteractionBoundary
        surfaceId="acme-page"
        snapshotTitle="Acme"
        enabled={online}
      >
        {renderPluginNavigationActions(null)}
      </PluginSurfaceInteractionBoundary>
    </DestinationInstanceHost>
  );
}

describe('plugin page header actions', () => {
  it('keeps the route control usable outside the read-only snapshot while the plugin is offline', async () => {
    const screen = await renderScreen(page(true));
    const live = screen.root.findAllByProps({ 'data-testid': 'run-on-chip' });
    expect(live).toHaveLength(1);
    expect(isInside(live[0]!, 'plugin-surface-snapshot:acme-page')).toBe(true);

    // Offline, the plugin's tree is inert; the one control that leads elsewhere (another machine)
    // must not be frozen inside it.
    await screen.update(page(false));
    const offline = screen.root.findAllByProps({
      'data-testid': 'run-on-chip',
    });
    expect(offline).toHaveLength(1);
    expect(isInside(offline[0]!, 'plugin-surface-snapshot:acme-page')).toBe(
      false,
    );
    expect(isInside(offline[0]!, 'app-stack-header-actions')).toBe(true);

    // Back online, the row takes it again: never drawn twice.
    await screen.update(page(true));
    const again = screen.root.findAllByProps({ 'data-testid': 'run-on-chip' });
    expect(again).toHaveLength(1);
    expect(isInside(again[0]!, 'plugin-surface-snapshot:acme-page')).toBe(true);
  });

  /**
   * D3: the page's UI could not be hosted on the Account. It still works here, so the outcome is one
   * quiet chip in the page's own header row, never a strip above the page; a surface that draws no
   * header keeps the line so the fact is never lost.
   */
  function hostedPage(completion: Promise<{ kind: 'unavailable' } | { kind: 'published' }> | null, header: boolean) {
    return (
      <DestinationInstanceHost
        tabId="prs"
        ref={{ kind: 'settings', params: {} }}
        pathname="/plugins/acme/page"
        focused
        visible
        phone={false}
        navigation={{ push: () => {}, replace: () => {}, back: () => {} }}
      >
        <PluginArtifactHostingStatusProvider completion={completion as never} isCurrent={() => true}>
          <PluginSurfaceInteractionBoundary surfaceId="acme-page" snapshotTitle="Acme" enabled>
            {header ? renderPluginNavigationActions(null) : null}
          </PluginSurfaceInteractionBoundary>
        </PluginArtifactHostingStatusProvider>
      </DestinationInstanceHost>
    );
  }

  it('says a failed Account upload as one header chip on the page, or a line when the page has no header', async () => {
    const failed = Promise.resolve({ kind: 'unavailable' as const });
    const screen = await renderScreen(hostedPage(failed, true));
    await screen.update(hostedPage(failed, true));
    const chips = screen.root.findAllByType(SurfaceFreshnessLine);
    expect(chips).toHaveLength(1);
    expect(isInside(chips[0]!, 'plugin-surface-snapshot:acme-page')).toBe(true);
    expect(chips[0]!.props.presentation).toBe('chip');

    const lineScreen = await renderScreen(hostedPage(failed, false));
    await lineScreen.update(hostedPage(failed, false));
    const lines = lineScreen.root.findAllByType(SurfaceFreshnessLine);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.props.presentation ?? 'line').toBe('line');

    const ok = Promise.resolve({ kind: 'published' as const });
    const okScreen = await renderScreen(hostedPage(ok, true));
    await okScreen.update(hostedPage(ok, true));
    expect(okScreen.root.findAllByType(SurfaceFreshnessLine)).toHaveLength(0);

    const idle = await renderScreen(hostedPage(null, true));
    expect(idle.root.findAllByType(SurfaceFreshnessLine)).toHaveLength(0);
  });

  /**
   * D14: a plugin page that is a pane host's main column offers Hide in its own header row, wired to
   * the host's main column, exactly like a core page header; anywhere else (a side pane, no pane
   * host) it draws nothing.
   */
  function mainColumnPage(
    region: 'main' | 'side' | null,
    setHidden: (hidden: boolean) => void,
    entity?: Readonly<{ showsTitle: boolean }>,
  ) {
    const main = {
      hidden: false, canHide: true, folded: false,
      labels: { hideLabel: 'Hide Acme', showLabel: 'Show Acme' }, identity: { name: 'Acme' },
      setHidden, requestHidden: setHidden, toggle: () => setHidden(true),
    };
    // An entity header (a leading mark) keeps its actions in the page: the `page` placement.
    const actions = entity
      ? <NavigationTitleChromeProvider showsTitle={entity.showsTitle}>
          {renderPluginNavigationActions(<button data-testid="entity-action">Fix</button>, 'page')}
        </NavigationTitleChromeProvider>
      : renderPluginNavigationActions(null);
    return (
      <DestinationInstanceHost
        tabId="prs"
        ref={{ kind: 'settings', params: {} }}
        pathname="/plugins/acme/page"
        focused
        visible
        phone={false}
        navigation={{ push: () => {}, replace: () => {}, back: () => {} }}
      >
        <PaneMainColumnContext.Provider value={region === null ? null : main}>
          <PluginSurfaceInteractionBoundary surfaceId="acme-page" snapshotTitle="Acme" enabled>
            {region === null ? actions : <PaneRegionProvider region={region}>{actions}</PaneRegionProvider>}
          </PluginSurfaceInteractionBoundary>
        </PaneMainColumnContext.Provider>
      </DestinationInstanceHost>
    );
  }

  it('offers Hide for a plugin page in the main column and hides that column', async () => {
    const hidden: boolean[] = [];
    const screen = await renderScreen(mainColumnPage('main', (value) => hidden.push(value)));
    await screen.pressByTestIdAsync('pane-main-hide');
    expect(hidden).toEqual([true]);

    const side = await renderScreen(mainColumnPage('side', () => {}));
    expect(side.findByTestId('pane-main-hide')).toBeNull();
    const isolated = await renderScreen(mainColumnPage(null, () => {}));
    expect(isolated.findByTestId('pane-main-hide')).toBeNull();
  });

  it('keeps Hide and the entity actions in the page row for an entity header, under any title chrome', async () => {
    for (const showsTitle of [false, true]) {
      const hidden: boolean[] = [];
      const screen = await renderScreen(mainColumnPage('main', (value) => hidden.push(value), { showsTitle }));
      const action = screen.root.findAllByProps({ 'data-testid': 'entity-action' });
      expect(action).toHaveLength(1);
      // Never hoisted into the navigation header: the entity's actions stay by its identity.
      expect(screen.root.findAllByType(NavigationHeaderActions)).toHaveLength(0);
      await screen.pressByTestIdAsync('pane-main-hide');
      expect(hidden).toEqual([true]);
    }
    const side = await renderScreen(mainColumnPage('side', () => {}, { showsTitle: false }));
    expect(side.findByTestId('pane-main-hide')).toBeNull();
  });
});

