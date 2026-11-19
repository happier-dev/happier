import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentHistoryQueryV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
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
  it('a row older than a day says the same day count as its day group', async () => {
    const { t } = await import('@/text');
    const environmentId = createDeploymentEnvironmentDetailV1().environment.id;
    // 01:00 now, settled 5 days and 2 hours earlier at 23:00: five whole days elapsed, but six calendar days back.
    const now = new Date(2026, 10, 8, 1, 0, 0).getTime();
    const settled = now - (5 * 24 + 2) * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const items = [{ ...createDeploymentReceiptHeaderV1({ id: 'receipt-old', environmentId, state: 'succeeded',
      requestedAtMs: settled - 2, startedAtMs: settled - 1, settledAtMs: settled }) }];
    const { screen, controller, settle } = await renderHistory(() => ({ ok: true, items, nextCursor: null }));
    try {
      expect(await settle('project-deployments.receipt.row.receipt-old')).not.toBeNull();
      const group = screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('project-deployments.environment.history.day.') && typeof node.props.title === 'string')[0]!;
      expect(group.props.title).toBe(t('sessionHistory.daysAgo', { count: 6 }));
      const texts = screen.findAll(node => typeof node.props.children === 'string').map(node => node.props.children as string);
      expect(texts).toContain(t('time.daysAgoShort', { count: 6 }));
    } finally { vi.useRealTimers(); await screen.unmount(); controller.retire(); }
  });

  it('leads each row with what the operation did to which version, groups rows by day, and rows are buttons', async () => {
    const environmentId = createDeploymentEnvironmentDetailV1().environment.id;
    const source = { kind: 'repository' as const, sha: 'c'.repeat(40) };
    const day = 24 * 60 * 60 * 1000;
    // The same revision, rolled back to today and deployed two days ago: the titles must still tell them apart.
    const now = Date.now();
    const items = [
      { ...createDeploymentReceiptHeaderV1({ id: 'receipt-rollback', environmentId, operation: 'rollback', state: 'succeeded',
        requestedAtMs: now - 3_000, startedAtMs: now - 2_000, settledAtMs: now - 1_000 }), source },
      { ...createDeploymentReceiptHeaderV1({ id: 'receipt-deploy', environmentId, operation: 'deploy', state: 'succeeded',
        requestedAtMs: now - 2 * day, startedAtMs: now - 2 * day + 1, settledAtMs: now - 2 * day + 2 }), source },
    ];
    const { screen, controller, settle } = await renderHistory(() => ({ ok: true, items, nextCursor: null }));
    try {
      expect(await settle('project-deployments.receipt.row.receipt-deploy')).not.toBeNull();
      const row = (id: string) => screen.findAll(node => node.props.testID === `project-deployments.receipt.row.${id}`
        && typeof node.props.title === 'string')[0]!;
      const rollback = row('receipt-rollback').props;
      const deploy = row('receipt-deploy').props;
      expect(rollback.title).toContain('ccccccc');
      expect(deploy.title).toContain('ccccccc');
      expect(rollback.title).not.toBe(deploy.title);
      expect(rollback.accessibilityRole).toBe('button');
      // Two days, two groups, newest first.
      const groups = screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('project-deployments.environment.history.day.') && typeof node.props.title === 'string');
      expect(groups.map(group => group.props.testID)).toHaveLength(2);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('a failed or running row shows its compact step strip; a settled success keeps the single glyph (dHist)', async () => {
    const environmentId = createDeploymentEnvironmentDetailV1().environment.id;
    const now = Date.now();
    const steps = [
      { id: 'build', label: 'Build', state: 'succeeded' as const },
      { id: 'rollout', label: 'Roll out', state: 'failed' as const },
      { id: 'route', label: 'Route', state: 'skipped' as const },
    ];
    const items = [
      { ...createDeploymentReceiptHeaderV1({ id: 'receipt-failed', environmentId, state: 'failed',
        requestedAtMs: now - 3_000, startedAtMs: now - 2_000, settledAtMs: now - 1_000 }), steps },
      { ...createDeploymentReceiptHeaderV1({ id: 'receipt-ok', environmentId, state: 'succeeded',
        requestedAtMs: now - 6_000, startedAtMs: now - 5_000, settledAtMs: now - 4_000 }),
        steps: steps.map(step => ({ ...step, state: 'succeeded' as const })) },
    ];
    const { screen, controller, settle } = await renderHistory(() => ({ ok: true, items, nextCursor: null }));
    try {
      expect(await settle('project-deployments.receipt.row.receipt-failed.steps')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.receipt.row.receipt-ok.steps')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

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

  it('narrows by outcome in one press, at the read owner, and All returns every deploy', async () => {
    const queries: DeploymentHistoryQueryV1[] = [];
    const environmentId = createDeploymentEnvironmentDetailV1().environment.id;
    const { screen, controller, settle } = await renderHistory((query) => {
      queries.push(query);
      const match = receipts(environmentId).filter(
        (receipt) => query.state === undefined || receipt.state === query.state,
      );
      return { ok: true, items: match, nextCursor: null };
    });
    try {
      expect(await settle('project-deployments.receipt.row.receipt-two')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.history.outcome:failed');
      expect(await settle('project-deployments.receipt.row.receipt-two', false)).toBeNull();
      expect(screen.findByTestId('project-deployments.receipt.row.receipt-one')).not.toBeNull();
      expect(queries.at(-1)).toEqual(expect.objectContaining({ state: 'failed' }));
      await screen.pressByTestIdAsync('project-deployments.history.outcome:all');
      expect(await settle('project-deployments.receipt.row.receipt-two')).not.toBeNull();
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
      // The outcome segment states Failed, so it is not repeated as a token.
      expect(
        screen.findByTestId('project-deployments.history-filter-token:state'),
      ).toBeNull();
      expect(
        screen.findByTestId('project-deployments.history.outcome:failed')?.props.accessibilityState,
      ).toEqual(expect.objectContaining({ checked: true }));

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
