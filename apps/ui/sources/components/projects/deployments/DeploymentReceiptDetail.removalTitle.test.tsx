// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/utils/web/reactDomCjs', async () =>
  (
    await import('@/dev/testkit/mocks/reactDomCjs')
  ).createReactDomCjsRendererMock(),
);
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      confirmResult: true,
      renderCustomModals: true,
    }).module,
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { Modal } = await import('@/modal');

describe('removal receipt title (PAGE-ACCEPT-176 R21-D4)', () => {
  beforeEach(async () => {
    await homes.reset();
  });
  afterEach(async () => {
    Modal.hideAll();
    await standardCleanup();
  });

  it.each([
    ['Team Wiki', 'Team Wiki Production removed'],
    [null, 'Production removed'],
  ] as const)(
    'names what it removed (project %s), never the commit it last ran',
    async (projectName, expected) => {
      const serverId = await homes.addHome({
        name: 'Home',
        serverUrl: 'https://removal-title.test',
        serverIdentityId: `srv_${'a'.repeat(32)}`,
        accountId: 'account-owner',
        currentAccount: true,
      });
      const base = createDeploymentReceiptDetailV1();
      const receipt = createDeploymentReceiptDetailV1({
        deployment: {
          ...base.deployment,
          operation: 'teardown',
          state: 'succeeded',
        },
        content: {
          ...base.content,
          teardown: {
            reason: 'manual',
            targetLinkRevision: 1,
            machines: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            resources: [],
            proofs: [
              { step: 'removeTarget', machineId: 'machine-a', installationId: 'installation-a', state: 'succeeded', resources: [] },
              { step: 'verify', machineId: 'machine-a', installationId: 'installation-a', state: 'succeeded', resources: [] },
            ],
          },
        },
      });
      const environment = createDeploymentEnvironmentDetailV1({
        environment: createDeploymentEnvironmentHeaderV1({ serverId }),
      });
      const named = {
        ...environment,
        content: { ...environment.content, name: 'Production' },
      };
      const controller = createDeploymentReadControllerV1({
        scope: { serverId, accountId: 'account-owner' },
        transport: {
          listEnvironments: async () => ({
            ok: true,
            value: { items: [], nextCursor: null },
          }),
          readEnvironment: async () => ({ ok: true, value: named }),
          listHistory: async () => ({
            ok: true,
            value: { ok: true, items: [], nextCursor: null },
          }),
          readReceipt: async () => ({ ok: true, value: receipt }),
        },
      });
      try {
        // The removed Environment is no longer in the Project's list, so the page passes no name of its own.
        const screen = await renderAccountScreen(
          <DeploymentReceiptDetail
            controller={controller}
            environmentId={receipt.deployment.environmentId}
            deploymentId={receipt.deployment.id}
            environmentName={null}
            projectName={projectName}
            demand={{ mounted: true, visible: true, focused: true }}
            accountId="account-owner"
            serverId={serverId}
            readLogs={null}
            onBack={() => {}}
            rollback={null}
            cancel={null}
            deploy={null}
            phone={false}
            linkPath={null}
            review={{ pendingId: null, request() {}, open() {} }}
            onOpenReceipt={() => {}}
          />,
        );
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          const header = screen.findByTestId(
            'project-deployments.receipt.header',
          );
          expect(header, screen.getTextContent()).not.toBeNull();
          // The page header's title is what the tab and the navigation bar publish.
          expect(screen.findAllByProps({ testID: 'project-deployments.receipt.header', title: expected }).length,
            screen.getTextContent()).toBeGreaterThan(0);
        });
        expect(screen.getTextContent()).not.toMatch(/Removed [0-9a-f]{7}/);
        // Its settled steps read in words, from the removal's own signed proofs.
        const steps = screen.findByTestId('project-deployments.receipt.steps');
        expect(steps, screen.getTextContent()).not.toBeNull();
        expect(screen.getTextContent()).toContain('Stopped and removed its services');
        expect(screen.getTextContent()).toContain('Checked what was removed and what was kept');
      } finally {
        controller.retire();
      }
    },
  );
});
