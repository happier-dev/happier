import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

import {
  flushHookEffects,
  renderScreen,
  standardCleanup,
  withPopoverWebGlobals,
} from '@/dev/testkit';
import { reportPopoverContentLayout } from '@/dev/testkit/harness/popoverHarness';
import { projectWorkflowInvocationStructure } from './workflowInvocationStructure';
import * as invocationStructure from './workflowInvocationStructure';
import * as flowSlots from '../flow/useWorkflowFlowNodeSlots';
import {
  createWorkflowDefinitionFixture,
  createWorkflowInvocationIndexFixture,
  createWorkflowRunSummaryFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';
/**
 * Static on purpose. This module's dependency graph is large and its first
 * load runs to tens of seconds on a loaded host; imported lazily inside
 * `renderContent` that load was charged to whichever case ran first, which
 * could push it past the test timeout and leave every later case asserting
 * against a screen that never mounted. Loading at collection keeps each case's
 * clock for the behaviour it asserts. `vi.mock` is hoisted above this import.
 */
import { WorkflowRunContent } from './WorkflowRunContent';
import {
  WorkflowReviewCard,
  type WorkflowReviewDraft,
} from './WorkflowReviewCard';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PresentedDetailNavigationProvider } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveWorkflowFlowScopedNodeId } from '@/components/workflows/flow/workflowFlowProjection';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import {
  WorkflowMaterializedLeafV1Schema} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import {
  WorkflowProgressEnvelopeV1Schema,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import {
  createSessionFixture,
  createSessionAccessFixture,
} from '@/dev/testkit/fixtures/sessionFixtures';
import { ModalProvider, useModal } from '@/modal';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Icon } from '@/components/ui/icons/Icon';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { renderPaneMainColumnConsumer } from '@/dev/testkit/harness/paneMainColumnHarness';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

// These Run fixtures do not stream Markdown; keep its external web adapter at the boundary.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: () => {
      throw new Error(
        'Unexpected vendor Markdown reveal in Run rendering test',
      );
    },
  }),
);

// Hoist the Socket SDK boundary before the static screen import loads runtime consumers.
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const virtualizedListState = vi.hoisted(() => ({
  boundary: null as
    | import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState
    | null,
  get props() {
    return this.boundary?.props ?? null;
  },
  scrollToOffset: vi.fn(),
}));
const viewport = vi.hoisted(() => ({ window: { width: 1200, height: 800 } }));
const themeBoundary = vi.hoisted(() => ({ freshProxy: false }));
const arrivalCosts = vi.hoisted(() => new Map<string, {
  read(): { renders: number; commits: number }; reset(): void;
}>());
const selectionCosts = vi.hoisted(() => new Map<string, {
  read(): { renders: number; commits: number }; reset(): void;
}>());
const retireContents: Array<() => Promise<void>> = [];
let restorePopoverGlobals: (() => void) | null = null;
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  const native = await createReactNativeWebMock({
    // Responsive owners read Dimensions directly; keep it on the same viewport as the hook.
    Dimensions: { get: () => ({ ...viewport.window, scale: 2, fontScale: 1 }) },
    useWindowDimensions: () => viewport.window,
  });
  const ReactRuntime = await import('react');
  const { createRenderCommitCounter, useRenderCommitCounter } = await import('@/dev/testkit/performance/counts');
  // Count actual row host work while retaining the real Map and Steps producers.
  const View = ReactRuntime.forwardRef<React.ComponentRef<typeof native.View>, React.ComponentProps<typeof native.View>>((props, ref) => {
    const counter = ReactRuntime.useMemo(() => {
      const counter = createRenderCommitCounter();
      if (props.testID) arrivalCosts.set(props.testID, counter);
      return counter;
    }, [props.testID]);
    useRenderCommitCounter(counter);
    return ReactRuntime.createElement(native.View, { ...props, ref });
  });
  const Pressable = ReactRuntime.forwardRef<React.ComponentRef<typeof native.Pressable>, React.ComponentProps<typeof native.Pressable>>((props, ref) => {
    const counter = ReactRuntime.useMemo(() => {
      const counter = createRenderCommitCounter();
      if (typeof props.testID === 'string' && props.testID) selectionCosts.set(props.testID, counter);
      return counter;
    }, [props.testID]);
    useRenderCommitCounter(counter);
    return ReactRuntime.createElement(native.Pressable, { ...props, ref });
  });
  return { ...native, View, Pressable };
});
// Radix supplies the DOM portal primitives; modal custody and chrome stay real.
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsModuleMock } =
    await import('@/dev/testkit/mocks/radixCjs');
  return createRadixCjsModuleMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  const native = await createUnistylesMock();
  return { ...native, useUnistyles: () => {
    const state = native.useUnistyles();
    // Unistyles 3.5.3 useProxifiedUnistyles creates a new outer proxy on every render.
    return themeBoundary.freshProxy ? { ...state, theme: new Proxy(state.theme, {}) } : state;
  } };
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});
// Substitute only the native recycler; list selection, normalization and refs stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  const boundary = createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>(),
    renderItemLimit: 2,
    refHandle: { scrollToOffset: virtualizedListState.scrollToOffset },
  });
  virtualizedListState.boundary = boundary.state;
  return boundary.module;
});

beforeEach(() => {
  // Route-owned listeners must retain their platform boundary until unmount.
  restorePopoverGlobals = withPopoverWebGlobals();
  getStorage().setState({ workflowRunInvocationsByRunId: {} });
});

afterEach(async () => {
  for (const retire of retireContents.splice(0)) await retire();
  await standardCleanup();
  restorePopoverGlobals?.();
  restorePopoverGlobals = null;
  virtualizedListState.boundary?.reset();
  virtualizedListState.scrollToOffset.mockReset();
  viewport.window = { width: 1200, height: 800 };
  themeBoundary.freshProxy = false;
});

type ContentProps = React.ComponentProps<typeof WorkflowRunContent>;

function publishInvocationFixture(props: ContentProps) {
  const scope = selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), props.serverId ?? null);
  // The real route publishes exact reads before rendering Content. Activity now consumes that
  // same keyed owner, including opened paths when an invocation's parent page is absent.
  const invocations = props.invocations.map(index => {
    const progress = index.id === props.selectedInvocationId && props.selectedInvocationProgress != null
      ? props.selectedInvocationProgress : props.invocationProgressById?.get(index.id);
    return progress === undefined ? index : { ...index, opened: { index, progress, parentRevision: props.run.revision } };
  });
  getStorage().getState().applyWorkflowRunInvocationPage({ runId: props.run.id, scope,
    invocations, mode: 'replace', nextCursor: null, parentRevision: props.run.revision });
}

it('detail-navigation.T1/T2/T6 exposes run pages through the mounted owner without invocation or operation effects', async () => {
  const { readShellColumnActionOwner, invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
  const changed = vi.fn();
  const selected = vi.fn();
  const started = vi.fn();
  const screen = await renderContent({ active: true, onChangeView: changed, onSelectInvocation: selected, onRunAgain: started });
  expect(readShellColumnActionOwner('main')?.tabs).toEqual(['flow', 'steps', 'activity']);
  await act(async () => { await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'steps' }); });
  expect(changed).toHaveBeenCalledExactlyOnceWith('steps');
  await screen.update(<WorkflowRunContent {...screen.contentProps} view="steps" />);
  expect(readShellColumnActionOwner('main')?.activeTab).toBe('steps');
  expect(screen.findHostByTestId('workflow-run-view:steps')?.props.accessibilityState?.selected).toBe(true);
  await act(async () => { await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'steps' }); });
  // Selecting the retained page also returns from an open companion (34ec23a793c).
  expect(readShellColumnActionOwner('main')?.activeTab).toBe('steps');
  expect(selected).not.toHaveBeenCalled();
  expect(started).not.toHaveBeenCalled();
  await screen.unmount();
});

function flattenTestStyle(style: unknown): Record<string, unknown> {
  if (typeof style === 'function') return flattenTestStyle(style({}));
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenTestStyle(entry) }),
      {},
    );
  }
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

async function renderContent(overrides: Partial<ContentProps> = {}) {
  let modals: ReturnType<typeof useModal>['state']['modals'] = [];
  function ObserveModals() {
    modals = useModal().state.modals;
    return null;
  }
  function WorkflowRunPaneProvider({ children }: React.PropsWithChildren) {
    return (
      <ModalProvider>
        <ObserveModals />
        <PresentedDetailNavigationProvider>
          <AppPaneProvider>{children}</AppPaneProvider>
        </PresentedDetailNavigationProvider>
      </ModalProvider>
    );
  }
  const props: ContentProps = {
    // These controls do not need a live transcript; the real pane's inactive contract remains exercised.
    active: false,
    run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
    definition: createWorkflowDefinitionFixture(),
    invocations: [],
    invocationsLoaded: true,
    invocationHistoryComplete: true,
    firstFailedInvocationId: null,
    firstFailedInvocationResolution: 'resolved',
    selectedInvocationId: null,
    onSelectInvocation: vi.fn(),
    view: 'activity',
    onChangeView: vi.fn(),
    ...overrides,
  };
  // The application shell registers its modal host before mounting route content.
  const screen = await renderScreen(<></>, {
    wrapper: WorkflowRunPaneProvider,
    // Native host refs expose measurement; Test Renderer supplies no layout engine.
    createNodeMock: (element) =>
      element.type === 'View'
        ? {
            measureInWindow: (
              receive: (
                x: number,
                y: number,
                width: number,
                height: number,
              ) => void,
            ) => receive(24, 40, 160, 32),
          }
        : null,
  });
  publishInvocationFixture(props);
  await screen.update(React.createElement(WorkflowRunContent, props));
  let mounted = true;
  const retire = async () => {
    if (mounted) await screen.update(<></>);
  };
  retireContents.push(retire);
  return {
    ...screen,
    update: async (element: React.ReactElement) => {
      if (element.type === WorkflowRunContent) publishInvocationFixture(element.props as ContentProps);
      await screen.update(element);
    },
    contentProps: props,
    visibleModals: () =>
      modals.filter((entry) => 'visible' in entry && entry.visible),
    unmount: async () => {
      await retire();
      mounted = false;
      await screen.unmount();
    },
  };
}

it('keeps pane consumers asleep across unrelated publications and local controls in a 500-item Run', async () => {
  const props: Partial<ContentProps> = {
    title: 'Large Run',
    invocations: Array.from({ length: 500 }, (_, index) => createWorkflowInvocationIndexFixture({ id: `pane-${index}` })),
  };
  const screen = await renderContent(props);
  const descriptor = () => screen.findByType(AppPaneScopeHost).props.mainColumn;
  const consumer = await renderPaneMainColumnConsumer(descriptor());
  expect(consumer.read().current?.identity).toMatchObject({ name: 'Large Run', state: 'working' });
  consumer.reset();
  await act(async () => { getStorage().setState({ socketStatus: 'disconnected' }); });
  await consumer.publish(descriptor());
  expect(consumer.read().executions).toBe(0);
  await openTechnicalDetails(screen);
  await consumer.publish(descriptor());
  expect(consumer.read().executions).toBe(0);

  // Sensitivity: a wrongly rebound fresh identity really wakes the exact consumer.
  const settled = descriptor();
  await consumer.publish({ ...settled, identity: { ...settled.identity } });
  expect(consumer.read().executions).toBe(1);
  await screen.update(<WorkflowRunContent {...screen.contentProps}
    title="Renamed Run" run={createWorkflowRunSummaryFixture({ state: 'running', attentionRequired: true })} />);
  await consumer.publish(descriptor());
  expect(consumer.read().current?.identity).toMatchObject({ name: 'Renamed Run', state: 'attention' });
});

it('does no Map-only projection work for a 500-item Run while Activity is shown, then projects current facts on open', async () => {
  // Observe the real projection without replacing any internal domain logic.
  const mapProjection = vi.spyOn(invocationStructure, 'projectWorkflowFlowRunStates');
  const definition = createWorkflowDefinitionFixture({ blocks: Array.from({ length: 500 }, (_, index) => ({
    kind: 'wait', id: `wait-${index}`, document: { text: 'Review', references: [], attachments: [] },
  })) });
  const root = createWorkflowInvocationIndexFixture({ id: 'cost-root' });
  const invocations = [root, ...Array.from({ length: 500 }, (_, index) => createWorkflowInvocationIndexFixture({
    id: `item-${index}`, parentRecordId: root.id, sequence: String(index + 1), memberOrdinal: String(index),
    lifecycle: index === 499 ? 'waiting_for_review' : 'completed',
  }))];
  const props: ContentProps = {
    active: false, run: createWorkflowRunSummaryFixture(), definition, invocations,
    invocationsLoaded: true, invocationHistoryComplete: true, firstFailedInvocationId: null,
    firstFailedInvocationResolution: 'resolved', selectedInvocationId: null, onSelectInvocation: vi.fn(),
    view: 'activity', onChangeView: vi.fn(),
  };
  try {
    const screen = await renderContent(props);
    expect(mapProjection).toHaveBeenCalledTimes(0);
    const changed = invocations.map(row => row.id === 'item-499'
      ? createWorkflowInvocationIndexFixture({ ...row, lifecycle: 'completed' }) : row);
    await screen.update(<WorkflowRunContent {...props} invocations={changed} />);
    expect(mapProjection).toHaveBeenCalledTimes(0);
    await screen.update(<WorkflowRunContent {...props} invocations={changed} view="flow" />);
    expect(mapProjection).toHaveBeenCalledTimes(1);
    const states = mapProjection.mock.results[0]?.value;
    expect(states?.get(resolveWorkflowFlowScopedNodeId('wait-499', []))).toMatchObject([
      { invocationId: 'item-499', lifecycle: 'completed' },
    ]);
    expect(states?.get(resolveWorkflowFlowScopedNodeId('wait-498', []))).toMatchObject([
      { invocationId: 'item-498', lifecycle: 'completed' },
    ]);
  } finally { mapProjection.mockRestore(); }
});

it.each(['flow', 'steps'] as const)('measures a 500-item %s arrival without waking it for unrelated state', async view => {
  arrivalCosts.clear();
  const definition = createWorkflowDefinitionFixture({ blocks: Array.from({ length: 500 }, (_, index) => ({
    kind: 'wait', id: `budget-${index}`, document: { text: `Review ${index}`, references: [], attachments: [] },
  })) });
  const root = createWorkflowInvocationIndexFixture({ id: 'budget-root' });
  const invocations = [root, ...Array.from({ length: 500 }, (_, index) => createWorkflowInvocationIndexFixture({
    id: `budget-item-${index}`, parentRecordId: root.id, memberOrdinal: String(index), sequence: String(index + 1),
    lifecycle: index === 499 ? 'running' : 'completed',
  }))];
  const screen = await renderContent({ definition, invocations, view });
  const reset = () => { for (const counter of arrivalCosts.values()) counter.reset(); };
  const read = () => [...arrivalCosts].filter(([id]) => id.includes('budget-') && !id.includes('budget-499'))
    .reduce((sum, [, counter]) => sum + counter.read().renders, 0);
  reset();
  await act(async () => { getStorage().setState({ socketStatus: 'disconnected' }); });
  expect(read()).toBe(0);
  const changed = invocations.map(row => row.id === 'budget-item-499'
    ? createWorkflowInvocationIndexFixture({ ...row, lifecycle: 'completed', contentRevision: '1' }) : row);
  let commits = 0;
  await screen.update(<React.Profiler id="arrival" onRender={() => { commits += 1; }}>
    <WorkflowRunContent {...screen.contentProps} invocations={invocations} />
  </React.Profiler>);
  reset(); commits = 0;
  await screen.update(<React.Profiler id="arrival" onRender={() => { commits += 1; }}>
    <WorkflowRunContent {...screen.contentProps} invocations={changed} />
  </React.Profiler>);
  const measured = { view, items: 500, commits, unrelatedRowHostRenders: read(),
    changedRows: [...arrivalCosts].filter(([id, counter]) => id.includes('budget-499') && counter.read().renders > 0).length };
  console.info('FIN-FLOWBUDGET Run arrival', measured);
  expect(measured.changedRows).toBeGreaterThan(0);
  expect(measured.commits).toBeLessThanOrEqual(2);
  expect(measured.unrelatedRowHostRenders).toBe(0);
  // The changed lifecycle must survive the real projection, not a quiet-path-only optimization.
  expect(screen.findAll(node => typeof node.props.testID === 'string' && node.props.testID.includes('budget-499'))
    .some(node => node.findAllByType(WorkflowLifecycleStatus).some(status => status.props.lifecycle === 'completed'))).toBe(true);
});

it.each(['flow', 'steps'] as const)('selects a node in a 500-item %s with only the two affected rows rendering', async view => {
  themeBoundary.freshProxy = true;
  const costs = view === 'flow' ? selectionCosts : arrivalCosts;
  costs.clear();
  const definition = createWorkflowDefinitionFixture({ blocks: Array.from({ length: 500 }, (_, index) => ({
    kind: 'wait', id: `selection-${index}`, document: { text: `Review ${index}`, references: [], attachments: [] },
  })) });
  const root = createWorkflowInvocationIndexFixture({ id: 'selection-root' });
  const invocations = [root, ...Array.from({ length: 500 }, (_, index) => createWorkflowInvocationIndexFixture({
    id: `selection-item-${index}`, parentRecordId: root.id, memberOrdinal: String(index), sequence: String(index + 1),
    lifecycle: 'completed',
  }))];
  const screen = await renderContent({ definition, invocations, view, selectedInvocationId: 'selection-item-0' });
  let commits = 0;
  const content = (selectedInvocationId: string) => <React.Profiler id="selection" onRender={() => { commits += 1; }}>
    <WorkflowRunContent {...screen.contentProps} selectedInvocationId={selectedInvocationId} />
  </React.Profiler>;
  await screen.update(content('selection-item-0'));
  for (const selected of [1, 2]) {
    for (const counter of costs.values()) counter.reset();
    commits = 0;
    await screen.update(content(`selection-item-${selected}`));
    const changedRows = [...costs].filter(([id, counter]) =>
      /(?:flow-node-selection-\d+|steps-selection-\d+-block)$/.test(id) && counter.read().renders > 0).map(([id]) => id);
    const rowRenders = changedRows.reduce((total, id) => total + (costs.get(id)?.read().renders ?? 0), 0);
    console.info('WORKMAP-SELECT selection', { view, selected, commits, rowRenders, changedRows: changedRows.length });
    expect(changedRows.length).toBeLessThanOrEqual(2);
    expect(changedRows).toHaveLength(2);
    expect(changedRows.some(id => id.includes(`selection-${selected - 1}`))).toBe(true);
    expect(changedRows.some(id => id.includes(`selection-${selected}`))).toBe(true);
    if (view === 'flow') {
      expect(screen.findByTestId(`workflow-run-flow-node-selection-${selected}`)?.props.accessibilityState.selected).toBe(true);
      expect(screen.findByTestId(`workflow-run-flow-node-selection-${selected - 1}`)?.props.accessibilityState.selected).toBe(false);
    }
    expect(commits).toBeLessThanOrEqual(2);
  }
});

it('renders For-each value names and stopped occurrence facts through the real Run body', async () => {
  const definition = createWorkflowDefinitionFixture({
    blocks: [
      {
        kind: 'loop',
        id: 'files',
        repetition: {
          kind: 'items',
          items: { kind: 'literal', value: ['#1482', 'src/main.ts'] },
          execution: 'parallel',
          failurePolicy: 'collect_outcomes',
        },
        body: [
          {
            kind: 'action',
            id: 'inspect',
            name: 'Inspect files',
            actionId: 'notifications.notify_me',
            input: {},
          },
        ],
      },
    ],
  });
  const root = createWorkflowInvocationIndexFixture({
    id: 'root',
    parentRecordId: null,
    sequence: '0',
  });
  const loop = createWorkflowInvocationIndexFixture({
    id: 'loop',
    parentRecordId: root.id,
    sequence: '1',
  });
  const frames = ['#1482', 'src/main.ts'].map((_, index) =>
    createWorkflowInvocationIndexFixture({
      id: `frame-${index}`,
      parentRecordId: loop.id,
      memberOrdinal: String(index),
      sequence: String(index * 2 + 2),
      lifecycle: 'cancelled',
    }),
  );
  const leaves = frames.map((frame, index) =>
    createWorkflowInvocationIndexFixture({
      id: `leaf-${index}`,
      parentRecordId: frame.id,
      sequence: String(index * 2 + 3),
      lifecycle: 'cancelled',
    }),
  );
  const invocations = [root, loop, ...frames, ...leaves];
  const progress = new Map(
    frames.map((frame, index) => [
      frame.id,
      WorkflowProgressEnvelopeV1Schema.parse({
        kind: 'happier.workflow-progress.v1',
        blockKind: 'loop',
        attempt: frame.attempt,
        logicalInvocationRecordId: frame.id,
        invocationPath: {
          blockId: 'files',
          scope: [{ kind: 'iteration', blockId: 'files', index }],
        },
        frame: {
          ownerBlockId: 'files',
          source: {
            kind: 'item',
            index: String(index),
            displayLabel: ['#1482', 'src/main.ts'][index],
          },
        },
      }),
    ]),
  );
  const selected = WorkflowProgressEnvelopeV1Schema.parse({
    kind: 'happier.workflow-progress.v1',
    blockKind: 'action',
    attempt: '0',
    logicalInvocationRecordId: 'leaf-0',
    invocationPath: {
      blockId: 'inspect',
      scope: [{ kind: 'iteration', blockId: 'files', index: 0 }],
    },
    timing: {
      startedAt: '2026-10-12T10:00:00.000Z',
      finishedAt: '2026-10-12T10:01:00.000Z',
    },
    result: 'Partial findings',
  });
  const screen = await renderContent({
    definition,
    invocations,
    view: 'flow',
    selectedInvocationId: 'leaf-0',
    selectedInvocationProgress: selected,
    run: createWorkflowRunSummaryFixture({ state: 'cancelled' }),
    invocationStructure: projectWorkflowInvocationStructure({
      definition,
      invocations,
      progressByInvocationId: progress,
      invocationEvidenceById: new Map(
        frames.map((frame) => [
          frame.id,
          { index: frame, progress: progress.get(frame.id)! },
        ]),
      ),
    }),
  });
  expect(screen.getTextContent()).toContain('#1482');
  await screen.pressByTestIdAsync('workflow-run-flow-node-files-item-selector-next');
  expect(screen.getTextContent()).toContain('src/main.ts');
  expect(screen.getTextContent()).toContain('Partial findings');
  expect(screen.getTextContent()).toContain(
    'workflows.invocationState.cancelled',
  );
});

/** Exact opened evidence identifies leaves when their parent lies outside the loaded page. */
function openedLeafProgress(...ids: string[]) {
  return new Map(
    ids.map((id) => [
      id,
      WorkflowProgressEnvelopeV1Schema.parse({
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: id,
      }),
    ]),
  );
}

/** Technical details live behind the page's ⋯ menu (DESIGN-13): open the menu, choose the action. */
async function openTechnicalDetails(
  screen: Awaited<ReturnType<typeof renderContent>>,
) {
  await withPopoverWebGlobals(async () => {
    await screen.pressByTestIdAsync('workflow-run-overflow');
    await layoutPopoverContent(screen);
    await screen.pressByTestIdAsync('workflow-run-technical-toggle');
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  });
}

async function layoutPopoverContent(
  screen: Awaited<ReturnType<typeof renderContent>>,
) {
  // Test Renderer does not emit the native layout event that makes portal content interactive.
  await act(async () => {
    reportPopoverContentLayout(screen, { width: 260, height: 240 });
  });
  await flushHookEffects({ cycles: 2, frames: 1 });
}

describe('WorkflowRunContent', () => {
  it('labels the run Pause control with what it does, "Pause at boundary" (07 §2.3 item 6)', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'running', availability: { cancel: true, pause: true } }),
      onPause: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(screen.findByTestId('workflow-run-pause')).not.toBeNull();
    // The visible words, not only the accessible name.
    expect(screen.getTextContent()).toContain('workflows.run.pauseAtBoundary');
    expect(screen.getTextContent()).not.toMatch(/workflows\.run\.pause(?!AtBoundary)/);
  });
  it.each(['paused', 'interrupted'] as const)('keeps one primary boundary control for a $state Run without replaying its held work', async (state) => {
    const onResume = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state,
        availability: { cancel: true, pause: false, resumeBoundary: true },
      }),
      onResume,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'held',
          parentRecordId: 'root',
          lifecycle: 'waiting_for_review',
        }),
      ],
      invocationProgressById: openedLeafProgress('held'),
      selectedInvocationId: null,
    });
    expect(screen.findByTestId('workflow-run-needs-you')).not.toBeNull();
    expect(screen.findAllByType(ToolbarButton).filter((button) => button.props.tone === 'primary')
      .map((button) => button.props.testID)).toEqual(['workflow-run-resume']);
    expect(screen.getTextContent())
      .toContain(state === 'interrupted' ? 'common.continue' : 'workflows.run.resume');
    await screen.pressByTestIdAsync('workflow-run-resume');
    expect(onResume).toHaveBeenCalledOnce();
  });
  it('keeps the Paused mark calm while Needs you carries the hold (FIN-DESIGN-REVIEW L2)', async () => {
    const pausedRun = createWorkflowRunSummaryFixture({
      state: 'paused',
      availability: { cancel: true, pause: false, resumeBoundary: true },
    });
    const markColor = (screen: Awaited<ReturnType<typeof renderContent>>) => screen
      .findByTestId('workflow-run-outcome-mark')?.findAll((node) => typeof node.props.color === 'string')[0]?.props.color;
    const calm = markColor(await renderContent({ run: pausedRun, onResume: vi.fn(), selectedInvocationId: null }));
    const held = await renderContent({
      run: { ...pausedRun, attentionRequired: true },
      onResume: vi.fn(),
      invocations: [
        createWorkflowInvocationIndexFixture({ id: 'held', parentRecordId: 'root', lifecycle: 'waiting_for_review' }),
      ],
      invocationProgressById: openedLeafProgress('held'),
      selectedInvocationId: null,
    });
    expect(held.findByTestId('workflow-run-needs-you')).not.toBeNull();
    expect(calm).toBeDefined();
    expect(markColor(held)).toBe(calm);
  });
  it('makes Stop the one primary of an interrupted Run with nothing to resume (FIN-DESIGN-REVIEW H3)', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'interrupted',
        availability: { cancel: true, pause: false, resumeBoundary: false },
      }),
      onCancel: vi.fn(),
      selectedInvocationId: null,
    });
    expect(screen.findAllByType(ToolbarButton).filter((button) => button.props.tone === 'primary')
      .map((button) => button.props.testID)).toEqual(['workflow-run-cancel']);
  });
  it('retires stale holds when the Run settles after Stop', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'cancelled',
        workflowCustodyState: 'settled',
      }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'held',
          parentRecordId: 'root',
          lifecycle: 'waiting_for_review',
        }),
      ],
      invocationProgressById: openedLeafProgress('held'),
    });
    expect(screen.findByTestId('workflow-run-needs-you')).toBeNull();
    expect(screen.findByTestId('workflow-run-review-primary')).toBeNull();
  });
  it('keeps stopping containers out of Needs you while retaining the held leaf', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'parallel',
          id: 'lanes',
          failurePolicy: 'collect_outcomes',
          branches: [
            {
              id: 'lane',
              blocks: [
                {
                  kind: 'wait',
                  id: 'confirm',
                  document: {
                    text: 'Confirm',
                    references: [],
                    attachments: [],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const row = (
      id: string,
      parentRecordId: string | null,
      memberOrdinal: string,
      lifecycle: 'cancel_requested' | 'waiting_for_review',
      sequence: string,
    ) =>
      createWorkflowInvocationIndexFixture({
        id,
        parentRecordId,
        memberOrdinal,
        lifecycle,
        sequence,
      });
    const screen = await renderContent({
      definition,
      run: createWorkflowRunSummaryFixture({ state: 'running' }),
      invocations: [
        row('root', null, '0', 'cancel_requested', '0'),
        row('parallel', 'root', '0', 'cancel_requested', '1'),
        row('frame', 'parallel', '0', 'cancel_requested', '2'),
        row('held', 'frame', '0', 'waiting_for_review', '3'),
      ],
    });
    expect(screen.findByTestId('workflow-run-needs-you-held')).not.toBeNull();
    for (const id of ['root', 'parallel', 'frame']) {
      expect(screen.findByTestId(`workflow-run-needs-you-${id}`)).toBeNull();
    }
  });
  it('describes exact stopping input custody without calling it a review hold', async () => {
    const screen = await renderContent({
      cancelRequested: true,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'stopping',
          parentRecordId: 'root',
          lifecycle: 'cancel_requested',
        }),
      ],
      invocationProgressById: openedLeafProgress('stopping'),
    });
    const row = screen.findByTestId('workflow-run-needs-you-stopping');
    expect(row).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      'workflows.run.attentionReviewRow',
    );
    expect(screen.findByTestId('workflow-run-needs-you')).toBeNull();
  });
  it.each([
    ['while a Stop is being carried out', { cancelRequested: true, run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }) }],
    ['once terminal with its publication custody pending', { run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded', workflowCustodyState: 'pending' }) }],
  ] as const)('opens each pending publication request from the Run %s', async (_name, overrides) => {
    const open = vi.fn();
    const screen = await renderContent({
      ...overrides,
      publicationRequests: [
        { artifactId: 'first', href: '/inbox/approvals/first?serverId=home' },
        { artifactId: 'second', href: '/inbox/approvals/second?serverId=home' },
      ],
      onOpenPublicationRequest: open,
    });
    expect(screen.getTextContent()).toContain('approvals.waitingForYou');
    await screen.pressByTestIdAsync('workflow-run-publication-request-second.open');
    // Navigation only: it names exactly the pressed request and offers no way to decide it from the Run.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/inbox/approvals/second?serverId=home');
  });
  it('shows no publication request control when the Run has none to open', async () => {
    const screen = await renderContent({ publicationRequests: [], onOpenPublicationRequest: vi.fn() });
    expect(screen.getTextContent()).not.toContain('inbox.work.detail.openApproval');
    expect(screen.findByTestId('workflow-run-publication-request-first')).toBeNull();
  });
  it.each([1200, 390])(
    'places source actions in the phone menu and on the wide tab row at width %s',
    async (width) => {
      viewport.window = { width, height: 844 };
      for (const kind of ['edit', 'open', 'sourceless', 'deleted'] as const) {
        const onSource = vi.fn();
        const onSave = vi.fn();
        const screen = await renderContent({
          hasSource: kind !== 'sourceless',
          sourceAction:
            kind === 'edit' || kind === 'open'
              ? { kind, onPress: onSource }
              : null,
          onSaveAsWorkflow: onSave,
        });
        const actionId =
          kind === 'sourceless' ? 'save-as-workflow' : `${kind}-workflow`;
        expect(
          screen.findByTestId('workflow-run-show-current-work'),
        ).not.toBeNull();
        if (kind === 'deleted') {
          expect(screen.findByTestId('workflow-run-edit-workflow')).toBeNull();
          expect(screen.findByTestId('workflow-run-open-workflow')).toBeNull();
          expect(
            screen.findByTestId('workflow-run-save-as-workflow'),
          ).toBeNull();
        } else {
          if (width === 390) {
            expect(screen.findByTestId(`workflow-run-${actionId}`)).toBeNull();
            await screen.pressByTestIdAsync('workflow-run-overflow');
            await layoutPopoverContent(screen);
          }
          expect(screen.findByTestId(`workflow-run-${actionId}`)).not.toBeNull();
          await screen.pressByTestIdAsync(`workflow-run-${actionId}`);
          if (width === 390) {
            // The web menu closes before its action runs on the next macrotask.
            await act(async () => {
              await new Promise((resolve) => { setTimeout(resolve, 0); });
            });
          }
          expect(
            kind === 'sourceless' ? onSave : onSource,
          ).toHaveBeenCalledOnce();
          expect(
            screen.findByTestId(
              kind === 'edit'
                ? 'workflow-run-open-workflow'
                : 'workflow-run-edit-workflow',
            ),
          ).toBeNull();
        }
        await screen.unmount();
      }
    },
  );

  it('keeps the sourceless Save control visible and announces pending work without another dispatch', async () => {
    const onSave = vi.fn();
    const screen = await renderContent({
      hasSource: false,
      onSaveAsWorkflow: onSave,
      saveAsWorkflowPending: true,
    });

    const save = screen.findHostByTestId('workflow-run-save-as-workflow');
    expect(save).toBeDefined();
    expect(save?.props.accessibilityRole ?? save?.props.role).toBe('button');
    expect(save?.props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
    await screen.pressByTestIdAsync('workflow-run-save-as-workflow');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('explains missing requester custody even when the Run never started a step', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'failed',
        errorCode: 'requester_custody_unavailable',
      }),
      invocations: [],
    });

    expect(screen.getTextContent()).toContain('workflows.problem.requesterCustodyUnavailable');
  });

  it.each(['failed', 'interrupted'] as const)('explains a %s Run from its exact failed leaf without attention or selection', async (state) => {
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'publish',
      lifecycle: 'failed',
    });
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state }),
      definition: createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'step',
            id: 'publish',
            name: 'Publish summary',
            document: {
              text: 'Publish the summary',
              references: [],
              attachments: [],
            },
            input: [],
            result: { kind: 'text' },
          },
        ],
      }),
      invocations: [invocation],
      selectedInvocationId: null,
      firstFailedInvocationId: invocation.id,
      firstFailedInvocationResolution: 'resolved',
      invocationHistoryComplete: false,
      invocationProgressById: new Map([
        [
          invocation.id,
          {
            kind: 'happier.workflow-progress.v1',
            invocationPath: { blockId: 'publish', scope: [] },
            blockKind: 'step',
            attempt: '0',
            logicalInvocationRecordId: invocation.id,
            reason: {
              code: 'step_failed',
              message: 'The publishing service refused the request.',
            },
          },
        ],
      ]),
    });
    expect(screen.getTextContent()).toContain(
      `workflows.run.outcomeLine:${JSON.stringify({
        word: `workflows.runState.${state}`,
        sentence: 'workflows.run.failedStepSentence:{"step":"Publish summary"}',
      })}`,
    );
    expect(screen.getTextContent()).toContain(
      'The publishing service refused the request.',
    );
  });

  it.each([false, true])('leads with the existing recovery instruction before a failed step is opened, usage limit: %s', async (usageLimit) => {
    const invocation = createWorkflowInvocationIndexFixture({ id: 'failed', parentRecordId: 'root', lifecycle: 'failed' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'analyze', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocation.id,
      reason: { code: 'session_input_target_update_required',
        ...(usageLimit ? { runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit',
          source: 'usage_limit', occurredAt: 100, sanitizedPreview: 'Usage limit reached',
          usageLimit: { v: 1, resetAtMs: 1_900_000_000_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } } } : {}) },
    });
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted', workflowCustodyState: 'pending' }),
      invocations: [invocation], invocationProgressById: new Map([[invocation.id, progress]]),
      selectedInvocationId: null, firstFailedInvocationId: invocation.id, onCancel: vi.fn(),
    });
    expect(screen.findByTestId('workflow-run-cancel')).toBeTruthy();
    expect(screen.getTextContent()).toContain(usageLimit ? 'workflows.recovery.usageLimitWait' : 'workflows.recovery.nextStop');
  });

  it('does not tell the person to stop and run again beside the recovery choice that keeps completed steps (RUN1109-1)', async () => {
    const invocation = createWorkflowInvocationIndexFixture({ id: 'failed', parentRecordId: 'root', lifecycle: 'failed' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'analyze', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocation.id,
      reason: { code: 'session_input_target_update_required' } });
    const notPrepared = { kind: 'unavailable', reason: 'recovery_not_prepared' } as const;
    const open = {
      run: createWorkflowRunSummaryFixture({ state: 'interrupted', workflowCustodyState: 'pending' }),
      invocations: [invocation], selectedInvocationId: invocation.id, selectedInvocationProgress: progress,
      invocationProgressById: new Map([[invocation.id, progress]]), firstFailedInvocationId: invocation.id,
      firstFailedInvocationResolution: 'resolved' as const, onCancel: vi.fn(),
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: [invocation.id] }, continueSameConversation: notPrepared,
        continueFreshAgent: { kind: 'available' }, restoreWorkspace: notPrepared,
      } as never,
    };
    const offered = await renderContent({ ...open, onRetryFreshAgent: vi.fn() });
    expect(offered.findByTestId('workflow-run-retry-fresh')).toBeTruthy();
    expect(offered.findByTestId('workflow-run-failure-next')).toBeNull();
    // The same attempt with no way to act on the choice has nothing to offer: the Run's Stop is still the way on.
    const notOffered = await renderContent(open);
    expect(notOffered.findByTestId('workflow-run-failure-next')?.props.children).toBe('workflows.recovery.nextStop');
  });

  it('says when recovery choices appear on the Run page while its Machine is away, once beside an open failure', async () => {
    // WAVE-ACCEPT-1117B fix 6: the phone page had no next step; only the wide step pane said it.
    const invocation = createWorkflowInvocationIndexFixture({ id: 'failed', parentRecordId: 'root', lifecycle: 'failed' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'analyze', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocation.id,
      reason: { code: 'machine_unavailable', message: 'The target Machine was offline.' } });
    const offline = {
      run: createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' }),
      machineName: 'MacBook Pro', machineReachable: false, invocations: [invocation],
      invocationProgressById: new Map([[invocation.id, progress]]), firstFailedInvocationId: invocation.id,
      firstFailedInvocationResolution: 'resolved' as const,
    };
    const reconnect = 'workflows.recovery.choicesOnReconnect:{"machine":"MacBook Pro"}';
    viewport.window = { width: 390, height: 844 };
    const phone = await renderContent({ ...offline, selectedInvocationId: null });
    expect(phone.findByTestId('workflow-run-failure-next')?.props.children).toBe(reconnect);
    // Its pages live in the phone bar and a settled Run folds its source action, so no empty switch band holds a gap.
    expect(phone.findByTestId('workflow-run-view:activity')).toBeNull();
    expect(phone.findByTestId('workflow-run-view-switch')).toBeNull();
    // WAVE-ACCEPT-1117C: the Run's headline says "Failed"; the failed row says it by its glyph, not a second word.
    expect(phone.findByTestId('workflow-run-invocations-word-failed')).toBeNull();
    // A phone list has no step open beside it, so the opening selection does not rest on a row.
    const phoneSelected = await renderContent({ ...offline, selectedInvocationId: invocation.id, selectedInvocationProgress: progress });
    expect(phoneSelected.findByTestId('workflow-run-invocations-row-failed')).not.toBeNull();
    expect(phoneSelected.findByTestId('workflow-run-invocations-row-failed')?.props.current).toBeUndefined();
    viewport.window = { width: 1440, height: 900 };
    const nothingOpen = await renderContent({ ...offline, selectedInvocationId: null });
    expect(nothingOpen.findByTestId('workflow-run-failure-next')?.props.children).toBe(reconnect);
    expect(nothingOpen.findByTestId('workflow-run-view-switch')).not.toBeNull();
    // The failed step open beside the Run says it in its own card; the page does not repeat it.
    const open = await renderContent({ ...offline, selectedInvocationId: invocation.id, selectedInvocationProgress: progress });
    expect(open.findByTestId('workflow-run-failure-next')).toBeNull();
    expect(open.getTextContent()).toContain(reconnect);
  });

  it('says Skipped on a completed Run map for a step it never ran, and only when the history is complete', async () => {
    const root = createWorkflowInvocationIndexFixture({ id: 'root', lifecycle: 'completed' });
    const taken = createWorkflowInvocationIndexFixture({ id: 'taken', parentRecordId: root.id, sequence: '1', lifecycle: 'completed' });
    const definition = createWorkflowDefinitionFixture({ blocks: [
      { kind: 'wait', id: 'taken', name: 'List machines', document: { text: 'List', references: [], attachments: [] } },
      { kind: 'wait', id: 'untaken', name: 'Alternative check', document: { text: 'Other', references: [], attachments: [] } },
    ] });
    const progress = new Map([[root.id, WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
      blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: root.id })],
      [taken.id, WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
        blockKind: 'wait', invocationPath: { blockId: 'taken', scope: [] }, attempt: '0', logicalInvocationRecordId: taken.id })]]);
    const render = (state: 'succeeded' | 'cancelled', invocationHistoryComplete = true) => renderContent({
      run: createWorkflowRunSummaryFixture({ state, workflowCustodyState: 'settled' }),
      definition, view: 'flow', invocations: [root, taken], invocationProgressById: progress, invocationHistoryComplete,
    });
    const completed = await render('succeeded');
    expect(completed.findByTestId('workflow-run-flow-node-untaken-not-started')?.props.children).toBe('workflows.invocationState.skipped');
    expect(completed.findByTestId('workflow-run-flow-node-taken-not-started')).toBeNull();
    await completed.unmount();
    const stopped = await render('cancelled');
    expect(stopped.findByTestId('workflow-run-flow-node-untaken-not-started')).toBeNull();
    await stopped.unmount();
    const partial = await render('succeeded', false);
    expect(partial.findByTestId('workflow-run-flow-node-untaken-not-started')).toBeNull();
    await partial.unmount();
  });

  it.each(['flow', 'steps'] as const)('keeps a failed step outcome honest about unreached leaves in %s only after history completes', async (view) => {
    const failed = createWorkflowInvocationIndexFixture({ id: 'failed', lifecycle: 'failed' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
      blockKind: 'wait', invocationPath: { blockId: 'first', scope: [] }, attempt: '0', logicalInvocationRecordId: failed.id });
    const render = (invocationHistoryComplete: boolean) => renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' }),
      definition: createWorkflowDefinitionFixture({ blocks: [
        { kind: 'wait', id: 'first', name: 'First check', document: { text: 'Check', references: [], attachments: [] } },
        { kind: 'wait', id: 'later', name: 'Later check', document: { text: 'Check later', references: [], attachments: [] } },
      ] }),
      view, invocations: [failed], invocationProgressById: new Map([[failed.id, progress]]),
      invocationHistoryComplete, firstFailedInvocationId: failed.id, firstFailedInvocationResolution: 'resolved',
    });
    const complete = await render(true);
    expect(complete.getTextContent()).toContain('workflows.run.notReached');
    await complete.unmount();
    const partial = await render(false);
    expect(partial.getTextContent()).not.toContain('workflows.run.notReached');
    await partial.unmount();
  });

  it('keeps the completed Wait completed after its Run fails from lost contact (R4)', async () => {
    const root = createWorkflowInvocationIndexFixture({ id: 'root', lifecycle: 'failed' });
    const completed = createWorkflowInvocationIndexFixture({ id: 'check', parentRecordId: root.id, sequence: '1', lifecycle: 'completed' });
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' }),
      definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'check', name: 'Review release readiness',
        document: { text: 'Ready?', references: [], attachments: [] } }] }),
      view: 'flow', invocations: [root, completed], firstFailedInvocationId: root.id,
      machineReachable: false, machineName: 'Build box', machineLastSeenAt: 1791633660000,
      invocationProgressById: new Map([[root.id, WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
        blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: root.id })]]),
    });
    expect(screen.findAllByType(WorkflowLifecycleStatus).find(node => node.props.testID === 'workflow-run-flow-node-check-state')?.props.lifecycle).toBe('completed');
    expect(screen.findAllByType(Icon).filter(node => node.props.name === 'hand')).toHaveLength(0);
  });

  it('shows current executable work without selecting a completed row or a running frame', async () => {
    const onSelectInvocation = vi.fn();
    const rows = [
      createWorkflowInvocationIndexFixture({
        id: 'frame',
        lifecycle: 'running',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'old',
        lifecycle: 'completed',
        sequence: '1',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'current',
        lifecycle: 'running',
        sequence: '2',
        attempt: '1',
      }),
    ];
    const progress = (blockId: string, attempt: string) => ({
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId, scope: [] },
      blockKind: 'step' as const,
      attempt,
      logicalInvocationRecordId: 'old',
    });
    const screen = await renderContent({
      invocations: rows,
      onSelectInvocation,
      invocationProgressById: new Map([
        ['old', progress('analyze', '0')],
        ['current', progress('analyze', '1')],
      ]),
    });
    await screen.pressByTestIdAsync('workflow-run-show-current-work');
    expect(onSelectInvocation).toHaveBeenCalledWith('current');
    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent as never)
          ?.props as ContentProps),
        run: createWorkflowRunSummaryFixture({ state: 'succeeded' }),
      }),
    );
    expect(screen.findByTestId('workflow-run-show-current-work') === null).toBe(
      true,
    );
  });

  it('draws no pane of its own when it is shown inside another pane, and keeps its header to the title', async () => {
    viewport.window = { width: 1200, height: 844 };
    const invocation = createWorkflowInvocationIndexFixture({ id: 'step-1' });
    const paused = createWorkflowRunSummaryFixture({
      id: 'run-1',
      state: 'running',
    });
    const standalone = await renderContent({
      run: paused,
      invocations: [invocation],
      selectedInvocationId: invocation.id,
      onCancel: vi.fn(),
    });
    expect(standalone.findAllByTestId('details-pane').length).toBeGreaterThan(
      0,
    );
    const standaloneHeader = standalone
      .findAllByTestId('workflow-run-header')
      .find((node) => 'leading' in node.props);
    expect(standaloneHeader?.props.leading).toBeTruthy();
    expect(standaloneHeader?.props.actions).toBeTruthy();
    await standardCleanup();

    const embedded = await renderContent({
      run: paused,
      invocations: [invocation],
      selectedInvocationId: invocation.id,
      onCancel: vi.fn(),
      embedded: true,
    });
    // The host pane is the pane: no nested details column, no second right rail.
    expect(embedded.findAllByTestId('details-pane')).toHaveLength(0);
    // One header layout for every detail kind in a pane (lab session-D): the pane's band header with
    // the thing's mark and name, the pane's own controls at its end and nothing else beside them.
    const header = embedded
      .findAllByTestId('workflow-run-header')
      .find(
        (node) => 'title' in node.props && typeof node.props.title === 'string',
      );
    expect(header?.props.leading).toBeTruthy();
    expect(header?.props.actions).toBeUndefined();
    // The run's own controls stay reachable, on the row under the band.
    expect(embedded.findByTestId('workflow-run-controls')).not.toBeNull();
    expect(embedded.findByTestId('workflow-run-cancel')).not.toBeNull();
  });

  it.each([1200, 390])(
    'retains accepted nested attempt context in the shared header across views at width %s',
    async (width) => {
      viewport.window = { width, height: 844 };
      const definition = createWorkflowDefinitionFixture({
        blocks: [
          ...createWorkflowDefinitionFixture().blocks,
          {
            kind: 'workflow',
            id: 'call',
            workflowRef: 'builtin:review',
            input: {},
          },
        ],
      });
      const childDefinition = createWorkflowDefinitionFixture();
      const frozenChildren = {
        'builtin:review': {
          ...childDefinition,
          blocks: childDefinition.blocks.map((block) => ({
            ...block,
            name: 'Frozen inspection',
          })),
        },
      };
      const invocation = createWorkflowInvocationIndexFixture({
        id: 'retry',
        attempt: '1',
      });
      const progress = {
        kind: 'happier.workflow-progress.v1' as const,
        invocationPath: {
          blockId: 'analyze',
          scope: [
            { kind: 'workflow' as const, blockId: 'call' },
            { kind: 'iteration' as const, blockId: 'rounds', index: 2 },
          ],
        },
        blockKind: 'step' as const,
        attempt: '1',
        logicalInvocationRecordId: 'first',
        previousAttemptRecordId: 'first',
      };
      const materializedLeaves = [
        WorkflowMaterializedLeafV1Schema.parse({
          sourceKey: 'builtin:review',
          blockId: 'analyze',
          kind: 'step',
          selection: {
            agentTarget: {
              kind: 'agent',
              identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex,
            },
          },
          authoredWorkspace: { kind: 'inherit' },
          executionTarget: { kind: 'detached_run' },
          role: {
            roleId: 'reviewer',
            name: 'Frozen reviewer',
            instructions: 'Review',
            runsAs: { kind: 'session' },
            workspaceWrites: 'deny',
            secondOpinion: 'off',
            enabled: true,
          },
        }),
      ];
      materializedLeaves.unshift({
        ...materializedLeaves[0]!,
        sourceKey: '$root',
        role: { ...materializedLeaves[0]!.role!, name: 'Root reviewer' },
      });
      const screen = await renderContent({
        definition,
        frozenChildren,
        materializedLeaves,
        invocations: [invocation],
        selectedInvocationId: invocation.id,
        invocationProgressById: new Map([[invocation.id, progress]]),
        selectedInvocationProgress: progress,
        invocationPage: width === 390,
      });
      for (const view of ['flow', 'steps', 'activity'] as const) {
        await screen.update(
          React.createElement(WorkflowRunContent, {
            ...(screen.findByType(WorkflowRunContent as never)
              ?.props as ContentProps),
            view,
          }),
        );
        const header = screen
          .findAllByTestId(
            width === 390
              ? 'workflow-run-selected-header'
              : 'details-pane.header',
          )
          .find((node) => typeof node.props.title === 'string');
        expect(header).toBeDefined();
        expect(header?.props.title).toBe('Frozen inspection');
        // Frozen authored identity survives Map, Steps and Activity; the role is separate context.
        expect(screen.getTextContent()).toContain('Frozen inspection');
        expect(header?.props.subtitle).toEqual(
          expect.stringContaining('Frozen reviewer'),
        );
        expect(header?.props.subtitle).not.toContain('Root reviewer');
        expect(header?.props.subtitle).toContain(
          'workflows.run.occurrenceRound:{"number":"3"}',
        );
        expect(header?.props.subtitle).toContain(
          'workflows.run.attempt:{"attempt":"2"}',
        );
        expect(header?.props.subtitle).not.toContain('duration');
      }
      await screen.update(
        React.createElement(WorkflowRunContent, {
          ...(screen.findByType(WorkflowRunContent as never)
            ?.props as ContentProps),
          materializedLeaves: materializedLeaves.map(
            ({ role: _role, ...leaf }) => leaf,
          ),
        }),
      );
      const agentHeader = screen
        .findAllByTestId(
          width === 390
            ? 'workflow-run-selected-header'
            : 'details-pane.header',
        )
        .find((node) => typeof node.props.title === 'string');
      expect(agentHeader?.props.subtitle.toLowerCase()).toContain('codex');
      await screen.update(
        React.createElement(WorkflowRunContent, {
          ...(screen.findByType(WorkflowRunContent as never)
            ?.props as ContentProps),
          materializedLeaves: materializedLeaves.map(
            ({ role: _role, ...leaf }) => ({
              ...leaf,
              selection: { ...leaf.selection, agentTarget: null },
            }),
          ),
        }),
      );
      const untargetedHeader = screen
        .findAllByTestId(
          width === 390
            ? 'workflow-run-selected-header'
            : 'details-pane.header',
        )
        .find((node) => typeof node.props.title === 'string');
      expect(untargetedHeader?.props.subtitle).toContain(
        'workflows.run.occurrenceRound:{"number":"3"}',
      );
      expect(untargetedHeader?.props.subtitle).toContain(
        'workflows.run.attempt:{"attempt":"2"}',
      );
      expect(untargetedHeader?.props.subtitle.toLowerCase()).not.toContain(
        'codex',
      );
    },
  );
  it('opens an unopened held child Wait from Flow using accepted children and loaded ancestry', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'workflow',
          id: 'call',
          workflowRef: 'builtin:review',
          input: {},
        },
      ],
    });
    const frozenChildren = {
      'builtin:review': createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'wait',
            id: 'held',
            document: { text: 'Continue?', references: [], attachments: [] },
          },
        ],
      }),
    };
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      definition,
      frozenChildren,
      view: 'flow',
      onSelectInvocation,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'root',
          parentRecordId: null,
          memberOrdinal: '0',
          sequence: '0',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'call',
          parentRecordId: 'root',
          memberOrdinal: '0',
          sequence: '1',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'held-row',
          parentRecordId: 'call',
          memberOrdinal: '0',
          sequence: '2',
          lifecycle: 'waiting_for_review',
        }),
      ],
    });
    await screen.pressByTestIdAsync(
      `workflow-run-flow-node-${JSON.stringify(['call', 'held'])}`,
    );
    expect(onSelectInvocation.mock.calls.at(-1)?.[0]).toBe('held-row');
  });
  it('keeps a successful outcome outside Needs you while the origin acknowledgement is behind', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'succeeded',
        originDeliveryAckRevision: 0,
      }),
    });
    expect(screen.getTextContent()).toContain('workflows.runState.succeeded');
    expect(screen.findByTestId('workflow-run-needs-you')).toBeNull();
  });

  it('virtualizes paged Activity rows under one scroll owner while keeping selected and attention content reachable', async () => {
    const onLoadMoreInvocations = vi.fn();
    const invocations = Array.from({ length: 512 }, (_, index) =>
      createWorkflowInvocationIndexFixture({
        id: `inv-${index}`,
        sequence: String(index),
        parentRecordId: 'run-root',
        lifecycle: index === 400 ? 'waiting_for_approval' : 'completed',
      }),
    );
    const screen = await renderContent({
      invocations,
      selectedInvocationId: 'inv-450',
      onLoadMoreInvocations,
      invocationProgressById: openedLeafProgress('inv-400'),
    });

    expect(screen.findAllByType('LegendList' as never)).toHaveLength(1);
    // The rows have one scroll owner; the only other one is the neighbouring
    // inspector, which scrolls the selected detail on its own.
    const scrollViews = screen.findAllByType('ScrollView' as never);
    expect(scrollViews.map((node) => node.props.testID)).toEqual([
      'workflow-run-inspector',
    ]);
    expect(screen.findAllByType('LegendListItem' as never)).toHaveLength(2);
    expect(virtualizedListState.props?.data).toHaveLength(512);
    expect(
      virtualizedListState.props?.keyExtractor(invocations[450], 450),
    ).toBe('inv-450');
    expect(screen.findByTestId('workflow-run-needs-you-inv-400')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-selected-detail')).toBeTruthy();

    await screen.pressByTestIdAsync('workflow-run-invocations-load-more');
    expect(onLoadMoreInvocations).toHaveBeenCalledTimes(1);
  });

  it('gives Flow one plain scroll owner without mounting the Activity list', async () => {
    const screen = await renderContent({ view: 'flow' });

    expect(screen.findAllByType('LegendList' as never)).toHaveLength(0);
    expect(screen.findAllByType('ScrollView' as never)).toHaveLength(1);
    expect(screen.findByTestId('workflow-run-flow')).toBeTruthy();
  });

  /**
   * UX §3.2/§4.5: wide layouts place the selected detail in a neighbouring
   * inspector; compact ones use the canonical modal. The selected id and the
   * reviewed text buffers have one owner above both, so switching Activity
   * and Flow neither remounts the detail nor loses a half-written sentence.
   */
  it('keeps the selected detail in one neighbouring inspector across the Activity/Flow switch on wide layouts', async () => {
    const props: Partial<ContentProps> = {
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
        continueSameConversation: { kind: 'available' },
        continueFreshAgent: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
        restoreWorkspace: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      onRetryWithReplacement: vi.fn(),
    };
    const screen = await renderContent({ ...props, view: 'activity' });

    const inspector = screen.findByTestId('workflow-run-inspector');
    expect(inspector).toBeTruthy();
    expect(
      inspector?.findAllByProps({ testID: 'workflow-run-selected-detail' })
        .length,
    ).toBeGreaterThan(0);
    // Not appended after the rows: the list's footer carries no detail.
    expect(
      virtualizedListState.props?.ListFooterComponent === null ||
        screen
          .findAllByType('LegendList' as never)[0]
          ?.findAllByProps({ testID: 'workflow-run-selected-detail' })
          .length === 0,
    ).toBe(true);
    expect(screen.visibleModals()).toEqual([]);

    // Open the replacement editor without typing: only a still-mounted
    // instance can keep that disclosure open across the view switch.
    await screen.pressByTestIdAsync('workflow-run-use-replacement-input');
    expect(
      screen.findByTestId('workflow-run-replacement-input'),
    ).not.toBeNull();
    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent as never)
          ?.props as ContentProps),
        view: 'flow',
      }),
    );
    expect(screen.findByTestId('workflow-run-flow')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-inspector')).toBeTruthy();
    const slots = vi.spyOn(flowSlots, 'useWorkflowFlowNodeSlots');
    try {
      await act(async () => { screen.changeTextByTestId('workflow-run-replacement-input', 'A'); });
      await act(async () => { screen.changeTextByTestId('workflow-run-replacement-input', 'A new'); });
      console.info('B14-05 recovery typing', { keystrokes: 2, flowSlotPreparations: slots.mock.calls.length });
      expect(slots).toHaveBeenCalledTimes(0);
    } finally { slots.mockRestore(); }

    expect(
      screen.findByTestId('workflow-run-replacement-input'),
    ).not.toBeNull();
  });

  it('keeps what needs you in a phone dock in thumb reach, not a section above the Map (phone-P1)', async () => {
    viewport.window = { width: 390, height: 844 };
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'running', availability: { cancel: true, pause: true } }),
      invocations: [
        createWorkflowInvocationIndexFixture({ id: 'held', parentRecordId: 'root', lifecycle: 'waiting_for_review' }),
      ],
      invocationProgressById: openedLeafProgress('held'),
      selectedInvocationId: null,
      onSelectInvocation,
    });
    expect(screen.findByTestId('workflow-run-needs-you')).toBeNull();
    const dock = screen.findByTestId('workflow-run-needs-you-dock');
    expect(dock).not.toBeNull();
    expect(screen.getTextContent()).toContain('workflows.a11y.needsYou:{"count":1}');
    await screen.pressByTestIdAsync('workflow-run-needs-you-dock-review');
    expect(onSelectInvocation.mock.calls[0]?.[0]).toBe('held');
  });

  it('keeps one primary on a phone page whose paused Run has a hold: the dock Review yields to Resume', async () => {
    viewport.window = { width: 390, height: 844 };
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'paused', availability: { cancel: true, pause: false, resumeBoundary: true } }),
      onResume: vi.fn(),
      invocations: [
        createWorkflowInvocationIndexFixture({ id: 'held', parentRecordId: 'root', lifecycle: 'waiting_for_review' }),
      ],
      invocationProgressById: openedLeafProgress('held'),
      selectedInvocationId: null,
    });
    expect(screen.findByTestId('workflow-run-needs-you-dock')).not.toBeNull();
    expect(screen.findAllByType(ToolbarButton).filter((button) => button.props.tone === 'primary')
      .map((button) => button.props.testID)).toEqual(['workflow-run-resume']);
  });

  it('leaves phone selection to the exact pushed invocation page rather than opening a detail modal', async () => {
    viewport.window = { width: 390, height: 844 };
    const onSelectInvocation = vi.fn();
    const onDeselectInvocation = vi.fn();
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'inv-1',
      parentRecordId: 'run-root',
      lifecycle: 'running',
    });
    const screen = await renderContent({
      invocations: [invocation],
      onSelectInvocation,
      onDeselectInvocation,
    });
    expect(screen.visibleModals()).toEqual([]);

    // Selecting from a row records where focus returns when the sheet closes.
    const row = screen.findByTestId('workflow-run-invocations-row-inv-1');
    const rowHost = { focus: vi.fn(), isConnected: true };
    await act(async () => {
      row?.props.onPress({
        currentTarget: rowHost,
        nativeEvent: { target: 7 },
      });
    });
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-1');

    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent as never)
          ?.props as ContentProps),
        selectedInvocationId: 'inv-1',
      }),
    );
    expect(screen.findByTestId('workflow-run-inspector')).toBeNull();
    expect(screen.findByTestId('workflow-run-selected-detail')).toBeNull();
    expect(screen.visibleModals()).toEqual([]);
    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent as never)
          ?.props as ContentProps),
        invocationPage: true,
      }),
    );
    expect(screen.findByTestId('workflow-run-selected-detail')).toBeTruthy();
    expect(screen.findAllByType('LegendList' as never)).toHaveLength(0);

    // Growing past compact moves the same selection into the inspector and
    // takes the sheet down; nothing is selected twice.
    viewport.window = { width: 1200, height: 800 };
    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent as never)
          ?.props as ContentProps),
      }),
    );
    expect(screen.findByTestId('workflow-run-inspector')).toBeTruthy();
  });

  it('offers Steps as the frozen read-only document with exact occurrence selection', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      view: 'steps',
      invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1' })],
      invocationStructure: new Map([
        [
          'inv-1',
          {
            invocationId: 'inv-1',
            blockId: 'analyze',
            nodeId: 'analyze',
            occurrence: [],
            isFrame: false,
            coverageKind: 'executable',
          },
        ],
      ]),
      onSelectInvocation,
    });
    expect(screen.findByTestId('workflow-run-view:steps')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-steps-list-root')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-steps-add-root')).toBeNull();
    await screen.pressByTestIdAsync('workflow-run-steps-occurrence-inv-1');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-1');
  });

  it.each(['flow', 'steps', 'activity'] as const)(
    'shows a completed sub-minute occurrence elapsed time in %s and its exact detail',
    async (view) => {
      const invocation = createWorkflowInvocationIndexFixture({
        id: 'finished',
        lifecycle: 'completed',
      });
      const progress = {
        kind: 'happier.workflow-progress.v1' as const,
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step' as const,
        attempt: '0',
        logicalInvocationRecordId: invocation.id,
        timing: {
          startedAt: '2026-10-11T20:54:03.018Z',
          finishedAt: '2026-10-11T20:54:57.085Z',
        },
      };
      const screen = await renderContent({
        view,
        invocations: [invocation],
        selectedInvocationId: invocation.id,
        selectedInvocationProgress: progress,
        invocationProgressById: new Map([[invocation.id, progress]]),
      });
      const elapsed = 'tools.common.elapsedSeconds:{"seconds":"54"}';
      const surface =
        view === 'steps'
          ? screen.findByTestId('workflow-run-steps-list-root')
          : view === 'flow'
            ? screen.findByTestId('workflow-run-flow-node-analyze')
            : null;
      if (view !== 'activity') {
        expect(surface).not.toBeNull();
        expect(
          surface?.findAll((node) => node.props.children === elapsed).length,
        ).toBeGreaterThan(0);
      }
      // The pane's subtitle carries the state and the time once (DESIGN-16 D5), not loose body lines.
      const header = screen
        .findAllByTestId('workflow-run-selected-header')
        .concat(screen.findAllByTestId('details-pane.header'))
        .find((node) => typeof node.props.subtitle === 'string');
      expect(header?.props.subtitle).toContain(
        'workflows.invocationState.completed',
      );
      expect(header?.props.subtitle).toContain(elapsed);
      expect(screen.findByTestId('workflow-run-invocation-elapsed')).toBeNull();

      // Page-opened progress must reach unselected steps too; selection is not the data fetch.
      await screen.update(
        React.createElement(WorkflowRunContent, {
          ...(screen.findByType(WorkflowRunContent as never)
            ?.props as ContentProps),
          selectedInvocationId: null,
          selectedInvocationProgress: null,
        }),
      );
      if (view === 'steps')
        expect(
          screen
            .findByTestId('workflow-run-steps-list-root')
            ?.findAll((node) => node.props.children === elapsed).length,
        ).toBeGreaterThan(0);
      expect(screen.findByTestId('workflow-run-invocation-elapsed')).toBeNull();
    },
  );

  it('keeps the first Agent input bindings and Returns visible as read-only words in Steps', async () => {
    const screen = await renderContent({
      view: 'steps',
      definition: createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'step',
            id: 'first',
            document: { text: 'Do the work', references: [], attachments: [] },
            input: [{ kind: 'literal', value: 'Recorded input' }],
            result: { kind: 'json', schema: { type: 'object' } },
          },
        ],
      }),
    });
    expect(screen.getTextContent()).toContain('Recorded input');
    // What the step returns is not a line under it (owner 2026-11-15).
    expect(
      screen.findByTestId('workflow-run-steps-step-first-returns'),
    ).toBeNull();
    expect(
      screen.findByTestId('workflow-run-steps-step-first-add-input'),
    ).toBeNull();
    const binding = screen.findByTestId(
      'workflow-run-steps-step-first-input-0',
    );
    expect(binding).toBeTruthy();
    expect(
      binding?.findAll(
        (node) =>
          typeof node.type === 'string' &&
          (typeof node.props.onChangeText === 'function' ||
            node.props.accessibilityRole === 'radio'),
      ),
    ).toHaveLength(0);
  });

  it('closes a selected docked step through the canonical pane header and selection owner', async () => {
    const onDeselectInvocation = vi.fn();
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      onDeselectInvocation,
    });
    await screen.pressByTestIdAsync('details-pane.header.close');
    expect(onDeselectInvocation).toHaveBeenCalledOnce();
  });

  it('keeps an inactive exact Session pane free of transcript and composer subscriptions', async () => {
    const screen = await renderContent({
      active: false,
      selectedInvocationId: 'inv-1',
      invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1' })],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        blockKind: 'step',
        invocationPath: { blockId: 'analyze', scope: [] },
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: {
          kind: 'session',
          sessionId: 'step-session',
          localInputId: 'input-1',
        },
      },
    });
    expect(
      screen.findByTestId('session-in-pane-inactive:step-session'),
    ).toBeTruthy();
    expect(screen.findByTestId('session-in-pane:step-session')).toBeNull();
  });

  it('selects exact repeated Action and Wait occurrences from Steps', async () => {
    const onSelectInvocation = vi.fn();
    await withPopoverWebGlobals(async () => {
      const invocations = [
        'notify-old',
        'notify-new',
        'wait-old',
        'wait-new',
      ].map((id, index) =>
        createWorkflowInvocationIndexFixture({
          id,
          sequence: String(index),
          lifecycle: index % 2 === 0 ? 'completed' : 'waiting_for_review',
        }),
      );
      const screen = await renderContent({
        view: 'steps',
        onSelectInvocation,
        definition: createWorkflowDefinitionFixture({
          blocks: [
            {
              kind: 'action',
              id: 'notify',
              actionId: 'notifications.notify_me',
              input: { message: { kind: 'literal', value: 'Frozen message' } },
            },
            {
              kind: 'wait',
              id: 'held',
              document: {
                text: 'Review before continuing',
                references: [],
                attachments: [],
              },
            },
          ],
        }),
        invocations,
        invocationStructure: new Map(
          invocations.map((invocation) => {
            const blockId = invocation.id.startsWith('notify')
              ? 'notify'
              : 'held';
            return [
              invocation.id,
              {
                invocationId: invocation.id,
                blockId,
                nodeId: blockId,
                occurrence: [],
                isFrame: false,
                coverageKind: 'executable' as const,
              },
            ];
          }),
        ),
      });
      expect(
        screen.findByTestId('workflow-run-steps-notify-occurrence-notify-old'),
      ).toBeNull();
      await screen.pressByTestIdAsync(
        'workflow-run-steps-notify-select-occurrence',
      );
      await flushHookEffects({ frames: 1 });
      expect(
        screen.findHostByTestId(
          'workflow-run-steps-notify-occurrence-notify-old',
        ),
      ).not.toBeNull();
      await layoutPopoverContent(screen);
      await screen.pressByTestIdAsync(
        'workflow-run-steps-notify-occurrence-notify-old',
      );
      await flushHookEffects({ frames: 1 });
      expect(onSelectInvocation.mock.calls.at(-1)?.[0]).toBe('notify-old');
      await screen.pressByTestIdAsync(
        'workflow-run-steps-held-select-occurrence',
      );
      await flushHookEffects({ frames: 1 });
      expect(
        screen.findHostByTestId('workflow-run-steps-held-occurrence-wait-new'),
      ).not.toBeNull();
      await layoutPopoverContent(screen);
      await screen.pressByTestIdAsync(
        'workflow-run-steps-held-occurrence-wait-new',
      );
      await flushHookEffects({ frames: 1 });
      expect(onSelectInvocation.mock.calls.at(-1)?.[0]).toBe('wait-new');
    });
  });

  it('reads frozen Action bindings without mounting editable reference controls', async () => {
    const screen = await renderContent({
      view: 'steps',
      definition: createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'action',
            id: 'notify',
            actionId: 'notifications.notify_me',
            input: {
              message: { kind: 'literal', value: 'Frozen message' },
              recipients: {
                kind: 'list',
                items: [
                  { kind: 'input', name: 'person' },
                  { kind: 'origin_session_id' },
                ],
              },
            },
          },
        ],
      }),
    });
    for (const field of ['message', 'recipients']) {
      const binding = screen.findByTestId(
        `workflow-run-steps-action-notify-field-${field}`,
      );
      expect(binding).toBeTruthy();
      expect(
        binding?.findAll(
          (node) =>
            typeof node.type === 'string' &&
            (typeof node.props.onChangeText === 'function' ||
              node.props.accessibilityRole === 'radio'),
        ),
      ).toHaveLength(0);
    }
    expect(screen.getTextContent()).toContain('Frozen message');
  });

  it('renders frozen nested documents through the same owner without mixing identical child block occurrences', async () => {
    const onSelectInvocation = vi.fn();
    const workflowRef = 'builtin:keep-going-until-done';
    const screen = await renderContent({
      view: 'steps',
      definition: createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'workflow',
            id: 'first',
            workflowRef,
            input: { topic: { kind: 'literal', value: 'Frozen topic' } },
          },
          { kind: 'workflow', id: 'second', workflowRef, input: {} },
        ],
      }),
      frozenChildren: { [workflowRef]: createWorkflowDefinitionFixture() },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'first-child',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'second-child',
          lifecycle: 'waiting_for_review',
        }),
      ],
      invocationStructure: new Map(
        ['first', 'second'].map((id) => [
          `${id}-child`,
          {
            invocationId: `${id}-child`,
            blockId: 'analyze',
            nodeId: resolveWorkflowFlowScopedNodeId('analyze', [id]),
            occurrence: [{ kind: 'workflow' as const, blockId: id }],
            isFrame: false,
            coverageKind: 'executable' as const,
          },
        ]),
      ),
      selectedInvocationId: 'first-child',
      onSelectInvocation,
    });
    expect(
      screen.findByTestId('workflow-run-steps-first-list-root'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('workflow-run-steps-second-list-root'),
    ).toBeTruthy();
    expect(
      screen.findAllByTestId('workflow-run-steps-first-occurrence-first-child'),
    ).not.toHaveLength(0);
    expect(
      screen.findByTestId('workflow-run-steps-first-occurrence-second-child'),
    ).toBeNull();
    await screen.pressByTestIdAsync(
      'workflow-run-steps-second-occurrence-second-child',
    );
    expect(onSelectInvocation).toHaveBeenCalledWith('second-child');
    const binding = screen.findByTestId(
      'workflow-run-steps-workflow-first-input-topic',
    );
    expect(
      binding?.findAll(
        (node) =>
          typeof node.type === 'string' &&
          typeof node.props.onChangeText === 'function',
      ),
    ).toHaveLength(0);
    // Accepted child content is already present: reading this run must not
    // ask for a fresh child catalog or offer an execution-looking Retry.
    expect(
      screen.findByTestId('workflow-run-steps-workflow-first-retry'),
    ).toBeNull();
    expect(
      screen.findByTestId('workflow-run-steps-workflow-second-retry'),
    ).toBeNull();
  });

  it('states a single occurrence lifecycle once in the Steps document and keeps it selectable', async () => {
    const onSelectInvocation = vi.fn();
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'finished',
      lifecycle: 'completed',
    });
    const screen = await renderContent({
      view: 'steps',
      invocations: [invocation],
      onSelectInvocation,
      selectedInvocationId: invocation.id,
      invocationStructure: new Map([
        [
          invocation.id,
          {
            invocationId: invocation.id,
            blockId: 'analyze',
            nodeId: 'analyze',
            occurrence: [],
            isFrame: false,
            coverageKind: 'executable' as const,
          },
        ],
      ]),
    });
    const document = screen.findByTestId('workflow-run-steps-list-root');
    expect(document).not.toBeNull();
    // Badge content may contain nested children; count the painted status, not a JSX prop shape.
    const status = document?.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.children.filter((child) => typeof child === 'string').join('') ===
          'workflows.invocationState.completed',
    );
    expect(status).toHaveLength(1);
    await screen.pressByTestIdAsync('workflow-run-steps-occurrence-finished');
    expect(onSelectInvocation).toHaveBeenCalledWith('finished');
  });

  it.each(['owner', 'view'] as const)(
    'offers Discuss only from the exact Session input grant (%s)',
    async (level) => {
      const store = getStorage();
      const prior = store.getState().sessions;
      const session = createSessionFixture({
        id: 'discussion-session',
        access: createSessionAccessFixture(level),
      });
      store.setState({ sessions: { ...prior, [session.id]: session } });
      let discuss: (() => void) | undefined;
      try {
        await renderContent({
          selectedInvocationId: 'inv-1',
          selectedInvocationProgress: {
            kind: 'happier.workflow-progress.v1',
            blockKind: 'step',
            invocationPath: { blockId: 'analyze', scope: [] },
            attempt: '0',
            logicalInvocationRecordId: 'inv-1',
            execution: {
              kind: 'session',
              sessionId: session.id,
              localInputId: 'input-1',
            },
          },
          renderReviewCard: (onDiscuss) => {
            discuss = onDiscuss;
            return React.createElement('ReviewSlot');
          },
        });
        expect(typeof discuss === 'function').toBe(level === 'owner');
      } finally {
        await act(async () => store.setState({ sessions: prior }));
      }
    },
  );

  it('covers the exact phone conversation with one canonical review card, not a second inline card', async () => {
    viewport.window = { width: 390, height: 844 };
    const screen = await renderContent({
      active: true,
      invocationPage: true,
      selectedInvocationId: 'inv-1',
      onOpenSession: vi.fn(),
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        blockKind: 'step',
        invocationPath: { blockId: 'analyze', scope: [] },
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: {
          kind: 'session',
          sessionId: 'step-session',
          localInputId: 'input-1',
        },
      },
      renderReviewCard: () => React.createElement('ReviewSlot'),
    });
    expect(
      screen.findByTestId('session-in-pane-inactive:step-session'),
    ).toBeTruthy();
    expect(screen.findAllByType('ReviewSlot' as never)).toHaveLength(1);
    expect(screen.visibleModals()).toHaveLength(1);
    expect(screen.visibleModals()[0]).toMatchObject({
      chrome: { testID: 'workflow-run-review-modal' },
      props: { card: expect.anything() },
    });
    const modalId = screen.visibleModals()[0].id;
    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent).props as ContentProps),
        renderReviewCard: () =>
          React.createElement('ReviewSlot', { publication: 'updated' }),
      }),
    );
    expect(screen.visibleModals().map((modal) => modal.id)).toEqual([modalId]);
    expect(screen.findAllByType('ReviewSlot' as never)).toHaveLength(1);
    expect(screen.findByType('ReviewSlot' as never).props.publication).toBe(
      'updated',
    );
    // Publishing fresh held content must retain the sheet's title band and presentation.
    const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
    const sheet = screen.findAllByType(ModalCardFrame)
      .find((node) => node.props.testID === 'workflow-run-review-modal');
    expect(sheet?.props.title).toBe('workflows.run.untitled');
    expect(sheet?.props.presentation).toBe('sheet');
    // A route departure retires the owned sheet while the shell's provider remains mounted.
    await screen.update(<></>);
    expect(screen.visibleModals()).toEqual([]);
  });

  it('reopens the same phone hold with its external draft and resets dismissal for a new exact attempt', async () => {
    viewport.window = { width: 390, height: 844 };
    const drafts = new Map<string, WorkflowReviewDraft>();
    const progress: NonNullable<ContentProps['selectedInvocationProgress']> = {
      kind: 'happier.workflow-progress.v1',
      blockKind: 'wait',
      invocationPath: { blockId: 'held', scope: [] },
      attempt: '0',
      logicalInvocationRecordId: 'held-1',
    };
    let exactId = 'held-1';
    let currentProgress = progress;
    const renderReviewCard = (
      _discuss?: () => void,
      placement?: Readonly<{ compact: boolean }>,
    ) => {
      const id = exactId;
      return (
        <WorkflowReviewCard
          progress={currentProgress}
          contract={{ kind: 'text' }}
          waitForYou
          contentRevision="7"
          draft={drafts.get(id)}
          onChangeDraft={(next) => {
            if (next) drafts.set(id, next);
            else drafts.delete(id);
          }}
          onComplete={async () => {}}
          primaryActionPlacement={placement?.compact ? 'footer' : 'inline'}
        />
      );
    };
    const screen = await renderContent({
      active: true,
      invocationPage: true,
      selectedInvocationId: exactId,
      selectedInvocationProgress: progress,
      renderReviewCard,
    });
    expect(screen.findByTestId('workflow-run-view:flow')).toBeNull(); // Cockpit navigation belongs to the mounted phone host.
    expect(screen.findByTestId('workflow-run-selected-header')).toBeNull();
    expect(screen.visibleModals()).toHaveLength(1);
    const firstId = screen.visibleModals()[0].id;
    await act(async () => {
      screen.changeTextByTestId('workflow-review-editor', 'My retained answer');
    });
    await screen.pressByTestIdAsync('modal-card-close');
    expect(screen.visibleModals()).toEqual([]);
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, motionTokens.overlay.modal.exitMs),
      );
    });
    expect(screen.findAllByType(WorkflowReviewCard)).toHaveLength(0);
    expect(screen.findByTestId('workflow-run-view:flow')).toBeNull(); // Cockpit navigation belongs to the mounted phone host.
    await screen.pressByTestIdAsync('workflow-run-open-review');
    expect(screen.visibleModals()).toHaveLength(1);
    const reopenedId = screen.visibleModals()[0].id;
    expect(reopenedId).not.toBe(firstId);
    expect(screen.findByTestId('workflow-review-editor')?.props.value).toBe(
      'My retained answer',
    );
    await screen.pressByTestIdAsync('modal-card-close');
    expect(screen.visibleModals()).toEqual([]);
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, motionTokens.overlay.modal.exitMs),
      );
    });
    expect(screen.findAllByType(WorkflowReviewCard)).toHaveLength(0);
    exactId = 'held-2';
    currentProgress = {
      ...progress,
      attempt: '1',
      previousAttemptRecordId: 'held-1',
    };
    await screen.update(
      React.createElement(WorkflowRunContent, {
        ...(screen.findByType(WorkflowRunContent as never)
          ?.props as ContentProps),
        selectedInvocationId: exactId,
        selectedInvocationProgress: currentProgress,
      }),
    );
    expect(screen.visibleModals()).toHaveLength(1);
    expect(screen.visibleModals()[0].id).not.toBe(reopenedId);
    expect(screen.findByTestId('workflow-review-editor')?.props.value).toBe('');
    expect(drafts.get('held-1')?.text).toBe('My retained answer');
  });

  it('opens the exact previous attempt from a failed generation without choosing its value', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      selectedInvocationId: 'generation-2',
      onSelectInvocation,
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        blockKind: 'step',
        invocationPath: { blockId: 'analyze', scope: [] },
        attempt: '1',
        logicalInvocationRecordId: 'analyze',
        previousAttemptRecordId: 'published-1',
        reason: { code: 'generation_failed' },
      },
    });
    await screen.pressByTestIdAsync('workflow-run-previous-attempt');
    expect(onSelectInvocation).toHaveBeenCalledWith('published-1');
  });

  it('never gives an Action leaf a conversation even when a stale Session override remains', async () => {
    let discuss: (() => void) | undefined;
    const screen = await renderContent({
      selectedInvocationId: 'action-1',
      selectedSessionId: 'stale-session',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        blockKind: 'action',
        invocationPath: { blockId: 'notify', scope: [] },
        attempt: '0',
        logicalInvocationRecordId: 'action-1',
      },
      renderReviewCard: (onDiscuss) => {
        discuss = onDiscuss;
        return React.createElement('ReviewSlot');
      },
    });
    expect(
      screen.findByTestId('session-in-pane-inactive:stale-session'),
    ).toBeNull();
    expect(discuss).toBeUndefined();
  });

  describe('a held step, said once and reviewed in one scroller', () => {
    it('omits hold navigation when only one hold is loaded', async () => {
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({ state: 'waiting_for_review', attentionRequired: true }),
        selectedInvocationId: 'only-hold',
        invocations: [createWorkflowInvocationIndexFixture({ id: 'only-hold', parentRecordId: 'root', lifecycle: 'waiting_for_review' })],
        invocationProgressById: openedLeafProgress('only-hold'),
        renderReviewCard: () => React.createElement('ReviewSlot'),
      });
      expect(screen.findByTestId('workflow-run-previous-hold')).toBeNull();
      expect(screen.findByTestId('workflow-run-next-hold')).toBeNull();
      expect(screen.findAllByType('ReviewSlot')).toHaveLength(1);
    });

    it('walks the loaded attention window in its published order', async () => {
      const onSelectInvocation = vi.fn();
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({ state: 'waiting_for_review', attentionRequired: true }),
        selectedInvocationId: 'first-hold', onSelectInvocation,
        invocations: ['first-hold', 'next-hold'].map((id) => createWorkflowInvocationIndexFixture({ id, parentRecordId: 'root', lifecycle: 'waiting_for_review' })),
        invocationProgressById: new Map(['first-hold', 'next-hold'].map((id) => [id, WorkflowProgressEnvelopeV1Schema.parse({
          kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'analyze', scope: [] },
          attempt: '0', logicalInvocationRecordId: id,
        })])),
        renderReviewCard: () => React.createElement('ReviewSlot'),
      });
      expect(screen.findByTestId('workflow-run-previous-hold')?.props.disabled).toBe(true);
      await screen.pressByTestIdAsync('workflow-run-next-hold');
      expect(onSelectInvocation).toHaveBeenCalledWith('next-hold');
      await screen.update(<WorkflowRunContent {...screen.contentProps} selectedInvocationId="next-hold" attentionHasMore />);
      expect(screen.findByTestId('workflow-run-next-hold')?.props.disabled).toBe(true);
      expect(screen.getTextContent()).toContain('workflows.run.holdsPosition:{"current":2,"total":2,"more":true}');
      await screen.pressByTestIdAsync('workflow-run-previous-hold');
      expect(onSelectInvocation).toHaveBeenLastCalledWith('first-hold');
    });
    const sessionProgress = (sessionId: string): NonNullable<ContentProps['selectedInvocationProgress']> => ({
      kind: 'happier.workflow-progress.v1',
      blockKind: 'step',
      invocationPath: { blockId: 'analyze', scope: [] },
      attempt: '0',
      logicalInvocationRecordId: 'inv-1',
      execution: { kind: 'session', sessionId, localInputId: 'input-1' },
    });
    const withSession = async (level: 'owner' | 'view', run: () => Promise<void>) => {
      const store = getStorage();
      const prior = store.getState().sessions;
      const session = createSessionFixture({ id: 'review-session', access: createSessionAccessFixture(level) });
      store.setState({ sessions: { ...prior, [session.id]: session } });
      try {
        await run();
      } finally {
        await act(async () => store.setState({ sessions: prior }));
      }
    };

    it('keeps a wide held result and its conversation available together through Discuss and back', async () => {
      await withSession('owner', async () => {
        let discuss: (() => void) | undefined;
        const screen = await renderContent({
          selectedInvocationId: 'inv-1',
          invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1' })],
          selectedInvocationProgress: sessionProgress('review-session'),
          renderReviewCard: (onDiscuss) => {
            discuss = onDiscuss;
            return React.createElement('ReviewSlot');
          },
        });
        expect(screen.findAllByType('ReviewSlot' as never)).toHaveLength(1);
        expect(screen.findByTestId('session-in-pane-inactive:review-session')).toBeTruthy();

        await act(async () => discuss?.());
        expect(screen.findAllByType('ReviewSlot' as never)).toHaveLength(0);
        expect(screen.findByTestId('session-in-pane-inactive:review-session')).toBeTruthy();

        // The page is inactive here so no live transcript mounts, which also disables the control; its handler is what returns.
        const reopen = screen.findAll((node) => node.props.testID === 'workflow-run-open-review' && typeof node.props.onPress === 'function')[0];
        await act(async () => reopen?.props.onPress());
        expect(screen.findAllByType('ReviewSlot' as never)).toHaveLength(1);
        expect(screen.findByTestId('session-in-pane-inactive:review-session')).toBeTruthy();
      });
    });

    it('still reaches the conversation when the person may read it but not reply', async () => {
      await withSession('view', async () => {
        const screen = await renderContent({
          selectedInvocationId: 'inv-1',
          invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1' })],
          selectedInvocationProgress: sessionProgress('review-session'),
          renderReviewCard: () => React.createElement('ReviewSlot'),
        });
        expect(screen.findByTestId('session-in-pane-inactive:review-session')).toBeTruthy();
      });
    });

    it('keeps the overall status while Needs you names the held work', async () => {
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({ state: 'waiting_for_review', attentionRequired: true }),
        invocations: [
          createWorkflowInvocationIndexFixture({ id: 'held', parentRecordId: 'root', lifecycle: 'waiting_for_review' }),
        ],
        invocationProgressById: openedLeafProgress('held'),
        selectedInvocationId: null,
      });
      expect(screen.findByTestId('workflow-run-needs-you')).toBeTruthy();
      expect(screen.findByTestId('workflow-run-outcome')).toBeTruthy();
      expect(screen.findByTestId('workflow-run-invocations-word-held')).toBeNull();
    });

    it('leaves agent and attempt identity out of a human Wait header', async () => {
      const invocation = createWorkflowInvocationIndexFixture({ id: 'held', lifecycle: 'waiting_for_review' });
      const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
        blockKind: 'wait', attempt: invocation.attempt, logicalInvocationRecordId: invocation.id,
        invocationPath: { blockId: 'confirm', scope: [] } });
      const screen = await renderContent({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'confirm', name: 'Confirm the release',
          document: { text: 'Review the release summary.', references: [], attachments: [] } }] }),
        invocations: [invocation], selectedInvocationId: invocation.id,
        selectedInvocationProgress: progress, invocationProgressById: new Map([[invocation.id, progress]]),
      });
      const header = screen.findAllByTestId('workflow-run-selected-header')
        .concat(screen.findAllByTestId('details-pane.header'))
        .find((node) => typeof node.props.subtitle === 'string');
      expect(header).toBeDefined();
      expect(header?.props.subtitle).not.toMatch(/attempt/iu);
    });

    it('keeps the outcome when it says something the hold does not, as a Run that is stopping does', async () => {
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({ state: 'waiting_for_review', attentionRequired: true }),
        cancelRequested: true,
        invocations: [
          createWorkflowInvocationIndexFixture({ id: 'held', parentRecordId: 'root', lifecycle: 'waiting_for_review' }),
        ],
        invocationProgressById: openedLeafProgress('held'),
        selectedInvocationId: null,
      });
      expect(screen.findByTestId('workflow-run-outcome')).toBeTruthy();
    });

    it('lists Activity in the order the work ran, though the window puts held rows first', async () => {
      const row = (id: string, sequence: string) => createWorkflowInvocationIndexFixture({ id, sequence, parentRecordId: 'root' });
      const screen = await renderContent({
        view: 'activity',
        invocations: [row('held-c', '30'), row('first-a', '9'), row('second-b', '10')],
      });
      const prefix = 'workflow-run-invocations-time-';
      const order = screen.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith(prefix))
        .map((node) => String(node.props.testID).slice(prefix.length));
      // The list mounts its window from the top, so the earliest work must lead it.
      expect([...new Set(order)].slice(0, 2)).toEqual(['first-a', 'second-b']);
    });
  });

  it('leads with the outcome and the Run origin', async () => {
    const screen = await renderContent();

    expect(screen.findByTestId('workflow-run-outcome')).toBeTruthy();
    // The origin is the first fact of the header's meta line.
    expect(
      screen
        .findByTestId('workflow-run-header-meta')
        ?.findAll((node) => node.props.testID === 'workflow-run-origin').length,
    ).toBeGreaterThan(0);
  });

  it('uses confirmed summary attention before held private rows finish loading', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'claimed',
        attentionRequired: true,
      }),
      invocations: [],
      invocationsLoaded: false,
    });
    const outcome = screen.getTextContent();
    expect(outcome).toContain('workflows.review.waitTitle');
    expect(outcome).not.toContain('workflows.runState.claimed');
  });

  it('says nothing about the origin of a Run you started yourself (DESIGN-13)', async () => {
    // "Started directly · MacBook Pro · Started 12:00" said "started" twice for the unremarkable case.
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'running',
        origin: { kind: 'direct' },
      }),
    });
    expect(
      screen
        .findByTestId('workflow-run-header-meta')
        ?.findAll((node) => node.props.testID === 'workflow-run-origin')
        .length ?? 0,
    ).toBe(0);
  });

  it('says a held Wait-for-you status once, as the first words of the outcome, and offers Map · Steps · Activity', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'wait',
          id: 'confirm',
          document: {
            text: 'Confirm the release',
            references: [],
            attachments: [],
          },
        },
      ],
    });
    const screen = await renderContent({
      definition,
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'waiting_for_review',
      }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'root',
          parentRecordId: null,
          memberOrdinal: '0',
          sequence: '0',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'held',
          parentRecordId: 'root',
          memberOrdinal: '0',
          sequence: '1',
          lifecycle: 'waiting_for_review',
        }),
      ],
    });
    // The overall status remains while Needs you names the human step.
    expect(screen.findByTestId('workflow-run-state')).toBeNull();
    expect(screen.findByTestId('workflow-run-outcome')).toBeTruthy();
    // A Wait-for-you step never borrows the review hold's word.
    const text = screen.getTextContent();
    expect(screen.findByTestId('workflow-run-needs-you')).toBeTruthy();
    // A Wait that keeps its default name says it once ("Wait for you"), never "Wait for you is waiting for you".
    expect(text).not.toContain('workflows.run.attentionWaitRow');
    expect(text).toContain('workflows.page.blocks.waitTitle');
    expect(text).not.toContain('workflows.runState.waiting_for_review');
    expect(text).not.toContain('workflows.invocationState.waiting_for_review');
    expect(text.indexOf('workflows.tabs.map')).toBeGreaterThan(-1);
    expect(text.indexOf('workflows.tabs.map')).toBeLessThan(
      text.indexOf('workflows.tabs.steps'),
    );
    expect(text.indexOf('workflows.tabs.steps')).toBeLessThan(
      text.indexOf('workflows.tabs.activity'),
    );
  });

  it.each([
    ['running', 'running', 'runningStepSentence'],
    ['running', 'waiting_for_review', 'attentionReviewSentence'],
    ['running', 'waiting_for_approval', 'attentionApprovalSentence'],
    ['waiting_for_review', 'waiting_for_review', 'parkedReviewSentence'],
  ] as const)('explains a %s Run with a %s step through %s (07 §6.1)',
    async (state, lifecycle, sentenceKey) => {
      const definition = createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'step',
            id: 'check',
            name: 'Check the release',
            document: {
              text: 'Check the release',
              references: [],
              attachments: [],
            },
            input: [],
            result: { kind: 'text' },
          },
        ],
      });
      const screen = await renderContent({
        definition,
        run: createWorkflowRunSummaryFixture({ id: 'run-1', state }),
        invocationStructure: new Map([['review', { invocationId: 'review', blockId: 'check', nodeId: 'check',
          occurrence: [{ kind: 'item', blockId: 'files', index: 1 }], isFrame: false, coverageKind: 'executable' }]]),
        invocations: [
          createWorkflowInvocationIndexFixture({
            id: 'root',
            parentRecordId: null,
            memberOrdinal: '0',
            sequence: '0',
          }),
          createWorkflowInvocationIndexFixture({
            id: 'review',
            parentRecordId: 'root',
            memberOrdinal: '0',
            sequence: '1',
            lifecycle,
          }),
        ],
      });
      const outcome = String(
        screen.findByTestId('workflow-run-outcome')?.props.children,
      );
      expect(outcome).toContain('workflows.run.outcomeLine');
      expect(outcome).toContain(`"word":"workflows.runState.${state}"`);
      expect(outcome).toContain(`workflows.run.${sentenceKey}`);
      if (sentenceKey !== 'parkedReviewSentence') {
        expect(outcome).toContain('Check the release');
        expect(outcome).toContain('workflows.run.occurrenceItem');
      }
    },
  );

  it('shows no usage line when the provider supplied none', async () => {
    const screen = await renderContent();

    expect(screen.findByTestId('workflow-run-usage')).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      'workflows.run.usageUnavailable',
    );
  });

  it('does not claim complete child coverage while invocation history is paged', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'completed',
        }),
      ],
      invocationHistoryComplete: false,
    });

    expect(screen.getTextContent()).toContain('workflows.runState.succeeded');
    expect(screen.getTextContent()).not.toContain(
      'workflows.run.completedCount',
    );
  });

  it('hides the Needs you section entirely when nothing is actionable', async () => {
    const screen = await renderContent({
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'completed',
        }),
      ],
    });

    expect(screen.findAllByTestId('workflow-run-needs-you')).toHaveLength(0);
  });

  it('surfaces an actionable invocation in Needs you', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'step',
          id: 'analyze',
          document: {
            text: 'Analyze changes',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
      ],
    });
    const progress = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: 'analyze', scope: [] },
      blockKind: 'step' as const,
      attempt: '0',
      logicalInvocationRecordId: 'inv-2',
    };
    const screen = await renderContent({
      definition,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'inv-2',
          lifecycle: 'waiting_for_approval',
        }),
      ],
      invocationProgressById: new Map([['inv-2', progress]]),
    });

    expect(screen.findByTestId('workflow-run-needs-you')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-needs-you-inv-2')).toBeTruthy();
    expect(screen.getTextContent()).toContain('Analyze changes');
    expect(screen.getTextContent()).not.toContain('inv-2');
    expect(screen.findAllByTestId('workflow-run-needs-you-inv-1')).toHaveLength(
      0,
    );
  });

  it('labels invocation rows from opened private progress and keeps the UUID in technical details', async () => {
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'invocation-private-id',
      lifecycle: 'running',
    });
    const progress = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: 'analyze', scope: [] },
      blockKind: 'step' as const,
      attempt: '0',
      logicalInvocationRecordId: invocation.id,
    };
    const screen = await renderContent({
      definition: createWorkflowDefinitionFixture({
        blocks: [
          {
            kind: 'step',
            id: 'analyze',
            document: {
              text: 'Analyze changes',
              references: [],
              attachments: [],
            },
            input: [],
            result: { kind: 'text' },
          },
        ],
      }),
      invocations: [invocation],
      selectedInvocationId: invocation.id,
      selectedInvocationProgress: progress,
      invocationProgressById: new Map([[invocation.id, progress]]),
    });

    expect(screen.getTextContent()).toContain('Analyze changes');
    expect(screen.getTextContent()).not.toContain('invocation-private-id');
    await openTechnicalDetails(screen);
    expect(screen.getTextContent()).toContain('invocation-private-id');
  });

  it('offers only the controls the canonical availability projection permits', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'running',
        availability: { pause: false, cancel: true, resumeBoundary: false },
      }),
      onPause: vi.fn(),
      onCancel: vi.fn(),
      onResume: vi.fn(),
    });

    expect(screen.findByTestId('workflow-run-cancel')).toBeTruthy();
    // `pause: false` is the owner saying this Run cannot pause; the UI must
    // not offer an inert button next to a reason it invented.
    expect(screen.findAllByTestId('workflow-run-pause')).toHaveLength(0);
    expect(screen.findAllByTestId('workflow-run-resume')).toHaveLength(0);
  });

  it('shows a submitted stop as a request, not as an applied stop', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
      onCancel: vi.fn(),
      pendingControl: 'cancel',
    });

    expect(screen.getTextContent()).toContain('workflows.run.stopping');
  });

  it.each(['flow', 'steps', 'activity'] as const)(
    'keeps the cancelled header separate from offline physical stop custody in %s',
    async (view) => {
      const invocation = createWorkflowInvocationIndexFixture({
        id: 'stopping',
        parentRecordId: 'root',
        lifecycle: 'cancel_requested',
      });
      const screen = await renderContent({
        view,
        run: createWorkflowRunSummaryFixture({
          state: 'cancelled',
          workflowCustodyState: 'pending',
        }),
        machineName: 'Build box',
        machineReachable: false,
        deleteBlockedByCustody: true,
        invocations: [invocation],
        invocationProgressById: openedLeafProgress('stopping'),
      });
      expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
      expect(screen.getTextContent()).toContain('workflows.recovery.waitingForStop');
      // The physical step's mark retains its own accessible offline Stop state.
      expect(screen.root.findAll(node => typeof node.type === 'string'
        && typeof node.props.accessibilityLabel === 'string'
        && node.props.accessibilityLabel.startsWith('workflows.run.stopWhenMachineReconnects')).length).toBeGreaterThan(0);
      expect(screen.getTextContent()).not.toContain(
        'workflows.invocationState.cancel_requested',
      );
      expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
      expect(screen.findByTestId('workflow-run-needs-you')).toBeNull();
    },
  );

  /**
   * One durable operation at a time (screen mutex). While any is unsettled,
   * every other durable control is withdrawn as busy — not only the button
   * that was pressed — so Retry cannot race a pending Pause. Inspection,
   * selection and the view switch stay live.
   */
  it('withdraws every conflicting durable control while one operation is pending', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'interrupted',
        availability: { cancel: true, pause: true, resumeBoundary: true },
      }),
      onCancel: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRunAgain: vi.fn(),
      onDelete: vi.fn(),
      onReattach: vi.fn(),
      onRetrySameConversation: vi.fn(),
      onRetryFreshAgent: vi.fn(),
      onRetryWithReplacement: vi.fn(),
      onRestoreWorkspace: vi.fn(),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
        continueSameConversation: { kind: 'available' },
        continueFreshAgent: { kind: 'available' },
        restoreWorkspace: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: {
          kind: 'session',
          sessionId: 'session-1',
          localInputId: 'input-1',
        },
        recovery: {
          conversation: 'same_conversation',
          input: {
            kind: 'replacement',
            value: {
              document: { text: 'Finish', references: [], attachments: [] },
              input: [],
            },
          },
        },
      },
      onContinuePrepared: vi.fn(),
      pendingControl: 'retry',
    });

    for (const testID of [
      'workflow-run-cancel',
      'workflow-run-pause',
      'workflow-run-resume',
      'workflow-run-retry-same',
      'workflow-run-retry-fresh',
      'workflow-run-continue-prepared',
    ]) {
      // The host node carries what assistive technology is told.
      const control = screen
        .findAllByTestId(testID)
        .find((node) => typeof node.type === 'string');
      expect(control, testID).toBeTruthy();
      // Busy web controls retain focus for an asynchronous dialog while refusing activation.
      expect(control?.props.accessibilityState, testID).toMatchObject({
        disabled: true,
        busy: true,
      });
    }
    // The rest of the screen is not inert.
    expect(
      screen.findByTestId('workflow-run-view:flow')?.props.disabled,
    ).toBeFalsy();
  });

  it('renders invocation lifecycle from the canonical index, not from structure', async () => {
    const screen = await renderContent({
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          parentRecordId: 'run-root',
          lifecycle: 'waiting_for_capacity',
        }),
      ],
    });

    expect(
      screen.findByTestId('workflow-run-invocations-state-inv-1'),
    ).toBeTruthy();
  });

  it('switches to Flow without losing the selected invocation identity', async () => {
    const onChangeView = vi.fn();
    const screen = await renderContent({
      active: true,
      selectedInvocationId: 'inv-1',
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'running',
        }),
      ],
      onChangeView,
    });

    const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
    await act(async () => { await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'flow' }); });

    expect(onChangeView).toHaveBeenCalledWith('flow');
  });

  it('maps Flow state only from opened private invocation paths, never by guessing ids', async () => {
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'inv-1',
      lifecycle: 'running',
    });
    const progress = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: 'analyze', scope: [] },
      blockKind: 'step' as const,
      attempt: '0',
      logicalInvocationRecordId: 'inv-1',
    };
    const screen = await renderContent({
      view: 'flow',
      invocations: [invocation],
      invocationProgressById: new Map([['inv-1', progress]]),
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: progress,
    });
    expect(
      screen.findByTestId('workflow-run-flow-node-analyze-state'),
    ).toBeTruthy();
  });

  it('keeps repeated scoped occurrences and attempts individually selectable by exact invocation id', async () => {
    const onSelectInvocation = vi.fn();
    const invocations = [
      createWorkflowInvocationIndexFixture({
        id: 'item-1-attempt-0',
        sequence: '1',
        lifecycle: 'completed',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'item-2-attempt-0',
        sequence: '2',
        lifecycle: 'superseded',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'item-2-attempt-1',
        sequence: '3',
        attempt: '1',
        lifecycle: 'running',
      }),
    ];
    const invocationProgressById = new Map(
      invocations.map((invocation, index) => [
        invocation.id,
        {
          kind: 'happier.workflow-progress.v1' as const,
          invocationPath: {
            blockId: 'analyze',
            scope: [
              { kind: 'iteration' as const, blockId: 'rounds', index: 2 },
              {
                kind: 'iteration' as const,
                blockId: 'files',
                index: index === 0 ? 0 : 1,
              },
            ],
          },
          frame: {
            ownerBlockId: 'files',
            source: { kind: 'item' as const, index: index === 0 ? '0' : '1' },
          },
          blockKind: 'step' as const,
          attempt: invocation.attempt,
          logicalInvocationRecordId:
            index === 2 ? 'item-2-attempt-0' : invocation.id,
          ...(index === 2
            ? { previousAttemptRecordId: 'item-2-attempt-0' }
            : {}),
        },
      ]),
    );

    const screen = await renderContent({
      view: 'flow',
      invocations,
      invocationProgressById,
      selectedInvocationId: 'item-2-attempt-1',
      selectedInvocationProgress:
        invocationProgressById.get('item-2-attempt-1'),
      onSelectInvocation,
    });

    expect(
      screen.findByTestId(
        'workflow-run-flow-node-analyze-occurrence-item-1-attempt-0',
      ),
    ).toBeTruthy();
    expect(
      screen.findByTestId(
        'workflow-run-flow-node-analyze-occurrence-item-2-attempt-0',
      ),
    ).toBeTruthy();
    expect(
      screen.findByTestId(
        'workflow-run-flow-node-analyze-occurrence-item-2-attempt-1',
      ),
    ).toBeTruthy();
    expect(screen.getTextContent()).toContain(
      'workflows.run.occurrenceRound:{"number":"3"}',
    );
    expect(screen.getTextContent()).toContain(
      'workflows.run.occurrenceItem:{"number":"2"}',
    );
    await screen.pressByTestIdAsync(
      'workflow-run-flow-node-analyze-occurrence-item-2-attempt-0',
    );
    expect(onSelectInvocation).toHaveBeenCalledWith('item-2-attempt-0');
  });

  it('names and selects an exact unopened loop occurrence in Flow, starting from a paged index alone', async () => {
    const onSelectInvocation = vi.fn();
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'loop',
          id: 'files',
          repetition: {
            kind: 'items',
            items: { kind: 'input', name: 'files' },
            execution: 'parallel',
            failurePolicy: 'collect_outcomes',
          },
          body: [
            {
              kind: 'step',
              id: 'inspect',
              document: {
                text: 'Inspect the current item',
                references: [],
                attachments: [],
              },
              input: [],
              result: { kind: 'text' },
            },
          ],
        },
      ] as never,
    });
    const invocations = [
      createWorkflowInvocationIndexFixture({
        id: 'root',
        parentRecordId: null,
        memberOrdinal: '0',
        sequence: '0',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'loop',
        parentRecordId: 'root',
        memberOrdinal: '0',
        sequence: '1',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'frame-0',
        parentRecordId: 'loop',
        memberOrdinal: '0',
        sequence: '2',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'frame-1',
        parentRecordId: 'loop',
        memberOrdinal: '1',
        sequence: '3',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'inspect-0',
        parentRecordId: 'frame-0',
        memberOrdinal: '0',
        sequence: '4',
        lifecycle: 'completed',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'inspect-1',
        parentRecordId: 'frame-1',
        memberOrdinal: '0',
        sequence: '5',
        lifecycle: 'waiting_for_approval',
      }),
    ];

    const screen = await renderContent({
      view: 'flow',
      definition,
      invocations,
      // Nothing has been opened: no private progress exists yet.
      onSelectInvocation,
    });

    // The Map opens on the item that needs the person, named by the selector.
    expect(screen.getTextContent()).toContain(
      'workflows.run.occurrenceItem:{"number":"2"}',
    );
    await screen.pressByTestIdAsync('workflow-run-flow-node-inspect');
    expect(onSelectInvocation).toHaveBeenCalledWith('inspect-1');
    await screen.pressByTestIdAsync('workflow-run-flow-node-files-item-selector-previous');
    expect(screen.getTextContent()).toContain(
      'workflows.run.occurrenceItem:{"number":"1"}',
    );
    await screen.pressByTestIdAsync('workflow-run-flow-node-inspect');
    expect(onSelectInvocation).toHaveBeenCalledWith('inspect-0');
  });

  it('gives Activity rows their authored identity before any private detail has been opened', async () => {
    const invocations = [
      createWorkflowInvocationIndexFixture({
        id: 'root',
        parentRecordId: null,
        memberOrdinal: '0',
        sequence: '0',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'analyze-row',
        parentRecordId: 'root',
        memberOrdinal: '0',
        sequence: '1',
      }),
    ];
    const screen = await renderContent({ invocations });

    // A log row says what ran on its own: an unnamed step reads as its prompt, never "Agent step" on every row (owner 09.17.14).
    const row = screen.findByTestId('workflow-run-invocations-row-analyze-row');
    expect(row?.props.accessibilityLabel).toContain('Analyze the repository');
    expect(row?.props.accessibilityLabel).not.toContain(
      'workflows.contentUnavailable',
    );
  });

  it('reads an unconditional Activity branch as the condition that ran', async () => {
    const { WORKFLOW_CONDITION_UNSET } = await import('../presentation/workflowConditionRules');
    const invocation = createWorkflowInvocationIndexFixture({ id: 'choice-row', lifecycle: 'completed' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1', blockKind: 'if', attempt: '0',
      logicalInvocationRecordId: invocation.id, invocationPath: { blockId: 'choice', scope: [] },
    });
    const screen = await renderContent({
      definition: createWorkflowDefinitionFixture({ blocks: [{
        kind: 'if', id: 'choice', when: WORKFLOW_CONDITION_UNSET,
        then: [{ kind: 'wait', id: 'check', document: { text: 'Check', references: [], attachments: [] } }], otherwise: [],
      }] }),
      invocations: [invocation], invocationProgressById: new Map([[invocation.id, progress]]),
    });
    const row = screen.findByTestId('workflow-run-invocations-row-choice-row');
    expect(row?.props.accessibilityLabel).toContain('workflows.condition.always');
    expect(row?.props.accessibilityLabel).not.toContain('workflows.condition.unsetSentence');
  });

  it('marks an unopened authored Flow node unavailable instead of activating a guessed invocation', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      view: 'flow',
      invocations: [createWorkflowInvocationIndexFixture({ id: 'opaque-row' })],
      onSelectInvocation,
    });

    const node = screen.findByTestId('workflow-run-flow-node-analyze');
    expect(node?.props.accessibilityState).toMatchObject({ disabled: true });
    node?.props.onPress?.();
    expect(onSelectInvocation).not.toHaveBeenCalled();
  });

  it('keeps technical identity behind the details section rather than in the outcome', async () => {
    const screen = await renderContent();
    expect(screen.getTextContent()).not.toContain('run-1');
    await openTechnicalDetails(screen);
    expect(screen.getTextContent()).toContain('run-1');
    expect(screen.getTextContent()).toContain('machine-1');
  });

  /**
   * The Machine is identified the way the rest of Happier names it. The
   * exact id stays available beside the name; an unnamed Machine keeps
   * showing its id rather than a blank.
   */
  it('names the frozen Machine in technical details and keeps its exact id', async () => {
    const named = await renderContent({ machineName: 'Mac Studio' });
    await openTechnicalDetails(named);
    expect(named.findByTestId('workflow-run-machine')?.props.children).toBe(
      'Mac Studio',
    );
    expect(named.findByTestId('workflow-run-machine-id')?.props.children).toBe(
      'machine-1',
    );
    await named.unmount();

    const unnamed = await renderContent();
    await openTechnicalDetails(unnamed);
    expect(unnamed.findByTestId('workflow-run-machine')?.props.children).toBe(
      'machine-1',
    );
    expect(unnamed.findByTestId('workflow-run-machine-id')).toBeNull();
  });

  it.each(['session', 'session_ready'] as const)('still reaches the conversation through the %s invocation header action', async (kind) => {
    const openSession = vi.fn();
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: kind === 'session'
          ? { kind, sessionId: 'session-1', localInputId: 'input-1' }
          : { kind, sessionId: 'session-1' },
      },
      onOpenSession: openSession,
    });
    expect(screen.findByTestId('workflow-run-open-session')).toBeNull();
    await screen.pressByTestIdAsync('workflow-run-selected-open-execution');
    expect(openSession).toHaveBeenCalledWith('session-1');
  });

  it.each([true, false])('still reaches the conversation from a prepared related Wait execution only when inspectable: %s', async (canInspectExecution) => {
    const onOpenSession = vi.fn();
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'confirm', scope: [] }, blockKind: 'wait', attempt: '0', logicalInvocationRecordId: 'inv-1' }),
      selectedRelatedExecution: { execution: { kind: 'session_ready', sessionId: 'second-opinion' }, canInspectExecution },
      onOpenSession,
    });
    if (canInspectExecution) {
      await screen.pressByTestIdAsync('workflow-run-selected-open-execution');
      expect(onOpenSession).toHaveBeenCalledWith('second-opinion');
    } else {
      expect(screen.findByTestId('workflow-run-selected-open-execution')).toBeNull();
    }
    expect(screen.findByTestId('session-in-pane-inactive:second-opinion')).toBeNull();
  });

  it('routes a detached invocation to the canonical execution Run owner', async () => {
    const openExecutionRun = vi.fn();
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      selectedSessionId: 'stale-session',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: {
          kind: 'detached_run',
          runId: 'execution/run 1',
          localInputId: 'input-1',
          runtimeSelection: {},
        },
      },
      onOpenExecutionRun: openExecutionRun,
    });
    expect(
      screen.findByTestId('session-in-pane-inactive:stale-session'),
    ).toBeNull();
    expect(screen.findByTestId('workflow-run-open-execution-run')).toBeNull();
    await screen.pressByTestIdAsync('workflow-run-selected-open-execution');
    expect(openExecutionRun).toHaveBeenCalledWith('execution/run 1');
    expect(screen.findByTestId('workflow-run-open-session')).toBeNull();
  });

  it('shows the exact selected invocation input and result from opened private content', async () => {
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        input: { repository: 'happier' },
        result: { passed: false, summary: 'One issue remains' },
        usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
      },
    });

    expect(screen.findByTestId('workflow-run-invocation-input')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-invocation-result')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-invocation-usage')).toBeTruthy();
    expect(screen.getTextContent()).toContain('One issue remains');
    expect(screen.getTextContent()).toContain('150');
  });

  it('leads a stopped step with one recovery card and reads its authored input as words (DESIGN-17 R1)', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      machineName: 'NLDW6-3-11-20',
      machineReachable: false,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        input: {
          document: {
            text: 'Check the quiet habit',
            references: [],
            attachments: [],
          },
          input: [],
        },
      },
    });

    const card = screen.findByTestId('workflow-run-recovery-card');
    expect(card).not.toBeNull();
    // One card headed by its cause, inside the sheet (lab run-A_interrupted), and quiet: with nothing
    // to choose yet, nothing needs you, so it carries no needs-you tint (DESIGN-18 R1b).
    // The canonical screen query resolves React's collapsed memo fibers;
    // raw instance.findAllByType misses the real memoized ItemGroup/Item.
    const sheet = screen
      .findAllByType(ItemGroup)
      .find((group) => card!.findAll((node) => node === group).length > 0);
    expect(sheet).toBeDefined();
    expect(sheet!.props.title).toBeUndefined();
    expect(sheet!.props.containerStyle ?? null).toBeNull();
    const cause = screen
      .findAllByType(Item)
      .find((item) => item.props.testID === 'workflow-run-recovery-cause');
    expect(cause?.props.title).toBe('workflows.recovery.causeNotRecorded');
    const text = screen.getTextContent();
    expect(text).not.toContain('workflows.recovery.lostContact');
    expect(text).toContain('workflows.recovery.choicesOnReconnect');
    // Said once: the card owns "when choices appear", so the outcome region does not repeat it.
    expect(screen.findByTestId('workflow-run-machine-unavailable')).toBeNull();
    expect(screen.findByTestId('workflow-run-invocation-input-value')).not.toBeNull();
    expect(text).toContain('Check the quiet habit');
    expect(text).not.toContain('"references"');
  });

  it('names the Run\'s own way forward without inferring unknown effects from an unavailable target', async () => {
    const render = async (overrides: Partial<ContentProps>) => {
      const invocation = createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'failed' });
      const progress = {
        kind: 'happier.workflow-progress.v1' as const,
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step' as const,
        attempt: '0',
        logicalInvocationRecordId: invocation.id,
        reason: { code: 'target_unavailable', message: null },
      };
      const screen = await renderContent({
        invocations: [invocation],
        selectedInvocationId: invocation.id,
        selectedInvocationProgress: progress as never,
        invocationProgressById: new Map([[invocation.id, progress as never]]),
        ...overrides,
      });
      lastScreen = screen;
      return screen.findAllByType(Item)
        .find((item) => item.props.testID === 'workflow-run-recovery-cause')?.props.subtitle;
    };
    let lastScreen: Awaited<ReturnType<typeof renderContent>> | null = null;
    // An unavailable target alone does not establish whether effects or activity are unknown.
    expect(await render({ run: createWorkflowRunSummaryFixture({ state: 'running' }), onCancel: vi.fn() }))
      .toBe('workflows.recovery.noChoices workflows.recovery.nextStop');
    expect(lastScreen!.findByTestId('workflow-run-recovery-run-again')).toBeNull();
    // Ended: Run again is the way on, as the card's own primary right under the failure; the line says only why.
    const onRunAgain = vi.fn();
    expect(await render({ run: createWorkflowRunSummaryFixture({ state: 'failed', availability: { cancel: false } as never }),
      onRunAgain }))
      .toBe('workflows.recovery.noChoices');
    await lastScreen!.pressByTestIdAsync('workflow-run-recovery-run-again');
    expect(onRunAgain).toHaveBeenCalledOnce();
    // A real preparation refusal can carry target_unavailable before any input was admitted.
    // Its exact recovery owner must not be contradicted by an uncertain-stop explanation.
    expect(await render({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      onCancel: vi.fn(),
      invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'needs_attention' })],
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'execution_not_admitted' },
        retry: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        continueSameConversation: { kind: 'unavailable', reason: 'recovery_not_prepared' },
        continueFreshAgent: { kind: 'unavailable', reason: 'recovery_not_prepared' },
        restoreWorkspace: { kind: 'unavailable', reason: 'workspace_unavailable' },
      },
    })).toBe('workflows.recovery.noChoices workflows.recovery.nextStop');

    // B220-03: the retained Action refusal belongs to a settled parent Run.
    // A lack of retry choices does not turn its target refusal into an unknown stop.
    const refused = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'action',
      invocationPath: { blockId: 'refused', scope: [{ kind: 'iteration', blockId: 'failureMap', index: 1 }] },
      attempt: '0', logicalInvocationRecordId: 'inv-1', reason: { code: 'target_unavailable', message: 'target_unavailable',
        failureCause: { phase: 'workflow.run.summaries', errorClass: 'Error', errorCode: 'target_unavailable', httpStatus: null } },
      execution: { kind: 'action', actionId: 'workflow.run.summaries', actionRequestId: 'refusal-request', localInputId: 'workflow:refused:action',
        input: {} } });
    const unavailable = { kind: 'unavailable', reason: 'run_not_interrupted' } as const;
    expect(await render({ run: createWorkflowRunSummaryFixture({ state: 'succeeded', workflowCustodyState: 'settled' }),
      selectedInvocationProgress: refused, invocationProgressById: new Map([['inv-1', refused]]),
      selectedInvocationRecoveryAvailability: { reattach: unavailable, retry: unavailable, continueSameConversation: unavailable,
        continueFreshAgent: unavailable, restoreWorkspace: unavailable }, onRunAgain,
    })).toBe('workflows.recovery.noChoices');
  });

  it('heads an uncertain step with its effects and an unexplained failed step with cause not recorded', async () => {
    const render = async (lifecycle: 'outcome_uncertain' | 'failed') => {
      const invocation = createWorkflowInvocationIndexFixture({
        id: 'inv-1',
        lifecycle,
      });
      const progress = {
        kind: 'happier.workflow-progress.v1' as const,
        invocationPath: { blockId: 'publish', scope: [] },
        blockKind: 'step' as const,
        attempt: '0',
        logicalInvocationRecordId: invocation.id,
      };
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({ state: 'failed' }),
        definition: createWorkflowDefinitionFixture({
          blocks: [
            {
              kind: 'step',
              id: 'publish',
              name: 'Publish summary',
              document: {
                text: 'Publish the summary',
                references: [],
                attachments: [],
              },
              input: [],
              result: { kind: 'text' },
            },
          ],
        }),
        invocations: [invocation],
        selectedInvocationId: invocation.id,
        selectedInvocationProgress: progress,
        invocationProgressById: new Map([[invocation.id, progress]]),
        onAcknowledgeUncertainPriorEffects: vi.fn(),
      });
      const item = (testID: string) =>
        screen
          .findAllByType(Item)
          .find((candidate) => candidate.props.testID === testID);
      return {
        head: item('workflow-run-recovery-cause')?.props.title,
        acknowledgement: item('workflow-run-uncertain-effects'),
      };
    };
    // The possible effects are said once, in the card's head; the acknowledgement row keeps only its choice.
    const uncertain = await render('outcome_uncertain');
    expect(uncertain.head).toBe(
      'workflows.recovery.uncertainEffects:{"block":"Publish summary"}',
    );
    expect(uncertain.acknowledgement?.props.subtitle).toBeUndefined();
    expect((await render('failed')).head).toBe(
      'workflows.recovery.causeNotRecorded',
    );
  });

  it("keeps a failed step's cause in its open card, its code under Technical details, and completed steps quiet", async () => {
    const recordedStorageMessage = 'The Run store could not be written.';
    const retryFreshAgent = vi.fn();
    const notPrepared = { kind: 'unavailable', reason: 'recovery_not_prepared' } as const;
    const render = async (lifecycle: 'failed' | 'completed') => {
      const invocation = createWorkflowInvocationIndexFixture({
        id: 'inv-1',
        lifecycle,
      });
      const progress = {
        kind: 'happier.workflow-progress.v1' as const,
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step' as const,
        attempt: '0',
        logicalInvocationRecordId: invocation.id,
        reason: {
          code: 'storage_unavailable',
          message: recordedStorageMessage,
        },
      };
      return renderContent({
        run: createWorkflowRunSummaryFixture({
          state: lifecycle === 'failed' ? 'interrupted' : 'succeeded',
        }),
        invocations: [invocation],
        selectedInvocationId: invocation.id,
        selectedInvocationProgress: progress,
        invocationProgressById: new Map([[invocation.id, progress]]),
        firstFailedInvocationId: invocation.id,
        firstFailedInvocationResolution: 'resolved',
        selectedInvocationRecoveryAvailability: lifecycle === 'failed' ? {
          reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
          retry: { kind: 'available', causalInvocationIds: [invocation.id] },
          continueSameConversation: notPrepared,
          continueFreshAgent: { kind: 'available' },
          restoreWorkspace: notPrepared,
        } : null,
        onRetryFreshAgent: retryFreshAgent,
      });
    };
    const failed = await render('failed');
    // The readable cause heads the card; the typed code waits one tap away, never in the headline.
    const head = failed
      .findAllByType(Item)
      .find((item) => item.props.testID === 'workflow-run-recovery-cause');
    expect(head?.props.title).toBe('workflows.readState.storageTitle');
    expect(failed.getTextContent()).not.toContain(recordedStorageMessage);
    expect(failed.getTextContent()).not.toContain('storage_unavailable');
    const { TechnicalDetailsDisclosure } =
      await import('@/components/ui/lists/TechnicalDetailsDisclosure');
    const details = failed.findAllByType(TechnicalDetailsDisclosure as never);
    expect(details).toHaveLength(1);
    expect(details[0]?.props.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'failure-code', value: 'storage_unavailable' }),
      expect.objectContaining({ key: 'failure-cause', value: recordedStorageMessage }),
    ]));
    // The Run keeps its failure cause visible while the selected step is inspected.
    expect(failed.findAllByTestId('workflow-run-failure-reason').length).toBeGreaterThan(0);
    expect(failed.findByTestId('workflow-run-failure-reason')?.props.children)
      .toContain('workflows.readState.storageTitle');
    await failed.pressByTestIdAsync('workflow-run-invocation-technical.header');
    expect(failed.getTextContent()).toContain('storage_unavailable');
    expect(failed.getTextContent()).toContain(recordedStorageMessage);
    await failed.pressByTestIdAsync('workflow-run-retry-fresh');
    expect(retryFreshAgent).toHaveBeenCalledOnce();
    await failed.unmount();

    // With no step open, the header is the one place that says why the Run failed.
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'inv-1',
      lifecycle: 'failed',
    });
    const progress = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: 'analyze', scope: [] },
      blockKind: 'step' as const,
      attempt: '0',
      logicalInvocationRecordId: invocation.id,
      reason: {
        code: 'storage_unavailable',
        message: recordedStorageMessage,
      },
    };
    const unselected = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'failed' }),
      invocations: [invocation],
      selectedInvocationId: null,
      invocationProgressById: new Map([[invocation.id, progress]]),
      firstFailedInvocationId: invocation.id,
      firstFailedInvocationResolution: 'resolved',
    });
    // The same storage cause identifies the failed step without exposing technical prose.
    expect(
      unselected.findByTestId('workflow-run-failure-reason')?.props.children,
    ).toContain('workflows.readState.storageTitle');
    expect(unselected.findByTestId('workflow-run-failure-reason')?.props.children)
      .toContain('workflows.run.stepNumber:{"ordinal":"1"}');
    await unselected.unmount();

    // An interrupted Run whose step failed says why under its status, from the same retained cause.
    const interrupted = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      invocations: [invocation],
      selectedInvocationId: null,
      invocationProgressById: new Map([[invocation.id, progress]]),
      firstFailedInvocationId: invocation.id,
      firstFailedInvocationResolution: 'resolved',
    });
    expect(
      interrupted.findByTestId('workflow-run-failure-reason')?.props.children,
    ).toContain('workflows.readState.storageTitle');
    expect(interrupted.findByTestId('workflow-run-failure-reason')?.props.children)
      .toContain('workflows.run.stepNumber:{"ordinal":"1"}');
    await interrupted.unmount();

    // Storage can park the root before a Session leaf is admitted. Its retained
    // cause must still explain the interrupted Run without selecting a step.
    const root = createWorkflowInvocationIndexFixture({ id: 'root-storage', parentRecordId: null, lifecycle: 'needs_attention' });
    const rootProgress = WorkflowProgressEnvelopeV1Schema.parse({ ...progress, blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      logicalInvocationRecordId: root.id, reason: { code: 'storage_unavailable',
        message: 'Workflow storage is temporarily unavailable (database_transaction_timeout).',
        failureCause: { phase: 'workflow.storage.invocations.fact', errorClass: 'Error', errorCode: 'database_transaction_timeout', httpStatus: 503 } } });
    const beforePrepare = await renderContent({ run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      invocations: [root], selectedInvocationId: null, invocationProgressById: new Map([[root.id, rootProgress]]),
      firstFailedInvocationId: null, firstFailedInvocationResolution: 'resolved' });
    expect(beforePrepare.findByTestId('workflow-run-failure-reason')?.props.children).toContain('workflows.readState.storageTitle');
    expect(beforePrepare.getTextContent()).not.toContain('session.startFailure.cause.database_transaction_timeout');
    expect(beforePrepare.getTextContent()).not.toContain('Workflow storage is temporarily unavailable (database_transaction_timeout).');
    await beforePrepare.unmount();

    // A step that finished says nothing about an older failure reason.
    const completed = await render('completed');
    expect(completed.getTextContent()).not.toContain(recordedStorageMessage);
    expect(completed.getTextContent()).not.toContain('workflows.readState.storageTitle');
    expect(completed.getTextContent()).not.toContain('storage_unavailable');
    expect(completed.findByTestId('workflow-run-retry-fresh')).toBeNull();
    expect(
      completed.findAllByType(TechnicalDetailsDisclosure as never),
    ).toHaveLength(0);
  });

  /**
   * UX handbook §4.5: the outline says when its page is still loading rather
   * than looking like the end of history, and a loaded Run with no rows says
   * nothing has started — not the collection's "runs appear here" copy.
   */
  it.each(['activity', 'flow', 'steps'] as const)('states a still-loading %s outline and an empty loaded outline distinctly', async view => {
    const loading = await renderContent({
      view,
      invocationsLoaded: false,
      invocationHistoryComplete: false,
    });
    expect(
      loading.findByTestId('workflow-run-invocations-loading'),
    ).not.toBeNull();
    expect(loading.findByTestId('workflow-run-invocations-empty')).toBeNull();
    await loading.unmount();

    const empty = await renderContent({ invocationsLoaded: true, view: 'activity' });
    expect(empty.findByTestId('workflow-run-invocations-loading')).toBeNull();
    expect(
      empty.findByTestId('workflow-run-invocations-empty')?.props.children,
    ).toBe('workflows.problem.executionNotStarted');
  });

  /**
   * UX-26: per-step usage is explicitly unavailable when the provider
   * supplied none — never omitted as if it were zero or simply not loaded.
   * A container frame executes no agent, so it carries no usage row at all.
   */
  /**
   * Waiting and skipped rows, and a Run whose Machine went away, state only
   * what their canonical facts establish: the lifecycle plus the closed reason
   * code, and the machine owner's current reachability.
   */
  it('states a skipped cause and lost Machine contact from their canonical facts', async () => {
    const skipped = await renderContent({
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'skipped',
        }),
      ],
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        reason: { code: 'condition_false' },
      },
    });
    expect(
      skipped.findByTestId('workflow-run-invocation-cause'),
    ).not.toBeNull();
    expect(skipped.findByTestId('workflow-run-machine-unavailable')).toBeNull();
    await skipped.unmount();

    const sleeping = await renderContent({
      machineName: 'Build box',
      machineReachable: false,
      machineStatus: { state: 'asleep', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Asleep' },
    });
    expect(
      sleeping.findByTestId('workflow-run-machine-unavailable'),
    ).toBeNull();
    expect(sleeping.getTextContent()).not.toContain(
      'workflows.run.machineUnavailable',
    );
    expect(sleeping.getTextContent()).toContain('workflows.runState.running');
    await sleeping.unmount();

    const lost = await renderContent({
      machineName: 'Mac Studio',
      machineReachable: false,
    });
    expect(
      lost.findByTestId('workflow-run-machine-unavailable'),
    ).not.toBeNull();
    // The line leads with its cause, then what waits on it (one cause per line, 07 S12 Off).
    expect(lost.findByTestId('workflow-run-machine-unavailable')?.props.children).toEqual(expect.arrayContaining([
      'workflows.run.machineUnavailable:{"machine":"Mac Studio"}',
    ]));
    expect(lost.getTextContent()).toContain('workflows.run.machineUnavailableBody');
    await lost.unmount();

    const settled = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      machineName: 'Mac Studio',
      machineReachable: false,
    });
    expect(settled.findByTestId('workflow-run-machine-unavailable')).toBeNull();
  });

  it('omits missing usage for settled steps, running steps and containers', async () => {
    const renderStep = (lifecycle: 'completed' | 'running') =>
      renderContent({
        invocations: [
          createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle }),
        ],
        selectedInvocationId: 'inv-1',
        selectedInvocationProgress: {
          kind: 'happier.workflow-progress.v1',
          invocationPath: { blockId: 'analyze', scope: [] },
          blockKind: 'step',
          attempt: '0',
          logicalInvocationRecordId: 'inv-1',
          ...(lifecycle === 'completed' ? { result: 'done' } : {}),
        },
      });
    // A settled step without usage has no usage row: "Not reported" told nothing (FIN-DESIGN-REVIEW H4).
    const step = await renderStep('completed');
    expect(step.findByTestId('workflow-run-invocation-usage')).toBeNull();
    await step.unmount();

    // A running step has not reported yet; an empty usage row would only be noise.
    const running = await renderStep('running');
    expect(running.findByTestId('workflow-run-invocation-usage')).toBeNull();
    await running.unmount();

    const container = await renderContent({
      selectedInvocationId: 'inv-loop',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'review', scope: [] },
        blockKind: 'loop',
        attempt: '0',
        logicalInvocationRecordId: 'inv-loop',
      },
    });
    expect(container.findByTestId('workflow-run-invocation-usage')).toBeNull();
  });

  it('gives a step that worked in the bare home folder no workspace row, and reads its result before its input', async () => {
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      workspaceHomeDirectory: '/Users/alice',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        input: 'Return the single word FIRST.',
        result: 'FIRST',
        workspace: { descriptor: { machineId: 'machine-1', directory: '/Users/alice', checkoutRootPath: '/Users/alice' } },
      },
    });
    // "Workspace ~" told nothing (FIN-DESIGN-REVIEW H4).
    expect(screen.findByTestId('workflow-run-workspace')).toBeNull();
    const text = screen.getTextContent();
    expect(text.indexOf('FIRST')).toBeGreaterThan(-1);
    expect(text.lastIndexOf('Return the single word')).toBeGreaterThan(text.indexOf('workflows.input.result'));
  });

  it('shows a nested working directory separately from its recorded checkout root', async () => {
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      workspaceHomeDirectory: '/Users/alice',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        workspace: {
          descriptor: {
            machineId: 'machine-1',
            directory: '/Users/alice/project/packages/ui',
            checkoutRootPath: '/Users/alice/project',
            sourceInvocation: {
              producer: { blockId: 'analyze', scope: { kind: 'current' } },
              invocationRecordId: 'inv-analyze-iteration-7',
            },
          },
        },
      },
    });

    expect(
      screen.findByTestId('workflow-run-workspace-path')?.props.children,
    ).toBe('~/project/packages/ui');
    expect(
      screen.findByTestId('workflow-run-workspace-checkout-root')?.props
        .children,
    ).toEqual(['workflows.workspace.projectCheckout', ': ', '~/project']);
    expect(
      screen.findByTestId('workflow-run-workspace-source')?.props.children,
    ).toEqual(
      'workflows.workspace.fromStep:{"block":"Analyze the repository · inv-analyze-iteration-7"}',
    );
  });

  it('keeps an accepted stop request visible after the request itself has settled', async () => {
    const stopAgain = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'running',
        availability: { cancel: true },
      }),
      machineName: 'Mac Studio',
      // The request completed; the Run is still active and the server
      // recorded `cancel_requested`. Reverting to "Stop" here told the
      // person to stop a Run that is already stopping.
      pendingControl: null,
      cancelRequested: true,
      onCancel: stopAgain,
    });

    expect(screen.getTextContent()).toContain(
      'workflows.run.stopRequested:{"machine":"Mac Studio"}',
    );
    expect(screen.getTextContent()).toContain('workflows.run.stopAgain');
    expect(screen.getTextContent()).not.toContain('"workflows.run.stop"');
    await screen.pressByTestIdAsync('workflow-run-cancel');
    expect(stopAgain).toHaveBeenCalledTimes(1);
  });

  it('does not invent a repeat-stop affordance from delete custody alone', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'outcome_uncertain',
        workflowCustodyState: 'pending',
        availability: { cancel: true },
      }),
      deleteBlockedByCustody: true,
      onCancel: vi.fn(),
    });

    // Custody is not a control state. Without a durable cancel receipt the
    // control is the ordinary Stop.
    expect(screen.getTextContent()).not.toContain('workflows.run.stopAgain');
    expect(screen.getTextContent()).toContain('workflows.run.stop');
  });

  it('presents canonical cancellation separately from unresolved stop confirmation', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'running', workflowCustodyState: 'pending' }),
      cancelRequested: true,
      pendingControl: null,
    });
    await screen.update(<WorkflowRunContent {...screen.contentProps}
      run={createWorkflowRunSummaryFixture({ state: 'cancelled', revision: 8,
        workflowCustodyState: 'pending', availability: { cancel: false, pause: false } })}
      cancelRequested={false}
      deleteBlockedByCustody
    />);

    expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
    expect(screen.getTextContent()).not.toContain('workflows.run.stopping');
    expect(screen.findByTestId('workflow-run-custody-pending')).not.toBeNull();
    expect(screen.getTextContent()).toContain('workflows.recovery.waitingForStop');
  });

  it('resolves exactly one primary action when a terminal Run can also be run again', async () => {
    const onRunAgain = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'succeeded',
        availability: { cancel: false, pause: false },
      }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-failed',
          lifecycle: 'failed',
        }),
      ],
      firstFailedInvocationId: 'inv-failed',
      firstFailedInvocationResolution: 'resolved',
      onRunAgain,
    });

    // The outcome region's dominant action is the one the state calls for.
    // `Run workflow again` stays available, but it stops competing with it.
    expect(
      screen
        .findAllByType(ToolbarButton)
        .filter((button) => button.props.tone === 'primary')
        .map((button) => button.props.testID),
    ).toEqual(['workflow-run-see-failures']);
    await screen.pressByTestIdAsync('workflow-run-run-again');
    expect(onRunAgain).toHaveBeenCalledOnce();
  });

  it('keeps Run again secondary after success without a selected final output', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'succeeded',
        availability: { cancel: false, pause: false },
      }),
      onRunAgain: vi.fn(),
    });
    expect(
      flattenTestStyle(
        screen.findByTestId('workflow-run-run-again')?.props.style,
      ).borderWidth,
    ).not.toBe(0);
  });

  it('offers the canonical Steps view when a successful Run has no final output', async () => {
    const connection = await serveActionHomes({ homes: [{ key: 'navigation', serverUrl: 'https://workflow-run-navigation.test', accountId: 'run-navigation-account' }],
      route: request => createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    onTestFinished(() => connection.dispose());
    const onChangeView = vi.fn();
    const screen = await renderContent({
      active: true,
      serverId: connection.homes.navigation!.id,
      run: createWorkflowRunSummaryFixture({
        state: 'succeeded',
        availability: { cancel: false, pause: false },
      }),
      onChangeView,
    });
    await flushHookEffects();
    expect(screen.findByTestId('workflow-run-inspect-steps') !== null).toBe(
      true,
    );
    // A healthy Run stays calm: Inspect steps is offered, but not as a filled primary.
    expect(screen.findByTestId('workflow-run-inspect-steps')?.props.tone).not.toBe('primary');
    await screen.pressByTestIdAsync('workflow-run-inspect-steps');
    expect(onChangeView).toHaveBeenCalledWith('steps');
  });

  it('leads a stopped Run with Run workflow again, not Inspect steps (07 §6.1)', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'cancelled',
        workflowCustodyState: 'settled',
        availability: { cancel: false, pause: false },
      }),
      onChangeView: vi.fn(),
      onRunAgain: vi.fn(),
    });
    expect(
      screen
        .findAllByType(ToolbarButton)
        .filter((button) => button.props.tone === 'primary')
        .map((button) => button.props.testID),
    ).toEqual(['workflow-run-run-again']);
    expect(screen.findByTestId('workflow-run-inspect-steps')).toBeNull();
  });

  it('states how many interventions the Needs-you section holds', async () => {
    const screen = await renderContent({
      invocationProgressById: openedLeafProgress('inv-a', 'inv-b'),
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-a',
          lifecycle: 'waiting_for_approval',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'inv-b',
          sequence: '1',
          lifecycle: 'needs_attention',
        }),
      ],
    });

    const section = screen.findByTestId('workflow-run-needs-you');
    expect(section?.props.accessibilityLabel).toBe(
      'workflows.a11y.needsYou:{"count":2}',
    );
    expect(screen.getTextContent()).toContain('2');
  });

  it('announces a failed control request instead of leaving it silent', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
      errorLabel: 'workflows.problem.targetUnavailable',
      errorSemantics: 'alert',
    });

    expect(
      screen.findByTestId('workflow-run-error')?.props.accessibilityRole,
    ).toBe('alert');
  });

  it('lets someone copy the exact technical identifiers', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        id: 'run-exact',
        state: 'running',
      }),
    });

    await openTechnicalDetails(screen);
    expect(screen.findByTestId('workflow-run-run-id')?.props.selectable).toBe(
      true,
    );
    expect(screen.findByTestId('workflow-run-revision')?.props.selectable).toBe(
      true,
    );
  });

  it('offers a reviewed new whole Run when the original workspace is unavailable', async () => {
    const startReviewedNewRun = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'cancelled',
        workflowCustodyState: 'settled',
      }),
      selectedInvocationId: 'inv-1',
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        reason: { code: 'workspace_unavailable' },
      },
      onRestoreWorkspace: vi.fn(),
      onStartReviewedNewRun: startReviewedNewRun,
    });

    // No restoration producer exists, so this is D4's second arm — and the
    // copy warns about repetition because only this arm repeats work.
    expect(screen.getTextContent()).toContain(
      'workflows.workspace.unavailableNewRunBody',
    );
    expect(
      screen.findAllByTestId('workflow-run-restore-workspace'),
    ).toHaveLength(0);
    await screen.pressByTestIdAsync('workflow-run-start-reviewed-new-run');
    expect(startReviewedNewRun).toHaveBeenCalledTimes(1);
    expect(screen.findAllByTestId('workflow-run-reattach')).toHaveLength(0);
  });

  it('offers exact workspace restoration when the canonical recovery projection permits it', async () => {
    const restoreWorkspace = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'interrupted',
        // Settled custody removes the waiting-for-stop block, so this is
        // the exact state in which both D4 arms were offered together.
        workflowCustodyState: 'settled',
        availability: { restoreWorkspace: true },
      }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'workspace_unavailable' },
        retry: { kind: 'unavailable', reason: 'workspace_unavailable' },
        continueSameConversation: {
          kind: 'unavailable',
          reason: 'workspace_unavailable',
        },
        continueFreshAgent: {
          kind: 'unavailable',
          reason: 'workspace_unavailable',
        },
        restoreWorkspace: { kind: 'available' },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        reason: { code: 'workspace_unavailable' },
        workspace: {
          creationIntent: {
            kind: 'git_worktree',
            sourceDirectory: '/repo',
            baseRef: 'a'.repeat(40),
            displayName: 'workflow-analyze',
            branchMode: 'new',
          },
          descriptor: {
            machineId: 'machine-1',
            directory: '/repo/.worktrees/workflow-analyze',
            checkoutRootPath: '/repo/.worktrees/workflow-analyze',
            checkout: { kind: 'git_worktree', branchName: 'workflow-analyze' },
          },
        },
      },
      onRestoreWorkspace: restoreWorkspace,
      onStartReviewedNewRun: vi.fn(),
    });

    await screen.pressByTestIdAsync('workflow-run-restore-workspace');
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
    // Restoring resumes this Run with its completed work intact, so the
    // strictly worse offer is withheld and the copy does not warn about
    // repeating work that will not be repeated.
    expect(
      screen.findAllByTestId('workflow-run-start-reviewed-new-run'),
    ).toHaveLength(0);
    expect(screen.getTextContent()).toContain(
      'workflows.workspace.unavailableRestoreBody',
    );
    expect(screen.getTextContent()).not.toContain(
      'workflows.recovery.repeatedEffectWarning',
    );
  });

  it('blocks workspace replacement while authoritative Run custody is still pending', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'interrupted',
        workflowCustodyState: 'pending',
      }),
      selectedInvocationId: 'inv-1',
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        reason: { code: 'workspace_unavailable' },
      },
      onStartReviewedNewRun: vi.fn(),
    });

    expect(
      screen.findByTestId('workflow-run-recovery-waiting-for-stop'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('workflow-run-start-reviewed-new-run'),
    ).toBeNull();
  });

  it('gives the completion haptic a visible twin on the outcome region', async () => {
    const emphasised = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      completionEmphasis: true,
    });
    const quiet = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
    });

    // A haptic with nothing on screen is feedback only some users receive.
    const emphasisedStyle = flattenTestStyle(
      emphasised.findByTestId('workflow-run-outcome-region')?.props.style,
    );
    const quietStyle = flattenTestStyle(
      quiet.findByTestId('workflow-run-outcome-region')?.props.style,
    );
    expect(emphasisedStyle.backgroundColor).toBeDefined();
    expect(quietStyle.backgroundColor).toBeUndefined();
    expect(
      emphasised.findByTestId('workflow-run-outcome-emphasis'),
    ).toBeTruthy();
    expect(quiet.findByTestId('workflow-run-outcome-emphasis')).toBeNull();
  });

  it('keeps Delete history in the destructive overflow instead of beside normal actions', async () => {
    const screen = await renderContent({
      onDelete: vi.fn(),
      onRunAgain: vi.fn(),
    });
    expect(screen.findByTestId('workflow-run-delete')).toBeNull();
    expect(screen.findByTestId('workflow-run-overflow')).toBeTruthy();
  });

  it('offers Save as workflow from the frozen managed definition through the actions menu', async () => {
    const saveAsWorkflow = vi.fn();
    // The overflow opens the real canonical Popover, whose web placement owner
    // subscribes to `window`. The shared testkit harness supplies exactly those
    // globals instead of replacing the owner with a local stand-in.
    await withPopoverWebGlobals(async () => {
      const screen = await renderContent({
        hasSource: true,
        onSaveAsWorkflow: saveAsWorkflow,
        onDelete: vi.fn(),
      });

      await screen.pressByTestIdAsync('workflow-run-overflow');
      expect(screen.findByTestId('workflow-run-save-as-workflow')).toBeTruthy();
      await layoutPopoverContent(screen);
      await screen.pressByTestIdAsync('workflow-run-save-as-workflow');
      // The canonical row-actions owner closes the menu and runs the action
      // off the current block — one macrotask on web — so the dispatch is
      // flushed with exactly that yield, as the owner's own test does.
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    });
    expect(saveAsWorkflow).toHaveBeenCalledTimes(1);
  });

  it('gives every actionable Run row a real press target and leaves header buttons at their own size', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      onSelectInvocation,
      invocationProgressById: openedLeafProgress('inv-1'),
      run: createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'running',
        availability: { cancel: true, pause: true },
      }),
      onCancel: vi.fn(),
      onPause: vi.fn(),
      onRunAgain: vi.fn(),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          parentRecordId: 'run-root',
          lifecycle: 'waiting_for_approval',
        }),
      ],
    });

    // `hitSlop` is inert on react-native-web's `Pressable`, and the desktop
    // app IS the web bundle, so a slop-declared row target is a target that
    // does not exist. A row's frame has to be real box model.
    for (const testID of ['workflow-run-invocations-row-inv-1']) {
      const node = screen.findByTestId(testID);
      expect(node, testID).toBeTruthy();
      // This web SDK fixture has a precise pointer. The shared target owner
      // requires 24 CSS px here; 44 is the finger floor (48 on Android).
      expect(flattenTestStyle(node?.props.style).minHeight, testID).toBe(24);
      expect(node?.props.hitSlop, testID).toBeUndefined();
      await screen.pressByTestIdAsync(testID);
      expect(onSelectInvocation).toHaveBeenCalledWith('inv-1');
    }
    // The header's buttons own their target in the shared button (the touch floor
    // where the pointer is a finger); the Run never stretches their visible box to
    // the touch target under a precise pointer (DESIGN-14 D1).
    for (const testID of [
      'workflow-run-cancel',
      'workflow-run-pause',
      'workflow-run-run-again',
      'workflow-run-needs-you-inv-1',
    ]) {
      const node = screen.findByTestId(testID);
      expect(node, testID).toBeTruthy();
      const style =
        typeof node?.props.style === 'function'
          ? node.props.style({ hovered: false, pressed: false, focused: false })
          : node?.props.style;
      expect(flattenTestStyle(style).minHeight ?? 0, testID).toBeLessThan(44);
    }
  });

  it('offers explicit same-conversation and fresh-Agent retry choices', async () => {
    const same = vi.fn();
    const fresh = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
        continueSameConversation: { kind: 'available' },
        continueFreshAgent: { kind: 'available' },
        restoreWorkspace: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      onRetrySameConversation: same,
      onRetryFreshAgent: fresh,
    });
    await screen.pressByTestIdAsync('workflow-run-retry-same');
    await screen.pressByTestIdAsync('workflow-run-retry-fresh');
    expect(same).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it.each(['action', 'root', 'if', 'loop'] as const)(
    'offers a plain Retry for a recoverable %s that presses through the retry handler',
    async (blockKind) => {
      const retry = vi.fn();
      const same = vi.fn();
      const fresh = vi.fn();
      const notPrepared = { kind: 'unavailable', reason: 'recovery_not_prepared' } as const;
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
        selectedInvocationId: 'inv-1',
        selectedInvocationRecoveryAvailability: {
          reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
          retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
          continueSameConversation: notPrepared,
          continueFreshAgent: notPrepared,
          restoreWorkspace: notPrepared,
        },
        invocations: [
          createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'failed' }),
        ],
        selectedInvocationProgress: {
          kind: 'happier.workflow-progress.v1',
          invocationPath: { blockId: blockKind === 'root' ? '$root' : 'projector', scope: [] },
          blockKind,
          attempt: '0',
          logicalInvocationRecordId: 'inv-1',
        },
        onRetry: retry,
        onRetrySameConversation: same,
        onRetryFreshAgent: fresh,
      });
      // An Action or frame is never offered as an Agent; Retry reads as itself and shares the card.
      expect(screen.findByTestId('workflow-run-retry-same')).toBeNull();
      expect(screen.findByTestId('workflow-run-retry-fresh')).toBeNull();
      expect(screen.findByTestId('workflow-run-retry-replacement')).toBeNull();
      expect(screen.getTextContent()).not.toContain('workflows.recovery.freshAgent');
      expect(screen.getTextContent()).toContain('workflows.recovery.retry');
      expect(screen.findByTestId('workflow-run-recovery-card')).not.toBeNull();
      await screen.pressByTestIdAsync('workflow-run-retry');
      expect(retry).toHaveBeenCalledTimes(1);
      expect(same).not.toHaveBeenCalled();
      expect(fresh).not.toHaveBeenCalled();
    },
  );

  it('offers an Agent step only its conversation choices, never a plain Retry', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
        continueSameConversation: { kind: 'available' },
        continueFreshAgent: { kind: 'available' },
        restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'failed' }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
      },
      onRetry: vi.fn(),
      onRetrySameConversation: vi.fn(),
      onRetryFreshAgent: vi.fn(),
    });
    expect(screen.findByTestId('workflow-run-retry')).toBeNull();
    expect(screen.findByTestId('workflow-run-retry-same')).not.toBeNull();
    expect(screen.findByTestId('workflow-run-retry-fresh')).not.toBeNull();
  });

  it('shows no Retry control for an Action whose owner answer is unavailable', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        continueSameConversation: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        continueFreshAgent: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'failed' }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'projector', scope: [] },
        blockKind: 'action',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
      },
      onRetry: vi.fn(),
    });
    expect(screen.findByTestId('workflow-run-retry')).toBeNull();
  });

  it('formats and exposes only the actual resolved workspace through canonical actions', async () => {
    const copyWorkspace = vi.fn();
    const openWorkspace = vi.fn();
    const screen = await renderContent({
      selectedInvocationId: 'inv-1',
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'running',
        }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        workspace: {
          descriptor: {
            machineId: 'machine-1',
            directory: '/Users/alice/project',
            checkoutRootPath: '/Users/alice/project',
            workspaceRefId: 'workspace-1',
            checkout: { kind: 'git_worktree', branchName: 'workflow/analyze' },
          },
        },
      },
      workspaceHomeDirectory: '/Users/alice',
      onCopyWorkspace: copyWorkspace,
      onOpenWorkspace: openWorkspace,
    });

    expect(screen.findByTestId('workflow-run-workspace-path')).toBeTruthy();
    expect(screen.getTextContent()).toContain('~/project');
    expect(screen.getTextContent()).toContain('workflow/analyze');
    await screen.pressByTestIdAsync('workflow-run-copy-workspace');
    await screen.pressByTestIdAsync('workflow-run-open-workspace');
    expect(copyWorkspace).toHaveBeenCalledWith('/Users/alice/project');
    expect(openWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      '/Users/alice/project',
    );
  });

  it('does not offer retry or execution navigation for an ineligible selected row', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'interrupted',
        availability: { inspectExecution: false },
      }),
      selectedInvocationId: 'inv-1',
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'completed',
        }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        execution: {
          kind: 'session',
          sessionId: 'session-1',
          localInputId: 'input-1',
        },
      },
      onRetrySameConversation: vi.fn(),
      onRetryFreshAgent: vi.fn(),
      onOpenSession: vi.fn(),
    });

    expect(screen.findByTestId('workflow-run-retry-same')).toBeNull();
    expect(screen.findByTestId('workflow-run-retry-fresh')).toBeNull();
    expect(screen.findByTestId('workflow-run-open-session')).toBeNull();
  });

  /**
   * UX §3.3: a completed Run's primary action is **Open result**, and a Run
   * whose outcomes include failures leads with **See failures** instead. Both
   * navigate to the exact producing/failing invocation through the canonical
   * structure projection — never to "the latest row".
   */
  it('leads a completed Run with Open result and opens the exact final-output producer', async () => {
    const onSelectInvocation = vi.fn();
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'step',
          id: 'analyze',
          document: {
            text: 'Analyze changes',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
        {
          kind: 'step',
          id: 'implement',
          document: {
            text: 'Implement the plan',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
      ],
      finalOutput: {
        kind: 'result',
        producer: { blockId: 'implement', scope: { kind: 'current' } },
        path: [],
      },
    });
    const invocations = [
      createWorkflowInvocationIndexFixture({
        id: 'inv-root',
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        lifecycle: 'completed',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'inv-analyze',
        sequence: '1',
        parentRecordId: 'inv-root',
        memberOrdinal: '0',
        lifecycle: 'completed',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'inv-implement',
        sequence: '2',
        parentRecordId: 'inv-root',
        memberOrdinal: '1',
        lifecycle: 'completed',
      }),
    ];
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      definition,
      invocations,
      // The canonical Action result names the exact producer row; this
      // consumer opens that row and never derives one.
      finalOutputInvocationId: 'inv-implement',
      resultLabel: 'All checks green',
      onSelectInvocation,
    });

    expect(screen.getTextContent()).toContain('All checks green');
    expect(screen.findAllByTestId('workflow-run-see-failures')).toHaveLength(0);
    await screen.pressByTestIdAsync('workflow-run-open-result');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-implement');
    await screen.unmount();

    // With the result open beside the Run, the Completed state still shows Run workflow again next to Open
    // result (07 §6.1, M15; lab run-A_completed); the `⋯` never repeats it.
    const opened = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      definition, invocations, finalOutputInvocationId: 'inv-implement', resultLabel: 'All checks green',
      onSelectInvocation, selectedInvocationId: 'inv-implement', onRunAgain: vi.fn(),
    });
    expect(opened.findAllByType(ToolbarButton).map((button) => button.props.testID))
      .toEqual(expect.arrayContaining(['workflow-run-run-again', 'workflow-run-open-result']));
    expect(opened.findAllByType(ItemRowActions).flatMap((menu) => menu.props.actions.map((action: { id: string }) => action.id)))
      .not.toContain('workflow-run-run-again');
  });

  it('keeps a structured final output in its result pane instead of printing it under the outcome', async () => {
    const onSelectInvocation = vi.fn();
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'step',
          id: 'analyze',
          document: {
            text: 'Analyze changes',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
        {
          kind: 'step',
          id: 'implement',
          document: {
            text: 'Implement the plan',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
      ],
      finalOutput: {
        kind: 'result',
        producer: { blockId: 'implement', scope: { kind: 'current' } },
        path: [],
      },
    });
    const invocations = [
      createWorkflowInvocationIndexFixture({
        id: 'inv-root',
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        lifecycle: 'completed',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'inv-analyze',
        sequence: '1',
        parentRecordId: 'inv-root',
        memberOrdinal: '0',
        lifecycle: 'completed',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'inv-implement',
        sequence: '2',
        parentRecordId: 'inv-root',
        memberOrdinal: '1',
        lifecycle: 'completed',
      }),
    ];
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      definition,
      invocations,
      // The canonical Action result names the exact producer row; this
      // consumer opens that row and never derives one.
      finalOutputInvocationId: 'inv-implement',
      resultLabel: JSON.stringify({ allPassed: false, nextParticipants: [{ kind: 'session' }] }, null, 2),
      onSelectInvocation,
    });

    expect(screen.getTextContent()).not.toContain('allPassed');
    expect(screen.findAllByTestId('workflow-run-result')).toHaveLength(0);
    expect(screen.findAllByTestId('workflow-run-see-failures')).toHaveLength(0);
    await screen.pressByTestIdAsync('workflow-run-open-result');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-implement');
  });

  it.each([{ items: ['alpha', 'beta', 'gamma'] }, null])('opens the canonical final value when its loop producer has only a container result: %j', async (value) => {
    const invocation = createWorkflowInvocationIndexFixture({ id: 'loop-result', lifecycle: 'completed' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1', blockKind: 'loop', attempt: '0',
      logicalInvocationRecordId: invocation.id, invocationPath: { blockId: 'loop-1', scope: [] },
      containerResult: { kind: 'container', containerRecordId: invocation.id },
    });
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'succeeded' }),
      definition: createWorkflowDefinitionFixture({ finalOutput: {
        kind: 'result', producer: { blockId: 'loop-1', scope: { kind: 'current' } }, path: [],
      } }),
      invocations: [invocation], finalOutputInvocationId: invocation.id,
      result: value, resultLabel: JSON.stringify(value),
      selectedInvocationId: invocation.id, selectedInvocationProgress: progress,
    });
    expect(screen.findByTestId('workflow-run-invocation-result')).not.toBeNull();
    expect(screen.getTextContent()).toContain(value === null ? 'null' : 'alpha');
    // The final value belongs only to its authenticated producer, never a neighboring step.
    await screen.update(<WorkflowRunContent {...screen.contentProps} finalOutputInvocationId="other" />);
    expect(screen.findByTestId('workflow-run-invocation-result')).toBeNull();
  });

  it('carries proven skipped step counts into the completed Run outcome', async () => {
    const definition = createWorkflowDefinitionFixture({ blocks: Array.from({ length: 4 }, (_, index) => ({
      kind: 'wait', id: `wait-${index}`, document: { text: `Review ${index + 1}`, references: [], attachments: [] },
    })) });
    const invocations = [
      createWorkflowInvocationIndexFixture({ id: 'root', lifecycle: 'completed' }),
      ...Array.from({ length: 4 }, (_, index) => createWorkflowInvocationIndexFixture({
        id: `wait-${index}`, parentRecordId: 'root', memberOrdinal: String(index), sequence: String(index + 1),
        lifecycle: index < 2 ? 'completed' : 'skipped',
      })),
    ];
    const screen = await renderContent({ definition, invocations,
      run: createWorkflowRunSummaryFixture({ state: 'succeeded', stepProgress: { completed: 2, skipped: 2, total: 4 } }) });
    const completedWithSkipped = 'workflows.run.completedWithSkipped:{"completed":2,"skipped":2}';
    // The sentence is a parameter of the outcome-line translation, so the boundary serializes it again.
    expect(screen.getTextContent()).toContain(JSON.stringify(completedWithSkipped).slice(1, -1));
    expect(screen.getTextContent()).not.toContain('workflows.list.stepsProgress');
  });

  it('opens the authoritative final producer even when that row is beyond the loaded history page', async () => {
    const onSelectInvocation = vi.fn();
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'step',
          id: 'analyze',
          document: {
            text: 'Analyze changes',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
        {
          kind: 'step',
          id: 'publish',
          document: {
            text: 'Publish the result',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
      ],
      finalOutput: {
        kind: 'result',
        producer: { blockId: 'publish', scope: { kind: 'current' } },
        path: [],
      },
    });
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      definition,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-analyze',
          sequence: '1',
          parentRecordId: 'inv-root',
          memberOrdinal: '0',
          lifecycle: 'completed',
        }),
      ],
      invocationHistoryComplete: false,
      finalOutputInvocationId: 'inv-publish-off-page',
      firstFailedInvocationId: null,
      firstFailedInvocationResolution: 'resolved',
      resultLabel: 'Published result',
      onSelectInvocation,
    });

    expect(screen.getTextContent()).toContain('Published result');
    expect(screen.findAllByTestId('workflow-run-result-absent')).toHaveLength(
      0,
    );
    await screen.pressByTestIdAsync('workflow-run-open-result');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-publish-off-page');
  });

  it('never reconstructs the final producer from invocation history', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'step',
          id: 'publish',
          document: {
            text: 'Publish the result',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
      ],
      finalOutput: {
        kind: 'result',
        producer: { blockId: 'publish', scope: { kind: 'current' } },
        path: [],
      },
    });
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      definition,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-root',
          sequence: '0',
          parentRecordId: null,
          memberOrdinal: '0',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'old-publish-attempt',
          sequence: '1',
          parentRecordId: 'inv-root',
          memberOrdinal: '0',
          lifecycle: 'completed',
        }),
      ],
      invocationHistoryComplete: false,
      resultLabel: 'Published result',
    });

    expect(screen.getTextContent()).toContain('Published result');
    expect(screen.findAllByTestId('workflow-run-open-result')).toHaveLength(0);
    expect(screen.findAllByTestId('workflow-run-result-absent')).toHaveLength(
      0,
    );

    // A complete page is not a licence to guess either: the row that
    // produced the selected result is a fact the Action owner reports, and
    // a matching block can have several attempts with different outcomes.
    const complete = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      definition,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-root',
          sequence: '0',
          parentRecordId: null,
          memberOrdinal: '0',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'old-publish-attempt',
          sequence: '1',
          parentRecordId: 'inv-root',
          memberOrdinal: '0',
          lifecycle: 'completed',
        }),
      ],
      invocationHistoryComplete: true,
      resultLabel: 'Published result',
    });

    expect(complete.getTextContent()).toContain('Published result');
    expect(complete.findAllByTestId('workflow-run-open-result')).toHaveLength(
      0,
    );
    expect(complete.findAllByTestId('workflow-run-result-absent')).toHaveLength(
      0,
    );
  });

  it('answers the absence of a selected final result with Inspect steps, not editor copy in the outcome', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'completed',
        }),
      ],
      resultLabel: null,
    });

    // The outcome sentence has one owner; the editor's setting copy never trails it (DESIGN-14 D2).
    expect(screen.getTextContent()).not.toContain('workflows.finalOutput.none');
    expect(
      screen.findAllByTestId('workflow-run-inspect-steps').length,
    ).toBeGreaterThan(0);
    expect(screen.findAllByTestId('workflow-run-open-result')).toHaveLength(0);
    // One final-output row, never two.
    expect(screen.findAllByTestId('workflow-run-result')).toHaveLength(0);
  });

  it('leads a Run whose outcomes include failures with See failures on the exact failed row', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          sequence: '1',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'inv-2',
          sequence: '2',
          memberOrdinal: '1',
          lifecycle: 'failed',
        }),
      ],
      resultLabel: 'partial',
      firstFailedInvocationId: 'inv-2',
      onSelectInvocation,
    });

    expect(screen.getTextContent()).toContain(
      'workflows.runState.completed_with_failures',
    );
    expect(screen.findAllByTestId('workflow-run-open-result')).toHaveLength(0);
    await screen.pressByTestIdAsync('workflow-run-see-failures');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-2');
  });

  it.each([
    { state: 'running' as const, availability: { cancel: true, pause: true }, then: 'workflow-run-pause' },
    { state: 'paused' as const, availability: { cancel: true, pause: false, resumeBoundary: true }, then: 'workflow-run-resume' },
  ])('leads a $state phone page\'s controls with Stop, so Pause and Resume never move it (REPLAY-1107-COORD)', async ({ state, availability, then }) => {
    viewport.window = { width: 390, height: 844 };
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state, availability }),
      onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn(), selectedInvocationId: null,
    });
    const controls = screen.findByTestId('workflow-run-page-controls')
      ?.findAll((node) => node.props.testID === 'workflow-run-cancel' || node.props.testID === then)
      .map((node) => node.props.testID as string) ?? [];
    expect([...new Set(controls)]).toEqual(['workflow-run-cancel', then]);
  });

  it('keeps a failed Run\'s own actions in the phone page and links its origin from the meta line', async () => {
    const failedRun = createWorkflowRunSummaryFixture({ id: 'run-1', state: 'failed',
      origin: { kind: 'direct', originSessionId: 'session-origin' } });
    const failed = createWorkflowInvocationIndexFixture({ id: 'inv-2', sequence: '1', lifecycle: 'failed' });
    const onOpenSession = vi.fn();
    const props = { run: failedRun, invocations: [failed], firstFailedInvocationId: 'inv-2',
      onRunAgain: vi.fn(), onAnotherRound: vi.fn(), sourceAction: { kind: 'open' as const, onPress: vi.fn() },
      onOpenSession } satisfies Partial<ContentProps>;

    // Wide: the state's actions sit in the header; nothing repeats them in the page.
    const wide = await renderContent(props);
    expect(wide.findByTestId('workflow-run-page-controls')).toBeNull();
    const seeFailures = (screen: typeof wide) => screen.findAllByType(ToolbarButton)
      .filter((button) => button.props.testID === 'workflow-run-see-failures');
    expect(seeFailures(wide)).toHaveLength(1);
    await wide.unmount();

    // Phone: the page keeps its one primary (Run again) under the outcome with See failures beside it; Another
    // round and Open workflow move into ⋯ rather than stacking more bordered buttons over two rows (lab P1).
    viewport.window = { width: 390, height: 844 };
    const phone = await renderContent(props);
    const pageControls = phone.findByTestId('workflow-run-page-controls');
    expect(pageControls?.findAll((node) => node.props.testID === 'workflow-run-see-failures').length).toBeGreaterThan(0);
    expect(seeFailures(phone)).toHaveLength(1);
    expect(phone.findAllByType(ToolbarButton).map((button) => button.props.testID))
      .toEqual(['workflow-run-run-again', 'workflow-run-see-failures']);
    const menuIds = phone.findAllByType(ItemRowActions).flatMap((menu) => menu.props.actions.map((action: { id: string }) => action.id));
    expect(menuIds).toEqual(expect.arrayContaining(['workflow-run-another-round', 'workflow-run-open-workflow']));
    expect(menuIds).not.toContain('workflow-run-run-again');

    // "From a session" is the way back; there is no second "Open the session it came from" line.
    expect(phone.getTextContent()).not.toContain('workflows.run.openSourceSession');
    const originLink = phone.findByTestId('workflow-run-origin')
      ?.findAll((node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function')[0];
    expect(originLink?.props.accessibilityLabel).toBe('workflows.run.openSourceSession');
    await act(async () => { originLink?.props.onPress(); });
    expect(onOpenSession).toHaveBeenCalledWith('session-origin');
  });

  it('opens the authoritative first failure even when that row is beyond the loaded history page', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          sequence: '1',
          lifecycle: 'completed',
        }),
      ],
      invocationHistoryComplete: false,
      firstFailedInvocationId: 'inv-failed-off-page',
      resultLabel: 'partial',
      onSelectInvocation,
    });

    await screen.pressByTestIdAsync('workflow-run-see-failures');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-failed-off-page');
  });

  it.each(['loading', 'error'] as const)(
    'keeps the bounded result visible without a false terminal action while failure discovery is %s',
    async (firstFailedInvocationResolution) => {
      const screen = await renderContent({
        run: createWorkflowRunSummaryFixture({
          id: 'run-1',
          state: 'succeeded',
        }),
        invocations: [
          createWorkflowInvocationIndexFixture({
            id: 'inv-1',
            sequence: '1',
            lifecycle: 'completed',
          }),
        ],
        invocationHistoryComplete: false,
        definition: createWorkflowDefinitionFixture({
          blocks: [
            {
              kind: 'step',
              id: 'publish',
              document: { text: 'Publish', references: [], attachments: [] },
              input: [],
              result: { kind: 'text' },
            },
          ],
          finalOutput: {
            kind: 'result',
            producer: { blockId: 'publish', scope: { kind: 'current' } },
            path: [],
          },
        }),
        resultLabel: 'Authoritative result preview',
        finalOutputInvocationId: 'inv-final-off-page',
        firstFailedInvocationResolution,
      });

      expect(screen.getTextContent()).toContain('Authoritative result preview');
      expect(screen.findAllByTestId('workflow-run-open-result')).toHaveLength(
        0,
      );
      expect(screen.findAllByTestId('workflow-run-see-failures')).toHaveLength(
        0,
      );
      expect(screen.findAllByTestId('workflow-run-result-absent')).toHaveLength(
        0,
      );
    },
  );

  it.each(['failed', 'interrupted'] as const)(
    'settles a %s Run outcome once: a reserved cause line and no undecided actions until the first failure resolves, no primary swap after',
    async (state) => {
      const invocation = createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'failed' });
      const progress = {
        kind: 'happier.workflow-progress.v1' as const,
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step' as const,
        attempt: '0',
        logicalInvocationRecordId: invocation.id,
        reason: { code: 'storage_unavailable', message: 'The Run store could not be written.' },
      };
      const base: ContentProps = {
        active: false,
        run: createWorkflowRunSummaryFixture({ id: 'run-1', state, availability: { cancel: false, pause: false } }),
        definition: createWorkflowDefinitionFixture(),
        invocations: [invocation],
        invocationsLoaded: true,
        invocationHistoryComplete: true,
        invocationProgressById: new Map([[invocation.id, progress]]),
        firstFailedInvocationId: null,
        firstFailedInvocationResolution: 'loading',
        selectedInvocationId: null,
        onSelectInvocation: vi.fn(),
        view: 'activity',
        onChangeView: vi.fn(),
        onRunAgain: vi.fn(),
      };
      const screen = await renderContent(base);
      const primaries = () => screen.findAllByType(ToolbarButton)
        .filter((button) => button.props.tone === 'primary').map((button) => button.props.testID);
      // Unsettled: the outcome sentence is stable, the cause has its place, and a terminal Run offers nothing
      // that could swap later (an interrupted Run's primary never depends on the failure).
      expect(screen.findByTestId('workflow-run-outcome')).not.toBeNull();
      expect(primaries()).toEqual(state === 'failed' ? [] : ['workflow-run-run-again']);
      if (state === 'failed') expect(screen.findAllByType(ToolbarButton)).toHaveLength(0);
      expect(screen.findByTestId('workflow-run-failure-reason-pending')).not.toBeNull();
      expect(screen.findByTestId('workflow-run-failure-reason')).toBeNull();
      expect(base.onRunAgain).not.toHaveBeenCalled();

      await screen.update(React.createElement(WorkflowRunContent, {
        ...base, firstFailedInvocationId: invocation.id, firstFailedInvocationResolution: 'resolved',
      }));
      // Settled: the cause fills the reserved place, and the primary is decided once.
      expect(screen.findByTestId('workflow-run-failure-reason-pending')).toBeNull();
      const cause = screen.findByTestId('workflow-run-failure-reason')?.props.children;
      expect(cause).toContain('workflows.readState.storageTitle');
      expect(cause).not.toContain('storage_unavailable');
      expect(cause).not.toContain(progress.reason.message);
      // A failed Run leads with Run again, next to its failure (See failures stays beside it).
      expect(primaries()).toEqual(['workflow-run-run-again']);
      await screen.pressByTestIdAsync('workflow-run-run-again');
      expect(base.onRunAgain).toHaveBeenCalledOnce();
    },
  );

  it('decides a failed Run whose first-failure lookup failed once, as Run workflow again', async () => {
    const onRunAgain = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'failed', availability: { cancel: false, pause: false } }),
      firstFailedInvocationResolution: 'error',
      onRunAgain,
    });
    expect(screen.findAllByType(ToolbarButton).filter((button) => button.props.tone === 'primary')
      .map((button) => button.props.testID)).toEqual(['workflow-run-run-again']);
    expect(screen.findByTestId('workflow-run-failure-reason-pending')).toBeNull();
  });

  it('offers See failures for a terminally failed Run and preserves its completed work', async () => {
    const onSelectInvocation = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'failed' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          sequence: '1',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'inv-2',
          sequence: '2',
          memberOrdinal: '1',
          lifecycle: 'failed',
        }),
      ],
      firstFailedInvocationId: 'inv-2',
      onSelectInvocation,
    });

    await screen.pressByTestIdAsync('workflow-run-see-failures');
    expect(onSelectInvocation).toHaveBeenCalledWith('inv-2');
  });

  it('does not offer a terminal result action while the Run is still running', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'running',
        }),
      ],
      resultLabel: 'partial output',
    });

    expect(screen.findAllByTestId('workflow-run-open-result')).toHaveLength(0);
    expect(screen.findAllByTestId('workflow-run-see-failures')).toHaveLength(0);
    expect(screen.findAllByTestId('workflow-run-result-absent')).toHaveLength(
      0,
    );
  });

  it('names each technical detail instead of reusing the section heading as a field label', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'running',
        }),
      ],
      selectedInvocationId: 'inv-1',
    });

    await openTechnicalDetails(screen);
    const text = screen.getTextContent();
    expect(text).toContain('workflows.run.technical.runId');
    expect(text).toContain('workflows.run.technical.invocationId');
    expect(text).toContain('workflows.run.technical.machine');
    expect(text).toContain('workflows.run.technical.revision');
    // The heading is not a field label, and Where is the editor's Machine control.
    expect(text).not.toContain('workflows.editor.whereTitle');
  });

  it('gives each Flow node its own lifecycle treatment rather than one uniform row', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'step',
          id: 'analyze',
          document: {
            text: 'Analyze changes',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
        {
          kind: 'step',
          id: 'implement',
          document: {
            text: 'Implement the plan',
            references: [],
            attachments: [],
          },
          input: [],
          result: { kind: 'text' },
        },
      ],
    });
    const screen = await renderContent({
      view: 'flow',
      definition,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-root',
          sequence: '0',
          parentRecordId: null,
          memberOrdinal: '0',
          lifecycle: 'running',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'inv-analyze',
          sequence: '1',
          parentRecordId: 'inv-root',
          memberOrdinal: '0',
          lifecycle: 'completed',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'inv-implement',
          sequence: '2',
          parentRecordId: 'inv-root',
          memberOrdinal: '1',
          lifecycle: 'waiting_for_approval',
        }),
      ],
    });

    // Finished work is quiet on the map: its marker carries the state as its spoken name.
    expect(
      screen.findByTestId('workflow-run-flow-node-analyze-state')?.props
        .accessibilityLabel,
    ).toBe('workflows.invocationState.completed');
    // A hold is said once, in Needs you: here its mark carries it as the spoken name.
    expect(
      screen.findByTestId('workflow-run-flow-node-implement-state')?.props
        .accessibilityLabel,
    ).toBeTruthy();
    expect(
      screen.findByTestId(
        'workflow-run-flow-node-implement-state:variant:attention',
      ),
    ).toBeNull();
    // Colour is never the only carrier of the state.
    expect(
      screen.findByTestId('workflow-run-flow-node-analyze-state-marker'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('workflow-run-flow-node-implement-state-marker'),
    ).toBeTruthy();
  });

  /**
   * UX §6.1 lists prepared continuation and inspected-replacement retry as two
   * different reviewed decisions. Sharing one text buffer and one disclosure
   * between them means opening either reveals the other's half-written text
   * and submits it.
   */
  it('keeps the prepared continuation and the replacement retry in separate buffers', async () => {
    const onContinuePrepared = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
        continueSameConversation: { kind: 'available' },
        continueFreshAgent: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
        restoreWorkspace: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      selectedInvocationProgress: {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        recovery: {
          conversation: 'same_conversation',
          input: {
            kind: 'replacement',
            value: {
              document: {
                text: 'Finish the original objective',
                references: [],
                attachments: [],
              },
              input: ['recorded context'],
            },
          },
        },
      },
      onContinuePrepared,
      onRetryWithReplacement: vi.fn(),
    });

    // The prepared continuation opens closed (the owner already prepared it).
    expect(screen.findByTestId('workflow-run-continuation-input')).toBeNull();
    expect(screen.findByTestId('workflow-run-replacement-input')).toBeNull();

    // Ordinary Resume accepts the complete producer-prepared objective and
    // context immediately; opening the editor is optional.
    await screen.pressByTestIdAsync('workflow-run-continue-prepared');
    expect(onContinuePrepared).toHaveBeenCalledWith({
      conversation: 'same_conversation',
      document: {
        text: 'Finish the original objective',
        references: [],
        attachments: [],
      },
      input: ['recorded context'],
    });

    await screen.pressByTestIdAsync('workflow-run-edit-continuation');
    expect(
      screen.findByTestId('workflow-run-continuation-input'),
    ).not.toBeNull();
    // Opening the continuation must not open the replacement field too.
    expect(screen.findByTestId('workflow-run-replacement-input')).toBeNull();

    await screen.pressByTestIdAsync('workflow-run-use-replacement-input');
    const replacement = screen.findByTestId('workflow-run-replacement-input');
    expect(replacement).not.toBeNull();
    // Two decisions, two buffers: the replacement starts empty rather than
    // inheriting the prepared objective.
    expect(replacement?.props.value).toBe('');
    expect(
      screen.findByTestId('workflow-run-continuation-input')?.props.value,
    ).toBe('Finish the original objective');
  });

  it('lets a replacement retry choose the fresh-agent conversation when the owner allows it', async () => {
    const onRetryWithReplacement = vi.fn();
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({ state: 'interrupted' }),
      selectedInvocationId: 'inv-1',
      selectedInvocationRecoveryAvailability: {
        reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
        retry: { kind: 'available', causalInvocationIds: ['inv-1'] },
        continueSameConversation: { kind: 'available' },
        continueFreshAgent: { kind: 'available' },
        restoreWorkspace: {
          kind: 'unavailable',
          reason: 'recovery_not_prepared',
        },
      },
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          lifecycle: 'failed',
        }),
      ],
      onRetryWithReplacement,
    });

    await screen.pressByTestIdAsync('workflow-run-use-replacement-input');
    expect(screen.findByTestId('workflow-run-replacement-input')).toBeTruthy();
    await act(async () => {
      screen.changeTextByTestId('workflow-run-replacement-input', 'Try the safer path');
    });
    expect(
      screen.findByTestId('workflow-run-replacement-input')?.props.value,
    ).toBe('Try the safer path');
    // Same conversation is the default, and fresh agent is genuinely
    // reachable rather than being decided by which capability came first.
    expect(
      screen.tree.findHostByTestId(
        'workflow-run-replacement-conversation-same_conversation',
      )?.props.accessibilityState?.checked,
    ).toBe(true);
    await screen.pressByTestIdAsync(
      'workflow-run-replacement-conversation-fresh_agent',
    );
    await screen.pressByTestIdAsync('workflow-run-submit-replacement');

    expect(onRetryWithReplacement).toHaveBeenCalledWith({
      conversation: 'fresh_agent',
      document: { text: 'Try the safer path', references: [], attachments: [] },
      input: [],
    });
  });

  /**
   * The index counts attempts from zero; people count from one. One formatter
   * owns that translation, so the Activity row, the Flow occurrence list, the
   * selected detail and their accessible names cannot disagree about which
   * attempt a person is looking at.
   */
  it('names the second physical attempt "Attempt 2" on every surface', async () => {
    const invocations = [
      createWorkflowInvocationIndexFixture({
        id: 'analyze-first',
        sequence: '1',
        lifecycle: 'superseded',
      }),
      createWorkflowInvocationIndexFixture({
        id: 'analyze-retry',
        sequence: '2',
        attempt: '1',
        lifecycle: 'running',
      }),
    ];
    const progress = (id: string, attempt: string) => ({
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: 'analyze', scope: [] },
      blockKind: 'step' as const,
      attempt,
      logicalInvocationRecordId: 'analyze-first',
      ...(attempt === '0' ? {} : { previousAttemptRecordId: 'analyze-first' }),
    });
    const invocationProgressById = new Map([
      ['analyze-first', progress('analyze-first', '0')],
      ['analyze-retry', progress('analyze-retry', '1')],
    ]);
    const attemptTwo = 'workflows.run.attempt:{"attempt":"2"}';
    // Inside another translated label the mock serializes it once more.
    const attemptTwoNested = JSON.stringify(attemptTwo).slice(1, -1);
    const attemptOneNested = JSON.stringify(
      'workflows.run.attempt:{"attempt":"1"}',
    ).slice(1, -1);

    const activity = await renderContent({
      invocations,
      invocationProgressById,
      selectedInvocationId: 'analyze-retry',
      selectedInvocationProgress: invocationProgressById.get('analyze-retry'),
    });
    const retryRow = activity.findByTestId(
      'workflow-run-invocations-row-analyze-retry',
    );
    expect(
      activity.findByTestId('workflow-run-invocations-attempt-analyze-retry')
        ?.props.children,
    ).toBe(attemptTwo);
    expect(retryRow?.props.accessibilityLabel).toContain(attemptTwoNested);
    // The first attempt is not a retry and is not decorated as one.
    expect(
      activity.findByTestId('workflow-run-invocations-attempt-analyze-first'),
    ).toBeNull();
    expect(
      activity.findByTestId('workflow-run-invocation-attempt')?.props.children,
    ).toBe(attemptTwo);
    await activity.unmount();

    const flow = await renderContent({
      view: 'flow',
      invocations,
      invocationProgressById,
      selectedInvocationId: 'analyze-retry',
      selectedInvocationProgress: invocationProgressById.get('analyze-retry'),
    });
    const occurrence = flow.findByTestId(
      'workflow-run-flow-node-analyze-occurrence-analyze-retry',
    );
    expect(occurrence?.props.accessibilityLabel).toContain(attemptTwoNested);
    expect(occurrence?.props.accessibilityLabel).not.toContain(
      attemptOneNested,
    );
    expect(
      flow.findByTestId(
        'workflow-run-flow-node-analyze-occurrence-analyze-first',
      )?.props.accessibilityLabel,
    ).toContain(attemptOneNested);
  });

  it('carries the Activity row lifecycle with a marker, not colour alone', async () => {
    const screen = await renderContent({
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          parentRecordId: 'run-root',
          lifecycle: 'outcome_uncertain',
        }),
      ],
    });

    expect(screen.findByTestId('workflow-run-invocations-word-inv-1')).toBeTruthy();
    expect(
      screen.findByTestId('workflow-run-invocations-state-inv-1-marker'),
    ).toBeTruthy();
  });

  it('keeps finished Activity rows quiet: the state is the glyph, and only unfinished work gets a word (owner 09.17.14)', async () => {
    const screen = await renderContent({
      invocations: [
        createWorkflowInvocationIndexFixture({ id: 'done', parentRecordId: 'run-root', lifecycle: 'completed' }),
        createWorkflowInvocationIndexFixture({ id: 'held', parentRecordId: 'run-root', lifecycle: 'waiting_for_review', sequence: '2' }),
      ],
    });
    expect(screen.findByTestId('workflow-run-invocations-state-done-marker')).toBeTruthy();
    expect(screen.findByTestId('workflow-run-invocations-word-done')).toBeNull();
    expect(screen.findByTestId('workflow-run-invocations-state-held-marker')).toBeTruthy();
    // Needs you says a hold in words; its row keeps the glyph, with the word as its spoken name.
    expect(screen.findByTestId('workflow-run-invocations-word-held')).toBeNull();
  });

  it('distinguishes repeated Activity steps by their exact occurrence and recorded time', async () => {
    const items = ['first', 'second'];
    const definition = createWorkflowDefinitionFixture({ blocks: [{
      kind: 'loop', id: 'files', repetition: {
        kind: 'items', items: { kind: 'literal', value: items },
        execution: 'parallel', failurePolicy: 'collect_outcomes',
      }, body: [{ kind: 'action', id: 'inspect', name: 'Inspect files',
        actionId: 'notifications.notify_me', input: {} }],
    }] });
    // The canonical opened progress places these leaves even when their parent page is absent.
    const invocations = ['2026-10-24T10:00:00.000Z', '2026-10-24T11:30:00.000Z'].map((createdAt, index) =>
      createWorkflowInvocationIndexFixture({ id: `inspect-${index}`, parentRecordId: `frame-${index}`,
        createdAt, updatedAt: '2026-10-25T12:00:00.000Z', sequence: String(index), lifecycle: 'completed' }));
    const invocationProgressById = new Map(invocations.map((row, index) => [row.id,
      WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'action',
        attempt: '0', logicalInvocationRecordId: row.id,
        invocationPath: { blockId: 'inspect', scope: [{ kind: 'iteration', blockId: 'files', index }] } }),
    ]));
    const screen = await renderContent({ definition, invocations, invocationProgressById });
    for (const [index, row] of invocations.entries()) {
      const time = formatAsOfTime(Date.parse(row.createdAt));
      // The day is said once, above the day's first row; each row says its time of day.
      expect(screen.findByTestId(`workflow-run-invocations-time-${row.id}`)?.props.children)
        .toBe(formatAsOfTime(Date.parse(row.createdAt), Date.parse(row.createdAt)));
      const occurrence = screen.findByTestId(`workflow-run-invocations-occurrence-${row.id}`);
      const occurrenceLabel = items[index];
      expect(occurrence?.props.children).toBe(occurrenceLabel);
      const accessibleName = screen.findByTestId(`workflow-run-invocations-row-${row.id}`)?.props.accessibilityLabel;
      expect(accessibleName).toContain(JSON.stringify(occurrenceLabel).slice(1, -1));
      expect(accessibleName).toContain(time);
    }
  });

  /**
   * A continuation that failed keeps the rows already read and replaces only
   * the paging action with its reason and a Retry that asks for the same page
   * again, exactly as the Workflows collection presents a failed page.
   */
  it('replaces the Activity paging action with an accessible retry that keeps the loaded rows', async () => {
    const onLoadMoreInvocations = vi.fn();
    const screen = await renderContent({
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-1',
          parentRecordId: 'run-root',
        }),
      ],
      invocationHistoryComplete: false,
      onLoadMoreInvocations,
      loadMoreInvocationsFailed: true,
    });

    expect(
      screen.findByTestId('workflow-run-invocations-load-more'),
    ).toBeNull();
    // The failure is announced: the shared notice sits inside an alert live region.
    expect(
      screen.findAll((node) => typeof node.type === 'string'
        && node.props.accessibilityRole === 'alert'
        && node.findAll((child) => child.props.testID === 'workflow-run-invocations-load-more-error').length > 0),
    ).not.toHaveLength(0);
    expect(
      screen.findByTestId('workflow-run-invocations-row-inv-1'),
    ).toBeTruthy();

    await screen.pressByTestIdAsync('workflow-run-invocations-load-more-retry');
    expect(onLoadMoreInvocations).toHaveBeenCalledTimes(1);
  });

  it('replaces the Needs you paging action with an accessible retry that keeps the attention rows', async () => {
    const onLoadMoreAttention = vi.fn();
    const screen = await renderContent({
      invocationProgressById: openedLeafProgress('inv-attention'),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-attention',
          lifecycle: 'waiting_for_approval',
        }),
      ],
      onLoadMoreAttention,
      loadMoreAttentionFailed: true,
    });

    expect(screen.findByTestId('workflow-run-needs-you-load-more')).toBeNull();
    // The failure is announced: the shared notice sits inside an alert live region.
    expect(
      screen.findAll((node) => typeof node.type === 'string'
        && node.props.accessibilityRole === 'alert'
        && node.findAll((child) => child.props.testID === 'workflow-run-needs-you-load-more-error').length > 0),
    ).not.toHaveLength(0);
    expect(
      screen.findByTestId('workflow-run-needs-you-inv-attention'),
    ).toBeTruthy();

    await screen.pressByTestIdAsync('workflow-run-needs-you-load-more-retry');
    expect(onLoadMoreAttention).toHaveBeenCalledTimes(1);
  });

  it('withdraws the Needs you paging action while its page is in flight', async () => {
    const onLoadMoreAttention = vi.fn();
    const screen = await renderContent({
      invocationProgressById: openedLeafProgress('inv-attention'),
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'inv-attention',
          lifecycle: 'waiting_for_approval',
        }),
      ],
      onLoadMoreAttention,
      loadingMoreAttention: true,
    });

    const action = screen.findByTestId('workflow-run-needs-you-load-more');
    expect(action?.props.accessibilityState?.disabled).toBe(true);
    expect(action?.props.disabled).toBe(true);
  });
});

describe('WorkflowRunContent lab fidelity (run-A)', () => {
  const terminal = { cancel: false, pause: false } as const;

  it('states a finished Run as its start–finish range, from the server finish fact', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'succeeded',
        availability: terminal,
        createdAt: '2026-09-08T10:00:00.000Z',
        finishedAt: '2026-09-08T10:31:00.000Z',
      }),
    });
    const meta = screen.findByTestId('workflow-run-header-meta');
    const text = JSON.stringify(
      meta
        ?.findAll((node) => typeof node.props.children === 'string')
        .map((node) => node.props.children),
    );
    expect(text).toContain('workflows.run.timeRange');
    expect(text).not.toContain('workflows.run.startedAt');
  });

  it('keeps the start alone while the Run has no finish fact', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'running',
        finishedAt: null,
      }),
    });
    const meta = screen.findByTestId('workflow-run-header-meta');
    const text = JSON.stringify(
      meta
        ?.findAll((node) => typeof node.props.children === 'string')
        .map((node) => node.props.children),
    );
    expect(text).toContain('workflows.run.startedAt');
    expect(text).not.toContain('workflows.run.timeRange');
  });

  it('leads the outcome sentence with the Run state mark', async () => {
    const screen = await renderContent({
      run: createWorkflowRunSummaryFixture({
        state: 'succeeded',
        availability: terminal,
      }),
    });
    expect(screen.findByTestId('workflow-run-outcome-mark')).toBeTruthy();
  });

  it('lists steps in Activity without the Run root row or raw member ordinals', async () => {
    const definition = createWorkflowDefinitionFixture({
      blocks: [
        {
          kind: 'wait',
          id: 'first',
          document: { text: 'First', references: [], attachments: [] },
        },
        {
          kind: 'wait',
          id: 'second',
          document: { text: 'Second', references: [], attachments: [] },
        },
      ],
    });
    const screen = await renderContent({
      view: 'activity',
      definition,
      invocations: [
        createWorkflowInvocationIndexFixture({
          id: 'root',
          parentRecordId: null,
          memberOrdinal: '0',
          sequence: '0',
        }),
        createWorkflowInvocationIndexFixture({
          id: 'second-row',
          parentRecordId: 'root',
          memberOrdinal: '1',
          sequence: '1',
          lifecycle: 'completed',
        }),
      ],
    });
    expect(screen.findByTestId('workflow-run-invocations-row-root')).toBeNull();
    const row = screen.findByTestId('workflow-run-invocations-row-second-row');
    expect(row).toBeTruthy();
    expect(row?.findAll((node) => node.props.children === '1')).toHaveLength(0);
  });

  it('reads a single Steps occurrence as its open-work link, never a bare attempt', async () => {
    const onSelectInvocation = vi.fn();
    const invocation = createWorkflowInvocationIndexFixture({
      id: 'finished',
      lifecycle: 'completed',
    });
    const screen = await renderContent({
      view: 'steps',
      invocations: [invocation],
      onSelectInvocation,
      invocationStructure: new Map([
        [
          invocation.id,
          {
            invocationId: invocation.id,
            blockId: 'analyze',
            nodeId: 'analyze',
            occurrence: [],
            isFrame: false,
            coverageKind: 'executable' as const,
          },
        ],
      ]),
    });
    expect(screen.getTextContent()).not.toContain('workflows.run.attempt');
    const link = screen.findByTestId('workflow-run-steps-occurrence-finished');
    expect(
      link?.findAll(
        (node) => node.props.children === 'workflows.run.openConversation',
      ).length,
    ).toBeGreaterThan(0);
    await screen.pressByTestIdAsync('workflow-run-steps-occurrence-finished');
    expect(onSelectInvocation).toHaveBeenCalledWith('finished');
  });

  it('withdraws Inspect steps once Steps is the open view', async () => {
    const screen = await renderContent({
      view: 'steps',
      run: createWorkflowRunSummaryFixture({
        state: 'succeeded',
        availability: terminal,
      }),
    });
    expect(screen.findByTestId('workflow-run-inspect-steps')).toBeNull();
  });
});
