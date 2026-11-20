// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const routing = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routing.module);

afterEach(() => standardCleanup());
// Module graph loads outside the test's own time budget, as the neighbouring suites do.
const { DeploymentPrivateServiceExports } = await import('./DeploymentPrivateServiceExports');

it('leads a repository-defined Environment to the agent that edits its Compose file instead of a dead end (PAGE-ACCEPT-176 R9-D2)', async () => {
  const base = createDeploymentEnvironmentDetailV1();
  const detail = {
    ...base,
    content: {
      ...base.content,
      definition: { kind: 'repository' as const, path: 'compose.yaml' },
    },
  };
  const scope = { serverId: 'home', accountId: 'account' };
  const lifetime = {
    scope,
    isCurrent: () => true,
    onRetire: () => ({ dispose() {} }),
  };
  const editing = {
    actions: { setController: vi.fn(), updateEnvironment: vi.fn() },
    serverId: 'home',
    review: { pendingId: null, request() {}, open() {} },
    onChanged() {},
  };
  const screen = await renderScreen(
    <DeploymentPrivateServiceExports
      detail={detail as never}
      editing={editing as never}
      lifetime={lifetime as never}
    />,
  );
  expect(
    screen.findByTestId(
      'project-deployments.environment.privateSharing.repository',
    ),
  ).not.toBeNull();
  expect(
    screen.findByTestId('project-deployments.prepare.open'),
  ).not.toBeNull();
});
