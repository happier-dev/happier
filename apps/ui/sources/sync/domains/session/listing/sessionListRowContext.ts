import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionListIdentityDisplay } from '@happier-dev/protocol/account/settings/accountSettings';

export type SessionListRowContextFacts = Readonly<{
    /** The canonical Home identity already admitted by the list projection. */
    serverId: string | null;
    project: QualifiedProjectKeyV1 | null;
    /** Existing exact fallback group identity, not a private Project association. */
    fallbackGroupKey?: string | null;
    machineId: string | null;
    workspaceId: string | null;
    path: string | null;
    branch?: string | null;
}>;

/** Only facts the visible lead can establish for a nested row. */
export type SessionListRowParentContextFacts = Readonly<Pick<SessionListRowContextFacts,
    'serverId' | 'project' | 'fallbackGroupKey' | 'machineId' | 'workspaceId'>>;

export function areSessionListRowParentContextsEqual(
    left: SessionListRowParentContextFacts | null | undefined,
    right: SessionListRowParentContextFacts | null | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right) return !left && !right;
    return left.serverId === right.serverId
        && left.project?.serverId === right.project?.serverId
        && left.project?.projectKey === right.project?.projectKey
        && (left.fallbackGroupKey ?? null) === (right.fallbackGroupKey ?? null)
        && left.machineId === right.machineId && left.workspaceId === right.workspaceId;
}

function sameProject(left: QualifiedProjectKeyV1 | null | undefined, right: QualifiedProjectKeyV1 | null | undefined): boolean {
    return Boolean(left && right && left.serverId === right.serverId && left.projectKey === right.projectKey);
}

function home(facts: SessionListRowParentContextFacts): string | null {
    return facts.project?.serverId ?? facts.serverId;
}

function sameMachine(left: SessionListRowContextFacts, right: SessionListRowParentContextFacts | null | undefined): boolean {
    return Boolean(right && home(left) && home(left) === home(right)
        && left.machineId && left.machineId === right.machineId);
}

/** Context facts stay available to accessible labels even when visual context is disabled. */
export function resolveSessionListRowContext(input: Readonly<{
    facts: SessionListRowContextFacts;
    groupProject?: QualifiedProjectKeyV1 | null;
    groupFallbackKey?: string | null;
    /** The shared display index's accepted baseline for groupProject, never an elected candidate. */
    baseline?: WorkspaceRefV1 | null;
    parent?: SessionListRowParentContextFacts | null;
    enabled?: boolean;
    identityDisplay?: SessionListIdentityDisplay;
    hasProjectFavicon?: boolean;
}>): Readonly<{ facts: SessionListRowContextFacts; showProject: boolean; showCheckout: boolean;
    identity: Readonly<{ leadingMark: 'agent' | 'project' | 'projectWithAgent' | 'avatar' | 'none';
        projectPlacement: 'none' | 'context' | 'trailing'; showProjectName: boolean }> }> {
    const { facts, baseline, parent } = input;
    const inAcceptedProject = sameProject(facts.project, input.groupProject);
    const inOwnProject = inAcceptedProject || Boolean(!facts.project && facts.fallbackGroupKey
        && facts.fallbackGroupKey === input.groupFallbackKey);
    const parentProject = sameProject(facts.project, parent?.project) || Boolean(!facts.project && !parent?.project
        && facts.fallbackGroupKey && facts.fallbackGroupKey === parent?.fallbackGroupKey);
    const hasProjectContext = Boolean(facts.project || facts.fallbackGroupKey);
    const projectOutside = hasProjectContext && !inOwnProject && !parentProject;
    const baselineMachine = Boolean(inAcceptedProject && baseline
        && facts.machineId && facts.machineId === baseline.machineId);
    const parentMachine = sameMachine(facts, parent);
    // Only an admitted checkout id proves the default. Unknown ids and matching-looking paths
    // cannot silently establish equality (including sandbox paths and identical folder names).
    const baselineCheckout = Boolean(baselineMachine && facts.workspaceId && facts.workspaceId === baseline?.id);
    const parentProjectsConflict = Boolean(hasProjectContext && (parent?.project || parent?.fallbackGroupKey) && !parentProject);
    const parentCheckout = Boolean(!parentProjectsConflict && parentMachine && facts.workspaceId && facts.workspaceId === parent?.workspaceId);
    const enabled = input.enabled !== false;
    const display = input.identityDisplay;
    let leadingMark: 'agent' | 'project' | 'projectWithAgent' | 'avatar' | 'none';
    let projectPlacement: 'none' | 'context' | 'trailing' = 'none';
    let showProjectName = false;
    switch (display) {
        case 'avatar':
        case 'none':
        case 'agentLogo':
            leadingMark = display === 'agentLogo' ? 'agent' : display;
            if (projectOutside && enabled) {
                projectPlacement = 'context';
                showProjectName = true;
            }
            break;
        case 'agentWithTrailingProject':
            leadingMark = 'agent';
            if (projectOutside) {
                projectPlacement = 'trailing';
                showProjectName = enabled && input.hasProjectFavicon !== true;
            }
            break;
        case 'project':
        case 'projectWithAgent':
            leadingMark = display;
            break;
        default:
            leadingMark = projectOutside ? 'projectWithAgent' : 'agent';
    }
    if (projectOutside && enabled && input.hasProjectFavicon !== true
        && (leadingMark === 'project' || leadingMark === 'projectWithAgent')) {
        projectPlacement = 'context';
        showProjectName = true;
    }
    return { facts,
        showProject: enabled && projectOutside,
        showCheckout: enabled && !baselineCheckout && !parentCheckout,
        identity: { leadingMark, projectPlacement, showProjectName } };
}
