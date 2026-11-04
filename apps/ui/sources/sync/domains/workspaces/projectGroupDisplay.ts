import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1, resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ProjectOrganizationRow } from './projectAccountRows';

export function projectGroupIdentityKey(project: QualifiedProjectKeyV1): string {
    return JSON.stringify(['project', resolveServerProfileScopeIdForIdentifier(project.serverId) || project.serverId, project.projectKey]);
}

export function readProjectGroupIdentityKey(value: string): QualifiedProjectKeyV1 | null {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return null; }
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 'project'
        || typeof parsed[1] !== 'string' || !parsed[1] || typeof parsed[2] !== 'string' || !parsed[2]) return null;
    return { serverId: parsed[1], projectKey: parsed[2] };
}

export type ProjectGroupDisplay = Readonly<{
    project: QualifiedProjectKeyV1;
    baseline: WorkspaceRefV1 | null;
    title: string | null;
    hasCustomLabel: boolean;
}>;

/** Admitted exact-group display only: this does not associate a Session with a private Project. */
export type SessionListFallbackGroupDisplay = Readonly<{ groupKey: string; title: string }>;

/** Header visibility cannot own the row's name. A published Project key always takes precedence. */
export function readSessionListProjectDisplay(
    item: Readonly<{ projectKey?: QualifiedProjectKeyV1; fallbackGroupDisplay?: SessionListFallbackGroupDisplay }>,
    projectDisplayByKey: ReadonlyMap<string, ProjectGroupDisplay>,
): Readonly<{ title: string | null; baseline?: WorkspaceRefV1 | null }> | undefined {
    return item.projectKey ? projectDisplayByKey.get(projectGroupIdentityKey(item.projectKey)) : item.fallbackGroupDisplay;
}

/** The baseline election: the oldest admitted ref, then the lowest id. Reachability, order and activity never elect. */
function isEarlierBaseline(candidate: WorkspaceRefV1, current: WorkspaceRefV1): boolean {
    return candidate.createdAtMs < current.createdAtMs
        || candidate.createdAtMs === current.createdAtMs && candidate.id.localeCompare(current.id) < 0;
}

/** One Project's baseline by the index's election, without building the whole index (Space marks). */
export function readProjectBaselineRef(workspaceRefs: readonly WorkspaceRefV1[], project: QualifiedProjectKeyV1): WorkspaceRefV1 | null {
    const key = projectGroupIdentityKey(project);
    let baseline: WorkspaceRefV1 | null = null;
    for (const ref of workspaceRefs) {
        if (projectGroupIdentityKey(projectWorkspaceRefV1(ref)) !== key) continue;
        if (!baseline || isEarlierBaseline(ref, baseline)) baseline = ref;
    }
    return baseline;
}

/** One admitted-ref pass; reachability, list order and activity never elect the baseline. */
export function buildProjectGroupDisplayIndex(
    workspaceRefs: readonly WorkspaceRefV1[],
    organizations: readonly ProjectOrganizationRow[] = [],
): ReadonlyMap<string, ProjectGroupDisplay> {
    const result = new Map<string, ProjectGroupDisplay>();
    for (const ref of workspaceRefs) {
        const project = projectWorkspaceRefV1(ref);
        const key = projectGroupIdentityKey(project);
        const previous = result.get(key)?.baseline;
        if (previous && !isEarlierBaseline(ref, previous)) continue;
        result.set(key, { project, baseline: ref, title: ref.label ?? resolveWorkspacePathBasenameV1(ref.rootPath), hasCustomLabel: false });
    }
    for (const row of organizations) {
        const project = { serverId: row.key.serverId, projectKey: row.key.projectKey };
        const key = projectGroupIdentityKey(project);
        const previous = result.get(key);
        result.set(key, { project, baseline: previous?.baseline ?? null, title: row.value.label ?? previous?.title ?? null,
            hasCustomLabel: row.value.label !== undefined });
    }
    return result;
}
