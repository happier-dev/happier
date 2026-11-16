import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
afterEach(standardCleanup);

const { ServicesColumnView, readServicesColumnSelection } =
  await import('./ServicesColumn');
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
  };
  return createDeploymentReadControllerV1({
    scope: { serverId: 'home', accountId: 'account-owner' },
    transport,
  });
}

function Column(
  props: Readonly<{
    controller: DeploymentReadControllerV1;
    selection: Selection;
    onNavigate: (href: string) => void;
    pinnedEnvironmentIds?: readonly string[];
    onTogglePinned?: (environmentId: string, pinned: boolean) => void;
  }>,
) {
  const read = useDeploymentCollection(props.controller, shown);
  return (
    <ServicesColumnView
      read={read}
      serverId="home"
      lifetime={null}
      selection={props.selection}
      onNavigate={props.onNavigate}
      create={null}
      pinnedEnvironmentIds={props.pinnedEnvironmentIds ?? []}
      onTogglePinned={props.onTogglePinned ?? (() => {})}
    />
  );
}

async function render(
  controller: DeploymentReadControllerV1,
  selection: Selection,
  onNavigate = vi.fn(),
  /** The row whose arrival says the column's read has landed. */
  ready = 'services-column:project:unnamed',
  pins: Readonly<{ pinnedEnvironmentIds?: readonly string[]; onTogglePinned?: (environmentId: string, pinned: boolean) => void }> = {},
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

  it('opens the Project the open Environment belongs to, selects that Environment, and navigates rows to the one Environment route', async () => {
    const controller = controllerFor(ITEMS);
    const { screen, onNavigate } = await render(controller, {
      kind: 'environment',
      projectSourceId: 'source-shop',
      environmentId: 'env-shop-production',
    });
    expect(rowIds(screen)).toEqual([
      'services-column:all',
      'services-column:project:source-shop',
      'services-column:environment:env-shop-staging',
      'services-column:environment:env-shop-production',
      'services-column:environment:env-api',
      'services-column:project:unnamed',
    ]);
    expect(
      selectedOf(screen, 'services-column:environment:env-shop-production'),
    ).toBe(true);
    await screen.pressByTestIdAsync(
      'services-column:environment:env-shop-staging',
    );
    expect(onNavigate).toHaveBeenCalledWith(
      '/deployments/source-shop?serverId=home&deploymentEnvironment=env-shop-staging',
    );
    await screen.pressByTestIdAsync('services-column:project:source-shop');
    expect(onNavigate).toHaveBeenLastCalledWith(
      '/deployments/source-shop?serverId=home',
    );
    controller.retire();
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
  function failing() {
    const unavailable = async () => ({ ok: false as const, failure: { code: 'deployment_unavailable', retryable: true } });
    return createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner' },
      transport: { listEnvironments: unavailable, readEnvironment: unavailable, listHistory: unavailable, readReceipt: unavailable } });
  }
  async function renderFailing(selection: Selection) {
    const controller = failing();
    const screen = await renderScreen(<Column controller={controller} selection={selection} onNavigate={vi.fn()} />);
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
