import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

/**
 * Mount scope of a long workflow (PERF-WF3).
 *
 * An authoring host that gives its document an editing demand mounts a block's editor (its
 * composer, or its composer's picture, and its name field) only for the block being worked on;
 * every other prompt block is its one-line summary row. Measured at the size a real author reached
 * (500 blocks, 4 on screen) as counts of mounted editors and editable fields, then through the
 * real activation path: a summary row becomes the editor and focus is asked for its prompt, at the
 * root and inside side-by-side, repeat and If lists.
 */

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-crypto', async () => ({
  randomUUID: (await import('node:crypto')).randomUUID,
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
// Keep the real visibility lifecycle; only IntersectionObserver is controlled below.
vi.mock('@/components/ui/performance/LazyMountOnScreen', async () => {
  return import('@/components/ui/performance/LazyMountOnScreen.web');
});
const headingRenders = vi.hoisted(() => ({ byTestId: new Map<string, number>(), headingType: null as unknown }));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  const boundary = await createUnistylesMock();
  const ReactRuntime = await import('react');
  // Observe the real heading at its styling hook through the owner React exposes for element ownership.
  const internals = Reflect.get(ReactRuntime, '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE') as {
    A: null | { getOwner(): null | { type: unknown; pendingProps: { testID?: string } } };
  };
  return { ...boundary, useUnistyles: () => {
    const owner = internals.A?.getOwner();
    if (owner != null && owner.type === headingRenders.headingType && owner.pendingProps.testID) {
      const id = owner.pendingProps.testID;
      headingRenders.byTestId.set(id, (headingRenders.byTestId.get(id) ?? 0) + 1);
    }
    return boundary.useUnistyles();
  } };
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
// Radix is the DOM boundary; the app's popover and modal owners stay real.
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsModuleMock } =
    await import('@/dev/testkit/mocks/radixCjs');
  return createRadixCjsModuleMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { WorkflowBlockListEditor } = await import('./WorkflowBlockListEditor');
const { LazyMountOnScreen } = await import('@/components/ui/performance/LazyMountOnScreen');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { ScopedAuthoringComposer } =
  await import('@/components/sessions/authoring/ScopedAuthoringComposer');
const { InlineTextField } =
  await import('@/components/ui/text/InlineTextField');
const { WorkflowBlockHeading } = await import('./WorkflowBlockHeading');
const { WorkflowRunWhenCaption } = await import('./WorkflowRunWhenConnector');
headingRenders.headingType = WorkflowBlockHeading;
const { IconButton } = await import('@/components/ui/buttons/IconButton');
const { createWorkflowEditorDraft } =
  await import('@/sync/domains/workflows/workflowEditorDraft');
const { validateWorkflowEditorDraft } =
  await import('@/sync/domains/workflows/workflowAuthoring');
const { createWorkflowAuthoringComposerCustody } =
  await import('@/components/sessions/authoring/authoringComposerCustody');
let serverId: string;
let restoreAppliedHome: (() => void) | undefined;
let restoreLocalStorage: (() => void) | undefined;

beforeAll(async () => {
  restoreLocalStorage = installLocalStorageMock().restore;
  const applied =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
  const previous = applied.getAppliedActiveServerSnapshot();
  const wasAvailable = applied.isAppliedActiveServerRuntimeAvailable();
  restoreAppliedHome = () =>
    applied.publishAppliedActiveServerSnapshot(previous, wasAvailable);
  serverId = await home.addHome({
    name: 'Mount scope Home',
    serverUrl: 'https://blocklist-mount.test',
    accountId: 'account-a',
  });
  const { storage } = await import('@/sync/domains/state/storage');
  storage.setState({
    profileScope: { serverId, accountId: 'account-a' },
    settingsScope: { serverId, accountId: 'account-a' },
  });
  const { getActiveServerSnapshot } =
    await import('@/sync/domains/server/serverRuntime');
  applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterAll(async () => {
  restoreAppliedHome?.();
  await home.reset();
  restoreLocalStorage?.();
});
afterEach(async () => {
  await standardCleanup();
});

const AGENT_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};
const doc = (text: string) => ({ text, references: [], attachments: [] });
const step = (id: string) => ({
  kind: 'step' as const,
  id,
  input: [],
  document: doc(`Check the ${id} package and report what changed.`),
  result: { kind: 'text' as const },
});
const wait = (id: string) => ({
  kind: 'wait' as const,
  id,
  document: doc(`Confirm ${id} before the release goes ahead.`),
  result: { kind: 'text' as const },
});

function buildDraft() {
  const blocks: unknown[] = Array.from({ length: 497 }, (_unused, index) =>
    index % 4 === 3 ? wait(`b${index}`) : step(`b${index}`),
  );
  blocks.splice(10, 0, {
    kind: 'parallel',
    id: 'side',
    failurePolicy: 'fail_stop',
    branches: [
      { id: 'lane-a', blocks: [step('lane-a-1')] },
      { id: 'lane-b', blocks: [wait('lane-b-1')] },
    ],
  });
  blocks.splice(200, 0, {
    kind: 'loop',
    id: 'again',
    repetition: { kind: 'count', count: { kind: 'literal', value: 3 } },
    body: [step('loop-1')],
  });
  blocks.splice(400, 0, {
    kind: 'if',
    id: 'gate',
    when: { kind: 'exists', value: { kind: 'literal', value: true } },
    then: [step('then-1')],
    otherwise: [],
  });
  return createWorkflowEditorDraft({
    draftId: 'draft-mount',
    name: 'Release audit',
    defaults: { agentTarget: AGENT_TARGET },
    blocks: blocks as never,
  });
}

// The side-by-side block and its two lanes, the repeat and the If keep their own name fields.
const CONTAINER_NAME_FIELDS = 5;
// An unreached summary row and the gap before it: the gap, the row's heading (ordinal, name, resting
// ⋯ mark) and its prompt line. Before PERF-WF3B Option A this renderer counted 24 (30 live DOM nodes,
// 19 after); the bound sits above the row's words and below a mounted menu or inserter.
const INACTIVE_ROW_HOST_NODES = 16;

async function renderLongDocument(initialBlockId: string | null = null) {
    const initialDraft = buildDraft();
    const composerCustody =
      createWorkflowAuthoringComposerCustody('draft-mount');
    const focusRequests: string[] = [];
    const control: { selected: string | null; edit: (blockId: string | null) => void; select: (blockId: string | null) => void } = {
      selected: null, edit: () => {}, select: () => {},
    };

    function Harness() {
      const [draft, setDraft] = React.useState(initialDraft);
      const [selected, setSelected] = React.useState<string | null>(initialBlockId);
      const [editing, setEditing] = React.useState<string | null>(initialBlockId);
      control.selected = selected;
      control.edit = setEditing;
      control.select = setSelected;
      const validation = React.useMemo(
        () => validateWorkflowEditorDraft(draft),
        [draft],
      );
      const requestPromptFocus = React.useCallback((blockId: string) => {
        focusRequests.push(blockId);
      }, []);
      return React.createElement(WorkflowBlockListEditor, {
        draft,
        list: { kind: 'root' },
        blocks: draft.blocks,
        depth: 0,
        selectedBlockId: selected,
        composerScope: {
          kind: 'machine',
          machineId: 'machine-1',
          serverId,
          directory: '/repo/project',
          machineHomeDir: '/Users/me',
        },
        composerCustody,
        validation,
        onChange: setDraft,
        onSelect: setSelected,
        onCustomize: () => {},
        requestPromptFocus,
        editingBlockId: editing,
        onRequestEditBlock: setEditing,
        testIDPrefix: 'workflow-editor',
      });
    }

    const screen = await renderScreen(React.createElement(Harness), {
      createNodeMock: element => element.type === 'div' ? {} : null,
    });
    return { initialDraft, composerCustody, focusRequests, control, screen };
}

/** Host elements (the DOM nodes a browser would mount) in one rendered subtree. */
function countHostNodes(node: { type: unknown; children: readonly unknown[] }): number {
  let count = typeof node.type === 'string' ? 1 : 0;
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null && 'children' in child) {
      count += countHostNodes(child as { type: unknown; children: readonly unknown[] });
    }
  }
  return count;
}

describe('workflow document mount scope', () => {
  it('mounts one block editor at a time across 500 blocks, and activation opens the pressed block', async () => {
    const { initialDraft, composerCustody, focusRequests, control, screen } = await renderLongDocument();
    expect(initialDraft.blocks).toHaveLength(500);
    const editors = () => screen.findAllByType(ScopedAuthoringComposer);
    const editables = () => screen.findAllByType(InlineTextField);
    const heading = (testID: string) =>
      screen
        .findAllByType(WorkflowBlockHeading)
        .find((node) => node.props.testID === testID);

    // Every block is still a reachable, labelled member of the document...
    expect(heading('workflow-editor-step-b0-label')).toBeDefined();
    expect(heading('workflow-editor-step-b248-label')).toBeDefined();
    expect(heading('workflow-editor-wait-b495-label')).toBeDefined();
    expect(
      heading('workflow-editor-step-b248-label')!.props.accessibilityLabel,
    ).toContain('workflows.a11y.stepContext');
    // ...but none mounts an editor until it is worked on; only container names stay editable.
    expect(editors()).toHaveLength(0);
    expect(editables().length).toBeLessThanOrEqual(CONTAINER_NAME_FIELDS);

    for (const [label, blockId] of [
      ['workflow-editor-step-b248-label', 'b248'],
      ['workflow-editor-wait-b495-label', 'b495'],
      ['workflow-editor-step-lane-a-1-label', 'lane-a-1'],
      ['workflow-editor-step-loop-1-label', 'loop-1'],
      ['workflow-editor-step-then-1-label', 'then-1'],
    ] as const) {
      await act(async () => {
        heading(label)!.props.onSelect();
      });
      expect(control.selected).toBe(blockId);
      expect(focusRequests.at(-1)).toBe(blockId);
      const mounted = editors();
      expect(mounted).toHaveLength(1);
      expect(mounted[0]!.props.custody).toBe(composerCustody.entryFor(blockId));
      expect(editables().length).toBeLessThanOrEqual(CONTAINER_NAME_FIELDS + 1);
    }

    // The summary's own prompt line is where a person reaches to keep writing: pressing it opens
    // that block exactly as its name does, still one editor at a time.
    await act(async () => {
      screen.findByTestId('workflow-editor-step-b0-summary-prompt')!.props.onPress();
    });
    expect(control.selected).toBe('b0');
    expect(focusRequests.at(-1)).toBe('b0');
    expect(editors()).toHaveLength(1);
    expect(editors()[0]!.props.custody).toBe(composerCustody.entryFor('b0'));
  }, 120_000);
  // A summary row a person has not reached is only its words (PERF-WF3B, Option A): its ⋯ menu,
  // the inserter in the gap before it and its drop-zone layout measurement mount when a pointer or
  // the keyboard reaches the row, so 500 rows cost their text, not 500 menus and observers.
  it('keeps an unreached summary row to its words and mounts its menu and gaps when it is reached', async () => {
    const { screen } = await renderLongDocument();
    const host = (testID: string) => screen.findHostByTestId(testID);
    const rowCost = (blockId: string) =>
      countHostNodes(host(`workflow-editor-gap-${blockId}`)! as never)
      + countHostNodes(host(`workflow-editor-step-${blockId}-session-drop`)! as never);

    const menuButton = (blockId: string) =>
      screen.findAllByType(IconButton).find((node) => node.props.testID === `workflow-editor-step-${blockId}-actions`);

    expect.soft(rowCost('b248')).toBeLessThanOrEqual(INACTIVE_ROW_HOST_NODES);
    expect.soft(menuButton('b248')).toBeUndefined();
    expect.soft(host('workflow-editor-insert-after-b247')).toBeNull();
    expect(host('workflow-editor-step-b248-session-drop')!.props.onLayout).toBeUndefined();

    // Reached by the keyboard (focus inside the row) or a pointer: its ⋯ and both neighbouring
    // gaps mount, so Tab walks name → ⋯ → the next gap's Add.
    await act(async () => {
      host('workflow-editor-b248-block')!.props.onFocus();
    });
    expect(menuButton('b248')).toBeDefined();
    expect(host('workflow-editor-insert-after-b247')).not.toBeNull();
    expect(host('workflow-editor-insert-after-b248')).not.toBeNull();
    expect(menuButton('b249')).toBeUndefined();

    // Reaching another row hands the menu over; the first row returns to its words.
    await act(async () => {
      host('workflow-editor-gap-b301')!.props.onMouseEnter();
    });
    expect(menuButton('b301')).toBeDefined();
    expect(host('workflow-editor-insert-after-b300')).not.toBeNull();
    expect(menuButton('b248')).toBeUndefined();
    expect(rowCost('b248')).toBeLessThanOrEqual(INACTIVE_ROW_HOST_NODES);
  }, 120_000);

  // Typing in the one open block changes the whole draft object; the 499 summary rows around it
  // show unchanged words, so none of them may execute again.
  it('does not execute an unrelated summary row when the open block\'s prompt changes', async () => {
    const { screen, control } = await renderLongDocument();
    await act(async () => {
      screen.findAllByType(WorkflowBlockHeading)
        .find((node) => node.props.testID === 'workflow-editor-step-b248-label')!.props.onSelect();
    });
    expect(control.selected).toBe('b248');
    await act(async () => { control.edit('b248'); });
    const before = new Map(headingRenders.byTestId);
    expect(before.size).toBeGreaterThan(400);
    await act(async () => {
      screen.findAllByType(AgentInput)[0]!.props.onChangeText('Check the b248 package again.');
    });
    // A container's nested lists read the draft, so its own heading follows every edit; leaf rows must not.
    const reran = [...before].filter(([id, count]) => id !== 'workflow-editor-step-b248-label'
      && !/^workflow-editor-(parallel|loop|if)-/.test(id)
      && headingRenders.byTestId.get(id) !== count).map(([id]) => id);
    expect(reran).toEqual([]);
  }, 120_000);

  it('mounts complete rows only where the viewport reaches and retains editing continuity as it scrolls', async () => {
    const intersections: Array<(visible: boolean) => void> = [];
    vi.stubGlobal('window', { getComputedStyle: () => ({ overflowY: 'visible' }), addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('IntersectionObserver', class {
      private readonly report: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void;
      private readonly index: number;
      constructor(report: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) {
        this.report = report;
        this.index = intersections.length;
        intersections.push(visible => report([{ isIntersecting: visible }]));
      }
      observe() { if (this.index < 12) this.report([{ isIntersecting: true }]); }
      disconnect() {}
    });
    try {
      const { screen, control, composerCustody, focusRequests } = await renderLongDocument('b248');
      const rows = () => screen.root.findAll(node => typeof node.type === 'string' && node.props.role === 'listitem');
      const spines = () => screen.root.findAll(node => typeof node.type === 'string' && /-spine$/.test(node.props.testID ?? ''));
      const captions = () => screen.findAllByType(WorkflowRunWhenCaption);
      const regions = screen.findAllByType(LazyMountOnScreen);
      const reachedRegions = regions.filter(region => region.findAll(node => typeof node.type === 'string' && node.props.role === 'listitem').length > 0);
      console.info('workflow initial mount census', {
        rootBlocks: 500, rows: rows().length, spines: spines().length, captions: captions().length,
        visibilityRegions: regions.length, placeholders: regions.length - reachedRegions.length, observers: intersections.length,
      });
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().length).toBeLessThanOrEqual(12 + CONTAINER_NAME_FIELDS);
      expect(spines().length).toBeLessThanOrEqual(12 + CONTAINER_NAME_FIELDS);
      expect(captions().length).toBeLessThanOrEqual(12 + CONTAINER_NAME_FIELDS);
      expect(screen.findAllByType(ScopedAuthoringComposer)).toHaveLength(1);
      expect(screen.findAllByType(ScopedAuthoringComposer)[0]!.props.custody).toBe(composerCustody.entryFor('b248'));

      await act(async () => {
        screen.findAllByType(WorkflowBlockHeading)
          .find(node => node.props.testID === 'workflow-editor-step-b0-label')!.props.onSelect();
        control.edit('b0');
      });
      const composer = screen.findAllByType(ScopedAuthoringComposer)[0]!;
      await act(async () => {
        screen.findAllByType(AgentInput)[0]!.props.onChangeText('Keep this unfinished audit note.');
        for (const intersect of intersections) intersect(false);
      });
      expect(screen.findAllByType(ScopedAuthoringComposer)[0]).toBe(composer);
      expect(composer.props.custody).toBe(composerCustody.entryFor('b0'));
      expect(screen.findAllByType(AgentInput)[0]!.props.value).toBe('Keep this unfinished audit note.');

      // An offscreen focus request is admitted even before its placeholder intersects.
      expect(screen.findAllByType(WorkflowBlockHeading)
        .some(node => node.props.testID === 'workflow-editor-step-b249-label')).toBe(false);
      await act(async () => { control.select('b249'); control.edit('b249'); });
      expect(screen.findAllByType(ScopedAuthoringComposer)).toHaveLength(1);
      expect(screen.findAllByType(ScopedAuthoringComposer)[0]!.props.custody).toBe(composerCustody.entryFor('b249'));
      await act(async () => { for (const intersect of intersections) intersect(true); });
      expect(screen.findAllByType(WorkflowBlockHeading)
        .some(node => node.props.testID === 'workflow-editor-wait-b495-label')).toBe(true);
      await act(async () => {
        screen.findAllByType(WorkflowBlockHeading)
          .find(node => node.props.testID === 'workflow-editor-step-b0-label')!.props.onSelect();
        control.edit('b0');
      });
      expect(focusRequests.at(-1)).toBe('b0');
      expect(screen.findAllByType(AgentInput)[0]!.props.value).toBe('Keep this unfinished audit note.');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120_000);
});
