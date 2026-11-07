import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
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
afterEach(() => {
  routerMock.spies.push.mockClear();
});
afterEach(standardCleanup);

const { AllDeploymentsView } = await import('./AllDeploymentsScreen');
const { useDeploymentCollection } = await import('./useDeploymentReads');

const shown = { mounted: true, visible: true, focused: true };
type ListResult = Awaited<
  ReturnType<DeploymentReadTransportV1['listEnvironments']>
>;

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
  items: ReturnType<typeof environment>[],
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
function controllerFor(list: (cursor: string | undefined) => ListResult) {
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
  };
  const controller = createDeploymentReadControllerV1({
    scope: { serverId: 'home', accountId: 'account-owner' },
    transport,
  });
  return { controller, calls };
}

function Page(props: Readonly<{ controller: DeploymentReadControllerV1 }>) {
  const read = useDeploymentCollection(props.controller, shown);
  return <AllDeploymentsView read={read} serverId="home" />;
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
    const rowsIn = (key: string) => [...new Set(screen.findByTestId(`all-deployments.project.${key}`)!
      .findAll((node) => typeof node.props.testID === 'string' && /^all-deployments\.row\.[^.]+$/.test(node.props.testID))
      .map((node) => node.props.testID as string))];
    expect(rowsIn('source-shop')).toEqual(['all-deployments.row.env-shop-staging', 'all-deployments.row.env-shop-production']);
    expect(rowsIn('source-api')).toEqual(['all-deployments.row.env-api-production']);
    expect(rowsIn('unnamed')).toEqual(['all-deployments.row.env-hidden-name']);
    const text = screen.getTextContent();
    expect(text.indexOf('storefront')).toBeLessThan(text.indexOf('payments-api'));
    expect(text).toContain('feat(cart): keep the cart after sign-in');
    await screen.pressByTestIdAsync('all-deployments.row.env-api-production');
    expect(routerMock.spies.push).toHaveBeenCalledWith({
      pathname: '/deployments/[projectSourceId]',
      params: { projectSourceId: 'source-api', serverId: 'home', deploymentEnvironment: 'env-api-production' },
    });
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
    await screen.pressByTestIdAsync('all-deployments.older');
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
    expect(screen.findByTestId('all-deployments.older')).toBeNull();
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
});
