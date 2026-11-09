import type { FoundItem } from '@/sync/domains/skills/useFoundSkills';
import { foundSkillsByName } from '@/sync/domains/skills/foundSkillInventory';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

export const SKILLS_FOUND_ROUTE = SETTINGS_ROUTES.skillsFound;

/**
 * What a Found row offers (P6 §4.5), decided once:
 * - `in_library`: the library already holds these bytes; the row opens that skill.
 * - `masks`: the library has another skill of this name and the machine's copy wins there; Compare.
 * - `plugin`: an Agent plugin's own skill; the only way to take it is a copy, never Add all.
 * - `addable`: Add to library.
 */
export type FoundRowKind = 'in_library' | 'masks' | 'plugin' | 'addable';

export function foundRowKind(item: FoundItem): FoundRowKind {
  if (item.inLibrary !== null) return 'in_library';
  if (item.pluginOwned !== null) return 'plugin';
  if (item.masksLibrary) return 'masks';
  return 'addable';
}

/**
 * Masked names first, because they need a decision; every other row keeps the scan's order, so a row
 * that has just been added stays where it was and only its words change.
 */
export function orderFoundRows(items: readonly FoundItem[]): readonly FoundItem[] {
  return items
    .map((item, index) => ({ item, index, first: foundRowKind(item) === 'masks' ? 0 : 1 }))
    .sort((a, b) => a.first - b.first || a.index - b.index)
    .map((entry) => entry.item);
}

/** "Add all N": the rows that offer Add to library, never plugin-owned, masked or held ones. */
export function foundAddAllItems(items: readonly FoundItem[]): readonly FoundItem[] {
  return items.filter((item) => foundRowKind(item) === 'addable');
}

/** The agents that read a skill, as names in order, de-duplicated. */
export function foundAgentIds(item: FoundItem): readonly string[] {
  return [...new Set(item.agents)];
}

/** One skill name on one machine: its row, the agents that read any copy and the folders the copies live in. */
export type FoundRowGroup = Readonly<{
  item: FoundItem;
  agents: readonly string[];
  /** The folder each copy sits in (the skill's parent directory), in scan order, once each. */
  folders: readonly string[];
}>;

/**
 * One row per skill name: the same skill kept in several agents' folders is one thing to add or compare, so its other
 * copies fold into the first one given (callers order first, so a name that needs a decision leads its group).
 */
export function groupFoundRowsByName(items: readonly FoundItem[]): readonly FoundRowGroup[] {
  const groups = new Map<string, { item: FoundItem; agents: Set<string>; folders: Set<string> }>();
  for (const item of items) {
    const group = groups.get(item.name) ?? { item, agents: new Set<string>(), folders: new Set<string>() };
    for (const agent of item.agents) group.agents.add(agent);
    group.folders.add(item.path.replace(/[\\/][^\\/]*[\\/]*$/, ''));
    groups.set(item.name, group);
  }
  return [...groups.values()].map((group) => ({ item: group.item, agents: [...group.agents], folders: [...group.folders] }));
}

export type FoundHomeRow = Readonly<{ machineId: string; item: FoundItem }>;

/**
 * The homepage's "Found on your machines" rows (P6 §4.2, lab hs A2): a few skills from the last known
 * results that can simply be added (held, plugin and same-name rows need the Found page), each name
 * once, machines that can answer first so Add works. `room` is the block's size, not a cap on what
 * exists: "See all" opens every row.
 */
export function pickFoundHomeRows(
  machines: readonly Readonly<{ machineId: string; offline: boolean }>[],
  results: Readonly<Record<string, Readonly<{ items: readonly FoundItem[] }> | null>>,
  room: number,
): readonly FoundHomeRow[] {
  const ordered = [...machines].sort((a, b) => Number(a.offline) - Number(b.offline));
  const rows: FoundHomeRow[] = [];
  if (room <= 0) return rows;
  for (const row of foundSkillsByName(ordered.map(machine => machine.machineId), results, item => foundRowKind(item) === 'addable')) {
    rows.push(row);
    if (rows.length >= room) break;
  }
  return rows;
}

/**
 * Library skill names a machine's own same-name copy wins over (`masksLibrary`), from the last known
 * results, each with the first machine (by the given order) where that happens.
 */
export function maskedLibraryNames(
  machines: readonly Readonly<{ machineId: string; name: string | null }>[],
  results: Readonly<Record<string, Readonly<{ items: readonly FoundItem[] }> | null>>,
): ReadonlyMap<string, string> {
  const masked = new Map<string, string>();
  for (const machine of machines) {
    for (const item of results[machine.machineId]?.items ?? []) {
      if (item.masksLibrary && !masked.has(item.name)) masked.set(item.name, machine.name ?? machine.machineId);
    }
  }
  return masked;
}
