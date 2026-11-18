import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';

const viewport = vi.hoisted(() => ({
  width: 1440,
  height: 900,
  scale: 1,
  fontScale: 1,
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => viewport,
    Dimensions: { get: () => viewport },
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
const router = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: { deploymentSettings: 'defaults' } });
});
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
afterEach(standardCleanup);
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');

describe('Project deployment defaults navigation', () => {
  it("opens an Environment's Automations on its Settings tab, not its Overview (WAVE-REVIEW F8, D16)", async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const scope = {
      serverId: 'home',
      accountId: 'account-owner',
      projectSourceId: 'source-app',
    };
    // The deployment transport is the network/content boundary; route, page and controller logic stay real.
    const controller = createDeploymentReadControllerV1({
      scope,
      transport: {
        listEnvironments: async () => ({
          ok: true,
          value: {
            items: [{ environment: detail.environment, title: 'Storefront' }],
            nextCursor: null,
          },
        }),
        readEnvironment: async () => ({ ok: true, value: detail }),
        listHistory: async () => ({
          ok: true,
          value: { ok: true, items: [], nextCursor: null },
        }),
        readReceipt: async () => ({
          ok: true,
          value: createDeploymentReceiptDetailV1(),
        }),
      },
    });
    const lifetime = {
      scope,
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    };
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <ProjectDeploymentsView
          controller={controller}
          demand={{ mounted: true, visible: true, focused: true }}
          lifetime={lifetime}
          serverId={scope.serverId}
          accountId={scope.accountId}
          sourceId={scope.projectSourceId}
        />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      const row = `project-deployment-defaults.triggers.${detail.environment.id}`;
      await vi.waitFor(() => expect(screen.findByTestId(row)).not.toBeNull());
      await screen.pressByTestIdAsync(row);
      const params = Object.assign(
        {},
        ...router.spies.setParams.mock.calls.map(([next]) => next),
      ) as Record<string, unknown>;
      expect(params).toMatchObject({
        deploymentEnvironment: detail.environment.id,
        deploymentTab: 'settings',
        deploymentSection: 'automations',
      });
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('project-deployments.environment.settings.lead'),
        ).not.toBeNull(),
      );
    } finally {
      await screen.unmount();
      controller.retire();
      router.resetParams();
    }
  });
});
