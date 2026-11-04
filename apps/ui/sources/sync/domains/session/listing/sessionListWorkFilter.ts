import type { SessionListFilterV1} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionSpaceMembershipV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { matchSessionListFilterV1, readSessionListStartedByV1, sessionWorkFilterFields, SessionListStatusV1Schema, type SessionListFilterFactsV1, type SessionListFilterMatchV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { compileEntityListFilterV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { QualifiedSessionSectionV1 } from '@happier-dev/protocol/sessions/organization/folders';
import { projectSessionListFilterAfterHomeQueryV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterQueryV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceRefResolutionContextV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { getSessionStorageKind } from '../sessionStorageKind';
import { readSessionListRenderableOwnerMetadataView, readSessionListPresentationOwnerMetadata,
    type SessionListPresentationSource } from './sessionListRenderableSessionProjection';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { readSessionListRenderableSourceMetadata } from './sessionListRenderable';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readExternalSessionLink } from '../external/readExternalSessionLink';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';

const ALL_STARTERS: SessionListFilterV1['startedBy'] = ['you', 'triggers', 'agents'];
export type SessionListSpaceMembership = Readonly<{ filter: SessionListFilterV1; membership: SessionSpaceMembershipV1 }>;

function buildSessionListWorkStatusFacts(status: WorkStatusPresentation): Pick<SessionListFilterFactsV1, 'status' | 'workStatus'> {
    const admitted = SessionListStatusV1Schema.safeParse(status.state);
    return admitted.success ? { status: admitted.data, workStatus: { bucket: status.bucket, tone: status.tone } } : {};
}

export type SessionListRowFilterFactsOptions = Readonly<{
    /** Diagnostic field ids from the same predicate, only when its final result is unknown. */
    onUnavailable?: (fieldIds: readonly string[]) => void;
    presentationSource?: SessionListPresentationSource;
    nowMs: number;
    viewerAccountId?: string;
    workspaceRefs?: readonly WorkspaceRefV1[];
    /** Home whose currently opened Account admitted this private census. */
    workspaceRefsServerId?: string;
    sessionProjectKeyResolver?: WorkspaceRefResolutionContextV1['sessionProjectKeyResolver'];
    storageKind?: 'persisted' | 'direct';
    scopeMatches?: SessionListFilterFactsV1['scopeMatches'];
    underSessionMatches?: boolean;
    audiences?: SessionListFilterFactsV1['audiences'];
    tagIds?: readonly string[];
    attentionRequired?: boolean;
    section?: QualifiedSessionSectionV1 | null;
    /** Exact folderIds proven by this row's admitted structural query page. */
    querySectionIds?: readonly string[];
    /** List consumers avoid awareness work unless their selected facet demands it. */
    includeStatus?: boolean;
    includeAgent?: boolean;
    includeSource?: boolean;
}>;

/** Already authorized/opened row facts shared by the list, rule preview and Activity matching. */
export function buildSessionListRowFilterFacts(
    row: SessionListRenderableSession | Session | null,
    serverId: string,
    options: SessionListRowFilterFactsOptions,
): SessionListFilterFactsV1 {
    const hydrated = row !== null && 'agentState' in row;
    const source = options.presentationSource;
    const metadata = source ? source.metadata : row && !('metadataUnavailable' in row && row.metadataUnavailable)
        ? hydrated ? readSessionListRenderableSourceMetadata(row) : row.metadata : null;
    const ownerMetadata = source ? readSessionListPresentationOwnerMetadata(source) : metadata && row
        ? hydrated ? readSessionOwnerMetadataView(row) : readSessionListRenderableOwnerMetadataView(row) : null;
    const relevance = row?.viewer?.relevance;
    const follow = row?.viewer?.follow;
    const ownerAccountId = row?.ownerAccountId;
    const projectCensus = admitProjectWorkspaceCensusForSubject({
        subject: { kind: 'session', ownerAccountId, access: row?.access, accessLevel: row?.accessLevel },
        rowServerId: serverId, censusServerId: options.workspaceRefsServerId, viewerAccountId: options.viewerAccountId,
        workspaceRefs: options.workspaceRefs, sessionProjectKeyResolver: options.sessionProjectKeyResolver,
    });
    const agentTargetKey = (() => {
        if (options.includeAgent === false || !metadata || !row) return null;
        if ((!source || source.metadataFromRow) && !('agentState' in row)) return row.agentTargetKey ?? null;
        const target = resolveAgentExecutionTargetFromSessionMetadata(metadata,
            typeof metadata.flavor === 'string' ? metadata.flavor : null,
            readExternalSessionLink(ownerMetadata ?? row.metadata));
        return target ? buildBackendTargetKeyV2(target) : null;
    })();
    const scopeMatches = options.scopeMatches ?? {
        ...(relevance ? { my_work: relevance.relevant,
            involving_me: relevance.reasons.some(reason => reason === 'owned_by_me' || reason === 'responsible_for_me'
                || reason === 'shared_directly_with_me' || reason === 'authored_by_me'),
            assigned_to_me: relevance.reasons.includes('responsible_for_me') } : {}),
        ...(follow ? { following: follow.follows } : {}),
    };
    return {
        serverId, kind: 'session',
        managedSessions: row?.managedSessions,
        receivedRuleCount: row?.receivedRuleCount,
        startedBy: readSessionListStartedByV1({ origin: row?.origin, ownerAccountId, viewerAccountId: options.viewerAccountId }),
        ...(ownerMetadata ? { machine: ownerMetadata.machineId ? { serverId, machineId: ownerMetadata.machineId } : null } : {}),
        ...(typeof ownerMetadata?.branch === 'string' || ownerMetadata?.branch === null ? { branch: ownerMetadata.branch } : {}),
        ...(agentTargetKey ? { agent: agentTargetKey } : {}),
        ...(ownerAccountId ? { owner: { serverId, accountId: ownerAccountId } } : {}),
        ...(row ? { updatedAt: source?.lifecycle.updatedAt ?? row.updatedAt } : {}),
        ...(options.section === undefined ? {} : { section: options.section }),
        metadata: metadata ? { bot: metadata.bot } : null,
        projectMetadata: ownerMetadata ? { projectId: ownerMetadata.projectId, workspaceId: ownerMetadata.workspaceId,
            machineId: ownerMetadata.machineId, path: ownerMetadata.path,
            sessionDirectoryV1: ownerMetadata.sessionDirectoryV1,
            sessionWorkspaceLocationV1: ownerMetadata.sessionWorkspaceLocationV1 } : null,
        projectKey: row?.projectKey,
        ...(options.includeStatus !== false && row ? buildSessionListWorkStatusFacts(resolveWorkStatusTone({
            kind: 'session', facts: readSessionWorkStatusFacts(row, options.nowMs, source),
        })) : {}),
        source: options.storageKind ?? (options.includeSource !== false && row
            ? getSessionStorageKind({ ...row, ownerMetadataView: ownerMetadata }) : undefined),
        attentionRequired: options.attentionRequired ?? row?.viewer?.attention.needsAttention,
        scopeMatches, underSessionMatches: options.underSessionMatches,
        audiences: options.audiences, tagIds: options.tagIds,
        workspaceRefs: projectCensus.workspaceRefs, workspaceContext: { ...workspaceRefResolutionContextV1(),
            sessionProjectKeyResolver: projectCensus.sessionProjectKeyResolver },
    };
}

/**
 * Structural membership was proved before pagination by the Home listing owner.
 * Released Homes/cold placeholders may lack starter identity. That historical list admission
 * is not a rule fact: the constructor above always keeps missing evidence unavailable.
 */
export function matchSessionListRowLocalFilter(
    row: SessionListRenderableSession | null,
    serverId: string,
    filter: SessionListFilterV1,
    options: SessionListRowFilterFactsOptions,
): SessionListFilterMatchV1 {
    return compileSessionListRowLocalFilter(filter, serverId, options.querySectionIds)(row, options);
}

/** The list projection retains this compiled predicate for its current filter and Home proof. */
export function compileSessionListRowLocalFilter(
    filter: SessionListFilterV1,
    serverId: string,
    querySectionIds?: readonly string[],
    structuralProof = true,
): (row: SessionListRenderableSession | null, options: SessionListRowFilterFactsOptions) => SessionListFilterMatchV1 {
    // Find text belongs to its transient search owner, never to stored opaque narrowing.
    const { searchQuery: _searchQuery, ...stored } = filter as SessionListFilterV1 & Readonly<{ searchQuery?: string }>;
    const local = { ...(structuralProof ? projectSessionListFilterAfterHomeQueryV1(stored, serverId,
        querySectionIds === undefined ? undefined : { folderIds: [...querySectionIds] }) : stored), show: 'sessions' as const };
    const match = compileEntityListFilterV1(sessionWorkFilterFields, local);
    const legacyMatch = compileEntityListFilterV1(sessionWorkFilterFields, { ...local, startedBy: ALL_STARTERS });
    const includeStatus = Boolean(filter.statuses?.length || filter.excludedStatuses?.length);
    return (row, options) => {
        const facts = buildSessionListRowFilterFacts(row, serverId, { ...options,
            includeStatus, includeSource: filter.source !== 'all',
            includeAgent: Boolean(filter.agents && filter.agents.include.length + filter.agents.exclude.length) });
        return (local.startedBy.length > 0 && (facts.startedBy === undefined || row?.origin?.kind === 'run_step') ? legacyMatch : match)(facts, options.onUnavailable);
    };
}

/** One compiled predicate per selected Space/Home, using only held row/organization facts. */
export function compileSessionListSpaceFilter(
    filter: SessionListFilterV1, serverId: string, space: SessionListSpaceMembership,
    querySectionIds?: readonly string[],
): ReturnType<typeof compileSessionListRowLocalFilter> {
    const refinement = compileSessionListRowLocalFilter(filter, serverId, querySectionIds);
    const smart = compileSessionListRowLocalFilter(space.filter, serverId, undefined, false);
    const smartProven = compileSessionListRowLocalFilter(space.filter, serverId,
        space.filter.sections?.include.filter(section => areServerProfileIdentifiersEquivalent(section.serverId, serverId)).map(section => section.sectionId));
    const membershipTagByAccount = new Map(space.membership.tags.filter(tag => areServerProfileIdentifiersEquivalent(tag.serverId, serverId))
        .map(tag => [tag.accountId, tag.tagId] as const));
    return (row, options) => {
        const outer = refinement(row, options);
        if (outer === 'miss') return outer;
        const tagId = options.viewerAccountId === undefined ? undefined : membershipTagByAccount.get(options.viewerAccountId);
        const heldTags = options.tagIds ?? row?.viewer?.tagIds;
        const manual = tagId === undefined ? 'miss' : heldTags === undefined ? 'unavailable' : heldTags.includes(tagId) ? 'match' : 'miss';
        let member: SessionListFilterMatchV1 = manual;
        if (space.membership.mode !== 'manual_only' && space.filter.show !== 'runs' && manual !== 'match') {
            // A page admitted outside its manual branch proved the smart structural
            // selectors. After a local removal from a manual page, retain unknown
            // smart facts until the existing query invalidation replaces the page.
            const pageTags = row?.viewer?.tagIds;
            const pageProvedSmart = tagId === undefined || pageTags !== undefined && !pageTags.includes(tagId);
            const result = (pageProvedSmart ? smartProven : smart)(row, { ...options, tagIds: heldTags });
            member = result === 'match' ? 'match' : result === 'unavailable' || manual === 'unavailable' ? 'unavailable' : 'miss';
        }
        return member === 'miss' ? 'miss' : member === 'unavailable' || outer === 'unavailable' ? 'unavailable' : 'match';
    };
}

/** A mounted Home and a loaded window cannot certify unavailable Run filter facts. */
export function resolveWorkflowRunUnavailableHomes(input: Readonly<{
    selectedHomeServerIds: readonly string[];
    mountedHomeServerIds: readonly string[];
    servedHomeServerId: string | null;
    filter?: SessionListFilterV1;
    runs?: readonly (WorkflowRunSummaryV1 | null)[];
    /** The real list supplies the same held-row projection used for membership/count. */
    runFactsUnavailable?: boolean;
    viewerAccountId?: string;
    /** This page came from workflow.run.list with the exact Under filter. */
    runUnderSessionId?: string;
}>): readonly Readonly<{ serverId: string; reason: 'not_selected' | 'unsupported' }>[] {
    return input.selectedHomeServerIds.flatMap((serverId) => {
        if (input.servedHomeServerId
            && areServerProfileIdentifiersEquivalent(serverId, input.servedHomeServerId)) {
            const filter = input.filter;
            const unavailable = input.runFactsUnavailable ?? (filter && input.runs?.some(run => (run
                ? matchWorkflowRunSessionListFilter(run, serverId, filter, input.viewerAccountId,
                    input.runUnderSessionId === filter.underSessionId && filter.underSessionId !== undefined ? true : undefined)
                : matchSessionListFilterV1(filter, { serverId, kind: 'run' })) === 'unavailable'));
            if (!unavailable) return [];
        }
        const reason = input.mountedHomeServerIds.some((home) => areServerProfileIdentifiersEquivalent(home, serverId))
            ? 'unsupported' as const : 'not_selected' as const;
        return [{ serverId, reason }];
    });
}

/** Run-native evidence shared by strict rules/preview; no list attention admission is a fact. */
export function buildWorkflowRunFilterFacts(
    run: WorkflowRunSummaryV1,
    serverId: string,
    viewerAccountId?: string,
    underSessionMatches?: boolean,
    includeStatus = true,
): SessionListFilterFactsV1 {
    const ownedByViewer = viewerAccountId ? run.ownerAccountId === viewerAccountId : undefined;
    const starter = run.startedBy === 'user' ? ownedByViewer === undefined ? undefined : ownedByViewer ? 'you' : 'other_account'
        : run.startedBy === 'agent' ? 'agents'
        : run.startedBy === 'trigger' ? 'triggers' : undefined;
    return {
        serverId, kind: 'run', startedBy: starter, attentionRequired: run.attentionRequired,
        owner: { serverId, accountId: run.ownerAccountId },
        updatedAt: Date.parse(run.updatedAt),
        ...(includeStatus ? buildSessionListWorkStatusFacts(resolveWorkStatusTone({
            kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(run),
        })) : {}),
        // Readability through a Team is not evidence of the viewer's participation.
        scopeMatches: { ...(ownedByViewer ? { my_work: true, involving_me: true } : {}), following: false, assigned_to_me: false },
        audiences: run.visibleTeamId === null ? [{ kind: 'outside_teams' }]
            : [{ kind: 'team', teamId: run.visibleTeamId }],
        tagIds: [], source: 'persisted',
        underSessionMatches,
        // A Run's destination is not owner Session Project evidence.
        workspaceContext: workspaceRefResolutionContextV1(),
    };
}

/** List/Board presentation retains its existing attention supplement, never rule match authority. */
export function matchWorkflowRunSessionListFilter(
    run: WorkflowRunSummaryV1,
    serverId: string,
    filter: SessionListFilterV1,
    viewerAccountId?: string,
    underSessionMatches?: boolean,
    onUnavailable?: (fieldIds: readonly string[]) => void,
): SessionListFilterMatchV1 {
    return compileWorkflowRunSessionListFilter(filter)(run, serverId, viewerAccountId, underSessionMatches, onUnavailable);
}

export function compileWorkflowRunSessionListFilter(filter: SessionListFilterV1) {
    const { searchQuery: _searchQuery, ...stored } = filter as SessionListFilterV1 & Readonly<{ searchQuery?: string }>;
    const match = compileEntityListFilterV1(sessionWorkFilterFields, stored);
    const attentionMatch = compileEntityListFilterV1(sessionWorkFilterFields, { ...stored, startedBy: ALL_STARTERS });
    const includeStatus = Boolean(filter.statuses?.length || filter.excludedStatuses?.length);
    return (run: WorkflowRunSummaryV1, serverId: string, viewerAccountId?: string, underSessionMatches?: boolean,
        onUnavailable?: (fieldIds: readonly string[]) => void): SessionListFilterMatchV1 =>
        (stored.startedBy.length > 0 && run.attentionRequired ? attentionMatch : match)(buildWorkflowRunFilterFacts(run, serverId, viewerAccountId, underSessionMatches, includeStatus), onUnavailable);
}

/** The same authorized lean Run membership predicate for Sessions and Boards. */
export function workflowRunMatchesSessionListFilter(
    run: WorkflowRunSummaryV1,
    serverId: string,
    filter: SessionListFilterV1,
    viewerAccountId?: string,
    underSessionMatches?: boolean,
): boolean {
    return matchWorkflowRunSessionListFilter(run, serverId, filter, viewerAccountId, underSessionMatches) === 'match';
}
