import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentHistoryQueryV1,
} from '@happier-dev/deployments';
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
const routerMock = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
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
// Render-count probe only: the real glyph still renders; each row draws exactly one, so its renders are the row's.
const glyphRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('@/components/work/status/WorkStatusGlyph', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/components/work/status/WorkStatusGlyph')
    >();
  const Real = actual.WorkStatusGlyph;
  function CountingWorkStatusGlyph(props: React.ComponentProps<typeof Real>) {
    const key = String(props.testIDSuffix ?? '');
    glyphRenders.set(key, (glyphRenders.get(key) ?? 0) + 1);
    return <Real {...props} />;
  }
  return { ...actual, WorkStatusGlyph: CountingWorkStatusGlyph };
});
afterEach(standardCleanup);

const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { PresentedDetailNavigationProvider } =
  await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');

const scope = {
  serverId: 'home',
  accountId: 'account-owner',
  projectSourceId: 'source-app',
};
const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };

function receipts(environmentId: string) {
  return ['one', 'two', 'three'].map((id, index) =>
    createDeploymentReceiptHeaderV1({
      id: `receipt-${id}`,
      environmentId,
      state: index === 0 ? 'failed' : 'succeeded',
      requestedByAccountId: index === 1 ? scope.accountId : 'account-other',
    }),
  );
}

async function renderHistory(
  listHistory: (query: DeploymentHistoryQueryV1) => unknown,
) {
  const detail = createDeploymentEnvironmentDetailV1();
  const controller = createDeploymentReadControllerV1({
    scope,
    transport: {
      listEnvironments: async () => ({
        ok: true,
        value: { items: [], nextCursor: null },
      }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async (_scope, _environmentId, query) => ({
        ok: true,
        value: listHistory(query),
      }),
      readReceipt: async () => ({
        ok: true,
        value: createDeploymentReceiptDetailV1(),
      }),
    },
  });
  const opened: string[] = [];
  let rerenderParent: () => void = () => {};
  // The real parent passes a fresh closure on each of its renders (ProjectDeploymentsBody).
  function Parent() {
    const [, setTick] = React.useState(0);
    rerenderParent = () => setTick((tick) => tick + 1);
    return (
      <PresentedDetailNavigationProvider>
        <DeploymentEnvironmentDetail
          controller={controller}
          environmentId={detail.environment.id}
          demand={shown}
          accountId={scope.accountId}
          serverId="home"
          phone={false}
          deploy={null}
          review={noReview}
          onOpenReceipt={(id) => {
            opened.push(id);
          }}
          destination={{ tab: 'history', section: null }}
        />
      </PresentedDetailNavigationProvider>
    );
  }
  const screen = await renderScreen(<Parent />);
  const settle = async (testID: string, present = true) => {
    await act(async () => {
      await Promise.race([
        waitForTestEvent(
          screen.subscribe,
          () => screen.findByTestId(testID),
          (node) => (node !== null) === present,
        ),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
    return screen.findByTestId(testID);
  };
  return {
    screen,
    controller,
    settle,
    opened,
    detail,
    rerenderParent: () =>
      act(async () => {
        rerenderParent();
      }),
  };
}

describe('Environment → History', () => {
  it('unrelated parent renders redraw 0 unchanged receipt rows, and a row still opens its own receipt', async () => {
    const { screen, controller, settle, opened, detail, rerenderParent } =
      await renderHistory(() => ({
        ok: true,
        items: receipts(createDeploymentEnvironmentDetailV1().environment.id),
        nextCursor: null,
      }));
    try {
      expect(
        await settle('project-deployments.receipt.row.receipt-three'),
      ).not.toBeNull();
      glyphRenders.clear();
      for (let arrival = 0; arrival < 3; arrival += 1) await rerenderParent();
      expect(
        [...glyphRenders.entries()].filter(([key]) =>
          key.startsWith('deployment-receipt-'),
        ),
      ).toEqual([]);
      await screen.pressByTestIdAsync(
        'project-deployments.receipt.row.receipt-two',
      );
      expect(opened).toEqual(['receipt-two']);
      expect(detail.environment.id).toBeTruthy();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('narrows at the read owner by state, started by and operation, and Clear returns every deploy', async () => {
    const queries: DeploymentHistoryQueryV1[] = [];
    const environmentId = createDeploymentEnvironmentDetailV1().environment.id;
    const { screen, controller, settle } = await renderHistory((query) => {
      queries.push(query);
      const match = receipts(environmentId).filter(
        (receipt) =>
          (query.state === undefined || receipt.state === query.state) &&
          (query.actorAccountId === undefined ||
            receipt.requestedByAccountId === query.actorAccountId) &&
          (query.operation === undefined ||
            receipt.operation === query.operation),
      );
      return { ok: true, items: match, nextCursor: null };
    });
    // The editor is a positioned popover; its placement listens to the browser window (a platform boundary).
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    try {
      expect(
        await settle('project-deployments.receipt.row.receipt-two'),
      ).not.toBeNull();
      await act(async () =>
        screen.pressByTestId('project-deployments.history-filter-open'),
      );
      const editor = () =>
        screen.findAll(
          (node) =>
            node.props.testID === 'project-deployments.history-editor' &&
            node.props.model !== undefined,
        )[0]!;
      expect(
        (editor().props.model.availableFields as readonly { id: string }[]).map(
          (field) => field.id,
        ),
      ).toEqual(['state', 'actorAccountId', 'operation']);
      await act(async () => {
        editor().props.onChange({
          type: 'add',
          condition: { fieldId: 'state', operator: 'is', values: ['failed'] },
        });
      });
      expect(
        await settle('project-deployments.receipt.row.receipt-two', false),
      ).toBeNull();
      expect(
        screen.findByTestId('project-deployments.receipt.row.receipt-one'),
      ).not.toBeNull();
      expect(queries.at(-1)).toEqual(
        expect.objectContaining({ state: 'failed' }),
      );
      expect(
        screen.findByTestId('project-deployments.history-filter-token:state'),
      ).not.toBeNull();

      // Failed and started by you match nothing: one inline line with Clear, never the unfiltered empty state.
      await act(async () => {
        editor().props.onChange({
          type: 'add',
          condition: {
            fieldId: 'actorAccountId',
            operator: 'is',
            values: [scope.accountId],
          },
        });
      });
      expect(queries.at(-1)).toEqual(
        expect.objectContaining({
          state: 'failed',
          actorAccountId: scope.accountId,
        }),
      );
      expect(
        await settle('project-deployments.environment.history.filteredEmpty'),
      ).not.toBeNull();
      expect(
        screen.findByTestId('project-deployments.environment.history.empty'),
      ).toBeNull();

      await screen.pressByTestIdAsync(
        'project-deployments.environment.history.clear',
      );
      expect(
        await settle('project-deployments.receipt.row.receipt-two'),
      ).not.toBeNull();
      // Back to every deploy: the unnarrowed page is the read owner's already-held entry, so no new request is owed.
    } finally {
      // Unmount first: the closing popover still reads the stubbed window.
      await screen.unmount();
      controller.retire();
      vi.unstubAllGlobals();
    }
  });
});
