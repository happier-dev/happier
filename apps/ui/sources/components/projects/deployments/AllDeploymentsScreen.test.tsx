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
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol';
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
      // The list's own page reads; the count line's one counted read (includeTotal) is not a page of the list.
      if (!query?.includeTotal) calls.push(query?.cursor);
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
  it('keeps other Services views reachable while Apps is loading', async () => {
    const held = createDeferred<ListResult>();
    const { controller } = controllerFor(() => page([]), { listEnvironments: () => held.promise });
    try {
      const screen = await render(controller, 'all-deployments.loading');
      expect(screen.findByTestId('services.views')).not.toBeNull();
    } finally { controller.retire(); held.resolve(page([])); }
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

  it('says its count is this page\'s when more pages continue (the read reports no Account total)', async () => {
    const { controller } = controllerFor((cursor) => cursor
      ? page([environment('env-later', 'source-later', 'Later', { projectSourceName: 'later' })])
      : page([environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' })], { nextCursor: 'env-later' }));
    const screen = await render(controller, 'all-deployments');
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findHostByTestId('all-deployments.header:count'), (node) => node !== null);
    });
    expect(screen.getTextContent()).toContain('on this page');
    controller.retire();
  });

  it('says the Account-wide total from its own counted read, never "on this page", and paging never recounts', async () => {
    const counted: (string | undefined)[] = [];
    const first = page([environment('env-shop', 'source-shop', 'Production', { projectSourceName: 'storefront' })], { nextCursor: 'env-later' });
    const later = page([environment('env-later', 'source-later', 'Later', { projectSourceName: 'later' })]);
    const { controller } = controllerFor(() => first, {
      listEnvironments: async (_scope, query) => {
        if (query?.includeTotal) counted.push(query.cursor);
        const result = query?.cursor ? later : first;
        return query?.includeTotal && result.ok ? { ...result, value: { ...result.value, totalCount: 2417 } } : result;
      },
    });
    const screen = await render(controller, 'all-deployments');
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.getTextContent().includes('2417'), (found) => found);
    });
    expect(screen.getTextContent()).not.toContain('on this page');
    await screen.pressByTestIdAsync('all-deployments.paging.older');
    await act(async () => {
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('all-deployments.row.env-later'), (node) => node !== null);
    });
    expect(screen.getTextContent()).toContain('2417');
    expect(counted).toEqual([undefined]);
    controller.retire();
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

  it('names a Project once when its only Environment carries the Project’s name, and never repeats that name as what is live', async () => {
    const { controller } = controllerFor(() =>
      page([
        environment('env-maria', 'source-maria', 'maria-db', { projectSourceName: 'maria-db', liveVersionTitle: 'maria-db' }),
        environment('env-pgb', 'source-pgb', 'pgbouncer', { projectSourceName: 'pgbouncer' }),
        environment('env-shop-staging', 'source-shop', 'Staging', { projectSourceName: 'storefront' }),
        environment('env-redis', 'source-redis', 'redis-cache', { projectSourceName: 'redis-cache' }),
      ]),
    );
    const screen = await render(controller, 'all-deployments');
    const text = screen.getTextContent();
    // Untitled rows lead the page in one sheet: one placed below a titled group would read as part of it.
    expect(text.split('maria-db').length - 1).toBe(1);
    expect(text.split('pgbouncer').length - 1).toBe(1);
    expect(text.indexOf('maria-db')).toBeLessThan(text.indexOf('pgbouncer'));
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
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const bare = createDeploymentEnvironmentHeaderV1({ id: 'env-bare', projectSourceId: 'source-bare' });
    const shop = createDeploymentEnvironmentHeaderV1({ id: 'env-shop', projectSourceId: 'source-shop' });
    const content = createDeploymentEnvironmentDetailV1().content;
    const cursors: (string | undefined)[] = [];
    const { controller } = controllerFor(() => page([environment('env-shop', 'source-shop', 'Production')]), {
      listDataServicePage: async (_scope, query) => {
        cursors.push(query.cursor);
        return query.cursor === undefined
          ? { ok: true, value: { nextCursor: 'older', items: [{ environment: bare, title: 'Demo', content, databaseSizes: [] }] } }
          : { ok: true, value: { nextCursor: null, items: [{ environment: shop, title: 'Production', content, databaseSizes: [
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
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const shop = createDeploymentEnvironmentHeaderV1({ id: 'env-shop', projectSourceId: 'source-shop' });
    const { controller } = controllerFor(() => page([environment('env-shop', 'source-shop', 'Production')]), {
      listDataServicePage: async () => ({ ok: true, value: { nextCursor: null, items: [{ environment: shop, title: 'Production',
        content: createDeploymentEnvironmentDetailV1().content,
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
    // A size the owner could not read says why, never a made-up figure.
    expect(screen.getTextContent()).toContain(t('projects.deployments.services.sizeUnsupported'));
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
      environment: createDeploymentEnvironmentHeaderV1({ id: environmentId, projectSourceId }),
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
    controller.retire();
  });
});
