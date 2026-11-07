import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import {
  act,
  renderScreen,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
// The exact controller RPC is the network boundary; its protocol reader stays real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: vi.fn(async () => {
      throw new Error('controller_unavailable');
    }),
  }),
);
afterEach(standardCleanup);

const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { AccountNoticeInvestigationBoundary } =
  await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
const { readDeploymentFailureRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe('Receipt → Images', () => {
  it('names each exact image the release ran, by service and platform, with its reference', async () => {
    const base = createDeploymentReceiptDetailV1();
    const content = DeploymentOwnServerContentV1Schema.parse({
      ...base.content,
      images: [
        {
          service: 'web',
          platform: 'linux/amd64',
          configDigest: digest('a'),
          manifestDigest: digest('b'),
          registryReference:
            'registry.example/app/web@sha256:' + 'b'.repeat(64),
        },
        {
          service: 'worker',
          platform: 'linux/amd64',
          configDigest: digest('c'),
          manifestDigest: digest('d'),
        },
      ],
    });
    const receipt = createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({ state: 'succeeded' }),
      content,
    });
    const detail = createDeploymentEnvironmentDetailV1();
    const controller = createDeploymentReadControllerV1({
      scope,
      transport: {
        listEnvironments: async () => ({
          ok: true,
          value: { items: [], nextCursor: null },
        }),
        readEnvironment: async () => ({ ok: true, value: detail }),
        listHistory: async () => ({
          ok: true,
          value: { ok: true, items: [], nextCursor: null },
        }),
        readReceipt: async () => ({ ok: true, value: receipt }),
      },
    });
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail
          controller={controller}
          environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id}
          environmentName="Staging"
          demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId}
          serverId={scope.serverId}
          readLogs={null}
          onBack={() => {}}
          rollback={null}
          cancel={null}
          deploy={null}
          phone={false}
          linkPath={null}
          review={{ pendingId: null, request() {}, open() {} }}
          onOpenReceipt={() => {}}
        />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await Promise.race([
          waitForTestEvent(
            screen.subscribe,
            () => screen.findByTestId('project-deployments.receipt.images'),
            (node) => node !== null,
          ),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      });
      // The Item row itself, which carries the subtitle it draws.
      const row = (id: string) => screen.findAll(node => node.props.testID === id && node.props.subtitle !== undefined)[0];
      const web = row('project-deployments.receipt.image.web.linux/amd64');
      const worker = row('project-deployments.receipt.image.worker.linux/amd64');
      expect(web?.props.subtitle).toBe(
        'registry.example/app/web@sha256:' + 'b'.repeat(64),
      );
      // Without a registry reference the config digest is the image's identity.
      expect(worker?.props.subtitle).toBe(digest('c'));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Receipt → failed', () => {
  it('offers Investigate as the shared agent-action control and says the canonical remedy for the recorded cause', async () => {
    const base = createDeploymentReceiptDetailV1();
    const failure = { code: 'deployment_image_unavailable', phase: 'build' as const };
    const content = DeploymentOwnServerContentV1Schema.parse({ ...base.content, failure });
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'failed' }), content });
    const detail = createDeploymentEnvironmentDetailV1();
    const opened: string[] = [];
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const screen = await renderScreen(
      <AccountNoticeInvestigationBoundary>
        <DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
          deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
          accountId={scope.accountId} serverId={scope.serverId} readLogs={null} onBack={() => {}} rollback={null}
          cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }}
          onOpenRecoveryDestination={(destination) => { opened.push(destination); }}
          onOpenReceipt={() => {}} />
      </AccountNoticeInvestigationBoundary>,
    );
    try {
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.receipt.outcome.failed'), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      // The banner component itself, which carries the description it draws.
      const banner = screen.findAll(node => node.props.testID === 'project-deployments.receipt.outcome.failed'
        && node.props.description !== undefined)[0];
      expect(banner).not.toBeNull();
      expect(screen.findAllByType(AgentActionButton)).toHaveLength(1);
      expect(String(banner?.props.description)).toContain(readDeploymentFailureRecoveryV1(failure.code, failure).remedy);
      // The canonical next action opens where the cause is fixed.
      await screen.pressByTestIdAsync('project-deployments.receipt.outcome.failed.recovery');
      expect(opened).toEqual([readDeploymentFailureRecoveryV1(failure.code, failure).nextAction.destination]);
    } finally { await screen.unmount(); controller.retire(); }
  });
});
