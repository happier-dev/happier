import type { PromptFoldersV1 } from '@happier-dev/protocol';
import { isReadOnlySkillProvenanceV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { resolveSkillPlanKindV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { getAgentCore, isBundledAgentId } from '@happier-dev/agents';

import type { HomeOrbitBody } from '@/components/atmosphere/orbit/homeOrbitScene';
import {
  projectReachOnMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';

import { t } from '@/text';
import { groupRowsByFolder } from '@/components/settings/prompts/collection/promptCollectionModel';

import { isSkillOff } from './status/skillStatus';

export const SKILLS_COLLECTION_ROUTE = '/settings/skills';
export const SKILLS_NEW_ROUTE = '/settings/skills/new';
export const skillHref = (skillId: string) =>
  `${SKILLS_COLLECTION_ROUTE}/${encodeURIComponent(skillId)}`;

/**
 * A skill is shown by its name. A skill whose content could not be read carries its id where the name
 * would be, and a full id is not a name a person can read in a sentence, so it is shown as "Skill" plus
 * the id's first block, which still tells two unreadable skills apart.
 */
export function skillDisplayName(name: string | null | undefined, skillId: string): string {
  return name && name !== skillId ? name : t('capabilities.skills.home.byId', { id: skillId.split('-')[0] });
}

/** The collection offers a search field only once it no longer fits at a glance (the Machines rule). */
export const SKILLS_SEARCH_THRESHOLD = 8;

export { skillSource } from './skillSource';

/** Publisher verification is distinct from the content pin Happier computes for every index item. */
export function skillSourceVerification(item: Pick<SkillListItemV1, 'provenance'>): string | undefined {
  const provenance = item.provenance;
  const ref = provenance.kind === 'wellKnown' ? provenance
    : provenance.kind === 'registry' ? provenance.registry.ref
      : provenance.kind === 'link' ? provenance.ref : null;
  return ref?.kind === 'wellKnown'
    ? t(ref.publishedDigest ? 'capabilities.skillDetail.source.verifiedByDigest' : 'capabilities.skillDetail.source.noDigestPublished')
    : undefined;
}

export type SkillsRailGroups = Readonly<{
  inUse: readonly SkillListItemV1[];
  off: readonly SkillListItemV1[];
}>;

/** In use / Off by the item's rules (D4: no rule turning it on = Off); library order within each. */
export function groupSkillsByUse(
  items: readonly SkillListItemV1[],
): SkillsRailGroups {
  const inUse: SkillListItemV1[] = [];
  const off: SkillListItemV1[] = [];
  for (const item of items) (isSkillOff(item) ? off : inUse).push(item);
  return { inUse, off };
}

/**
 * Folder groups (IR-83): when any skill is filed in a folder the personal folder tree knows, the list
 * groups by folder through the library's one grouping rule (shared with the prompt collection), and
 * Off rows stay in place with their "Off" summary. `null` when no skill has a folder: In use / Off stand.
 * Unknown folder names do not unfile retained items; a received tree can confirm a folder's deletion.
 */
export function groupSkillsByFolder(
  items: readonly SkillListItemV1[],
  folders: PromptFoldersV1 | null | undefined,
): readonly Readonly<{ id: string | null; title: string | null; rows: readonly SkillListItemV1[] }>[] | null {
  const names = new Map((folders?.folders ?? []).map((folder) => [folder.id, folder.name]));
  const filed = (item: SkillListItemV1) =>
    item.folderId !== null && (folders == null || names.has(item.folderId)) ? item.folderId : null;
  if (!items.some((item) => filed(item) !== null)) return null;
  return groupRowsByFolder(
    items.map((item) => {
      const id = filed(item);
      return { folder: id === null ? null : { id, title: names.get(id) ?? t('common.unavailable') }, row: item };
    }),
  );
}

/** Does any Agent on this machine get the skill (machine level, no project)? */
export function skillReachesMachine(
  item: SkillListItemV1,
  machine: ReachMachine,
): boolean {
  return (
    projectReachOnMachines(item.rules, [machine], undefined, [], { skillId: item.skillId, isFeatureEnabled: () => true })[0]?.agents.some(
      (agent) => agent.enabled && skillPlanOnMachine(machine, agent.agentId) !== 'none',
    ) ?? false
  );
}

export function filterSkills(
  items: readonly SkillListItemV1[],
  input: Readonly<{ query: string; machine: ReachMachine | null }>,
): readonly SkillListItemV1[] {
  const query = input.query.trim().toLowerCase();
  if (!query && !input.machine) return items;
  return items.filter(
    (item) =>
      (!query ||
        `${item.name} ${item.description ?? ''}`
          .toLowerCase()
          .includes(query)) &&
      (!input.machine || skillReachesMachine(item, input.machine)),
  );
}

export type SkillsReachMachine = Readonly<{
  machine: ReachMachine;
  /** Skills that reach at least one Agent on it (last known for an offline machine). */
  skillIds: readonly string[];
  /** The Agents on it that get at least one skill. */
  agentIds: readonly string[];
  /** Its installed Agents that can take skills at all (P3 plan kind not `none`): the legend's words. */
  supportedAgentIds: readonly string[];
}>;

export type SkillsReach = Readonly<{
  machines: readonly SkillsReachMachine[];
  bodies: readonly HomeOrbitBody[];
  /** Skills that reach at least one online machine. */
  reachingCount: number;
  /** Agents that get at least one skill on an online machine, in first-seen order. */
  agentIds: readonly string[];
  onlineReachedMachineCount: number;
  offlineMachineIds: readonly string[];
  /** Installed Agents on online machines that take skills on none of them (named once, in a note). */
  unsupportedAgentIds: readonly string[];
  /** Whether any online machine has said which Agents it has. */
  onlineInventory: boolean;
}>;

/**
 * The homepage's reach facts from P2's projection, one body per Account machine and one dot per skill
 * reaching an Agent there whose per-Machine declaration permits P3 delivery. A cold bundled catalog
 * can use its generated manifest facts; an unknown external Agent never counts as reached.
 */
/**
 * The legend's count for one machine: how many skills reach its known Agents (last known when offline).
 * A roster still being completed (an Agent added through a plugin not yet described) keeps the count of
 * the Agents already known, as the Where sentence does; only a machine with no known Agent is unknown.
 * A first visit has decided nothing yet, so every machine reads 0.
 */
export function skillsReachLegendCount(row: SkillsReachMachine, firstVisit: boolean): number | null {
  if (firstVisit) return 0;
  if (row.machine.agentInventoryComplete === false && row.machine.agentIds.length === 0) return null;
  return row.skillIds.length;
}

export function buildSkillsReach(
  items: readonly SkillListItemV1[],
  machines: readonly ReachMachine[],
): SkillsReach {
  const reached = new Set<string>();
  const agents: string[] = [];
  let onlineReachedMachineCount = 0;
  const rows = machines.map((machine): SkillsReachMachine => {
    const skillIds: string[] = [];
    const machineAgents = new Set<string>();
    for (const item of items) {
      const row = projectReachOnMachines(item.rules, [machine], undefined, [], { skillId: item.skillId, isFeatureEnabled: () => true })[0];
      const enabled = row?.agents.filter((agent) => agent.enabled && skillPlanOnMachine(machine, agent.agentId) !== 'none') ?? [];
      if (enabled.length === 0) continue;
      skillIds.push(item.skillId);
      for (const agent of enabled) machineAgents.add(agent.agentId);
    }
    if (machine.online === true && skillIds.length > 0) {
      onlineReachedMachineCount += 1;
      for (const id of skillIds) reached.add(id);
      for (const agentId of machineAgents)
        if (!agents.includes(agentId)) agents.push(agentId);
    }
    return {
      machine,
      skillIds,
      agentIds: [...machineAgents],
      supportedAgentIds: machine.agentIds.filter(
        (agentId) => skillPlanOnMachine(machine, agentId) !== 'none',
      ),
    };
  });
  const supportedOnline = new Set<string>();
  const unsupported: string[] = [];
  for (const row of rows) {
    if (row.machine.online !== true) continue;
    for (const agentId of row.supportedAgentIds) supportedOnline.add(agentId);
  }
  for (const row of rows) {
    if (row.machine.online !== true) continue;
    for (const agentId of row.machine.agentIds)
      if (!supportedOnline.has(agentId) && !unsupported.includes(agentId))
        unsupported.push(agentId);
  }
  // Inner orbits and the first legend rows go to what matters now (as Your Home ranks them): online
  // machines a skill reaches, then the other online ones, then offline ones, most recently seen first.
  // Each group keeps the store's order.
  // Offline machines a skill reaches (they catch up) come before offline ones it never reached.
  const rank = (row: SkillsReachMachine) =>
    (row.machine.online === true ? 0 : 2) + (row.skillIds.length > 0 ? 0 : 1);
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.machine.offline
        ? (b.machine.lastSeenAt ?? 0) - (a.machine.lastSeenAt ?? 0)
        : 0),
  );
  return {
    machines: rows,
    bodies: rows.map((row) => ({
      key: row.machine.machineId,
      online: row.machine.online === true,
      dots: row.skillIds.map((skillId) => ({
        key: skillId,
        tone: row.machine.online === true ? 'active' : 'quiet',
      })),
    })),
    reachingCount: reached.size,
    agentIds: agents,
    onlineReachedMachineCount,
    offlineMachineIds: rows
      .filter((row) => row.machine.offline)
      .map((row) => row.machine.machineId),
    unsupportedAgentIds: unsupported,
    onlineInventory: rows.some(
      (row) => row.machine.online === true && row.machine.agentIds.length > 0,
    ),
  };
}

/**
 * The homepage's present sentence, as one decision (P6 §4.2): the first-visit moment, no machine yet,
 * skills on but no online machine has said which Agents it has (the inventory wait), skills on but
 * every Agent there takes none (unsupported delivery, IR-80), or what reaches whom with what needs a
 * look and which offline machines catch up.
 */
export type SkillsPresent =
  | Readonly<{ kind: 'new' }>
  | Readonly<{ kind: 'first'; on: number; off: number }>
  | Readonly<{ kind: 'noMachines' }>
  | Readonly<{ kind: 'waiting'; on: number }>
  | Readonly<{ kind: 'unsupported'; on: number; agentIds: readonly string[] }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'reach';
      count: number;
      agentIds: readonly string[];
      machines: number;
      needs: number;
      unsupportedAgentIds: readonly string[];
      /** Offline machines a skill reaches, by name: they catch up when they're back. */
      catchUp: readonly string[];
    }>;

/**
 * Whether the person has a skill of their own. The canonical list always carries the built-in skill
 * (P6 §4.1), and plugins add theirs; neither makes a library non-empty: an Account with only those is a
 * brand-new library.
 */
export function hasOwnSkills(items: readonly SkillListItemV1[]): boolean {
  return items.some((item) => !isReadOnlySkillProvenanceV1(item.provenance));
}

export function resolveSkillsPresent(
  input: Readonly<{
    items: readonly SkillListItemV1[];
    reach: SkillsReach;
    needs: number;
    firstVisit: Readonly<{ on: number; off: number }> | null;
  }>,
): SkillsPresent {
  const { reach } = input;
  if (!hasOwnSkills(input.items)) return { kind: 'new' };
  if (input.firstVisit) return { kind: 'first', ...input.firstVisit };
  if (reach.machines.length === 0) return { kind: 'noMachines' };
  const on = input.items.filter((item) => !isSkillOff(item)).length;
  if (reach.reachingCount === 0) {
    if (on === 0) return { kind: 'none' };
    if (!reach.onlineInventory) return { kind: 'waiting', on };
    if (reach.unsupportedAgentIds.length > 0 && reach.machines.every(
      (row) => row.machine.online !== true || row.supportedAgentIds.length === 0,
    ))
      return { kind: 'unsupported', on, agentIds: reach.unsupportedAgentIds };
    return { kind: 'none' };
  }
  return {
    kind: 'reach',
    count: reach.reachingCount,
    agentIds: reach.agentIds,
    machines: reach.onlineReachedMachineCount,
    needs: input.needs,
    unsupportedAgentIds: reach.unsupportedAgentIds,
    catchUp: reach.machines
      .filter((row) => row.machine.offline && row.skillIds.length > 0)
      .map((row) => row.machine.name ?? row.machine.machineId),
  };
}

/** P3 owns the decision; this join supplies declarations, never installation or launch-readiness guesses. */
/** What an Agent on this machine does with skills (P3 plan kind): `none` never takes one. */
export function skillPlanOnMachine(machine: ReachMachine, agentId: string) {
  if (machine.agentDeclarationsById) {
    const capabilities = machine.agentDeclarationsById[agentId]?.capabilities;
    return resolveSkillPlanKindV1({ agentSkills: capabilities?.skills ?? null,
      agentHasActionChannel: capabilities?.tools !== undefined });
  }
  const bundled = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
  const skills = bundled?.skills;
  return resolveSkillPlanKindV1({ agentSkills: skills ? {
    delivery: skills.delivery, nativeDisable: skills.nativeDisable, liveReload: skills.liveReload,
  } : null, agentHasActionChannel: bundled?.tools.delivery !== undefined && bundled.tools.delivery !== 'unsupported' });
}

/**
 * The machines the map and its legend draw, in rank order: as many as the room holds; past it, the
 * last slot becomes one quiet "N more machines" line (layout density, not a limit: the rail's
 * `?machine=` filter and Settings → Machines still reach every one).
 */
export function foldReachMachines(
  machines: readonly SkillsReachMachine[],
  room: number,
): Readonly<{ shown: readonly SkillsReachMachine[]; more: number }> {
  if (machines.length <= room) return { shown: machines, more: 0 };
  const shown = machines.slice(0, Math.max(1, room - 1));
  return { shown, more: machines.length - shown.length };
}

/**
 * The first-visit moment (P6 §4.7): the library has skills with no rule at all and the Account's reach
 * is still the undecided default. The first-run owner also honors this device's dismissal.
 */
export { resolveSkillsFirstVisit } from './firstRun/firstRunEligibility';
