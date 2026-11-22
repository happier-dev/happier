import type { UsageAnalyticsBreakdownDimension, UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';
import type { ProjectListGroupV1, ProjectListOrganizationV1 } from '../projects/projectListProjectionV1.js';
import { resolveWorkspacePathBasenameV1 } from '../workspaces/workspaceRefResolutionV1.js';

export type UsageScopeFilterField = 'sources' | 'agents' | 'machines' | 'projects';
export const usageScopeFilterDimensions = {
  sources: 'source', agents: 'agent', machines: 'machine', projects: 'project',
} as const satisfies Readonly<Record<UsageScopeFilterField, UsageAnalyticsBreakdownDimension>>;

/** Reused results keep the same scope metadata and dimension order as a direct query. */
export function selectUsageScopeKeys(inventory: UsageAnalyticsQueryResponse['scopeKeys'],
  dimensions: readonly UsageAnalyticsBreakdownDimension[] | undefined): UsageAnalyticsQueryResponse['scopeKeys'] {
  const selected = (dimensions ?? []).flatMap(dimension => {
    const entry = inventory?.find(row => row.dimension === dimension);
    return entry ? [entry] : [];
  });
  return selected.length ? selected : undefined;
}

/** Engine timeline keys carry the Agent id before an optional backend mode. */
export function agentIdFromEngineKey(key: string): string {
  const separator = key.indexOf(':');
  return separator === -1 ? key : key.slice(0, separator);
}

type UsageProjectOptionFact = Readonly<{
  label?: string | null;
  checkoutPathLabel?: string;
  rootPath?: string;
  machineIds?: readonly string[];
}>;
export type UsageProjectOptionFacts = ReadonlyMap<string, UsageProjectOptionFact>;

export const usageUnnamedProjectTitle = { label: 'No project name', labelKey: 'usage.board.work.unknownProject' } as const;

/** Opened Account content may name a Project or supply a checkout place. It never adds filter membership. */
export function projectUsageOptionFacts(groups: readonly ProjectListGroupV1[],
  organizations: readonly ProjectListOrganizationV1[]): UsageProjectOptionFacts {
  const facts = new Map<string, UsageProjectOptionFact>(organizations.map(({ key, value }) =>
    [key.projectKey, { label: value.label, rootPath: value.nativeUsageRootPath }]));
  for (const group of groups) {
    const ref = group.items[0];
    if (!ref) continue;
    const key = group.projectKey.projectKey;
    facts.set(key, { label: facts.get(key)?.label ?? (ref.label?.trim() || undefined),
      checkoutPathLabel: resolveWorkspacePathBasenameV1(ref.rootPath) || ref.rootPath,
      rootPath: ref.rootPath,
      machineIds: [...new Set(group.items.flatMap(ref => ref.machineId ? [ref.machineId] : []))] });
  }
  return facts;
}

function hasUsageProjectOptionName(key: string, label: string): boolean {
  return key !== 'unknown' && Boolean(label && label !== key && !/^[a-f\d]{32,}$/i.test(label));
}

export function readUsageProjectScopeMachines(slices: readonly UsageQueryResultSlice[], anchorOf?: (key: string) => string,
  projectFacts?: UsageProjectOptionFacts): ReadonlyMap<string, readonly string[]> {
  const machines = new Map<string, Set<string>>();
  const add = (rawKey: string, ids: Iterable<string>) => {
    const key = anchorOf?.(rawKey) ?? rawKey;
    let current = machines.get(key);
    if (!current) machines.set(key, current = new Set());
    for (const id of ids) current.add(id);
  };
  for (const slice of slices) {
    const projectMachines = slice.accounting?.scopeKeys?.find(row => row.dimension === 'project')?.projectMachines;
    if (projectMachines) {
      for (const { key, machineIds } of projectMachines) add(key, machineIds);
    } else {
      for (const row of slice.accounting?.contributions ?? []) {
        if (row.projectKey && row.machineId) add(row.projectKey, [row.machineId]);
      }
    }
  }
  for (const [key, fact] of projectFacts ?? []) {
    if (!machines.has(key) && fact.machineIds?.length) add(key, fact.machineIds);
  }
  return new Map([...machines].map(([key, ids]) => [key, [...ids]]));
}

type UsageProjectOptionNames = Readonly<{
  machineNames?: Readonly<Record<string, string>>;
  projectFacts?: UsageProjectOptionFacts;
  projectMachines?: ReturnType<typeof readUsageProjectScopeMachines>;
}>;

/** A null title is the toolbar's unnamed group. Its underlying accounting keys remain usable in Actions. */
export function readUsageProjectOptionTitles(slices: readonly UsageQueryResultSlice[], selected: readonly string[] = [],
  anchorOf?: (key: string) => string, options: UsageProjectOptionNames = {}): ReadonlyMap<string, string | null> {
  const labels = readUsageScopeLabels(slices, 'projects', selected, anchorOf);
  const titles = new Map<string, string | null>();
  const groups = new Map<string, string[]>();
  for (const [key, accountingLabel] of labels) {
    const fact = options.projectFacts?.get(key);
    const base = fact?.label ?? accountingLabel.trim();
    const fallback = fact?.label == null ? fact?.checkoutPathLabel ?? '' : '';
    const label = hasUsageProjectOptionName(key, base) ? base
      : hasUsageProjectOptionName(key, fallback) ? fallback : null;
    titles.set(key, label);
    if (label === null) continue;
    const keys = groups.get(label);
    if (keys) keys.push(key);
    else groups.set(label, [key]);
  }
  const machines = options.projectMachines ?? readUsageProjectScopeMachines(slices, anchorOf, options.projectFacts);
  const alternatives = new Map<string, string[]>();
  for (const [label, keys] of groups) {
    if (keys.length < 2) continue;
    const places = keys.map(key => {
      const ids = machines.get(key) ?? [];
      const names = ids.flatMap(id => options.machineNames?.[id] || []).sort();
      const machine = names.length > 0 && names.length === ids.length ? names.join(', ') : '';
      const path = options.projectFacts?.get(key)?.rootPath?.replace(/[\\/]+$/, '') ?? '';
      const parent = resolveWorkspacePathBasenameV1(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))));
      return { key, machine, path, parent };
    });
    const machineCounts = new Map<string, number>();
    const parentCounts = new Map<string | null, number>();
    for (const { machine, parent } of places) {
      machineCounts.set(machine, (machineCounts.get(machine) ?? 0) + 1);
      parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
    }
    for (const { key, machine, path, parent } of places) {
      const suffixes = [machineCounts.get(machine) === 1 ? machine : '',
        parent && parentCounts.get(parent) === 1 ? parent : '', path];
      const [place, ...fallbacks] = [...new Set(suffixes.filter(Boolean))];
      if (place) titles.set(key, `${label} · ${place}`);
      if (fallbacks.length) alternatives.set(key, fallbacks.map(place => `${label} · ${place}`));
    }
  }

  // A Machine name can match a folder name or a title in another group.
  while (alternatives.size > 0) {
    const counts = new Map<string, number>();
    for (const title of titles.values()) if (title !== null) counts.set(title, (counts.get(title) ?? 0) + 1);
    let advanced = false;
    for (const [key, remaining] of alternatives) {
      if (counts.get(titles.get(key)!) === 1) continue;
      titles.set(key, remaining.shift()!);
      if (!remaining.length) alternatives.delete(key);
      advanced = true;
    }
    if (!advanced) break;
  }
  return titles;
}

/**
 * Both ordinary inputs and the Usage toolbar consume the admitted accounting inventory. `anchorOf`
 * (`createProjectAnchorOfKeyV1`, owner 11-08) lists usage a checkout was stamped with under the Project it belongs to now.
 */
export function readUsageScopeOptions(slices: readonly UsageQueryResultSlice[], field: UsageScopeFilterField,
  selected: readonly string[] = [], anchorOf?: (key: string) => string,
  projectNames: UsageProjectOptionNames = {}): Map<string, string> {
  if (field === 'projects') return new Map(Array.from(readUsageProjectOptionTitles(slices, selected, anchorOf, projectNames),
    ([key, title]) => [key, title ?? usageUnnamedProjectTitle.label]));
  return readUsageScopeLabels(slices, field, selected);
}

function readUsageScopeLabels(slices: readonly UsageQueryResultSlice[], field: UsageScopeFilterField,
  selected: readonly string[], anchorOf?: (key: string) => string): Map<string, string> {
  const labels = new Map<string, string>();
  const optionKey = (key: string) => field === 'projects' && anchorOf ? anchorOf(key) : key;
  for (const slice of slices) {
    if (field === 'agents') for (const bucket of slice.accounting?.engineTimeline ?? []) for (const entry of bucket.leaders) {
      const agentId = agentIdFromEngineKey(entry.key);
      if (!labels.has(agentId)) labels.set(agentId, agentId);
    }
    for (const entry of slice.accounting?.breakdowns?.[usageScopeFilterDimensions[field]] ?? []) {
      const key = optionKey(entry.key);
      // A grouped Project keeps the label its anchor's own entry carries.
      labels.set(key, (key === entry.key ? entry.label : undefined) ?? labels.get(key) ?? entry.label ?? key);
    }
    // Ranked entries supply labels, not membership. The producer's complete
    // identities retain every member of a folded group below the chart cutoff.
    for (const inventory of slice.accounting?.scopeKeys ?? []) {
      if (inventory.dimension !== usageScopeFilterDimensions[field]) continue;
      for (const rawKey of inventory.keys) {
        const key = optionKey(rawKey);
        if (!labels.has(key)) labels.set(key, key);
      }
    }
    if (field === 'sources') for (const source of slice.accounting?.coverage?.sources ?? []) {
      if (!labels.has(source.source)) labels.set(source.source, source.source);
    }
    if (field === 'machines') for (const source of slice.accounting?.coverage?.sources ?? []) {
      if (source.machineId && !labels.has(source.machineId)) labels.set(source.machineId, source.machineId);
    }
  }
  for (const value of selected) {
    const key = optionKey(value);
    if (!labels.has(key)) labels.set(key, key);
  }
  return labels;
}
