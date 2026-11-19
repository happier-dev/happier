import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// Test Renderer keeps the real menu and substitutes its browser portal and focus boundaries.
vi.mock('@/utils/web/reactDomCjs', async () =>
  (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
afterEach(standardCleanup);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ServicesColumnView, readServicesColumnSelection } =
  await import('./ServicesColumn');
type ServicesColumnGrouping = import('./ServicesColumn').ServicesColumnGrouping;
const { useDeploymentCollection } = await import('./useDeploymentReads');

const shown = { mounted: true, visible: true, focused: true };
type ListResult = Awaited<
  ReturnType<DeploymentReadTransportV1['listEnvironments']>
>;
type Selection = Parameters<typeof ServicesColumnView>[0]['selection'];

function environment(
  id: string,
  projectSourceId: string,
  title: string,
  projectSourceName: string | null,
  deployed = true,
) {
  return {
    environment: createDeploymentEnvironmentHeaderV1({ id, projectSourceId }),
    runtimeTargetLink: createDeploymentTargetLinkHeaderV1(),
    title,
    // A deployed Environment runs something; one never deployed has nothing in the column (E1).
    currentDeployment: deployed ? createDeploymentReceiptHeaderV1({ id: `receipt-${id}`, environmentId: id, state: 'succeeded' }) : null,
    projectSourceName,
  };
}

/** The network boundary only: the Account-wide controller and its page run for real. */
function controllerFor(
  items: DeploymentEnvironmentCollectionV1['items'],
  nextCursor: string | null = null,
  pages: Pick<DeploymentReadTransportV1, 'listDataServicePage' | 'listDomainPage'> = {},
  scope = { serverId: 'home', accountId: 'account-owner' },
) {
  const unavailable = async () => ({
    ok: false as const,
    failure: { code: 'deployment_unavailable', retryable: true },
  });
  const transport: DeploymentReadTransportV1 = {
    listEnvironments: async (): Promise<ListResult> => ({
      ok: true,
      value: { items, nextCursor },
    }),
    readEnvironment: unavailable,
    listHistory: unavailable,
    readReceipt: unavailable,
    ...pages,
  };
  return createDeploymentReadControllerV1({
    scope,
    transport,
  });
}

function Column(
  props: Readonly<{
    controller: DeploymentReadControllerV1;
    selection: Selection;
    selectedServerId?: string | null;
    onNavigate: (href: string) => void;
    pinnedEnvironmentIds?: readonly string[];
    onTogglePinned?: (environmentId: string, pinned: boolean) => void;
    grouping?: ServicesColumnGrouping;
    onGroupingChange?: (grouping: ServicesColumnGrouping) => void;
    space?: React.ComponentProps<typeof ServicesColumnView>['space'];
  }>,
) {
  const read = useDeploymentCollection(props.controller, shown);
  return (
    <ServicesColumnView
      read={read}
      serverId={props.controller.scope.serverId}
      lifetime={null}
      selection={props.selection}
      selectedServerId={props.selectedServerId}
      onNavigate={props.onNavigate}
      create={null}
      pinnedEnvironmentIds={props.pinnedEnvironmentIds ?? []}
      onTogglePinned={props.onTogglePinned ?? (() => {})}
      controller={props.controller}
      grouping={props.grouping ?? 'project'}
      onGroupingChange={props.onGroupingChange ?? (() => {})}
      {...(props.space ? { space: props.space } : {})}
    />
  );
}

async function render(
  controller: DeploymentReadControllerV1,
  selection: Selection,
  onNavigate = vi.fn(),
  /** The row whose arrival says the column's read has landed. */
  ready = 'services-column:project:unnamed',
  pins: Readonly<{ pinnedEnvironmentIds?: readonly string[]; onTogglePinned?: (environmentId: string, pinned: boolean) => void;
    grouping?: ServicesColumnGrouping; onGroupingChange?: (grouping: ServicesColumnGrouping) => void;
    space?: React.ComponentProps<typeof ServicesColumnView>['space'] }> = {},
) {
  const screen = await renderScreen(
    <Column
      controller={controller}
      selection={selection}
      onNavigate={onNavigate}
      {...pins}
    />,
  );
  await act(async () => {
    await waitForTestEvent(
      screen.subscribe,
      () => screen.findByTestId('services-column:all'),
      (node) => node !== null,
    );
    await waitForTestEvent(
      screen.subscribe,
      () => screen.findByTestId(ready),
      (node) => node !== null,
    );
  });
  return { screen, onNavigate };
}

const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => [
  ...new Set(
    screen.root
      .findAll(
        (node) =>
          typeof node.props.testID === 'string' &&
          /^services-column:(all|(project|environment):[^:]+)$/.test(
            node.props.testID,
          ),
      )
      .map((node) => node.props.testID as string),
  ),
];

/** The row's own `selected` prop (the composite row, not the host view it renders). */
const selectedOf = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => screen.root
  .findAll((node) => node.props.testID === testID && 'selected' in node.props)[0]?.props.selected;

const ITEMS = [
  environment('env-shop-staging', 'source-shop', 'Staging', 'storefront'),
  environment('env-api', 'source-api', 'payments-api', 'payments-api'),
  environment('env-gone', 'source-gone', 'Demo', null),
  environment('env-shop-production', 'source-shop', 'Production', 'storefront'),
];

describe('Services column', () => {
  it('leads with All services, then each Project folded in the read’s order, a one-Environment Project as its Environment, unnamed last', async () => {
    const controller = controllerFor(ITEMS);
    const { screen } = await render(controller, { kind: 'all' });
    expect(rowIds(screen)).toEqual([
      'services-column:all',
      'services-column:project:source-shop',
      'services-column:environment:env-api',
      'services-column:project:unnamed',
    ]);
    expect(selectedOf(screen, 'services-column:all')).toBe(
      true,
    );
    // A healthy Environment stays one quiet line in the column; the page beside it names where it runs.
    const api = screen.root.findAll((node) => node.props.testID === 'services-column:environment:env-api' && 'selected' in node.props)[0]!;
    expect(api.props.subtitle).toBeUndefined();
    controller.retire();
  });

  it('is one keyboard tree through the shared tree owner: treeitem levels, expanded state, ArrowRight opens a Project', async () => {
    const controller = controllerFor(ITEMS);
    const { screen } = await render(controller, { kind: 'all' });
    const treeItemOf = (testID: string) => screen.root
      .findAll((node) => node.props.testID === testID && 'treeItem' in node.props)[0]?.props.treeItem;
    const project = treeItemOf('services-column:project:source-shop');
    expect(project).toMatchObject({ webRole: 'treeitem', accessibilityLevel: 1, accessibilityExpanded: false });
    expect(treeItemOf('services-column:environment:env-api')).toMatchObject({ webRole: 'treeitem', accessibilityLevel: 1 });
    // A deployed Environment discloses what it runs (level 3), folded at first.
    expect(treeItemOf('services-column:environment:env-api')?.accessibilityExpanded).toBe(false);
    // One roving tab stop: exactly one row is in the tab order.
    const tabStops = rowIds(screen).filter((id) => treeItemOf(id)?.webTabIndex === 0);
    expect(tabStops).toHaveLength(1);
    await act(async () => {
      project.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} });
    });
    expect(rowIds(screen)).toContain('services-column:environment:env-shop-staging');
    expect(treeItemOf('services-column:project:source-shop')?.accessibilityExpanded).toBe(true);
    expect(treeItemOf('services-column:environment:env-shop-staging')).toMatchObject({ accessibilityLevel: 2 });
    controller.retire();
  });

  it('opens the addressed Environment from Services when a retained Project is duplicating another Environment', async () => {
    const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
    const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createDeploymentActions } = await import('./deploymentActions');
    const { ModalProvider } = await import('@/modal');
    const { PageHeader } = await import('@/components/ui/layout/PageHeader');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
    const previous = storage.getState();
    const serverId = await homes.addHome({ name: 'Services', serverUrl: 'https://services-column.test', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    homes.answer(serverId, 'GET /v1/projects/sources/source-shop', { body: { ok: true, canManage: true,
      source: { id: 'source-shop', revision: 1, name: 'Storefront', owner: { kind: 'account', accountId: 'alice' }, audience: [], createdByAccountId: 'alice' } } });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready',
      features: FeaturesResponseSchema.parse({ features: { deployments: { enabled: true } }, capabilities: {} }) } });
    storage.getState().applySettingsLocal({ featureToggles: { ...storage.getState().settings.featureToggles, deployments: true } });

    const homeItems = ITEMS.map(item => ({ ...item, environment: { ...item.environment, serverId } }));
    const column = controllerFor(homeItems, null, {}, account.accountLifetime.scope);
    const projectItems = homeItems.filter(item => item.environment.projectSourceId === 'source-shop');
    const controller = createDeploymentReadControllerV1({
      scope: { ...account.accountLifetime.scope, projectSourceId: 'source-shop' },
      transport: {
        listEnvironments: async () => ({ ok: true, value: { items: projectItems, nextCursor: null } }),
        readEnvironment: async (_scope, environmentId) => {
          const item = projectItems.find(candidate => candidate.environment.id === environmentId)!;
          const fixture = createDeploymentEnvironmentDetailV1();
          return { ok: true, value: { ...fixture, environment: item.environment,
            content: { ...fixture.content, name: item.title }, targetLinks: [] } };
        },
        listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        readReceipt: async () => ({ ok: false, failure: { code: 'deployment_unavailable', retryable: true } }),
      },
    });
    const pathname = '/deployments/source-shop';
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
      externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const project = <ProjectDeploymentsView controller={controller} demand={shown} lifetime={account.accountLifetime}
      serverId={serverId} accountId="alice" sourceId="source-shop" actions={createDeploymentActions(account.accountLifetime, 'source-shop')} />;
    const onNavigate = vi.fn();
    function RetainedProject() {
      const [href, setHref] = React.useState(`${pathname}?serverId=${serverId}&deploymentEnvironment=env-shop-production`);
      const ref = resolveDestinationRefFromHref(catalog, href);
      if (!ref) throw new Error(`Missing Environment destination for ${href}`);
      return <ModalProvider>
        <Column controller={column} selection={readServicesColumnSelection(pathname, ref.params.deploymentEnvironment ?? null)}
          onNavigate={next => { onNavigate(next); setHref(next); }} />
        <DestinationInstanceContext.Provider value={{ tabId: 'project-tab', pathname, ref, focused: true, visible: true,
          isFocused: () => true, navigation: routerMock.module.router }}>
          {project}
        </DestinationInstanceContext.Provider>
      </ModalProvider>;
    }
    const screen = await renderAccountScreen(<RetainedProject />);
    const waitFor = (id: string) => waitForTestEvent(screen.subscribe, () => screen.findByTestId(id), node => node !== null);
    const openedEnvironment = () => screen.findAllByType(PageHeader)
      .find(node => node.props.testID === 'project-deployments.environment.header')?.props.title;
    // The real menu registers layout listeners on the browser window.
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
      await waitFor('services-column:project:unnamed');
      expect(rowIds(screen)).toEqual([
        'services-column:all',
        'services-column:project:source-shop',
        'services-column:environment:env-shop-staging',
        'services-column:environment:env-shop-production',
        'services-column:environment:env-api',
        'services-column:project:unnamed',
      ]);
      expect(selectedOf(screen, 'services-column:environment:env-shop-production')).toBe(true);
      await waitFor('project-deployments.rail.add');
      await waitFor('project-deployments.environment.menu');
      expect(openedEnvironment()).toBe('Production');
      await screen.pressByTestIdAsync('project-deployments.environment.menu');
      await waitFor('project-deployments.environment.menu.duplicate');
      await screen.pressByTestIdAsync('project-deployments.environment.menu.duplicate');
      await waitFor('project-deployments.draft');
      await screen.pressByTestIdAsync('services-column:environment:env-shop-staging');
      expect(onNavigate).toHaveBeenCalledWith(`${pathname}?serverId=${serverId}&deploymentEnvironment=env-shop-staging`);
      expect(screen.findByTestId('project-deployments.draft')).toBeNull();
      await waitForTestEvent(screen.subscribe, () => expect(openedEnvironment()).toBe('Staging'));
      await screen.pressByTestIdAsync('services-column:environment:env-shop-production');
      await waitForTestEvent(screen.subscribe, () => expect(openedEnvironment()).toBe('Production'));
      expect(screen.findByTestId('project-deployments.draft')).toBeNull();
      await screen.pressByTestIdAsync('services-column:project:source-shop');
      expect(onNavigate).toHaveBeenLastCalledWith(`${pathname}?serverId=${serverId}`);
    } finally {
      await screen.unmount();
      controller.retire();
      column.retire();
      account.dispose();
      await homes.reset();
      storage.setState(previous);
      vi.unstubAllGlobals();
    }
  });

  it('counts the Account’s Environments only when the whole list is in one page', async () => {
    const countOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
      .findAll((node) => node.props.testID === 'services-column:list' && 'title' in node.props)[0]!.props.count;
    const whole = controllerFor(ITEMS);
    expect(countOf((await render(whole, null)).screen)).toBe(4);
    whole.retire();
    const paged = controllerFor(ITEMS, 'env-next');
    expect(countOf((await render(paged, null)).screen)).toBeUndefined();
    paged.retire();
  });
});

describe('Services column read failure', () => {
  function failing(code: 'deployment_unavailable' | 'home_unreachable' = 'deployment_unavailable') {
    const unavailable = async () => ({ ok: false as const, failure: { code, retryable: true } });
    return createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner' },
      transport: { listEnvironments: unavailable, readEnvironment: unavailable, listHistory: unavailable, readReceipt: unavailable } });
  }
  async function renderFailing(selection: Selection, code?: Parameters<typeof failing>[0], selectedServerId?: string) {
    const controller = failing(code);
    const screen = await renderScreen(<Column controller={controller} selection={selection}
      selectedServerId={selectedServerId} onNavigate={vi.fn()} />);
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('services-column:all'), (node) => node !== null);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return { screen, controller };
  }

  it('says the failure once: quiet beside the Services page that says it, a line with Retry beside an Environment', async () => {
    const page = await renderFailing({ kind: 'all' });
    expect(page.screen.findByTestId('services-column:error')).toBeNull();
    page.controller.retire();
    const environment = await renderFailing({ kind: 'environment', projectSourceId: 'source-shop', environmentId: 'env-1' });
    await act(async () => {
      await waitForTestEvent(environment.screen.subscribe, () => environment.screen.findByTestId('services-column:error'), (node) => node !== null);
    });
    expect(environment.screen.findByTestId('services-column:error')).not.toBeNull();
    environment.controller.retire();
  });

  it('leaves the shared Home outage to the selected Project or Environment page', async () => {
    for (const selection of [
      { kind: 'project', projectSourceId: 'source-shop' },
      { kind: 'environment', projectSourceId: 'source-shop', environmentId: 'env-1' },
    ] as const) {
      const { screen, controller } = await renderFailing(selection, 'home_unreachable', 'home');
      try {
        expect(screen.findByTestId('services-column:error')).toBeNull();
      } finally {
        controller.retire();
        await screen.unmount();
      }
    }
  });
  it('keeps the outage visible when the selected page is on a different Home', async () => {
    const { screen, controller } = await renderFailing(
      { kind: 'project', projectSourceId: 'source-shop' }, 'home_unreachable', 'other-home');
    try {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('services-column:error'), node => node !== null);
    } finally {
      controller.retire();
      await screen.unmount();
    }
  });
});

describe('readServicesColumnSelection', () => {
  it('reads the Services page, a Project’s Deployments page and an Environment from the route', () => {
    expect(readServicesColumnSelection('/projects/deployments', null)).toEqual({
      kind: 'all',
    });
    expect(
      readServicesColumnSelection('/deployments/source%2Fa', null),
    ).toEqual({ kind: 'project', projectSourceId: 'source/a' });
    expect(
      readServicesColumnSelection('/deployments/source-a', 'env-1'),
    ).toEqual({
      kind: 'environment',
      projectSourceId: 'source-a',
      environmentId: 'env-1',
    });
    expect(readServicesColumnSelection('/projects/ws-1', null)).toBeNull();
  });
});

describe('Services column draws the one Environment row (UI refinements 2026-11-15 08:57Z)', () => {
  it('ends a failed Environment with the shared Status mark, lets it open onto what it runs, and says the trouble once on its folded Project', async () => {
    const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const failed = {
      ...environment('env-shop-staging', 'source-shop', 'Staging', 'storefront'),
      currentDeployment: createDeploymentReceiptHeaderV1({ id: 'receipt-1', environmentId: 'env-shop-staging', state: 'failed' }),
    };
    const items = [failed, environment('env-shop-production', 'source-shop', 'Production', 'storefront', false)];
    const folded = controllerFor(items);
    const { screen: closed } = await render(folded, { kind: 'all' }, vi.fn(), 'services-column:project:source-shop');
    const projectEnd = closed.root.findAll((node) => node.props.presentation === 'inline'
      && String(node.props.testID ?? '').startsWith('services-column:project:source-shop'))[0];
    expect(projectEnd?.props.tone).toBe('danger');
    folded.retire();

    const opened = controllerFor(items);
    const { screen } = await render(opened, { kind: 'environment', projectSourceId: 'source-shop', environmentId: 'env-shop-staging' },
      vi.fn(), 'services-column:project:source-shop');
    const end = screen.root.findAll((node) => node.props.testID === 'services-column:environment:env-shop-staging:end'
      && node.props.presentation === 'inline')[0]!;
    expect(end.props).toMatchObject({ tone: 'danger', presentation: 'inline' });
    // A deployed Environment discloses what it runs (level 3, lab sideSvc); one never deployed has nothing beneath, and
    // stays listed while its Project has something deployed (E1 ruling 16:29Z).
    const row = (id: string) => screen.root.findAll((node) => node.props.testID === `services-column:environment:${id}`
      && 'disclosure' in node.props)[0]!;
    expect(row('env-shop-staging').props.disclosure).toMatchObject({ expanded: false });
    expect(row('env-shop-production').props.disclosure).toBeNull();
    opened.retire();
  });
});

describe('Services column Pinned (lab sideSvc "Pinned"; owner 2026-11-15 13:34Z)', () => {
  it('lists pinned Environments at the top under Pinned, named by their Project with the Environment beside it, and only when there are pins', async () => {
    const pinned = controllerFor(ITEMS);
    const { screen } = await render(pinned, { kind: 'all' }, vi.fn(), 'services-column:pinned:env-shop-staging',
      { pinnedEnvironmentIds: ['env-shop-staging', 'env-missing'] });
    const row = screen.root.findAll((node) => node.props.testID === 'services-column:pinned:env-shop-staging' && 'row' in node.props)[0]!;
    expect(row.props.row).toMatchObject({ kind: 'environment', title: 'storefront', titleQualifier: 'Staging' });
    // Above the Projects, right under All services; a pin this read does not hold draws nothing.
    const ids = rowIds(screen);
    expect(screen.findByTestId('services-column:pinned:env-missing')).toBeNull();
    const order = screen.root.findAll((node) => typeof node.props.testID === 'string'
      && /^services-column:(all|pinned:[^:]+|project:source-shop)$/.test(node.props.testID)).map((node) => node.props.testID as string);
    expect([...new Set(order)]).toEqual(['services-column:all', 'services-column:pinned:env-shop-staging', 'services-column:project:source-shop']);
    expect(ids).toContain('services-column:all');
    pinned.retire();
    const none = controllerFor(ITEMS);
    const { screen: unpinned } = await render(none, { kind: 'all' }, vi.fn(), 'services-column:project:source-shop');
    expect(unpinned.root.findAll((node) => String(node.props.testID ?? '').startsWith('services-column:pinned')).length).toBe(0);
    none.retire();
  });

  it('pins and unpins an Environment from its row menu, pinned or in the tree', async () => {
    const onTogglePinned = vi.fn();
    const controller = controllerFor(ITEMS);
    const { screen } = await render(controller, { kind: 'all' }, vi.fn(), 'services-column:pinned:env-api',
      { pinnedEnvironmentIds: ['env-api'], onTogglePinned });
    const menuOf = (testID: string) => screen.root.findAll((node) => node.props.testID === `${testID}:menu`
      && typeof node.props.onSelectPin === 'function')[0]!;
    // The pinned row unpins; an unpinned tree Environment pins.
    expect(menuOf('services-column:pinned:env-api').props.pinned).toBe(true);
    await act(async () => { menuOf('services-column:pinned:env-api').props.onSelectPin(); });
    expect(onTogglePinned).toHaveBeenLastCalledWith('env-api', false);
    controller.retire();
  });
});

describe('Services column lists what runs (OWNER-UI-1115B E1)', () => {
  it('leaves out Projects whose Environments were never deployed, keeping the one the route has open', async () => {
    const items = [
      environment('env-shop-staging', 'source-shop', 'Staging', 'storefront'),
      environment('env-shop-draft', 'source-shop', 'Draft', 'storefront', false),
      environment('env-idle', 'source-idle', 'idle-app', 'idle-app', false),
      environment('env-draft', 'source-draft', 'draft-app', 'draft-app', false),
    ];
    const controller = controllerFor(items);
    const { screen } = await render(controller, { kind: 'environment', projectSourceId: 'source-draft', environmentId: 'env-draft' },
      vi.fn(), 'services-column:project:source-shop');
    const ids = rowIds(screen);
    expect(ids).toContain('services-column:project:source-shop');
    expect(ids).toContain('services-column:environment:env-draft');
    expect(ids.some((id) => id.includes('env-idle') || id.includes('source-idle'))).toBe(false);
    controller.retire();
  });
});

describe('Services column grouping (owner 2026-11-16 10:20Z: All · By project · By type)', () => {
  const switchOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
    .findAll((node) => node.props.testIDPrefix === 'services-column:grouping' && Array.isArray(node.props.tabs))[0]!;

  it('offers the three groupings through the shared segmented control and reports the choice', async () => {
    const onGroupingChange = vi.fn();
    const controller = controllerFor(ITEMS);
    const { screen } = await render(controller, { kind: 'all' }, vi.fn(), 'services-column:project:source-shop', { onGroupingChange });
    const control = switchOf(screen);
    expect(control.props.tabs.map((tab: { id: string }) => tab.id)).toEqual(['all', 'project', 'type']);
    expect(control.props.activeTabId).toBe('project');
    await act(async () => { control.props.onSelectTab('type'); });
    expect(onGroupingChange).toHaveBeenCalledWith('type');
    controller.retire();
  });

  it('All lists every Environment as one flat run of rows, each named by its Project, with no Project rows', async () => {
    const controller = controllerFor(ITEMS);
    const { screen } = await render(controller, { kind: 'all' }, vi.fn(), 'services-column:environment:env-shop-staging', { grouping: 'all' });
    const ids = rowIds(screen);
    expect(ids.filter((id) => id.startsWith('services-column:project:'))).toEqual([]);
    for (const id of ['env-shop-staging', 'env-shop-production', 'env-api', 'env-gone']) expect(ids).toContain(`services-column:environment:${id}`);
    const staging = screen.root.findAll((node) => node.props.testID === 'services-column:environment:env-shop-staging' && 'row' in node.props)[0]!;
    expect(staging.props.row).toMatchObject({ title: 'storefront', titleQualifier: 'Staging' });
    controller.retire();
  });

  // SERVICES-ACCEPT-1116 F6: "SWEEP-A1 DJ28 build oracle" + "SWEEP-A1 DJ28 repository oracle" each took half the row and
  // both halves cut to the same words, so five rows read alike. An Environment named after its Project says its
  // Project already: its own name takes the whole row.
  it('All names an Environment that carries its Project\'s name by its own name alone, so like-named rows stay apart', async () => {
    const controller = controllerFor([
      environment('env-oracle', 'source-oracle', 'SWEEP-A1 DJ28 repository oracle', 'SWEEP-A1 DJ28 build oracle'),
      environment('env-preview', 'source-starter', 'sweep-a1-preview-push-a-1113', 'sweep-a1-1113-starter'),
      ...ITEMS,
    ]);
    const { screen } = await render(controller, { kind: 'all' }, vi.fn(), 'services-column:environment:env-oracle', { grouping: 'all' });
    const rowOf = (id: string) => screen.root.findAll((node) => node.props.testID === `services-column:environment:${id}` && 'row' in node.props)[0]!;
    expect(rowOf('env-oracle').props.row).toMatchObject({ title: 'SWEEP-A1 DJ28 repository oracle', titleQualifier: null });
    expect(rowOf('env-preview').props.row).toMatchObject({ title: 'sweep-a1-preview-push-a-1113', titleQualifier: null });
    // A stage name still reads with its Project (lab "billing-api  Production").
    expect(rowOf('env-shop-staging').props.row).toMatchObject({ title: 'storefront', titleQualifier: 'Staging' });
    controller.retire();
  });

  it('By type draws Apps and each type that has items as its own section, every row through the one Environment row', async () => {
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
    const shop = createDeploymentEnvironmentHeaderV1({ id: 'env-shop-staging', projectSourceId: 'source-shop' });
    const detail = createDeploymentEnvironmentDetailV1();
    const controller = controllerFor(ITEMS, null, {
      listDataServicePage: async () => ({ ok: true, value: { nextCursor: null, items: [{ environment: shop, title: 'Staging',
        content: { ...detail.content, template: { ...detail.content.template!, data: [{ service: 'shop-db', engine: 'postgres' as const }] } },
        databaseSizes: [{ service: 'shop-db', size: { status: 'unavailable', reason: 'unsupported_engine' },
          growth: { status: 'unavailable', reason: 'unsupported_engine' } }] }] } }),
      listDomainPage: async () => ({ ok: true, value: { nextCursor: null, items: [] } }),
    } as never);
    const { screen } = await render(controller, { kind: 'all' }, vi.fn(), 'services-column:database:env-shop-staging/shop-db', { grouping: 'type' });
    const text = screen.getTextContent();
    expect(text).toContain('Apps');
    expect(text).toContain('Databases');
    // A type with no items draws no section.
    expect(text).not.toContain('Domains');
    expect(rowIds(screen)).toContain('services-column:project:source-shop');
    const database = screen.root.findAll((node) => node.props.testID === 'services-column:database:env-shop-staging/shop-db' && 'row' in node.props)[0]!;
    expect(database.props.row).toMatchObject({ kind: 'database', title: 'shop-db', fact: 'PostgreSQL' });
    controller.retire();
  });
});

describe('Services column saved view (owner D5: one Services header, the column places it)', () => {
  it('narrows its tree and Pinned to the Environments the saved view keeps, counts what it keeps, and places the view controls in its header', async () => {
    const controller = controllerFor(ITEMS);
    const kept = new Set(['env-shop-staging', 'env-api']);
    const space = {
      isVisible: (environmentId: string) => kept.has(environmentId),
      narrowing: true,
      matchedCount: kept.size,
      titleControl: <View testID="space:title" />,
      filterButton: <View testID="space:filter" />,
      band: <View testID="space:strip" />,
      conditions: <View testID="space:conditions" />,
    };
    const { screen } = await render(controller, { kind: 'all' }, vi.fn(), 'services-column:project:source-shop',
      { space, pinnedEnvironmentIds: ['env-shop-production', 'env-api'] });
    expect(rowIds(screen)).toEqual([
      'services-column:all',
      'services-column:project:source-shop',
      'services-column:environment:env-api',
    ]);
    // A pin the view leaves out is not drawn under Pinned either.
    expect(screen.findByTestId('services-column:pinned:env-shop-production')).toBeNull();
    expect(screen.findByTestId('services-column:pinned:env-api')).not.toBeNull();
    const list = screen.root.findAll((node) => node.props.testID === 'services-column:list' && 'title' in node.props)[0]!;
    expect(list.props.count).toBe(2);
    for (const id of ['space:title', 'space:strip', 'space:conditions']) expect(screen.findByTestId(id)).not.toBeNull();
    // The funnel ends the column's search field (behind the magnifier, as the Sessions and Discussions columns).
    expect(list.props.search?.trailing).toBe(space.filterButton);
    controller.retire();
  });
});
