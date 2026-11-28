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
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { t } = await import('@/text');

describe('an outcome-unknown receipt while its Machine is not answering (PAGE-ACCEPT-176 R21-D7)', () => {
  beforeEach(async () => { await homes.reset(); });
  afterEach(async () => { Modal.hideAll(); await standardCleanup(); });

  it('names the offline Machine as the cause and does not lead with Roll back', async () => {
    const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://outcome-unknown.test',
      serverIdentityId: `srv_${'a'.repeat(32)}`, accountId: 'account-owner', currentAccount: true });
    const scope = { serverId, accountId: 'account-owner' };
    const base = createDeploymentReceiptDetailV1();
    const machineId = 'machine-a';
    const receipt = createDeploymentReceiptDetailV1({ deployment: { ...base.deployment, state: 'outcome_unknown' },
      content: { ...base.content, machines: [machineId] } });
    const environment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
    const machine = createMachineFixture({ id: machineId, active: false, activeAt: 1 });
    await publishMachineInventoryForTest(scope, [{ ...machine, metadata: { ...machine.metadata!, displayName: 'Build box' } }]);
    const controller = createDeploymentReadControllerV1({ scope, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: environment }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    try {
      const screen = await renderAccountScreen(<DeploymentReceiptDetail controller={controller} environmentId={receipt.deployment.environmentId}
        deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
        accountId="account-owner" serverId={serverId} readLogs={null} onBack={() => {}} rollback={vi.fn()} cancel={null} deploy={null}
        phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />);
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.getTextContent()).toContain(t('projects.deployments.machineOffline', { machine: 'Build box' }));
      });
      expect(screen.findByTestId('project-deployments.receipt.rollback')).toBeNull();
    } finally {
      controller.retire();
    }
  });
});
