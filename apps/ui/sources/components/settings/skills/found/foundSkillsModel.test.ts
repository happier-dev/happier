import { describe, expect, it } from 'vitest';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import {
  foundAddAllItems,
  foundRowKind,
  groupFoundRowsByName,
  pickFoundHomeRows,
  orderFoundRows,
} from './foundSkillsModel';
import { FOUND_FOLD_ROWS, foldFoundRows } from '@/components/capabilities/found/foundMachineModel';

const result = SkillFoundListResultV1Schema.parse({
  scannedAt: 1,
  roots: [],
  items: [
    { name: 'held', description: null, path: '/s/held', digest: 'a', agents: ['claude'], scope: 'user', inLibrary: 'held', masksLibrary: false, happierInstalled: false, pluginOwned: null },
    { name: 'plug', description: null, path: '/p/plug', digest: 'b', agents: ['claude'], scope: 'plugin', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: { pluginName: 'frontend' } },
    { name: 'same-name', description: null, path: '/s/same-name', digest: 'c', agents: ['codex'], scope: 'user', inLibrary: null, masksLibrary: true, happierInstalled: false, pluginOwned: null },
    { name: 'plain', description: null, path: '/s/plain', digest: 'd', agents: ['claude'], scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
    { name: 'plain-2', description: null, path: '/s/plain-2', digest: 'e', agents: ['claude'], scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
  ],
});
const byName = (name: string) => result.items.find((item) => item.name === name)!;

describe('Found rows', () => {
  it('offers each row exactly one thing, whatever else is true of it', () => {
    expect(result.items.map((item) => [item.name, foundRowKind(item)])).toEqual([
      ['held', 'in_library'], ['plug', 'plugin'], ['same-name', 'masks'], ['plain', 'addable'], ['plain-2', 'addable'],
    ]);
    // A copy the library already holds wins over a same-name warning.
    expect(foundRowKind({ ...byName('same-name'), inLibrary: 'x' })).toBe('in_library');
  });

  it('puts masked names first and otherwise keeps scan order, so an added row stays put', () => {
    expect(orderFoundRows(result.items).map((item) => item.name)).toEqual(['same-name', 'held', 'plug', 'plain', 'plain-2']);
    const added = result.items.map((item) => (item.name === 'plain' ? { ...item, inLibrary: 'plain' } : item));
    expect(orderFoundRows(added).map((item) => item.name)).toEqual(['same-name', 'held', 'plug', 'plain', 'plain-2']);
  });

  it('draws one row per skill name: the copies in other agents\' folders fold into it, with their folders and readers', () => {
    const copy = (path: string, agents: string[], extra: Record<string, unknown> = {}) => SkillFoundListResultV1Schema.parse({
      scannedAt: 1,
      roots: [],
      items: [{ name: 'frontend-design', description: null, path, digest: path, agents, scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null, ...extra }],
    }).items[0]!;
    const groups = groupFoundRowsByName([
      copy('/h/.claude/skills/frontend-design', ['claude', 'codex']),
      byName('plain'),
      copy('/h/.cursor/skills/frontend-design', ['cursor', 'claude'], { masksLibrary: true }),
      copy('/h/.claude/skills/frontend-design', ['claude']),
    ]);
    expect(groups.map((group) => group.item.name)).toEqual(['frontend-design', 'plain']);
    expect(groups[0]).toMatchObject({
      agents: ['claude', 'codex', 'cursor'],
      folders: ['/h/.claude/skills', '/h/.cursor/skills'],
    });
    expect(groups[0]!.item.path).toBe('/h/.claude/skills/frontend-design');
  });

  it('adds all only the rows that offer Add to library', () => {
    expect(foundAddAllItems(result.items).map((item) => item.name)).toEqual(['plain', 'plain-2']);
  });

  it('folds a long list to a head and a count, and never hides a single row behind "1 more"', () => {
    const rows = Array.from({ length: FOUND_FOLD_ROWS + 5 }, (_, index) => index);
    expect(foldFoundRows(rows, false)).toEqual({ shown: rows.slice(0, FOUND_FOLD_ROWS), hidden: 5 });
    expect(foldFoundRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    const justOver = Array.from({ length: FOUND_FOLD_ROWS + 1 }, (_, index) => index);
    expect(foldFoundRows(justOver, false)).toEqual({ shown: justOver, hidden: 0 });
  });
});

describe('Found on the homepage', () => {
  const other = SkillFoundListResultV1Schema.parse({
    scannedAt: 2,
    roots: [],
    items: [
      { name: 'plain', description: null, path: '/o/plain', digest: 'd', agents: ['codex'], scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
      { name: 'remote-only', description: null, path: '/o/remote-only', digest: 'f', agents: ['codex'], scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
    ],
  });

  it('offers only rows that can be added, once per name, reachable machines first', () => {
    const rows = pickFoundHomeRows(
      [{ machineId: 'off', offline: true }, { machineId: 'on', offline: false }],
      { off: other, on: result },
      3,
    );
    // Held, plugin-owned and masked rows need the Found page; "plain" from the offline machine repeats a name.
    expect(rows.map((row) => [row.machineId, row.item.name])).toEqual([
      ['on', 'plain'], ['on', 'plain-2'], ['off', 'remote-only'],
    ]);
  });

  it('shows nothing for a machine nothing is known about, and stops at the room it is given', () => {
    expect(pickFoundHomeRows([{ machineId: 'on', offline: false }], { on: null }, 3)).toEqual([]);
    expect(pickFoundHomeRows([{ machineId: 'on', offline: false }], { on: result }, 1).map((row) => row.item.name)).toEqual(['plain']);
  });
});
