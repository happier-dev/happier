import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

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

const checkout = {
  id: 'ref',
  serverId: 'home',
  machineId: 'machine',
  rootPath: '/repo',
  projectKey: 'anchor',
  createdAtMs: 1,
} as WorkspaceRefV1;

describe('Project → Deployments without a source', () => {
  it('leads to saving this checkout as a source, the one step deploying needs', async () => {
    const screen = await renderScreen(
      <ProjectDeploymentsBody workspaceRef={checkout} isFocused />,
    );
    expect(screen.findByTestId('project-deployments.noSource')).not.toBeNull();
    expect(
      screen.findByTestId('project-deployments.noSource.save'),
    ).not.toBeNull();
  });
});
