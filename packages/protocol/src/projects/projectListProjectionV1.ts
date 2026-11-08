import type { ProjectAccountOrganizationV1, ProjectAccountRowKeyV1 } from './projectAccountRowsV1.js';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '../workspaces/workspaceRefV1.js';
import { projectWorkspaceRefV1, workspaceAddressFromRefV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';

export type ProjectListOrganizationV1 = Readonly<{
  key: Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>;
  value: ProjectAccountOrganizationV1;
}>;
export type ProjectListGroupV1 = Readonly<{
  projectKey: QualifiedProjectKeyV1;
  hidden: boolean;
  pinned: boolean;
  /**
   * The person added this Project (owner 11-08): its organization row decides (Add/Show = `projects.visibility.set
   * {hidden:false}`); without one, a Project the person opened or set up from a Source stays listed. A folder that
   * only a Session brought waits in "From your sessions".
   */
  listed: boolean;
  items: readonly WorkspaceRefV1[];
}>;

/**
 * Every Project key a Project's Sessions, memory and usage may carry: its anchor plus each member's own id. A
 * checkout keeps the key it was stamped with when it joins or leaves a Project; the set, not a rewrite, follows it.
 */
export function projectScopeKeysV1(group: Pick<ProjectListGroupV1, 'projectKey' | 'items'>): ReadonlySet<string> {
  return new Set([group.projectKey.projectKey, ...group.items.map(ref => ref.id)]);
}

/** Stable across hydration order; comparing paths does not change their stored spelling. */
export function compareProjectWorkspaceRefsV1(a: WorkspaceRefV1, b: WorkspaceRefV1): number {
  return (b.lastOpenedAtMs ?? -1) - (a.lastOpenedAtMs ?? -1)
    || b.createdAtMs - a.createdAtMs || a.rootPath.localeCompare(b.rootPath) || a.id.localeCompare(b.id);
}

/**
 * UI and CLI group by each checkout's accepted anchor. Upstream grouping is materialized into that anchor when a
 * checkout is accepted or first learns its repository (`resolveWorkspaceProjectKeyV1`), never guessed here from
 * folder names or remotes.
 */
export function projectProjectListV1(input: Readonly<{
  serverId: string; workspaceRefs: readonly WorkspaceRefV1[];
  organizations?: readonly ProjectListOrganizationV1[];
  normalizeServerId?: (id: string) => string;
  includeHidden?: boolean; machineId?: string; limit?: number;
  /** `listed`: only Projects the person added (the Projects list, `projects.list`); `all` (default): every visible one. */
  listing?: 'listed' | 'all';
  coverage?: 'complete' | 'partial' | 'unknown';
}>) {
  const normalize = input.normalizeServerId ?? ((id: string) => id.trim());
  const home = normalize(input.serverId);
  const organizations = new Map((input.organizations ?? []).filter(row => normalize(row.key.serverId) === home)
    .map(row => [row.key.projectKey, row.value]));
  const refsByProject = new Map<string, WorkspaceRefV1[]>();
  const lastOpenedByProject = new Map<string, number>();
  for (const ref of input.workspaceRefs) {
    if (normalize(ref.serverId) !== home) continue;
    const anchor = projectWorkspaceRefV1(ref).projectKey;
    lastOpenedByProject.set(anchor, Math.max(lastOpenedByProject.get(anchor) ?? -1, ref.lastOpenedAtMs ?? -1));
    const refs = refsByProject.get(anchor);
    if (refs) refs.push(ref); else refsByProject.set(anchor, [ref]);
  }
  const groups: ProjectListGroupV1[] = [...refsByProject].map(([anchor, refs]) => {
    const organization = organizations.get(anchor);
    return {
      projectKey: { serverId: input.serverId, projectKey: anchor },
      hidden: organization?.hidden === true, pinned: organization?.pinned === true,
      listed: organization ? organization.hidden !== true : refs.some(ref => ref.lastOpenedAtMs != null || ref.source !== undefined),
      items: refs.sort((a, b) => a.machineId.localeCompare(b.machineId) || compareProjectWorkspaceRefsV1(a, b)),
    };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || (lastOpenedByProject.get(b.projectKey.projectKey) ?? -1) - (lastOpenedByProject.get(a.projectKey.projectKey) ?? -1)
    || a.projectKey.projectKey.localeCompare(b.projectKey.projectKey));
  const projectGroups = groups.filter(group => !group.hidden);
  const hiddenProjectGroups = groups.filter(group => group.hidden);
  const listedProjectGroups = projectGroups.filter(group => group.listed);
  const newestMember = (group: ProjectListGroupV1) => Math.max(...group.items.map(ref => ref.createdAtMs));
  const unlistedProjectGroups = projectGroups.filter(group => !group.listed)
    .sort((a, b) => newestMember(b) - newestMember(a) || a.projectKey.projectKey.localeCompare(b.projectKey.projectKey));
  const leaves = (input.includeHidden === true ? groups : projectGroups)
    .filter(group => input.listing !== 'listed' || group.listed || group.hidden).flatMap(group => group.items
    .filter(ref => input.machineId === undefined || ref.machineId === input.machineId)
    .map(ref => ({ ref, project: group.projectKey, projectKey: { serverId: ref.serverId, id: ref.id },
      workspaceAddress: workspaceAddressFromRefV1(ref), hidden: group.hidden, pinned: group.pinned, listed: group.listed })));
  const items = input.limit === undefined ? leaves : leaves.slice(0, input.limit);
  const truncated = items.length < leaves.length || (input.coverage ?? 'complete') !== 'complete';
  return { projectGroups, hiddenProjectGroups, listedProjectGroups, unlistedProjectGroups, items, truncated,
    coverage: truncated ? input.coverage === 'unknown' ? 'unknown' as const : 'partial' as const : 'complete' as const };
}

/** Context follows the accepted qualified Project anchor; competing Sources cannot select a writer. */
export function resolveProjectContextSourceV1(input: Readonly<{
  projectRef: QualifiedProjectKeyV1; workspaceRefs: readonly WorkspaceRefV1[]; organizationPresent: boolean;
}>): Readonly<{ kind: 'personal' } | { kind: 'source'; sourceId: string } | { kind: 'unavailable' }> {
  const target = QualifiedProjectKeyV1Schema.safeParse(input.projectRef);
  if (!target.success) return { kind: 'unavailable' };
  const projection = projectProjectListV1({ serverId: target.data.serverId, workspaceRefs: input.workspaceRefs });
  const group = [...projection.projectGroups, ...projection.hiddenProjectGroups]
    .find(candidate => candidate.projectKey.projectKey === target.data.projectKey);
  if (!group && !input.organizationPresent) return { kind: 'unavailable' };
  const sources = new Set((group?.items ?? []).flatMap(ref => ref.source ? [ref.source.sourceId] : []));
  if (sources.size > 1) return { kind: 'unavailable' };
  const sourceId = sources.values().next().value;
  return sourceId === undefined ? { kind: 'personal' } : { kind: 'source', sourceId };
}
