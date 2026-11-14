import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
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
) {
  return {
    environment: createDeploymentEnvironmentHeaderV1({ id, projectSourceId }),
    title,
    currentDeployment: null,
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
    />
  );
}

async function render(
  controller: DeploymentReadControllerV1,
  selection: Selection,
  onNavigate = vi.fn(),
) {
  const screen = await renderScreen(
    <Column
      controller={controller}
      selection={selection}
      onNavigate={onNavigate}
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
      () => screen.findByTestId('services-column:project:unnamed'),
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
