import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentReceiptDetailV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
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
// The dialog is the platform boundary: record what it asked and press its buttons ourselves.
const dialogs = vi.hoisted(
  () =>
    [] as {
      title: string;
      body: string;
      buttons: { text: string; style?: string; onPress?: () => void }[];
    }[],
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: {
        alert: ((title: string, body: string, buttons: never) => {
          dialogs.push({ title, body, buttons });
        }) as never,
      },
    }).module,
);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: vi.fn(async () => {
      throw new Error('controller_unavailable');
    }),
  }),
);
afterEach(() => {
  dialogs.length = 0;
});
afterEach(standardCleanup);

const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { AccountNoticeInvestigationBoundary } =
  await import('@/hooks/inbox/AccountNoticeInvestigationProvider');

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};

async function renderRunning(
  consequence:
    | 'service-down-until-rollback'
    | 'may-leave-service-down-until-rollback'
    | null,
  state: 'running' | 'outcome_unknown' = 'running',
) {
  const receipt = {
    ...createDeploymentReceiptDetailV1({
      deployment: createDeploymentReceiptHeaderV1({
        state,
        settledAtMs: undefined,
      }),
    }),
    cancellable: true,
    ...(consequence ? { cancellationConsequence: { kind: consequence } } : {}),
  };
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
  // The Action owner's Cancel is the boundary this page calls.
  const cancel = vi.fn(async () => ({ ok: true as const }));
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
        cancel={cancel as never}
        deploy={null}
        phone={false}
        linkPath={null}
        review={{ pendingId: null, request() {}, open() {} }}
        onOpenReceipt={() => {}}
      />
    </AccountNoticeInvestigationBoundary>,
  );
  await act(async () => {
    await Promise.race([
      waitForTestEvent(
        screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.header'),
        (node) => node !== null,
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  });
  return { screen, controller, cancel };
}

describe('Receipt → Cancel after the previous version stopped (d3d/cancelask)', () => {
  it.each([
    'service-down-until-rollback',
    'may-leave-service-down-until-rollback',
  ] as const)(
    '%s: asks first, and cancels only when the person confirms',
    async (kind) => {
      const { screen, controller, cancel } = await renderRunning(kind);
      try {
        await screen.pressByTestIdAsync('project-deployments.receipt.cancel');
        expect(cancel).not.toHaveBeenCalled();
        expect(dialogs).toHaveLength(1);
        await act(async () => {
          dialogs[0]!.buttons.find((button) => button.style === 'destructive')!
            .onPress!();
        });
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
        controller.retire();
      }
    },
  );

  it('the two facts say different things: stopped, or may have stopped', async () => {
    const bodies: string[] = [];
    for (const kind of [
      'service-down-until-rollback',
      'may-leave-service-down-until-rollback',
    ] as const) {
      const { screen, controller } = await renderRunning(kind);
      try {
        await screen.pressByTestIdAsync('project-deployments.receipt.cancel');
        bodies.push(dialogs.at(-1)!.body);
      } finally {
        await screen.unmount();
        controller.retire();
      }
    }
    expect(new Set(bodies).size).toBe(2);
  });

  it('without the fact, Cancel runs at once with no question', async () => {
    const { screen, controller, cancel } = await renderRunning(null);
    try {
      await screen.pressByTestIdAsync('project-deployments.receipt.cancel');
      expect(dialogs).toHaveLength(0);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Receipt → Cancel is the primary only while the work runs (PAGE-ACCEPT-88 N11)', () => {
  it('an unconfirmed receipt the server still lets you cancel offers Cancel in its menu, not as the header primary', async () => {
    const { screen, controller, cancel } = await renderRunning(null, 'outcome_unknown');
    // The menu is a positioned popover; its placement listens to the browser window (a platform boundary).
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
      expect(screen.findByTestId('project-deployments.receipt.cancel')).toBeNull();
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.menu'); });
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.receipt.menu.cancel'), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      await act(async () => { await screen.pressByTestIdAsync('project-deployments.receipt.menu.cancel'); });
      // The menu closes before it runs its choice; the press then reaches the Action owner.
      await act(async () => { await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1)); });
    } finally { await screen.unmount(); controller.retire(); vi.unstubAllGlobals(); }
  });
});
