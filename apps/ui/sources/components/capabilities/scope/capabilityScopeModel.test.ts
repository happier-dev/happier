import { describe, expect, it } from 'vitest';
import type { ReachPlaceV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { applyReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { resolveSkillReachV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import {
  describeScope,
  machinesNeedingOfflineNote,
  migratedProjectRuleItems,
  orderScopeRows,
  readScope,
  scopeWrite,
  type ScopeMachine,
  type ScopePlace,
} from './capabilityScopeModel';

const agentTitle = (id: string) =>
  (
    ({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }) as Record<
      string,
      string
    >
  )[id] ?? id;
const names: WhereItsOnNames = {
  agentName: agentTitle,
  agentNames: (ids) => ids.map(agentTitle),
  machineName: (id) =>
    (({ a: 'MacBook Pro', b: 'nl2', nl2: 'nl2' }) as Record<string, string>)[
      id
    ] ?? id,
  projectName: (key) => key,
  folderLabel: (machineId, root) => `${root} · ${machineId}`,
};

let seq = 0;
function rule(
  target: ReachPlaceV1,
  enabled: boolean,
  agentId?: string,
  id?: string,
): ReachRuleV1 {
  seq += 1;
  return {
    id: id ?? `r${seq}`,
    target,
    enabled,
    createdAt: seq,
    updatedAt: seq,
    ...(agentId ? { agentId } : {}),
  };
}
const everywhere = (on: boolean, agentId?: string) =>
  rule({ t: 'allMachines' }, on, agentId);
const onMachine = (machineId: string, on: boolean, agentId?: string) =>
  rule({ t: 'machine', machineId }, on, agentId);
const inProject = (
  projectKey: string,
  on: boolean,
  agentId?: string,
  id?: string,
) => rule({ t: 'project', projectKey }, on, agentId, id);

const machine = (
  machineId: string,
  agentIds: readonly string[],
): ScopeMachine => ({ machineId, platform: 'posix', agentIds });
const nl2: ScopePlace = { t: 'machine', machineId: 'nl2' };
const happier: ScopePlace = { t: 'project', projectKey: 'happier' };

/** Applies a write the way the Account rules owner does, so a test reads what the next state would say. */
function after(
  rules: readonly ReachRuleV1[],
  change: ReturnType<typeof scopeWrite>,
): ReachRuleV1[] {
  return applyReachRulesChangeV1(rules, change, {
    nowMs: 1_000_000,
    newId: () => `new${(seq += 1)}`,
  });
}

describe("a machine's switch", () => {
  const machines = [machine('nl2', ['codex', 'gemini'])];

  it('persists an explicit Off against a built-in default and can return to that default', () => {
    const resolve: Parameters<typeof readScope>[3] = (rules, context) =>
      resolveSkillReachV1('happier:workflows', rules, context, () => true);
    expect(readScope([], nl2, machines, resolve).on).toBe(true);
    const change = scopeWrite([], nl2, machines, false, resolve);
    expect(change).toMatchObject({ write: { state: 'off' } });
    const rules = after([], change);
    expect(readScope(rules, nl2, machines, resolve).on).toBe(false);
    expect(scopeWrite(rules, nl2, machines, true, resolve)).toMatchObject({ write: { state: 'inherit' } });
  });

  it('reads the agent-general state and names the Agents that differ (D33)', () => {
    const rules = [everywhere(true), everywhere(false, 'gemini')];
    const read = readScope(rules, nl2, machines);
    expect(read.on).toBe(true);
    expect(describeScope(read, nl2, names)).toBe('On for Codex · not Gemini');
  });

  it('writes only the agent-general machine rule, so the Gemini exception keeps holding', () => {
    const rules = [everywhere(true), everywhere(false, 'gemini')];
    const change = scopeWrite(rules, nl2, machines, false);
    expect(change).toEqual({
      kind: 'write',
      write: { place: nl2, state: 'off' },
    });
    const next = after(rules, change);
    expect(next.find((entry) => entry.agentId === 'gemini')?.enabled).toBe(
      false,
    );
    expect(readScope(next, nl2, machines).on).toBe(false);
  });

  it('writes inherit when the requested state is what the broader rules already say', () => {
    const rules = [everywhere(true), onMachine('nl2', false)];
    expect(readScope(rules, nl2, machines).on).toBe(false);
    expect(scopeWrite(rules, nl2, machines, true)).toEqual({
      kind: 'write',
      write: { place: nl2, state: 'inherit' },
    });
  });

  it('does not let an agent-qualified rule decide what inherit means (RED: it would compare against Gemini)', () => {
    const rules = [
      everywhere(false),
      everywhere(true, 'codex'),
      onMachine('nl2', true),
    ];
    // Broader general state is Off, so On here has to stay an explicit rule even though Codex is On already.
    expect(scopeWrite(rules, nl2, machines, true)).toEqual({
      kind: 'write',
      write: { place: nl2, state: 'on' },
    });
  });

  it('says where a uniform decision comes from', () => {
    expect(
      describeScope(readScope([everywhere(true)], nl2, machines), nl2, names),
    ).toBe('Everywhere');
    expect(
      describeScope(readScope([everywhere(false)], nl2, machines), nl2, names),
    ).toBe('Off');
    expect(describeScope(readScope([], nl2, machines), nl2, names)).toBe('Off');
    expect(
      describeScope(
        readScope([everywhere(false), onMachine('nl2', true)], nl2, machines),
        nl2,
        names,
      ),
    ).toBe('On for nl2');
    expect(
      describeScope(
        readScope([everywhere(true), onMachine('nl2', false)], nl2, machines),
        nl2,
        names,
      ),
    ).toBe('Off for nl2');
  });

  it('does not apply a project rule on the machine page', () => {
    const rules = [everywhere(false), inProject('happier', true)];
    expect(readScope(rules, nl2, machines).on).toBe(false);
  });
});

describe("a project's switch across its machines", () => {
  const machines = [machine('a', ['claude']), machine('b', ['claude'])];

  it('reads Off with "On on A · not B" when only one machine has it (IR-87)', () => {
    const rules = [everywhere(false), onMachine('a', true)];
    const read = readScope(rules, happier, machines);
    expect(read.on).toBe(false);
    expect(describeScope(read, happier, names)).toBe('On on MacBook Pro · not nl2');
  });

  it('retains an explicit project On, so the other machine gets it too (RED: PD7 against one machine writes inherit)', () => {
    const rules = [everywhere(false), onMachine('a', true)];
    const change = scopeWrite(rules, happier, machines, true);
    expect(change).toEqual({
      kind: 'write',
      write: { place: happier, state: 'on' },
    });
    const next = after(rules, change);
    expect(readScope(next, happier, machines).on).toBe(true);
  });

  it('retains an explicit project Off, so the machine that had it loses it', () => {
    const rules = [everywhere(false), onMachine('a', true)];
    const change = scopeWrite(rules, happier, machines, false);
    expect(change).toEqual({
      kind: 'write',
      write: { place: happier, state: 'off' },
    });
    // The project rule outranks the machine rule, so MacBook Pro loses it inside this project.
    expect(readScope(after(rules, change), happier, machines).on).toBe(false);
    expect(
      describeScope(readScope(after(rules, change), happier, machines), happier, names),
    ).toBe('Off in happier');
  });

  it('keeps a Gemini exception holding through both writes', () => {
    const geminiMachines = [
      machine('a', ['claude', 'gemini']),
      machine('b', ['claude', 'gemini']),
    ];
    const rules = [everywhere(true), everywhere(false, 'gemini')];
    for (const requested of [true, false]) {
      const next = after(
        rules,
        scopeWrite(rules, happier, geminiMachines, requested),
      );
      expect(next.find((entry) => entry.agentId === 'gemini')?.enabled).toBe(
        false,
      );
    }
  });

  it('writes inherit once every machine already agrees with the broader rules', () => {
    const rules = [everywhere(true), inProject('happier', false)];
    expect(readScope(rules, happier, machines).on).toBe(false);
    expect(scopeWrite(rules, happier, machines, true)).toEqual({
      kind: 'write',
      write: { place: happier, state: 'inherit' },
    });
  });

  it('reads a project with no checked-out machine from the project and Everywhere rules alone', () => {
    expect(readScope([everywhere(true)], happier, []).on).toBe(true);
    expect(
      readScope([everywhere(false), inProject('happier', true)], happier, [])
        .on,
    ).toBe(true);
  });
});

describe('orderScopeRows', () => {
  it('orders rules set here, then problems and masks, then by name, and keeps four', () => {
    const rows = [
      { id: 'zeta', name: 'zeta', hasRuleHere: false, problem: false },
      { id: 'alpha', name: 'alpha', hasRuleHere: false, problem: false },
      { id: 'beta', name: 'beta', hasRuleHere: false, problem: true },
      { id: 'gamma', name: 'gamma', hasRuleHere: true, problem: false },
      { id: 'delta', name: 'delta', hasRuleHere: true, problem: true },
      { id: 'omega', name: 'omega', hasRuleHere: false, problem: false },
    ];
    expect(orderScopeRows(rows).map((row) => row.id)).toEqual([
      'delta',
      'gamma',
      'beta',
      'alpha',
      'omega',
      'zeta',
    ]);
  });
});

describe('migratedProjectRuleItems', () => {
  it('names the items that carry rules migrated for this project and no other', () => {
    const items = [
      {
        id: 's1',
        name: 'brand-voice',
        rules: [
          inProject(
            'happier',
            true,
            undefined,
            'migrated-stack:project:happier:skill-1',
          ),
        ],
      },
      {
        id: 's2',
        name: 'code-review',
        rules: [inProject('happier', true, undefined, 'r-user')],
      },
      {
        id: 's3',
        name: 'other',
        rules: [
          inProject(
            'website',
            true,
            undefined,
            'migrated-stack:project:website:skill-3',
          ),
        ],
      },
    ];
    expect(
      migratedProjectRuleItems(items, 'happier').map((item) => item.name),
    ).toEqual(['brand-voice']);
    expect(migratedProjectRuleItems(items, 'happier-plugins')).toEqual([]);
  });
});

describe('machinesNeedingOfflineNote', () => {
  const covered = [
    { machineId: 'a', offline: true },
    { machineId: 'b', offline: true },
    { machineId: 'c', offline: false },
  ];
  it('names every unreachable covered machine when no page announces one', () => {
    expect(machinesNeedingOfflineNote(covered, null).map((machine) => machine.machineId)).toEqual(['a', 'b']);
  });
  it('leaves out the machine the page already says is not answering, and keeps the others', () => {
    expect(machinesNeedingOfflineNote(covered, 'a').map((machine) => machine.machineId)).toEqual(['b']);
  });
});
