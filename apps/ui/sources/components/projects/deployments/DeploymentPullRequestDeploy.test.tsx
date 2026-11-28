import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const router = vi.hoisted(() => ({ push: vi.fn() }));
// The Machine's SCM read is the RPC transport boundary; its typed failure is what the section answers.
const scm = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>()),
  machineRpcWithServerScope: scm.get,
}));

afterEach(() => {
  standardCleanup();
  router.push.mockReset();
  scm.get.mockReset();
});

const { DeploymentPullRequestDeploy } =
  await import('./DeploymentPullRequestDeploy');
const { GITHUB_CONNECTED_SERVICE_ROUTE } =
  await import('@/sync/domains/connectedServices/githubConnectedServiceRoute');

function render(kind: 'github' | 'gitlab') {
  return renderScreen(
    <DeploymentPullRequestDeploy
      workspaceRef={
        {
          id: 'ws-1',
          serverId: 'home-a',
          machineId: 'machine-1',
          rootPath: '/srv/app',
          repositoryIdentity: {
            kind,
            deployment: `https://${kind}.com`,
            repository: 'acme/app',
          },
        } as never
      }
      projectSourceId="source-1"
      sourceRevision={1}
      compose={undefined}
      serverId="home-a"
      accountId="account-1"
      disabled={false}
      checkoutLedByVersion={false}
      onDeploy={async () => {}}
    />,
  );
}

describe('Deploy a pull request head without a GitHub connection (COR4B ui-61)', () => {
  it('says that connecting GitHub is the fix and opens it, instead of a retry that cannot succeed', async () => {
    scm.get.mockResolvedValue({
      success: false,
      errorCode: 'REMOTE_AUTH_REQUIRED',
      error: 'GitHub pull request authentication is required',
    });
    const screen = await render('github');
    await act(async () => {
      screen.changeTextByTestId('project-deployments.pr.number', '109');
    });
    await screen.pressByTestIdAsync('project-deployments.pr.load');
    expect(scm.get).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SCM_PULL_REQUEST_GET,
      machineId: 'machine-1',
      serverId: 'home-a',
      accountId: 'account-1',
      payload: expect.objectContaining({ cwd: '/srv/app', prReference: { number: 109 } }),
    }));
    expect(
      screen.findByTestId('project-deployments.pr.connect'),
    ).not.toBeNull();
    await screen.pressByTestIdAsync('project-deployments.pr.connect.action');
    expect(router.push).toHaveBeenCalledWith(GITHUB_CONNECTED_SERVICE_ROUTE);
  });

  it('offers no GitHub connection for another forge', async () => {
    scm.get.mockResolvedValue({
      success: false,
      errorCode: 'REMOTE_AUTH_REQUIRED',
      error: 'GitLab authentication is required',
    });
    const screen = await render('gitlab');
    await act(async () => {
      screen.changeTextByTestId('project-deployments.pr.number', '109');
    });
    await screen.pressByTestIdAsync('project-deployments.pr.load');
    expect(screen.findByTestId('project-deployments.pr.connect')).toBeNull();
    expect(
      screen.findByTestId('project-deployments.pr.unavailable'),
    ).not.toBeNull();
  });
});
