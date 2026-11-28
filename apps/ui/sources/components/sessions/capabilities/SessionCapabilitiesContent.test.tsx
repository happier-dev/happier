import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { SessionSkillPlanV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { readSessionCapabilityOverrideV1, setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { SessionCapabilitiesChange } from './SessionCapabilitiesContent';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
});

// Collect the real component graph before starting a test's renderer lifetime.
const { buildSessionCapabilitiesModel } = await import('./sessionCapabilitiesModel');
const { SessionCapabilitiesContent, sessionCapabilityRowRemovalState } = await import('./SessionCapabilitiesContent');

type Entry = Readonly<{
  kind: 'skill' | 'mcp_server';
  id: string;
  ruleOn: boolean;
  override: 'added' | 'removed' | null;
}>;
const names = {
  machineName: () => 'nl2',
  projectName: () => 'happier',
  agentName: () => 'Codex',
  agentNames: (ids: readonly string[]) => ids.map(() => 'Codex'),
  folderLabel: () => '~/happier',
};

function view(entries: readonly Entry[]) {
  const item = (entry: Entry) => ({
    kind: entry.kind,
    id: entry.id,
    name: entry.id,
    selectable: true,
    selected:
      entry.override === 'added'
        ? true
        : entry.override === 'removed'
          ? false
          : entry.ruleOn,
    reason: entry.override === 'removed' ? ('session_removed' as const) : entry.override === 'added' ? ('session_added' as const)
      : entry.ruleOn ? ('rule_on' as const) : ('rule_off' as const),
    sessionOverride: entry.override,
    decidedBy: {
      ruleId: entry.id,
      target: 'allMachines' as const,
      agentQualified: false,
    },
  });
  const parsed = SessionCapabilitiesGetOutputV1Schema.parse({
    ok: true,
    mcp: {
      items: entries
        .filter((entry) => entry.kind === 'mcp_server')
        .map((entry) => ({ ...item(entry), source: 'catalog' })),
    },
    skills: {
      items: entries.filter((entry) => entry.kind === 'skill').map(item),
      plan: SessionSkillPlanV1Schema.parse({
        plan: 'session_dir',
        items: [],
        nativeDisables: [],
        diagnostics: [],
      }),
    },
    pendingApply: { mcp: false, skills: false },
    applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
  });
  if (!parsed.ok) throw new Error('invalid fixture');
  return parsed;
}

async function render(
  entries: readonly Entry[],
  state: 'ready' | 'error' | 'machine_unreachable' | 'resolving' = 'ready',
  options: Readonly<{
    preview?: boolean;
    knownRows?: Readonly<{ skills: number; mcp: number }>;
    kind?: Parameters<typeof SessionCapabilitiesContent>[0]['kind'];
    presentation?: 'popover' | 'embedded';
    onOpen?: (destination: 'skills' | 'mcp') => void;
    skillDetails?: Parameters<typeof SessionCapabilitiesContent>[0]['skillDetails'];
    skillSection?: Parameters<typeof SessionCapabilitiesContent>[0]['skillSection'];
    undo?: Parameters<
      typeof import('./SessionCapabilitiesContent').SessionCapabilitiesContent
    >[0]['undo'];
  }> = {},
) {
  const model = buildSessionCapabilitiesModel({
    view: options.preview === false ? null : view(entries),
    state,
    readOnly: false,
    names,
    rules: (_kind, id) => [
      {
        id,
        target: { t: 'allMachines' },
        enabled: entries.find((entry) => entry.id === id)?.ruleOn ?? false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    mcpStatus: () => [],
    skillStatus: () => [],
    cost: () => ({ tokensWhenUsed: 1200 }),
  });
  const changes: Parameters<SessionCapabilitiesChange>[0][] = [];
  const onRetry = vi.fn();
  const screen = await renderScreen(
    <SessionCapabilitiesContent
      model={model}
      onChange={async (change) => {
        changes.push(change);
      }}
      onRetry={onRetry}
      undo={options.undo}
      knownRows={options.knownRows}
      kind={options.kind}
      presentation={options.presentation}
      onOpen={options.onOpen}
      skillDetails={options.skillDetails}
      skillSection={options.skillSection}
      machineName="nl2"
      testID="caps"
    />,
  );
  return { screen, changes, onRetry, model };
}

async function press(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) {
  const { act } = await import('react');
  const node = screen.findAll(
    (candidate) =>
      candidate.props?.testID === testID &&
      typeof candidate.props?.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no pressable ${testID}`);
  await act(async () => {
    await node.props.onPress({});
  });
}

describe('SessionCapabilitiesContent', () => {
  it('opens MCP settings and offers only MCP additions from the MCP section', async () => {
    const opened: string[] = [];
    const { screen } = await render([
      { kind: 'skill', id: 'editing-skill', ruleOn: true, override: null },
      { kind: 'mcp_server', id: 'operating-server', ruleOn: true, override: null },
      { kind: 'skill', id: 'optional-skill', ruleOn: false, override: null },
      { kind: 'mcp_server', id: 'optional-server', ruleOn: false, override: null },
    ], 'ready', { kind: 'mcp', presentation: 'embedded', onOpen: value => opened.push(value) });
    await press(screen, 'caps:open:mcp');
    expect(opened).toEqual(['mcp']);
    expect(screen.findAll(node => node.props?.testID === 'caps:open:skills')).toHaveLength(0);
  });
  it('projects the same remove intent for controls and mounted commands, excluding Turn on and read-only rows', async () => {
    const { model } = await render([
      { kind: 'skill', id: 'inherited', ruleOn: true, override: null },
      { kind: 'skill', id: 'added', ruleOn: false, override: 'added' },
      { kind: 'skill', id: 'removed', ruleOn: true, override: 'removed' },
    ]);
    const rows = model.groups.flatMap(group => group.rows);
    const inherited = rows.find(row => row.id === 'inherited');
    const added = rows.find(row => row.id === 'added');
    const removed = rows.find(row => row.id === 'removed');
    if (!inherited || !added || !removed) throw new Error('Expected all row states');
    expect(sessionCapabilityRowRemovalState(inherited)).toBe('off');
    expect(sessionCapabilityRowRemovalState(added)).toBe('inherit');
    expect(sessionCapabilityRowRemovalState(removed)).toBeNull();
    expect(sessionCapabilityRowRemovalState({ ...inherited, action: { kind: 'turn_on', state: 'on' } })).toBeNull();
    expect(sessionCapabilityRowRemovalState({ ...inherited, readOnlyReason: 'viewer' })).toBeNull();
  });

  it('groups displayed Skills by their maker without losing rows or duplicating the picker', async () => {
    const { screen } = await render([
      { kind: 'skill', id: 'bot-made', ruleOn: true, override: null },
      { kind: 'skill', id: 'mine', ruleOn: true, override: null },
    ], 'ready', { kind: 'skills', skillSection: id => id === 'bot-made'
      ? { key: 'this-session', title: 'Made here' } : { key: 'yours', title: 'Yours' } });
    expect(screen.findAll(node => node.props?.testID === 'caps:group:this-session').length).toBeGreaterThan(0);
    expect(screen.findAll(node => node.props?.testID === 'caps:group:yours').length).toBeGreaterThan(0);
    for (const id of ['bot-made', 'mine']) expect(screen.findAll(node => node.props?.testID === `caps:row:skill:${id}`).length).toBeGreaterThan(0);
    await press(screen, 'caps:add');
    expect(screen.findAll(node => typeof node.type === 'string' && node.props?.testID === 'caps:add:search' && typeof node.props?.onChangeText === 'function')).toHaveLength(1);
  });

  it('opens the selected skill through its supplied detail command while retaining its remove control', async () => {
    const open = vi.fn();
    const { screen, changes } = await render([
      { kind: 'skill', id: 'review', ruleOn: true, override: null },
    ], 'ready', { kind: 'skills', skillDetails: () => ({ description: 'Review code', onPress: open }) });
    await press(screen, 'caps:row:skill:review');
    expect(open).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
    await press(screen, 'caps:row:skill:review:remove');
    expect(changes).toEqual([{ kind: 'skill', id: 'review', state: 'off' }]);
  });

  it('keeps the Skills pane and its add picker scoped to skills', async () => {
    const { screen, changes } = await render([
      { kind: 'skill', id: 'included-skill', ruleOn: true, override: null },
      { kind: 'skill', id: 'available-skill', ruleOn: false, override: null },
      { kind: 'mcp_server', id: 'included-server', ruleOn: true, override: null },
      { kind: 'mcp_server', id: 'available-server', ruleOn: false, override: null },
    ], 'ready', { kind: 'skills' });
    expect(screen.findAll(node => node.props?.testID === 'caps:row:skill:included-skill').length).toBeGreaterThan(0);
    expect(screen.findAll(node => node.props?.testID === 'caps:row:mcp_server:included-server')).toHaveLength(0);
    await press(screen, 'caps:add');
    expect(screen.findAll(node => node.props?.testID === 'caps:add:pick:mcp_server:available-server')).toHaveLength(0);
    await press(screen, 'caps:add:pick:skill:available-skill');
    expect(changes).toEqual([{ kind: 'skill', id: 'available-skill', state: 'on' }]);
  });

  it('sits in a host row when embedded: no scroller or repeated kind heading, destinations as a trailing row (owner 11-16 F1)', async () => {
    const onOpen = vi.fn();
    const { screen } = await render([
      { kind: 'skill', id: 'included-skill', ruleOn: true, override: null },
    ], 'ready', { kind: 'skills', presentation: 'embedded', onOpen });
    const { ScrollView } = await import('react-native');
    const { CollectionListGroupLabel } = await import('@/components/ui/lists/collection/CollectionList');
    expect(screen.tree.root.findAllByType(ScrollView)).toHaveLength(0);
    expect(screen.tree.root.findAllByType(CollectionListGroupLabel)).toHaveLength(0);
    // The destination is an ordinary trailing row, pressable like the rows above it.
    await press(screen, 'caps:open:skills');
    expect(onOpen).toHaveBeenCalledWith('skills');
  });

  it('turns an inherited row off, returns an added row to its rules, and turns a removed row back on', async () => {
    const { screen, changes } = await render([
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
      { kind: 'skill', id: 'sql-migrations', ruleOn: false, override: 'added' },
      { kind: 'mcp_server', id: 'linear', ruleOn: true, override: 'removed' },
      { kind: 'mcp_server', id: 'postgres', ruleOn: false, override: 'removed' },
    ]);
    await press(screen, 'caps:row:skill:code-review:remove');
    await press(screen, 'caps:row:skill:sql-migrations:remove');
    await press(screen, 'caps:row:mcp_server:linear:turn-on');
    await press(screen, 'caps:row:mcp_server:postgres:turn-on');
    expect(changes).toEqual([
      { kind: 'skill', id: 'code-review', state: 'off' },
      { kind: 'skill', id: 'sql-migrations', state: 'inherit' },
      { kind: 'mcp_server', id: 'linear', state: 'inherit' },
      { kind: 'mcp_server', id: 'postgres', state: 'on' },
    ]);
    for (const [id, ruleOn] of [['linear', true], ['postgres', false]] as const) {
      const change = changes.find(change => change.id === id);
      if (!change) throw new Error('missing Turn on change');
      const selection = setSessionCapabilitySelectionItemV1({}, change.kind, change.id, change.state);
      const value = readSessionCapabilityOverrideV1(selection, change.kind, change.id);
      const settled = await render([{ kind: 'mcp_server', id, ruleOn, override: value === 'on' ? 'added' : value === 'off' ? 'removed' : null }]);
      expect(settled.model.groups[1]?.rows[0]).toMatchObject({ id, dimmed: false, action: { kind: 'remove' } });
      expect(settled.model.groups[1]?.rows[0]?.line2).toEqual(ruleOn ? { kind: 'cost', cost: { tokensWhenUsed: 1200 } }
        : { kind: 'change', change: 'added' });
      expect(selection.mcp?.forceIncludeServerIds).toEqual(ruleOn ? [] : [id]);
    }
  });

  it('adds an item that exists but is off here from the add field', async () => {
    const { screen, changes } = await render([
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
      { kind: 'mcp_server', id: 'postgres', ruleOn: false, override: null },
    ]);
    expect(
      screen.findAll(
        (node) => node.props?.testID === 'caps:row:mcp_server:postgres',
      ),
    ).toHaveLength(0);
    await press(screen, 'caps:add');
    await press(screen, 'caps:add:pick:mcp_server:postgres');
    expect(changes).toEqual([
      { kind: 'mcp_server', id: 'postgres', state: 'on' },
    ]);
  });

  it('offers Undo in place for the last change and hands the press to its owner', async () => {
    const onUndo = vi.fn();
    const entries: readonly Entry[] = [
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
    ];
    const without = await render(entries);
    expect(
      without.screen.findAll((node) => node.props?.testID === 'caps:undo'),
    ).toHaveLength(0);
    const { screen } = await render(entries, 'ready', {
      undo: { title: 'pdf', change: 'removed', onUndo },
    });
    expect(
      screen.findAll((node) => node.props?.testID === 'caps:undo').length,
    ).toBeGreaterThan(0);
    const { t } = await import('@/text');
    const { act } = await import('react');
    const undo = screen.findAll(
      (node) =>
        node.props?.accessibilityLabel === t('capabilities.session.ask.undo') &&
        typeof node.props?.onPress === 'function',
    )[0];
    if (!undo) throw new Error('no Undo control in the line');
    await act(async () => {
      await undo.props.onPress({});
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('says a failed preview once with its retry, and keeps an empty group with its own line', async () => {
    const failed = await render(
      [{ kind: 'skill', id: 'code-review', ruleOn: true, override: null }],
      'error',
    );
    expect(
      failed.screen.findAll((node) => node.props?.testID === 'caps:error')
        .length,
    ).toBeGreaterThan(0);
    const empty = await render([
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
    ]);
    expect(
      empty.screen.findAll((node) => node.props?.testID === 'caps:empty:mcp')
        .length,
    ).toBeGreaterThan(0);
    expect(
      empty.screen.findAll(
        (node) => node.props?.testID === 'caps:empty:skills',
      ),
    ).toHaveLength(0);
  });

  it('holds the groups open while the first preview loads: both headings, placeholder rows, a silent footer cost, and no empty claim', async () => {
    const loading = await render([], 'resolving', { preview: false });
    const ids = new Set(
      loading.screen
        .findAll((node) => typeof node.props?.testID === 'string')
        .map((node) => node.props.testID as string),
    );
    expect(ids.has('caps:group:skills')).toBe(true);
    expect(ids.has('caps:group:mcp')).toBe(true);
    expect(ids.has('caps:resolving')).toBe(true);
    expect([...ids].filter((id) => id.startsWith('caps:empty:'))).toEqual([]);
    const { t } = await import('@/text');
    expect(
      loading.screen.findAll((node) => node.props?.children === t('capabilities.session.costUnknown')),
    ).toHaveLength(0);
  });

  it('reserves the box the loaded groups will fill: what each held when last seen, else a full preview', async () => {
    const placeholders = (screen: Awaited<ReturnType<typeof render>>['screen'], testID: string) =>
      screen.findAll((node) => node.props?.testID === `${testID}:skeleton-row`).length;
    const unknown = await render([], 'resolving', { preview: false });
    const known = await render([], 'resolving', { preview: false, knownRows: { skills: 3, mcp: 9 } });
    const fullPreview = placeholders(unknown.screen, 'caps:resolving');
    // Unknown: a full preview in both groups. Known: 3 rows for the skills group; the MCP group (9) reserves a full
    // preview and the "n more" line below it.
    expect(placeholders(unknown.screen, 'caps:resolving:mcp')).toBe(fullPreview);
    expect(placeholders(known.screen, 'caps:resolving')).toBeLessThan(fullPreview);
    expect(placeholders(known.screen, 'caps:resolving:mcp')).toBe(fullPreview);
    expect(known.screen.findAll((node) => node.props?.testID === 'caps:resolving-more:mcp').length).toBeGreaterThan(0);
    expect(known.screen.findAll((node) => node.props?.testID === 'caps:resolving-more:skills')).toHaveLength(0);
  });

  it('says an offline machine once and never claims empty groups it could not check', async () => {
    const offline = await render([], 'machine_unreachable', { preview: false });
    const ids = new Set(
      offline.screen
        .findAll((node) => typeof node.props?.testID === 'string')
        .map((node) => node.props.testID as string),
    );
    expect(ids.has('caps:offline')).toBe(true);
    expect([...ids].filter((id) => id.startsWith('caps:group:'))).toEqual([]);
    expect([...ids].filter((id) => id.startsWith('caps:empty:'))).toEqual([]);
  });
});
