import * as React from 'react';
import { act } from 'react-test-renderer';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    {},
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/ops/scm/machineScm', () => ({
  machineScmHostingRepositoryDescribePublishTargets: vi.fn(async () => ({ success: false, error: 'Machine unavailable' })),
}));
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    createFrontDoorActionExecute: () => execute,
  }),
);

const { createActionExecutor } = await import('@happier-dev/protocol/actions');
const { createActionExecutorBoundaryFixture } =
  await import('@/dev/testkit/fixtures/actionExecutorBoundary');
const { createPlainPromptLibraryCatalogHomeFixture } =
  await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const { storage } = await import('@/sync/domains/state/storageStore');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
const { createActionOperationSelectors } = await import('@/sync/domains/actionOperations/actionOperationSelectors');
const { ActionOperationRows } = await import('@/components/inbox/actionOperations/ActionOperationLedger');
const { NewAppScreen } = await import('./NewAppScreen');

afterEach(async () => {
  actionOperationStore.reset();
  await standardCleanup();
});
beforeEach(() => {
  actionOperationStore.reset();
  execute.mockReset();
});

const runner = {
  v: 1 as const,
  modelSelection: {
    agentTargetKey: 'agent:happier.agent.claude/claude',
    providerConnectionId: null,
    modelId: 'default',
  },
};
const targets: DeploySuggestionCatalogV1['targets'] = [
  {
    id: 'own',
    title: 'A machine',
    targetClass: 'ownServer',
    availability: 'available',
    accepts: ['static'],
    needs: [],
    sources: { gitIntegration: ['github'], upload: false },
  },
];

type Ports = NonNullable<Parameters<typeof createActionExecutorBoundaryFixture>[0]>;
function suggestionBoundary(overrides: Ports) {
  const executor = createActionExecutor(
    createActionExecutorBoundaryFixture({
      registryActionExecute: async ({ input }) => {
        const kind = (input as { kind: string }).kind;
        return {
          pages: [
            {
              sourceId: kind,
              status: { state: 'ok', fetchedAt: 1 },
              nextCursor: null,
              items:
                kind === 'starter'
                  ? [
                      {
                        sourceId: kind,
                        kind: 'starter',
                        itemId: 'website',
                        title: 'Static website',
                        starterDeploy: { framework: 'html', output: 'static' },
                      },
                    ]
                  : [],
            },
          ],
        };
      },
      connectedServiceAction: async () => ({
        accounts: [],
        pools: [],
        healthBasis: 'credentials',
        source: { completeness: 'complete', observedAtMs: 1 },
      }),
      machinesList: async () => ({
        items: [
          {
            machineId: 'devbox',
            label: 'devbox',
            active: true,
            homeDir: '/home/alice',
          },
        ],
      }),
      deploymentSuggestionTargets: async () => ({ targets, stores: [] }),
      deploymentSuggestionForges: async () => [{ providerKind: 'github', title: 'GitHub' }],
      machineSetupPlan: async () => ({ targets: [] }),
      agentsModelsList: async () => ({
        llmTaskRunner: {
          ok: true,
          source: 'auto',
          runner,
          title: 'Claude Haiku',
        },
      }),
      executionRunCheckProtocolV2: async () => ({
        ok: true,
        exactMachineId: 'devbox',
      }),
      executionRunStart: async () => ({
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
      }),
      ...overrides,
    }),
  );
  execute.mockImplementation(executor.execute);
}

async function openDescribe(name: string) {
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    `https://${name}.test`,
    {
      key: 'registry-sources',
      value: { v: 2, disabledSourceIds: [], sources: [] },
    },
    'updated',
    { handleRequest: async () => null },
  );
  const screen = await renderScreen(<NewAppScreen onClose={vi.fn()} />);
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('newApp.describeApp')).toBeTruthy(),
  );
  const scope = storage.getState().settingsScope;
  if (!scope) throw new Error('Expected admitted Home Account');
  return { fixture, screen, scope };
}

function failedExecutionRunSnapshot(params: Readonly<{ accountId: string; runId: string; revision?: number }>) {
  return ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: params.runId,
    revision: params.revision ?? 2,
    actionId: 'execution.run.start',
    state: 'failed',
    scope: { accountId: params.accountId, machineId: 'devbox' },
    title: 'Start execution run',
    createdAt: 100,
    startedAt: 100,
    settledAt: 200,
    cancellation: 'unsupported',
    error: {
      errorCode: 'usage_limit',
      error: 'Claude usage limit reached.',
    },
  });
}

function failedRunResult(runId: string) {
  return {
    ok: true as const,
    status: 'failed' as const,
    result: {
      run: {
        runId,
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'task' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const },
        permissionMode: 'no_tools' as const,
        retentionPolicy: 'ephemeral' as const,
        runClass: 'bounded' as const,
        ioMode: 'request_response' as const,
        status: 'failed' as const,
        startedAtMs: 100,
        finishedAtMs: 200,
        error: {
          code: 'usage_limit',
          message: 'Claude usage limit reached.',
        },
      },
    },
  };
}

it('consumes a mounted Describe Suggest failure in place without admitting it to Needs you, regardless of snapshot arrival order', async () => {
  const selectors = createActionOperationSelectors();
  let mergeBeforeSettle: (() => void) | null = null;
  let callIndex = 0;
  suggestionBoundary({
    executionRunStart: async () => {
      callIndex += 1;
      return { runId: `run_${callIndex}`, callId: `call_${callIndex}`, sidechainId: `call_${callIndex}` };
    },
    executionRunWait: async () => {
      if (callIndex === 1) {
        // Order A: daemon failed snapshot merges BEFORE foreground wait settles.
        mergeBeforeSettle?.();
      }
      return failedRunResult(`run_${callIndex}`);
    },
  });

  const { fixture, screen, scope } = await openDescribe('auto-inbox-mounted');
  try {
    mergeBeforeSettle = () => {
      actionOperationStore.mergeSnapshots({
        serverId: scope.serverId,
        snapshots: [failedExecutionRunSnapshot({ accountId: scope.accountId, runId: 'run_1' })],
      });
    };

    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'Studio invoices'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');

    // Describe shows inline cause + Retry.
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.failed')).toBeTruthy());
    expect(screen.findByTestId('newApp.auto.tryAgain')).toBeTruthy();

    // Order A: already-merged failed snapshot is marked seen -> 0 Needs-you items.
    expect(selectors.selectInbox(actionOperationStore.getSnapshot())).toEqual([]);
    expect(selectors.selectInboxSummary(actionOperationStore.getSnapshot())).toEqual({
      count: 0,
      hasAttention: false,
    });

    // Order B: Retry fails and foreground consumes settlement BEFORE the daemon's failed snapshot arrives.
    await screen.pressByTestIdAsync('newApp.auto.tryAgain');
    await waitForHomeGovernance(() => expect(callIndex).toBe(2));
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.failed')).toBeTruthy());
    actionOperationStore.mergeSnapshots({
      serverId: scope.serverId,
      snapshots: [failedExecutionRunSnapshot({ accountId: scope.accountId, runId: 'run_2' })],
    });
    expect(selectors.selectInbox(actionOperationStore.getSnapshot())).toEqual([]);
    expect(selectors.selectInboxSummary(actionOperationStore.getSnapshot())).toEqual({
      count: 0,
      hasAttention: false,
    });

    // Unrelated failed Action operations continue to be admitted to Needs you identically.
    const unrelated = ActionOperationSnapshotV1Schema.parse({
      version: 1,
      operationId: 'unrelated-spawn-failure',
      revision: 1,
      actionId: 'session.spawn_new',
      state: 'failed',
      scope: { accountId: scope.accountId, machineId: 'devbox' },
      title: 'Create session',
      createdAt: 300,
      startedAt: 300,
      settledAt: 350,
      cancellation: 'unsupported',
      error: { errorCode: 'internal_error', error: 'Workspace is read-only' },
    });
    actionOperationStore.mergeSnapshots({
      serverId: scope.serverId,
      snapshots: [unrelated],
    });
    const inbox = selectors.selectInbox(actionOperationStore.getSnapshot());
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.operation.snapshot.operationId).toBe('unrelated-spawn-failure');
    expect(inbox[0]?.operation.snapshot.title).toBe('Create session');

    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('admits an unconsumed Describe Suggest failure after navigation away with its contextual title instead of Start execution run', async () => {
  const selectors = createActionOperationSelectors();
  let settleWait: (() => void) | null = null;
  let startedRun = false;
  suggestionBoundary({
    executionRunStart: async () => {
      startedRun = true;
      return { runId: 'run_nav_away', callId: 'call_nav', sidechainId: 'call_nav' };
    },
    executionRunWait: () =>
      new Promise((resolve) => {
        settleWait = () => resolve(failedRunResult('run_nav_away'));
      }),
    executionRunStop: async () => ({ ok: false, errorCode: 'stop_refused', error: 'Run already settling' }),
  });

  const { fixture, screen, scope } = await openDescribe('auto-inbox-nav-away');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'Studio invoices'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(startedRun).toBe(true));

    // Person navigates away (unmounts Describe) BEFORE the run settles.
    await screen.unmount();

    // Run fails on the daemon after navigation away; its snapshot arrives in the store.
    actionOperationStore.mergeSnapshots({
      serverId: scope.serverId,
      snapshots: [failedExecutionRunSnapshot({ accountId: scope.accountId, runId: 'run_nav_away' })],
    });
    await act(async () => {
      settleWait?.();
      await Promise.resolve();
    });

    const { t } = await import('@/text');
    const inbox = selectors.selectInbox(actionOperationStore.getSnapshot());
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.reason).toBe('failed');
    expect(inbox[0]?.operation.snapshot.operationId).toBe('run_nav_away');
    expect(inbox[0]?.operation.snapshot.title).toBe(t('newApp.auto.suggest'));
    expect(inbox[0]?.operation.snapshot.title).not.toBe('Start execution run');

    // Rendered through ActionOperationLedger with zero special cases in the ledger itself.
    const ledger = await renderScreen(
      <ActionOperationRows
        operations={inbox.map((entry) => entry.operation)}
        presentation="inbox"
        onOpenOperation={() => {}}
      />,
    );
    expect(ledger.getTextContent()).toContain(t('newApp.auto.suggest'));
    expect(ledger.getTextContent()).not.toContain('Start execution run');
    await ledger.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
