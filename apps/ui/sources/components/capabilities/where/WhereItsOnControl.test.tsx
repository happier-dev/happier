import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectReachForMachinesV1 } from '@happier-dev/protocol/reach/projectReachV1';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import {
  applyReachRulesChangeV1,
  reachRuleKeyV1,
  type ReachRulesChangeV1,
} from '@happier-dev/protocol/reach/reachRulesChangeV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

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

// Load the real UI graph during collection, not inside the behavior timeout budget.
const { WhereItsOnControl, useDraftReachRules } = await import('./WhereItsOnControl');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Replace = Extract<ReachRulesChangeV1, { kind: 'replace' }>;
let id = 0;
const rule = (
  input: Omit<ReachRuleV1, 'id' | 'createdAt' | 'updatedAt'>,
): ReachRuleV1 => ({ ...input, id: `r${id++}`, createdAt: 1, updatedAt: 1 });
const everywhere = (enabled: boolean) =>
  rule({ target: { t: 'allMachines' }, enabled });
const AGENTS = ['claude', 'codex', 'gemini'];
const MACHINES = [
  { machineId: 'mbp', name: 'MacBook Pro', online: true },
  { machineId: 'nl2', name: 'nl2', online: true },
];
const PROJECTS = [
  { projectKey: 'happier', name: 'happier', machineCount: 2 },
  { projectKey: 'client-site', name: 'client-site', machineCount: 1 },
];

const projectionFor = (
  rules: readonly ReachRuleV1[],
  projectKey: string | null = null,
) =>
  projectReachForMachinesV1(rules, {
    projectKey,
    machines: MACHINES.map((machine) => ({
      machineId: machine.machineId,
      platform: 'posix' as const,
      agentIds: AGENTS,
    })),
  });
/** The drafts a `replace` carries, keyed the way the reach owner keys rules. */
const drafts = (change: Replace) =>
  change.rules
    .map(
      (draft) =>
        `${JSON.stringify(draft.target)}|${draft.agentId ?? '*'}|${draft.enabled ? 'on' : 'off'}`,
    )
    .sort();

async function renderControl(
  input: Readonly<{
    rules: readonly ReachRuleV1[];
    onChange?: (
      change: Replace,
    ) => Promise<{ ok: true } | { ok: false; message: string }>;
    readOnlyReason?: string;
    projectKey?: string | null;
    projection?: readonly Readonly<ReturnType<typeof projectionFor>[number] & { agentInventoryComplete?: boolean }>[];
    kind?: 'skill' | 'mcp_server';
    presentation?: 'section' | 'pick';
    defaultEnabled?: boolean;
  }>,
) {
  const changes: Replace[] = [];
  const onChange =
    input.onChange ??
    (async (change: Replace) => {
      changes.push(change);
      return { ok: true as const };
    });
  const screen = await renderScreen(
    <WhereItsOnControl
      kind={input.kind ?? 'skill'}
      rules={input.rules}
      defaultEnabled={input.defaultEnabled}
      status="ready"
      projection={input.projection ?? projectionFor(input.rules, input.projectKey ?? null)}
      places={{ agentIds: AGENTS, machines: MACHINES, projects: PROJECTS }}
      onChange={async (change) => {
        const result = await onChange(change);
        if (input.onChange) changes.push(change);
        return result;
      }}
      presentation={input.presentation ?? 'section'}
      {...(input.readOnlyReason
        ? { readOnlyReason: input.readOnlyReason }
        : {})}
      testID="where"
    />,
  );
  const byTestId = (testID: string) =>
    screen.findAll((node) => node.props?.testID === testID);
  const open = async () => {
    const header = screen.findAll(
      (node) =>
        node.props?.testID === 'where:sentence' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      header.props.onPress();
    });
  };
  /** Choose an entry in a menu as the person would (the menu owner hands the chosen id to `onSelect`). */
  const choose = async (menuTestID: string, itemId: string) => {
    const menu = screen.findAll(
      (node) =>
        node.props?.testID === menuTestID &&
        typeof node.props?.onSelect === 'function',
    )[0]!;
    await act(async () => {
      menu.props.onSelect(itemId);
    });
  };
  const press = async (testID: string) => {
    const target = screen.findAll(
      (node) =>
        node.props?.testID === testID &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      await target.props.onPress();
    });
  };
  const directText = (children: unknown): string => typeof children === 'string' ? children
    : Array.isArray(children) ? children.map(directText).join('') : '';
  const text = () =>
    screen
      .findAll(() => true)
      .map((node) => directText(node.props.children))
      .join('|');
  return { screen, changes, byTestId, open, choose, press, text };
}

const ruleKey = (target: ReachRuleV1['target'], agentId?: string) =>
  `where:rule:${reachRuleKeyV1({ target, ...(agentId ? { agentId } : {}) })}`;

describe('WhereItsOnControl', () => {
  it('turns an implicit built-in Everywhere default off with one explicit rule and no write on read', async () => {
    const control = await renderControl({ rules: [], defaultEnabled: true });
    expect(control.changes).toEqual([]);
    await control.open();
    const toggle = control.screen.findAll(node => node.props?.testID === 'where:everywhere' && typeof node.props?.onChange === 'function')[0]!;
    expect(toggle.props.value).toBe('on');
    await act(async () => { await toggle.props.onChange('off'); });
    expect(control.changes.map(drafts)).toEqual([[`${JSON.stringify({ t: 'allMachines' })}|*|off`]]);
  });
  it('is a titled section in the compact add-flow form too, and leaves the description to the detail', async () => {
    const group = async (presentation: 'section' | 'pick') => {
      const { screen } = await renderControl({ rules: [], presentation });
      return screen.findAll((node) => node.props?.testID === 'where' && 'title' in node.props)[0]!.props;
    };
    expect((await group('section')).description).toBeTruthy();
    const pick = await group('pick');
    expect(pick.title).toBe('Where it’s on');
    expect(pick.description).toBeUndefined();
  });

  it.each(['skill', 'mcp_server'] as const)('keeps unknown %s inventory in the consequence slot without hiding confirmed availability', async kind => {
    const rules = [everywhere(true)];
    const incomplete = [{ machineId: 'mbp', agents: [], agentInventoryComplete: false }];
    const unknown = await renderControl({ rules, kind, projection: incomplete });
    expect(unknown.byTestId('where:consequence').length).toBeGreaterThan(0);
    expect(unknown.text()).toContain('—');
    expect(unknown.text()).not.toContain(t('capabilities.where.availableNowhere'));
    const known = await renderControl({ rules, kind, projection: [{ ...incomplete[0]!,
      agents: [{ agentId: 'codex', enabled: true, decidedBy: null }] }] });
    expect(known.text()).toContain('Codex');
    expect(known.text()).toContain('MacBook Pro');
    const empty = await renderControl({ rules, kind, projection: [{ ...incomplete[0]!, agentInventoryComplete: true }] });
    expect(empty.text()).toContain(t('capabilities.where.availableNowhere'));
  });

  it.each(['skill', 'mcp_server'] as const)('says an item turned off everywhere is available nowhere even while %s inventory is unknown', async kind => {
    const incomplete = [{ machineId: 'mbp', agents: [], agentInventoryComplete: false }];
    const off = await renderControl({ rules: [everywhere(false)], kind, projection: incomplete });
    expect(off.text()).toContain(t('capabilities.where.availableNowhere'));
    expect(off.text()).not.toContain('—');
  });

  it('adds an agent exception as one replace that holds wherever a project turns it on (D33)', async () => {
    const exceptRules = [
      everywhere(true),
      rule({ target: { t: 'project', projectKey: 'happier' }, enabled: true }),
    ];
    const excepting = await renderControl({ rules: exceptRules });
    await excepting.open();
    await excepting.choose('where:addMenu', 'agent:gemini');
    expect(excepting.changes).toHaveLength(1);
    expect(drafts(excepting.changes[0]!)).toContain(
      `${JSON.stringify({ t: 'allMachines' })}|gemini|off`,
    );
    expect(drafts(excepting.changes[0]!)).toContain(
      `${JSON.stringify({ t: 'project', projectKey: 'happier' })}|*|on`,
    );
    // The consequence for a session in the project, from the resolver, no longer names Gemini.
    const next = applyReachRulesChangeV1(exceptRules, excepting.changes[0]!, {
      nowMs: 2,
      newId: () => `n${id++}`,
    });
    const inProject = projectionFor(next, 'happier');
    expect(
      inProject.every(
        (row) =>
          row.agents.find((agent) => agent.agentId === 'gemini')?.enabled ===
          false,
      ),
    ).toBe(true);
    expect(
      inProject.every(
        (row) =>
          row.agents.find((agent) => agent.agentId === 'codex')?.enabled ===
          true,
      ),
    ).toBe(true);
  });

  it('turns the excepted Agent back on in one place through the place rule’s agents select', async () => {
    const rules = [
      everywhere(true),
      rule({ target: { t: 'allMachines' }, agentId: 'gemini', enabled: false }),
      rule({ target: { t: 'project', projectKey: 'happier' }, enabled: true }),
    ];
    const control = await renderControl({ rules });
    await control.open();
    await control.choose(
      `${ruleKey({ t: 'project', projectKey: 'happier' })}:agents`,
      'gemini',
    );
    expect(control.changes).toHaveLength(1);
    const after = drafts(control.changes[0]!);
    // One change: the general place rule is gone and the place+agent rule is on; the exception stays.
    expect(after).toContain(
      `${JSON.stringify({ t: 'project', projectKey: 'happier' })}|gemini|on`,
    );
    expect(after).not.toContain(
      `${JSON.stringify({ t: 'project', projectKey: 'happier' })}|*|on`,
    );
    expect(after).toContain(
      `${JSON.stringify({ t: 'allMachines' })}|gemini|off`,
    );
  });

  it('flips Everywhere off as one replace that keeps every other rule', async () => {
    const rules = [
      everywhere(true),
      rule({
        target: { t: 'project', projectKey: 'client-site' },
        enabled: false,
      }),
    ];
    const control = await renderControl({ rules });
    await control.open();
    const segmented = control.screen.findAll(
      (node) =>
        node.props?.testID === 'where:everywhere' &&
        typeof node.props?.onChange === 'function',
    )[0]!;
    await act(async () => {
      segmented.props.onChange('off');
    });
    expect(control.changes).toHaveLength(1);
    expect(drafts(control.changes[0]!)).toEqual(
      [
        `${JSON.stringify({ t: 'allMachines' })}|*|off`,
        `${JSON.stringify({ t: 'project', projectKey: 'client-site' })}|*|off`,
      ].sort(),
    );
  });

  it('adds a project from the menu under base Off, and removes a rule, each as one replace', async () => {
    const rules = [
      everywhere(false),
      rule({ target: { t: 'machine', machineId: 'nl2' }, enabled: true }),
    ];
    const control = await renderControl({ rules });
    await control.open();
    await control.choose('where:addMenu', 'project:client-site');
    expect(drafts(control.changes[0]!)).toContain(
      `${JSON.stringify({ t: 'project', projectKey: 'client-site' })}|*|on`,
    );
    await control.press(
      `${ruleKey({ t: 'machine', machineId: 'nl2' })}:remove`,
    );
    expect(control.changes).toHaveLength(2);
    expect(drafts(control.changes[1]!)).toEqual([
      `${JSON.stringify({ t: 'allMachines' })}|*|off`,
    ]);
  });

  it('swaps a place rule’s Agent qualifier in one replace', async () => {
    const rules = [
      everywhere(false),
      rule({
        target: { t: 'machine', machineId: 'nl2' },
        agentId: 'codex',
        enabled: true,
      }),
    ];
    const control = await renderControl({ rules });
    await control.open();
    await control.choose(
      `${ruleKey({ t: 'machine', machineId: 'nl2' }, 'codex')}:agents`,
      'claude',
    );
    expect(control.changes).toHaveLength(1);
    const after = drafts(control.changes[0]!);
    expect(after).toContain(
      `${JSON.stringify({ t: 'machine', machineId: 'nl2' })}|claude|on`,
    );
    expect(after.some((entry) => entry.includes('|codex|'))).toBe(false);
  });

  it('shows a refused change inline with Try again, which resends the same value', async () => {
    const rules = [everywhere(true)];
    let calls = 0;
    const control = await renderControl({
      rules,
      onChange: async () =>
        ++calls === 1
          ? { ok: false, message: 'catalog_unavailable' }
          : { ok: true },
    });
    await control.open();
    await control.choose('where:addMenu', 'machine:nl2');
    expect(control.byTestId('where:error').length).toBeGreaterThan(0);
    const card = control.screen.findAll(
      (node) => node.props?.testID === 'where:error' && node.props?.action,
    )[0]!;
    await act(async () => {
      await card.props.action.onPress();
    });
    expect(control.changes).toHaveLength(2);
    expect(control.changes[1]).toEqual(control.changes[0]);
    expect(control.byTestId('where:error')).toHaveLength(0);
  });

  it('keeps the sentence and the consequence but no controls when read-only', async () => {
    const rules = [
      everywhere(true),
      rule({ target: { t: 'machine', machineId: 'nl2' }, enabled: false }),
    ];
    const control = await renderControl({
      rules,
      readOnlyReason: 'Found on nl2.',
    });
    await control.open();
    expect(control.byTestId('where:sentenceText').length).toBeGreaterThan(0);
    expect(control.byTestId('where:consequence').length).toBeGreaterThan(0);
    expect(control.byTestId('where:add')).toHaveLength(0);
    expect(
      control.byTestId(`${ruleKey({ t: 'machine', machineId: 'nl2' })}:remove`),
    ).toHaveLength(0);
    expect(control.text()).toContain('Found on nl2.');
  });
});

describe('useDraftReachRules', () => {
  it('starts from the create-time default (Everywhere On) with no pick, then carries the last replace', async () => {
    let latest: ReturnType<typeof useDraftReachRules> | null = null;
    function Probe() {
      latest = useDraftReachRules('skill');
      return null;
    }
    await renderScreen(<Probe />);
    expect(latest!.where).toBeUndefined();
    expect(
      latest!.rules.map((entry) => [
        entry.target.t,
        entry.agentId ?? null,
        entry.enabled,
      ]),
    ).toEqual([['allMachines', null, true]]);
    const change: Replace = {
      kind: 'replace',
      rules: [{ target: { t: 'allMachines' }, enabled: false }],
    };
    await act(async () => {
      await latest!.onChange(change);
    });
    expect(latest!.where).toEqual(change);
    expect(latest!.rules.map((entry) => entry.enabled)).toEqual([false]);
  });
});
