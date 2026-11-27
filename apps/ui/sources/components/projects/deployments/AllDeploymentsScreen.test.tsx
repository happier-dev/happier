import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadControllerV1,
  type DeploymentAccountDomainReadItemV1,
  type DeploymentReadTransportV1,
  type DeploymentReadResultV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import {
  act,
  createDeferred,
  renderScreen as renderScreenWithoutAuth,
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
// The window is the platform boundary: a phone-width window, as the device-type owner reads it.
const phoneWindow = vi.hoisted(() => ({ on: false }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...original, useDeviceType: () => (phoneWindow.on ? 'phone' : original.useDeviceType()) };
});
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
afterEach(() => {
  routerMock.spies.push.mockClear();
  phoneWindow.on = false;
});
afterEach(standardCleanup);

const { AllDeploymentsView } = await import('./AllDeploymentsScreen');
const { useDeploymentCollection } = await import('./useDeploymentReads');
const { AuthProvider } = await import('@/auth/context/AuthContext');

function renderScreen(body: React.ReactNode) {
  return renderScreenWithoutAuth(<AuthProvider initialCredentials={null}>{body}</AuthProvider>);
}

const shown = { mounted: true, visible: true, focused: true };
type ListResult = DeploymentReadResultV1<DeploymentEnvironmentCollectionV1>;

function environment(id: string, projectSourceId: string, title: string,
  labels: Readonly<{ projectSourceName?: string | null; liveVersionTitle?: string | null }> = {}) {
  return {
    environment: createDeploymentEnvironmentHeaderV1({ id, projectSourceId }),
    title,
    currentDeployment: null,
    ...labels,
  };
}
const page = (
  items: DeploymentEnvironmentCollectionV1['items'],
  extra: Partial<{
    nextCursor: string | null;
    coverage: 'complete' | 'partial';
  }> = {},
): ListResult => ({
  ok: true,
  value: {
    items,
    nextCursor: extra.nextCursor ?? null,
    ...(extra.coverage ? { coverage: extra.coverage } : {}),
  },
});

/** The network boundary only: the Account-wide controller, its paging and the page composition run for real. */
function controllerFor(list: (cursor: string | undefined) => ListResult, extra: Partial<DeploymentReadTransportV1> = {}) {
  const calls: (string | undefined)[] = [];
  const transport: DeploymentReadTransportV1 = {
    listEnvironments: async (_scope, query) => {
      calls.push(query?.cursor);
      return list(query?.cursor);
    },
    readEnvironment: async () => ({
      ok: false,
      failure: { code: 'deployment_unavailable', retryable: true },
    }),
    listHistory: async () => ({
      ok: false,
      failure: { code: 'deployment_unavailable', retryable: true },
    }),
    readReceipt: async () => ({
      ok: false,
      failure: { code: 'deployment_unavailable', retryable: true },
    }),
    ...extra,
  };
  const controller = createDeploymentReadControllerV1({
    scope: { serverId: 'home', accountId: 'account-owner' },
    transport,
  });
  return { controller, calls };
}

function Page(props: Readonly<{ controller: DeploymentReadControllerV1; view?: 'apps' | 'databases' | 'domains' }>) {
  const read = useDeploymentCollection(props.controller, shown);
  return <AllDeploymentsView read={read} serverId="home" controller={props.controller} demand={shown} view={props.view} />;
}

async function render(controller: DeploymentReadControllerV1, ready: string) {
  const screen = await renderScreen(<Page controller={controller} />);
  await act(async () => {
    await waitForTestEvent(
      screen.subscribe,
      () => screen.findByTestId(ready),
      (node) => node !== null,
    );
  });
  return screen;
}

describe('Projects → All deployments', () => {
  // SERVICES-ACCEPT-1116 F7: the phone title flipped "All services ⌄" (Apps) ↔ "Services" and moved the views 2 px. The
  // page is Services on every view (lab svcHead); Apps carries its saved view under the views, as the Workflows home does.
  it('keeps one title, Services, on every view and carries the Apps saved view under the views', async () => {
    const { t } = await import('@/text');
    const { controller } = controllerFor(() => page([environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' })]));
    try {
      for (const view of ['apps', 'domains'] as const) {
        const screen = await renderScreen(<Page controller={controller} view={view} />);
        await act(async () => {
          await waitForTestEvent(screen.subscribe, () => screen.findByTestId('services.views'), (node) => node !== null);
        });
        const head = screen.root.findAll((node) => node.props.testID === 'all-deployments.header' && 'search' in node.props)[0]!;
        expect(head.props.title).toBe(t('projects.deployments.services.title'));
        expect(head.props.titleControl).toBeUndefined();
        expect(screen.findByTestId('services-page-space-title') !== null).toBe(view === 'apps');
        await screen.unmount();
      }
    } finally { controller.retire(); }
  });

  it('keeps other Services views reachable while Apps is loading', async () => {
    const held = createDeferred<ListResult>();
    const { controller } = controllerFor(() => page([]), { listEnvironments: () => held.promise });
    try {
      const screen = await render(controller, 'all-deployments.loading');
      expect(screen.findByTestId('services.views')).not.toBeNull();
    } finally { controller.retire(); held.resolve(page([])); }
  });

  it('shows the same stopped service and Environment health in Services and its Project rail', async () => {
    const { projectDeploymentHealthFactsV1 } = await import('@happier-dev/deployments');
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
    const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const { DeploymentEnvironmentCollection } = await import('./DeploymentEnvironmentCollection');
    const { ServicesColumnView } = await import('./ServicesColumn');
    const base = createDeploymentEnvironmentDetailV1();
    const environment = { ...base.environment, serverId: 'home' };
    const targetLink = base.targetLinks[0]!.targetLink;
    const member = targetLink.members[0]!;
    const { aggregate, leadingCause } = projectDeploymentHealthFactsV1({
      environment, targetLink, observations: [{
        environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
        machineId: member.machineId, installationId: member.installationId, role: 'runtime',
        source: { kind: 'native' }, observedAtMs: 1, services: [{ serviceId: 'web', name: 'web',
          observation: { status: 'down', observedAtMs: 1, expectedDown: 'stop' } }],
      }], savedChecks: [{ environmentId: environment.id, sourceInstanceId: 'check-source', automationId: 'check-automation',
        triggerId: 'check-trigger', checkId: 'check-http', name: 'HTTP · another port', status: 'down' }],
    });
    const row = { environment, title: 'Staging', projectSourceName: 'Storefront', runtimeTargetLink: targetLink,
      currentDeployment: createDeploymentReceiptHeaderV1({ environmentId: environment.id, state: 'succeeded' }) };
    const sibling = { environment: { ...environment, id: 'other-environment' }, title: 'Production' };
    const deliverHealth = (publish: (id: string, value: typeof aggregate, cause: typeof leadingCause) => void) =>
      publish(environment.id, aggregate, leadingCause);
    const { controller, calls } = controllerFor(() => page([row, sibling]), {
      observeEnvironmentCollectionHealth: (_scope, _items, publish) => {
        deliverHealth(publish);
        return () => {};
      },
    });
    function AppAndRail() {
      const read = useDeploymentCollection(controller, shown);
      return <>
        <AllDeploymentsView read={read} serverId="home" controller={controller} demand={shown} />
        <DeploymentEnvironmentCollection items={read.snapshot.value?.items ?? null} selectedId={environment.id}
          stale={null} drafting={false} onAdd={null} onSelect={() => {}} />
        <ServicesColumnView read={read} serverId="home" lifetime={null}
          selection={{ kind: 'project', projectSourceId: environment.projectSourceId }} controller={controller}
          create={null} pinnedEnvironmentIds={[]} onTogglePinned={() => {}} onNavigate={() => {}}
          grouping="all" onGroupingChange={() => {}} />
      </>;
    }
    const appsRow = `all-deployments.row.${environment.id}`;
    const railRow = `project-deployments.rail.row.${environment.id}`;
    const textOf = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
      screen.findByTestId(id)!.findAll(() => true).map(node => node.props.children)
        .filter((child): child is string => typeof child === 'string').join(' ');
    const screen = await renderScreen(<AppAndRail />);
    try {
      await act(async () => {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId(appsRow), node => node !== null);
      });
      const sidebarRow = `services-column:environment:${environment.id}`;
      for (const id of [appsRow, railRow]) {
        expect(textOf(screen, id), id).toContain('Degraded');
      }
      // The column places the status outside the row's press target beside the menu.
      expect(textOf(screen, `${sidebarRow}:end`)).toContain('Degraded');
      for (const id of [appsRow, railRow, sidebarRow]) {
        expect(textOf(screen, id), id).toContain('web stopped');
        expect(textOf(screen, id), id).not.toContain('HTTP · another port');
      }
      expect(textOf(screen, 'project-deployments.rail.row.other-environment')).not.toContain('web stopped');
      expect(calls).toEqual([undefined]);
    } finally {
      controller.retire();
    }
  });

  it('groups one page under each Project’s admitted name, keeps unavailable names in one last group, and opens a row on its Project’s page', async () => {
    const { controller } = controllerFor(() =>
      page([
        environment('env-shop-staging', 'source-shop', 'Staging', { projectSourceName: 'storefront', liveVersionTitle: 'feat(cart): keep the cart after sign-in' }),
        environment('env-hidden-name', 'source-gone', 'Demo', { projectSourceName: null }),
        environment('env-api-production', 'source-api', 'Production API', { projectSourceName: 'payments-api' }),
        environment('env-shop-production', 'source-shop', 'Production', { projectSourceName: 'storefront' }),
      ]),
    );
    const screen = await render(controller, 'all-deployments');
    // The bands (membership, order, the unnamed last) are deploymentEnvironmentBands' and its own test; the page
    // draws every row of the page.
    const text = screen.getTextContent();
    for (const id of ['env-shop-staging', 'env-hidden-name', 'env-api-production', 'env-shop-production']) {
      expect(screen.findByTestId(`all-deployments.row.${id}`)).not.toBeNull();
    }
    expect(text).toContain('feat(cart): keep the cart after sign-in');
    await screen.pressByTestIdAsync('all-deployments.row.env-api-production');
    expect(routerMock.spies.push).toHaveBeenCalledWith({
      pathname: '/deployments/[projectSourceId]',
      params: { projectSourceId: 'source-api', serverId: 'home', deploymentEnvironment: 'env-api-production' },
    });
    controller.retire();
  });

  it('offers a row\'s ⋯ menu that opens that Environment\'s Variables (lab Reach "Apps row ⋯ → Variables")', async () => {
    const { controller } = controllerFor(() =>
      page([environment('env-api-production', 'source-api', 'Production API', { projectSourceName: 'payments-api' })]));
    const screen = await render(controller, 'all-deployments.row.env-api-production');
    const { ContextMenu } = await import('@happier-dev/plugin-ui');
    const row = screen.findAll((node) => node.props.testID === 'all-deployments.row.env-api-production'
      && Array.isArray(node.props.secondaryActions))[0];
    expect(row).toBeDefined();
    routerMock.spies.push.mockClear();
    await act(async () => { row!.findByType(ContextMenu).props.onSelect('variables'); });
    expect(routerMock.spies.push).toHaveBeenCalledWith({
      pathname: '/deployments/[projectSourceId]',
      params: { projectSourceId: 'source-api', serverId: 'home', deploymentEnvironment: 'env-api-production', deploymentTab: 'variables' },
    });
    controller.retire();
  });

  it('says on line 2 the commit subject of the latest deploy and who asked for it (lab envRow)', async () => {
    const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const shipped = { ...environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' }),
      currentDeployment: { ...createDeploymentReceiptHeaderV1({ id: 'receipt-1', environmentId: 'env-shop', state: 'succeeded' }),
        title: 'Deploy main', commitSubject: 'fix(invoices): round VAT per line' } };
    const { controller } = controllerFor(() => page([shipped]));
    const screen = await render(controller, 'all-deployments.row.env-shop');
    const text = screen.findByTestId('all-deployments.row.env-shop')!.findAll(() => true)
      .map((node) => node.props.children).filter((child): child is string => typeof child === 'string').join(' ');
    expect(text).toContain('fix(invoices): round VAT per line');
    expect(text).not.toContain('Deploy main');
    controller.retire();
  });

  it('says its count is at least this page\'s when more pages continue (the read reports no Account total)', async () => {
    const { controller } = controllerFor((cursor) => cursor
      ? page([environment('env-later', 'source-later', 'Later', { projectSourceName: 'later' })])
      : page([environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' })], { nextCursor: 'env-later' }));
    const screen = await render(controller, 'all-deployments');
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findHostByTestId('all-deployments.header:count'), (node) => node !== null);
    });
    expect(screen.getTextContent()).toContain('1+ environments in 1+ projects');
    controller.retire();
  });

  it('shares one cold Apps read with the column and requests the total on the visible continuation', async () => {
    const calls: { cursor: string | undefined; counted: boolean }[] = [];
    const first = page([environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' })], { nextCursor: 'env-later' });
    const later = page([environment('env-later', 'source-later', 'Later', { projectSourceName: 'later' })], { nextCursor: 'env-oldest' });
    const oldest = page([environment('env-oldest', 'source-oldest', 'Oldest')]);
    const { controller } = controllerFor(() => first, {
      listEnvironments: async (_scope, query) => {
        calls.push({ cursor: query?.cursor, counted: query?.includeTotal === true });
        const result = query?.cursor === 'env-later' ? later : query?.cursor === 'env-oldest' ? oldest : first;
        return query?.includeTotal && result.ok ? { ...result, value: { ...result.value, totalCount: 2417 } } : result;
      },
    });
    function ColumnBorrower() {
      useDeploymentCollection(controller, shown);
      return null;
    }
    const screen = await renderScreen(<><ColumnBorrower /><Page controller={controller} /></>);
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('all-deployments.row.env-shop'), (node) => node !== null);
    });
    expect(calls).toEqual([{ cursor: undefined, counted: false }]);
    expect(screen.getTextContent()).toContain('1+ environments in 1+ projects');
    await screen.pressByTestIdAsync('all-deployments.paging.older');
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('all-deployments.row.env-later'), (node) => node !== null);
    });
    expect(screen.getTextContent()).toContain('2417');
    expect(calls).toEqual([
      { cursor: undefined, counted: false },
      { cursor: 'env-later', counted: true },
    ]);
    await act(async () => { await controller.refreshDemanded(); });
    expect(calls.filter((call) => call.counted)).toEqual([{ cursor: 'env-later', counted: true }]);
    expect(screen.getTextContent()).toContain('1+ environments in 1+ projects');
    await screen.pressByTestIdAsync('all-deployments.paging.older');
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('all-deployments.row.env-oldest'), (node) => node !== null);
    });
    expect(calls.at(-1)).toEqual({ cursor: 'env-oldest', counted: false });
    expect(calls.filter((call) => call.counted)).toHaveLength(1);
    controller.retire();
  });

  it('counts the search results instead of the unfiltered Account, and restores the total when cleared', async () => {
    const { t } = await import('@/text');
    const items = [environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' }),
      environment('env-api', 'source-api', 'API', { projectSourceName: 'payments' })];
    const { controller } = controllerFor(() => page(items, { nextCursor: 'later' }), {
      listEnvironments: async (_scope, query) => ({ ok: true, value: {
        items, nextCursor: query?.cursor ? null : 'later', ...(query?.includeTotal ? { totalCount: 2417 } : {}),
      } }),
    });
    try {
      const screen = await render(controller, 'all-deployments');
      await screen.pressByTestIdAsync('all-deployments.paging.older');
      await act(async () => {
        await waitForTestEvent(screen.subscribe, () => screen.getTextContent().includes('2417'), (found) => found);
      });
      const head = () => screen.root.findAll((node) => node.props.testID === 'all-deployments.header' && 'search' in node.props)[0]!;
      await act(async () => { head().props.search.onChangeText('payments'); });
      expect(screen.findByTestId('all-deployments.row.env-shop')).toBeNull();
      expect(screen.findByTestId('all-deployments.row.env-api')).not.toBeNull();
      expect(head().props.count).toContain(t('projects.deployments.services.countEnvironmentsAtLeast', { environments: 1, projects: 1 }));
      expect(head().props.count).not.toContain(t('projects.deployments.services.countEnvironmentsTotal', { count: 2417 }));
      await act(async () => { head().props.search.onChangeText(''); });
      expect(head().props.count).toContain(t('projects.deployments.services.countEnvironmentsTotal', { count: 2417 }));
    } finally { controller.retire(); }
  });

  it('keeps a page that hides every row it read leading on, instead of calling the Account empty', async () => {
    const { controller, calls } = controllerFor((cursor) =>
      cursor
        ? page([environment('env-shop-staging', 'source-shop', 'Staging')])
        : page([], { nextCursor: 'env-hidden', coverage: 'partial' }),
    );
    const screen = await render(controller, 'all-deployments.pageEmpty');
    expect(screen.findByTestId('all-deployments.empty')).toBeNull();
    await screen.pressByTestIdAsync('all-deployments.paging.older');
    await act(async () => {
      await waitForTestEvent(
        screen.subscribe,
        () => screen.findByTestId('all-deployments.row.env-shop-staging'),
        (node) => node !== null,
      );
    });
    expect(calls).toEqual([undefined, 'env-hidden']);
    controller.retire();
  });

  it('says an empty Account is empty only when no page continues', async () => {
    const { controller } = controllerFor(() => page([]));
    const screen = await render(controller, 'all-deployments.empty');
    expect(screen.findByTestId('all-deployments.paging.older')).toBeNull();
    expect(screen.findByTestId('services.views')).not.toBeNull();
    controller.retire();
  });

  it('leads an empty Account into Deploy an app, the one flow every entry opens (lab svcEmpty → f1src)', async () => {
    phoneWindow.on = true;
    const { controller } = controllerFor(() => page([]));
    const screen = await render(controller, 'all-deployments.empty');
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show');
    routerMock.spies.push.mockClear();
    try {
      await screen.pressByTestIdAsync('all-deployments.empty.deployApp');
      // One flow everywhere (lab f1src / f1srcp): a dialog over the page, a sheet over it on a phone; no page push.
      expect(show).toHaveBeenCalledWith(expect.objectContaining({
        chrome: expect.objectContaining({ testID: 'newApp.dialog', phonePresentation: 'sheet' }),
      }));
      expect(routerMock.spies.push).not.toHaveBeenCalled();
    } finally { show.mockRestore(); }
    controller.retire();
  });

  it('tells withdrawn access, which Retry cannot change, from a Home that is not answering', async () => {
    const denied = controllerFor(() => ({
      ok: false,
      failure: { code: 'access_denied', retryable: false },
    }));
    const deniedScreen = await render(
      denied.controller,
      'all-deployments.denied',
    );
    expect(deniedScreen.getTextContent()).not.toContain('Retry');
    denied.controller.retire();
    standardCleanup();

    let answering = false;
    const offline = controllerFor(() =>
      answering
        ? page([environment('env-shop-staging', 'source-shop', 'Staging')])
        : { ok: false, failure: { code: 'home_unreachable', retryable: true } },
    );
    const screen = await render(offline.controller, 'all-deployments.error');
    answering = true;
    await screen.pressByTestIdAsync('all-deployments.retry');
    await act(async () => {
      await waitForTestEvent(
        screen.subscribe,
        () => screen.findByTestId('all-deployments.row.env-shop-staging'),
        (node) => node !== null,
      );
    });
    offline.controller.retire();
  });

  it('bands a one-Environment Project like any other and never repeats its name as what is live (R2-D9)', async () => {
    const { controller } = controllerFor(() =>
      page([
        environment('env-maria', 'source-maria', 'maria-db', { projectSourceName: 'maria-db', liveVersionTitle: 'maria-db' }),
        environment('env-pgb', 'source-pgb', 'pgbouncer', { projectSourceName: 'pgbouncer' }),
        environment('env-shop-staging', 'source-shop', 'Staging', { projectSourceName: 'storefront' }),
        environment('env-redis', 'source-redis', 'redis-cache', { projectSourceName: 'redis-cache' }),
      ]),
    );
    const screen = await render(controller, 'all-deployments');
    // A band title may be drawn in more than one text run (it middle-ellipsizes), so compare without spaces.
    const text = screen.getTextContent().replace(/\s/g, '');
    // One band rule (UI refinements 2026-11-18): every Project of a several-Project list has its band, so the band and
    // the Environment row say the name, and what is live never says it a third time.
    expect(text.split('maria-db').length - 1).toBe(2);
    expect(text.split('pgbouncer').length - 1).toBe(2);
    expect(text.indexOf('maria-db')).toBeLessThan(text.indexOf('pgbouncer'));
    controller.retire();
  });

  it('says which version is live beside when it was deployed (lab envRow "ver · age", owner D4)', async () => {
    const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const { deploymentRevisionLabelV1 } = await import('@happier-dev/deployments');
    const source = { kind: 'repository' as const, sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' };
    const deployed = {
      environment: createDeploymentEnvironmentHeaderV1({ id: 'env-shop', projectSourceId: 'source-shop' }),
      title: 'Production', projectSourceName: 'storefront',
      currentDeployment: { ...createDeploymentReceiptHeaderV1({ id: 'receipt-1', environmentId: 'env-shop', state: 'succeeded' }), source },
    };
    const { controller } = controllerFor(() => page([deployed]));
    const screen = await render(controller, 'all-deployments.row.env-shop:column:lastDeploy');
    const cell = screen.findByTestId('all-deployments.row.env-shop:column:lastDeploy')!.findAll(() => true)
      .map((node) => node.props.children).filter((child): child is string => typeof child === 'string').join(' ');
    expect(cell).toContain(deploymentRevisionLabelV1(source));
    controller.retire();
  });

  it('says Last deploy from the latest deploy itself, never from the Environment\'s own updates (QA-WAVE-1115)', async () => {
    const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;
    const neverDeployed = {
      environment: createDeploymentEnvironmentHeaderV1({ id: 'env-new', projectSourceId: 'source-new', updatedAtMs: twoDaysAgo }),
      title: 'QA local fixture', projectSourceName: 'qa', currentDeployment: null,
    };
    const deployed = {
      environment: createDeploymentEnvironmentHeaderV1({ id: 'env-shop', projectSourceId: 'source-shop', updatedAtMs: twoDaysAgo }),
      title: 'Production', projectSourceName: 'storefront',
      currentDeployment: createDeploymentReceiptHeaderV1({ id: 'receipt-1', environmentId: 'env-shop', state: 'succeeded',
        requestedAtMs: threeHoursAgo - 60_000, startedAtMs: threeHoursAgo - 30_000, settledAtMs: threeHoursAgo }),
    };
    const { controller } = controllerFor(() => page([neverDeployed, deployed]));
    const screen = await render(controller, 'all-deployments.row.env-new:column:lastDeploy');
    const cell = (id: string) => screen.findByTestId(`all-deployments.row.${id}:column:lastDeploy`)!.findAll(() => true)
      .map((node) => node.props.children).filter((child): child is string => typeof child === 'string').join(' ');
    // Nothing was ever deployed: no age at all (the Environment's edits are not deploys).
    expect(cell('env-new')).not.toMatch(/\d/);
    // A deployed Environment says when its latest deploy settled, not when the Environment last changed.
    expect(cell('env-shop')).toMatch(/3/);
    expect(cell('env-shop')).not.toMatch(/2\s*d/);
    // State says the latest deploy's own word for every deployed row (a settled one quietly); never deployed has none.
    const { t } = await import('@/text');
    const state = (id: string) => screen.findByTestId(`all-deployments.row.${id}:column:state`)!.findAll(() => true)
      .map((node) => node.props.children).filter((child): child is string => typeof child === 'string').join(' ');
    expect(state('env-shop')).toContain(t('projects.deployments.stateSucceeded'));
    expect(state('env-new')).not.toContain(t('projects.deployments.stateSucceeded'));
    controller.retire();
  });

  it('renders a declared Services column before an Account is available to read its values', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui/declarationProjection');
    const { PluginManifestV2Schema } = await import('@happier-dev/protocol/plugins/manifest/v2');
    const { definePlugin } = await import('@happier-dev/plugin-sdk');
    const pluginId = 'com.acme.observability';
    const manifest = PluginManifestV2Schema.parse(definePlugin({ id: pluginId, version: '1.0.0',
      ui: { listExtensions: { traffic: { entity: 'service', filterFields: [{
        id: 'traffic', title: 'Traffic', source: { resource: 'traffic' },
        value: { kind: 'number', unit: '{request}' }, column: { title: 'Traffic', priority: 10 },
      }] } } },
    }).manifest);
    const projection = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest), undefined, {
      id: pluginId, displayName: 'Observability', version: '1.0.0', enabled: true,
      source: { kind: 'bundled', locator: pluginId } });
    const { controller } = controllerFor(() => page([environment('env-shop', 'source-shop', 'Production')]));
    try {
      const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: projection, accountLifetime: null, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: false, serverId: 'home', machineId: null, platform: 'web',
        clientExecutableActivation: { status: 'ready' }, reloadConnectedAccountProjection() {}, reloadClientExecutables() {},
      }}><Page controller={controller} /></AppShellPluginUiProjectionValueProvider>);
      await act(async () => {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId('all-deployments.row.env-shop'), node => node !== null);
      });
      expect(screen.findByTestId(`all-deployments.row.env-shop:column:${pluginId}/traffic`)).not.toBeNull();
    } finally {
      controller.retire();
    }
  });

  it('says a row’s status in one short line on a phone, leaving its Machine to the Environment', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { createDeploymentReceiptHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    // The active Home's Machine inventory, as discovery publishes it.
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', installationId: 'installation-a' })], true);
    const failed = {
      environment: createDeploymentEnvironmentHeaderV1({ id: 'env-failed', projectSourceId: 'source-shop', controllerMachineId: 'machine-a' }),
      title: 'Staging', projectSourceName: 'storefront',
      currentDeployment: createDeploymentReceiptHeaderV1({ id: 'receipt-failed', environmentId: 'env-failed', state: 'failed' }),
    };
    const wide = controllerFor(() => page([failed]));
    const wideScreen = await render(wide.controller, 'all-deployments.row.env-failed');
    const wideText = wideScreen.findByTestId('all-deployments.row.env-failed')!.findAll(() => true)
      .map(node => node.props.children).filter((child): child is string => typeof child === 'string').join(' ');
    // Wide rows say the status and the Machine in their own columns.
    expect(wideScreen.findByTestId('all-deployments.row.env-failed:column:state')).not.toBeNull();
    expect(wideScreen.findByTestId('all-deployments.row.env-failed:column:runsOn')).not.toBeNull();
    wide.controller.retire();
    standardCleanup();

    phoneWindow.on = true;
    const phone = controllerFor(() => page([failed]));
    const phoneScreen = await render(phone.controller, 'all-deployments.row.env-failed');
    const phoneText = phoneScreen.findByTestId('all-deployments.row.env-failed')!.findAll(() => true)
      .map(node => node.props.children).filter((child): child is string => typeof child === 'string').join(' ');
    // A phone row keeps the status (the fold of its columns at a measured narrow width is the Collection's own test).
    expect(phoneText).toContain('Failed');
    expect(wideText).toContain('Failed');
    phone.controller.retire();
  });

  it('keeps the last row clear of the phone floating tab bar', async () => {
    const { SessionCockpitChromeRegistryProvider, useSessionCockpitBottomChromeHeightSetter } =
      await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
    const floatingTabBarHeight = 83;
    function FloatingTabBar() {
      const setHeight = useSessionCockpitBottomChromeHeightSetter();
      React.useEffect(() => setHeight(floatingTabBarHeight), [setHeight]);
      return null;
    }
    const { controller } = controllerFor(() => page([environment('env-shop-staging', 'source-shop', 'Staging', { projectSourceName: 'storefront' })]));
    const screen = await renderScreen(
      <SessionCockpitChromeRegistryProvider>
        <FloatingTabBar />
        <Page controller={controller} />
      </SessionCockpitChromeRegistryProvider>,
    );
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('all-deployments.row.env-shop-staging'), (node) => node !== null);
    });
    const { StyleSheet } = await import('react-native');
    const scroller = screen.findAll((node) => node.props.contentContainerStyle !== undefined)[0]!;
    const { paddingBottom } = StyleSheet.flatten(scroller.props.contentContainerStyle) as { paddingBottom?: number };
    expect(paddingBottom).toBeGreaterThanOrEqual(floatingTabBarHeight);
    controller.retire();
  });
});

describe('Services (pfc-redesign svcApps · svcDb)', () => {
  it('settles a pending Databases read to unavailable and recovers to answered empty', async () => {
    type DataResult = Awaited<ReturnType<NonNullable<DeploymentReadTransportV1['listDataServicePage']>>>;
    const pending = createDeferred<DataResult>();
    let recovered = false;
    const { controller } = controllerFor(() => page([]), {
      listDataServicePage: async () => recovered
        ? { ok: true, value: { nextCursor: null, items: [] } } : pending.promise,
    });
    const screen = await renderScreen(<Page controller={controller} view="databases" />);
    try {
      expect(screen.findByTestId('services.databases.loading')).not.toBeNull();
      expect(screen.findByTestId('services.databases.empty')).toBeNull();
      await act(async () => {
        pending.resolve({ ok: false, failure: { code: 'machine_offline', retryable: true } });
      });
      await vi.waitFor(() => expect(screen.findByTestId('services.databases.error')).not.toBeNull());
      expect(screen.findByTestId('services.databases.loading')).toBeNull();
      expect(screen.findByTestId('services.databases.empty')).toBeNull();
      recovered = true;
      await act(async () => { await controller.refreshDemanded(); });
      await vi.waitFor(() => expect(screen.findByTestId('services.databases.empty')).not.toBeNull());
      expect(screen.findByTestId('services.databases.loading')).toBeNull();
      expect(screen.findByTestId('services.databases.error')).toBeNull();
    } finally {
      pending.resolve({ ok: false, failure: { code: 'machine_offline', retryable: true } });
      controller.retire();
    }
  });
  it('moves past a page of Environments without databases to the page that has them (the read pages every Environment)', async () => {
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
    const bare = createDeploymentEnvironmentHeaderV1({ id: 'env-bare', projectSourceId: 'source-bare' });
    const shop = createDeploymentEnvironmentHeaderV1({ id: 'env-shop', projectSourceId: 'source-shop' });
    const content = createDeploymentEnvironmentDetailV1().content;
    // What makes an Environment one the Databases page lists: its definition declares the data service.
    const holding = { ...content, template: { ...content.template!, data: [{ service: 'shop-db', engine: 'postgres' as const }] } };
    const cursors: (string | undefined)[] = [];
    const { controller } = controllerFor(() => page([environment('env-shop', 'source-shop', 'Production')]), {
      listDataServicePage: async (_scope, query) => {
        cursors.push(query.cursor);
        return query.cursor === undefined
          ? { ok: true, value: { nextCursor: 'older', items: [{ environment: bare, title: 'Demo', content, databaseSizes: [] }] } }
          : { ok: true, value: { nextCursor: null, items: [{ environment: shop, title: 'Production', content: holding, databaseSizes: [
            { service: 'shop-db', size: { status: 'available', bytes: 8_136_000, measurement: 'database_bytes', observedAtMs: 1 },
              growth: { status: 'unavailable', reason: 'no_previous_measurement' } }] }] } };
      },
    });
    const screen = await renderScreen(<Page controller={controller} view="databases" />);
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('services.databases.row.env-shop.shop-db'), (node) => node !== null);
    });
    expect(screen.findByTestId('services.databases.pageEmpty')).toBeNull();
    expect(cursors).toEqual([undefined, 'older']);
    controller.retire();
  });

  it('names the page Services and, in its Databases view, lists each environment\'s databases with their measured size', async () => {
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
    const shop = createDeploymentEnvironmentHeaderV1({ id: 'env-shop', projectSourceId: 'source-shop' });
    const { controller } = controllerFor(() => page([environment('env-shop', 'source-shop', 'Production')]), {
      listDataServicePage: async () => ({ ok: true, value: { nextCursor: null, items: [{ environment: shop, title: 'Production',
        content: { ...createDeploymentEnvironmentDetailV1().content, template: { ...createDeploymentEnvironmentDetailV1().content.template!,
          data: [{ service: 'shop-db', engine: 'postgres' as const }, { service: 'cache', engine: 'redis' as const }] } },
        databaseSizes: [
          { service: 'shop-db', size: { status: 'available', bytes: 1288490188, measurement: 'database_bytes', observedAtMs: 1 },
            growth: { status: 'unavailable', reason: 'no_previous_measurement' } },
          { service: 'cache', size: { status: 'unavailable', reason: 'unsupported_engine' },
            growth: { status: 'unavailable', reason: 'unsupported_engine' } },
        ] }] } }),
    });
    const screen = await renderScreen(<Page controller={controller} view="databases" />);
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('services.databases.row.env-shop.shop-db'), (node) => node !== null);
    });
    const { t } = await import('@/text');
    expect(screen.getTextContent()).toContain(t('projects.deployments.services.title'));
    expect(screen.getTextContent()).toMatch(/1\.\d+ GB/);
    // A size the owner could not read says why, never a made-up figure (under its Size head, without saying "Size" again).
    expect(screen.getTextContent()).toContain(t('projects.deployments.services.sizeCellUnsupported'));
    // The Apps list is not drawn under the Databases view.
    expect(screen.findByTestId('all-deployments.row.env-shop')).toBeNull();
    controller.retire();
  });
  it.each(['populated', 'empty', 'unavailable'] as const)('reads Domains independently of the %s Apps inventory', async (apps) => {
    let reads = 0;
    const { controller } = controllerFor(() => apps === 'unavailable'
      ? { ok: false, failure: { code: 'home_unreachable', retryable: true } }
      : page(apps === 'empty' ? [] : [environment('env-shop', 'source-shop', 'Production')]), {
      listDomainPage: async () => { reads += 1; return { ok: true, value: { nextCursor: null, items: [] } }; },
    });
    const screen = await renderScreen(<Page controller={controller} view="domains" />);
    await vi.waitFor(() => expect(screen.findByTestId('services.domains.empty')).not.toBeNull());
    expect(reads).toBe(1);
    expect(screen.findByTestId('all-deployments.row.env-shop')).toBeNull();
    controller.retire();
  });
  it('pages Domains through the read owner instead of calling a continued Account empty', async () => {
    const cursors: (string | null | undefined)[] = [];
    const { controller } = controllerFor(() => page([]), {
      listDomainPage: async (_scope: unknown, input: { cursor?: string | null }) => {
        cursors.push(input.cursor);
        return { ok: true, value: { nextCursor: input.cursor ? null : 'domains-2', items: [] } };
      },
    });
    const screen = await renderScreen(<Page controller={controller} view="domains" />);
    await vi.waitFor(() => expect(screen.findByTestId('services.domains.paging.older')).not.toBeNull());
    expect(screen.findByTestId('services.domains.empty')).toBeNull();
    await screen.pressByTestIdAsync('services.domains.paging.older');
    await vi.waitFor(() => expect(screen.findByTestId('services.domains.paging.newer')).not.toBeNull());
    expect(cursors).toEqual([undefined, 'domains-2']);
    expect(screen.findByTestId('services.domains.paging.older')).toBeNull();
    controller.retire();
  });
  it('bands Domains by Project and names each address\'s Environment (lab svcDom, G5)', async () => {
    const accountDomain = (id: string, hostname: string, environmentId: string, projectSourceId: string,
      environmentTitle: string, projectSourceName: string | null): DeploymentAccountDomainReadItemV1 => ({
      domain: { v: 1, id, environmentId, targetLinkId: 'link', revision: 1, state: 'active', contentArtifactId: `c-${id}`,
        contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account-owner', createdAtMs: 1, updatedAtMs: 1 },
      title: hostname,
      content: { hostname, target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 } },
      environment: createDeploymentEnvironmentHeaderV1({ id: environmentId, projectSourceId,
        runtimeTargetLinkId: id === 'd-old' ? undefined : 'link' }),
      environmentTitle, projectSourceName,
    });
    const { controller } = controllerFor(() => page([]), {
      listDomainPage: async () => ({ ok: true, value: { nextCursor: null, items: [
        accountDomain('d-shop', 'shop.example.com', 'env-shop', 'source-shop', 'Production', 'shop'),
        accountDomain('d-shop-staging', 'staging.shop.example.com', 'env-shop-staging', 'source-shop', 'Staging', 'shop'),
        accountDomain('d-old', 'old.example.com', 'env-old', 'source-old', 'Legacy', null),
      ] } }),
    });
    const screen = await renderScreen(<Page controller={controller} view="domains" />);
    await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.domains.d-old')).not.toBeNull());
    const { t } = await import('@/text');
    const text = screen.getTextContent();
    // One band per Project, by the read's Source name; a result without one stands in the Apps view's last band.
    expect(text).toContain('shop');
    // A band title may be drawn in more than one text run (it middle-ellipsizes), so compare without spaces.
    expect(text.replace(/\s/g, '')).toContain(t('projects.deployments.allOtherProject').replace(/\s/g, ''));
    // The Environment column names where each address belongs.
    expect(text).toContain(t('projects.deployments.editors.domainColumnEnvironment'));
    expect(text).toContain('Staging');
    expect(text).toContain('Legacy');
    const { Status } = await import('@happier-dev/plugin-ui');
    const state = (id: string) => screen.findAllByType(Status).find(node =>
      node.props.testID === `project-deployments.environment.domains.${id}.state`)?.props.label;
    expect(state('d-shop')).toBe(t('projects.deployments.editors.domainServing'));
    expect(state('d-old')).toBe('Unattached');
    controller.retire();
  });
});
