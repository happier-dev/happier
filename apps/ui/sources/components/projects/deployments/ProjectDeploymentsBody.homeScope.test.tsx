import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

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
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(standardCleanup);

const { ProjectDeploymentsBody } = await import('./ProjectDeploymentsBody');

describe('Project Source → Deployments addressed without a Home', () => {
  it('settles on the unknown-Home state with its next step instead of loading forever', async () => {
    const screen = await renderScreen(
      <ProjectDeploymentsBody serverId={null} projectSourceId="source-1" isFocused />,
    );
    expect(screen.findByTestId('project-deployments-unknown-home')).not.toBeNull();
    expect(screen.findByTestId('project-deployments.loading')).toBeNull();
  });
});
