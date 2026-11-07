import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionPresentationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { readApprovalArtifactAutomationOrigin, type ListedOpenApproval } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { comparePendingRequestsByAge, selectOldestPendingRequest } from '@happier-dev/session-core/pending';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { shallow } from 'zustand/shallow';
import { areSessionAppearanceColorsEqual } from '@/sync/domains/session/organization/appearanceColor';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/**
 * FIN's session↔PR link read projection (`sessionPullRequestLink`, FIN PLAN U10 / 08 §5A), as this
 * Inbox consumes it. State and observation time come from the qualified Channel binding.
 */
export type InboxPullRequestLink = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    number: number;
    title?: string | null;
    url: string;
    state?: 'open' | 'merged' | 'closed' | 'unknown';
    observedAt?: number;
}>;

/** What a held Run's named step needs from the person; a review hold is the Run's `heldStep`. */
export type InboxHeldStepNeed = 'review' | 'approval';

/**
 * The step a Run waits on, read from its own summary: the list host's review hold, otherwise the first
 * Writer step last observed waiting for approval. A step with no authored name is never guessed.
 */
function readHeldStep(summary: WorkflowRunRow['summary']): Readonly<{ label: string; laneLabel: string | null; need: InboxHeldStepNeed }> | null {
    const held = summary?.heldStep;
    if (held) return { label: held.label, laneLabel: held.laneLabel ?? null, need: 'review' };
    const approval = summary?.stepProgress?.destinations?.find(destination =>
        destination.observation?.lifecycle === 'waiting_for_approval' && destination.name);
    return approval?.name ? { label: approval.name, laneLabel: null, need: 'approval' } : null;
}

export type InboxWorkItem =
    /** A session that needs the person (permission, question, failure, …); `foldedUnderRunId` for a step session. */
    | Readonly<{ kind: 'session'; key: string; entry: InboxSessionAttentionEntry; foldedUnderRunId: string | null }>
    /** A workflow run in 03's attention window (a hold, an approval, an interrupted run). */
    | Readonly<{ kind: 'workflow_run'; key: string; runId: string; row: WorkflowRunRow;
        heldStepLabel: string | null; heldStepLaneLabel: string | null; heldStepNeed: InboxHeldStepNeed | null }>
    /** A worker whose machine went offline while its turn was in flight. */
    | Readonly<{ kind: 'stalled'; key: string; session: Session }>
    /** A session with a retained PR link, waiting for the person to land and settle it. */
    | Readonly<{ kind: 'landing'; key: string; session: SessionPresentationRecord; link: InboxPullRequestLink }>
    /** A session the person snoozed until `remindAt`; it stays in place, quietly. */
    | Readonly<{ kind: 'snoozed'; key: string; session: Session; remindAt: number }>
    | Readonly<{ kind: 'automation_run'; key: string; row: WorkflowRunRow }>
    | Readonly<{ kind: 'approval'; key: string; artifact: DecryptedArtifact; approval: InboxApprovalListing }>;

/** What grouping and Inbox rows read of an open request: its Artifact header and source. */
export type InboxApprovalListing = Pick<ListedOpenApproval, 'artifact' | 'source'>;

export type InboxWorkGroupRoot =
    | Readonly<{ kind: 'lead'; serverId: string | null; sessionId: string; session: SessionPresentationRecord | null }>
    | Readonly<{ kind: 'run'; runId: string; row: WorkflowRunRow }>
    | Readonly<{ kind: 'automation'; automationId: string; serverId: string; runId: string }>
    | Readonly<{ kind: 'other' }>;

export type InboxWorkGroup = Readonly<{
    key: string;
    root: InboxWorkGroupRoot;
    items: readonly InboxWorkItem[];
}>;

export type InboxWorkGroupsInput = Readonly<{
    /** Needs-you and failed session entries from the canonical classifier, in Activity priority order. */
    sessionEntries: readonly InboxSessionAttentionEntry[];
    /** 03's attention window, in server order. */
    workflowRuns: readonly WorkflowRunRow[];
    /** The attention window's Home; unknown scope cannot identify a Session origin or fold a step. */
    workflowServerId?: string | null;
    /** Automation attention-window rows and open approval Artifacts from this Account. */
    automationRuns: readonly WorkflowRunRow[];
    automationServerId: string | null;
    /** Listed from header facts; a row presents (and reads) its own body. */
    openApprovals: readonly InboxApprovalListing[];
    stalledSessions: readonly Session[];
    landings: readonly Readonly<{ session: SessionPresentationRecord; link: InboxPullRequestLink }>[];
    snoozed: readonly Readonly<{ session: Session; remindAt: number }>[];
    /**
     * Store lookup used to walk `manager`; an unknown id stops the walk. A candidate's Home is passed so a
     * Session known only to a background Home's list projection resolves there; a manager lives in its
     * report's Home. No Home means the lookup's own default scope.
     */
    resolveSession: (sessionId: string, serverId?: string | null) => SessionPresentationRecord | null | undefined;
    /**
     * The server origin link of a step session (ORC §3.1 `originRunId`, awareness `origin.runId`).
     * Absent until U4's awareness projection lands; then a step request folds under its run.
     */
    resolveOriginRunId: (entry: InboxSessionAttentionEntry) => string | null;
}>;

const ITEM_RANK: Readonly<Record<InboxWorkItem['kind'], number>> = {
    session: 1,
    workflow_run: 0,
    automation_run: 0,
    approval: 0,
    stalled: 2,
    landing: 3,
    snoozed: 4,
};

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function qualifiedSessionKey(sessionId: string, serverId: string | null | undefined): string {
    return sessionAddressKey({ serverId: serverId ?? '', sessionId });
}

function hasReports(session: SessionPresentationRecord | null | undefined): boolean {
    return (session?.managedSessions?.total ?? 0) > 0;
}

/**
 * The work root of a session: the top of its `manager` chain, or the session itself when it leads
 * others, or null for a loose session. The walk visits each id once, so a transiently cyclic store
 * (an edge seen before its reparent landed) cannot loop, and an unreadable lead stops it there.
 * `serverId` is the Home of `sessionId`; the whole chain is read from that Home.
 */
export function resolveInboxWorkRoot(
    sessionId: string,
    resolveSession: InboxWorkGroupsInput['resolveSession'],
    serverId?: string | null,
): string | null {
    const start = resolveSession(sessionId, serverId) ?? null;
    let parent = normalizeId(readSessionManagerSessionIdV1(start));
    if (!parent) return hasReports(start) ? sessionId : null;
    const visited = new Set<string>([sessionId]);
    let current = sessionId;
    while (parent && !visited.has(parent)) {
        visited.add(parent);
        current = parent;
        parent = normalizeId(readSessionManagerSessionIdV1(resolveSession(current, serverId)));
    }
    return current;
}

/**
 * The Inbox grouped by the work each item belongs to (ORC R-10, §3.8; lab `inbox-I1`).
 *
 * - A session under a lead, or a lead itself, groups under the lead's work root.
 * - A workflow run groups under the work root of its origin session, else under itself.
 * - A step session's request folds once under its run when 03's window lists that run, and is
 *   never also listed on its own (FIN 03 §6.4 "Grouping").
 * - Automation runs and their V2-origin approvals share an Automation root; other approvals go
 *   to "Other sessions", always last.
 *
 * It decides no attention: every item arrives already classified by its owner.
 */
export function buildInboxWorkGroups(input: InboxWorkGroupsInput, previous?: readonly InboxWorkGroup[]): readonly InboxWorkGroup[] {
    const groups = new Map<string, { root: InboxWorkGroupRoot; items: InboxWorkItem[] }>();
    const other: InboxWorkItem[] = [];
    const listedRunIds = new Set(input.workflowRuns.map((row) => row.id));
    const stepsByRunId = new Map<string, InboxWorkItem[]>();
    // One row per session: a session already listed for what it needs is not listed again as
    // stalled, landing or snoozed.
    const listedSessionKeys = new Set<string>();

    const leadGroup = (rootSessionId: string, serverId?: string | null) => {
        const home = serverId ?? input.resolveSession(rootSessionId)?.serverId ?? null;
        const key = `lead:${qualifiedSessionKey(rootSessionId, home)}`;
        let group = groups.get(key);
        if (!group) {
            const session = input.resolveSession(rootSessionId, home) ?? null;
            group = { root: { kind: 'lead', serverId: home, sessionId: rootSessionId, session }, items: [] };
            groups.set(key, group);
        }
        return group.items;
    };
    const placeSession = (sessionId: string, serverId: string | null | undefined, item: InboxWorkItem) => {
        const root = resolveInboxWorkRoot(sessionId, input.resolveSession, serverId);
        (root ? leadGroup(root, serverId) : other).push(item);
    };
    const automationGroup = (serverId: string, automationId: string, runId: string) => {
        const key = `automation:${serverId}:${automationId}`;
        let group = groups.get(key);
        if (!group) {
            group = { root: { kind: 'automation', automationId, serverId, runId }, items: [] };
            groups.set(key, group);
        }
        return group.items;
    };

    for (const entry of input.sessionEntries) {
        const serverId = entry.candidate.address?.serverId ?? entry.candidate.serverId;
        listedSessionKeys.add(qualifiedSessionKey(entry.candidate.sessionId, serverId));
        const originRunId = normalizeId(input.resolveOriginRunId(entry));
        const key = `session:${entry.candidate.address?.serverId ?? entry.candidate.serverId ?? ''}:${entry.candidate.sessionId}`;
        if (originRunId && listedRunIds.has(originRunId) && input.workflowServerId
            && areServerProfileIdentifiersEquivalent(serverId, input.workflowServerId)) {
            const steps = stepsByRunId.get(originRunId) ?? [];
            steps.push({ kind: 'session', key, entry, foldedUnderRunId: originRunId });
            stepsByRunId.set(originRunId, steps);
            continue;
        }
        placeSession(entry.candidate.sessionId, entry.candidate.address?.serverId ?? entry.candidate.serverId,
            { kind: 'session', key, entry, foldedUnderRunId: null });
    }

    for (const row of input.workflowRuns) {
        const held = readHeldStep(row.summary);
        const runItems: InboxWorkItem[] = [
            { kind: 'workflow_run', key: `run:${row.id}`, runId: row.id, row,
                heldStepLabel: held?.label ?? null, heldStepLaneLabel: held?.laneLabel ?? null, heldStepNeed: held?.need ?? null },
            ...(stepsByRunId.get(row.id) ?? []),
        ];
        const origin = row.summary?.origin;
        const originSessionId = normalizeId(origin?.kind === 'direct' ? origin.originSessionId : null);
        const root = originSessionId && input.workflowServerId
            ? resolveInboxWorkRoot(originSessionId, input.resolveSession, input.workflowServerId) : null;
        if (root) {
            leadGroup(root, input.workflowServerId).push(...runItems);
            continue;
        }
        groups.set(`run:${row.id}`, { root: { kind: 'run', runId: row.id, row }, items: runItems });
    }

    for (const row of input.automationRuns) {
        const run = row.automation;
        if (!run || !input.automationServerId) continue;
        automationGroup(input.automationServerId, run.automationId, run.id).push({
            kind: 'automation_run', key: `automation-run:${run.id}`, row,
        });
    }

    for (const entry of input.openApprovals) {
        const { artifact } = entry;
        const automation = readApprovalArtifactAutomationOrigin(artifact);
        const item: InboxWorkItem = { kind: 'approval', key: `approval:${artifact.id}`, artifact, approval: entry };
        // The writer's header list fact (verified against the body when read); the origin Home is the header's.
        const serverId = typeof entry.source.serverId === 'string' ? entry.source.serverId : null;
        if (automation && serverId) {
            automationGroup(serverId, automation.automationId, automation.runId).push(item);
        } else {
            other.push(item);
        }
    }

    const placeOnce = (session: Pick<Session, 'id' | 'serverId'>, item: InboxWorkItem) => {
        const key = qualifiedSessionKey(session.id, session.serverId);
        if (listedSessionKeys.has(key)) return;
        listedSessionKeys.add(key);
        placeSession(session.id, session.serverId, item);
    };
    for (const session of input.stalledSessions) {
        placeOnce(session, { kind: 'stalled', key: `stalled:${qualifiedSessionKey(session.id, session.serverId)}`, session });
    }
    for (const landing of input.landings) {
        placeOnce(landing.session, { kind: 'landing', key: `landing:${qualifiedSessionKey(landing.session.id, landing.session.serverId)}`, ...landing });
    }
    for (const snoozed of input.snoozed) {
        placeOnce(snoozed.session, { kind: 'snoozed', key: `snoozed:${qualifiedSessionKey(snoozed.session.id, snoozed.session.serverId)}`, ...snoozed });
    }

    const ordered: InboxWorkGroup[] = [];
    for (const [key, group] of groups) {
        ordered.push({ key, root: group.root, items: sortByRank(group.items) });
    }
    if (other.length > 0) ordered.push({ key: 'other', root: { kind: 'other' }, items: sortByRank(other) });
    if (!previous) return ordered;
    const oldGroups = new Map(previous.map((group) => [group.key, group]));
    const oldItems = new Map(previous.flatMap((group) => group.items.map((item) => [item.key, item] as const)));
    const retained = ordered.map((group) => {
        const items = group.items.map((item) => {
            const old = oldItems.get(item.key);
            return old && areInboxWorkItemsEqual(item, old) ? old : item;
        });
        const old = oldGroups.get(group.key);
        return old && shallow(group.root, old.root) && shallow(items, old.items) ? old : { ...group, items };
    });
    return shallow(retained, previous) ? previous : retained;
}

function areInboxWorkItemsEqual(a: InboxWorkItem, b: InboxWorkItem): boolean {
    if (a.kind !== 'session' || b.kind !== 'session') return shallow(a, b);
    if (a.foldedUnderRunId !== b.foldedUnderRunId || a.entry.candidate.session !== b.entry.candidate.session) return false;
    if (!areSessionAppearanceColorsEqual(a.entry.appearanceColor, b.entry.appearanceColor)) return false;
    const candidate = a.entry.candidate;
    const oldCandidate = b.entry.candidate;
    // Session identity is store-owned: compare only the small derived facts, never its transcript.
    const keys = Object.keys(candidate) as (keyof typeof candidate)[];
    if (keys.length !== Object.keys(oldCandidate).length || !keys.every((key) => candidate[key] === oldCandidate[key]
        || pluginJsonValuesEqual(candidate[key], oldCandidate[key]))) return false;
    const sameRequests = (next: InboxSessionAttentionEntry['pendingPermissions'], old: InboxSessionAttentionEntry['pendingPermissions']) =>
        next.length === old.length && next.every((request, index) => shallow(request, old[index]));
    return sameRequests(a.entry.pendingPermissions, b.entry.pendingPermissions) && sameRequests(a.entry.pendingUserActions, b.entry.pendingUserActions);
}

function sortByRank(items: InboxWorkItem[]): readonly InboxWorkItem[] {
    const rank = (item: InboxWorkItem) => item.kind === 'session' && (
        item.entry.candidate.personalAttention.reasons.some(reason => reason === 'permission_required' || reason === 'user_action_required')
        || item.entry.pendingPermissions.length > 0 || item.entry.pendingUserActions.length > 0
    ) ? 0 : ITEM_RANK[item.kind];
    const ranked = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (rank(a.item) - rank(b.item)) || (a.index - b.index))
        .map(({ item }) => item);
    // Sort only pending-session slots with the same classification and run parent.
    // Failures, workflow rows and the broader work-group order retain their positions.
    const slots = new Map<string, Array<{ index: number; item: InboxWorkItem; request: NonNullable<ReturnType<typeof selectOldestPendingRequest>> }>>();
    ranked.forEach((item, index) => {
        if (item.kind !== 'session') return;
        const request = selectOldestPendingRequest([...item.entry.pendingPermissions, ...item.entry.pendingUserActions]);
        if (!request) return;
        const classification = `${item.entry.candidate.attentionState}:${item.foldedUnderRunId ?? ''}`;
        const group = slots.get(classification) ?? [];
        group.push({ index, item, request });
        slots.set(classification, group);
    });
    for (const group of slots.values()) {
        const sorted = [...group].sort((a, b) => comparePendingRequestsByAge(a.request, b.request) || a.item.key.localeCompare(b.item.key));
        group.forEach(({ index }, position) => { ranked[index] = sorted[position]!.item; });
    }
    // Approval age orders approval slots only; workflow and session priorities keep their places.
    const approvals = ranked.filter(item => item.kind === 'approval')
        .sort((a, b) => b.artifact.createdAt - a.artifact.createdAt || a.key.localeCompare(b.key));
    let approvalIndex = 0;
    ranked.forEach((item, index) => {
        if (item.kind === 'approval') ranked[index] = approvals[approvalIndex++]!;
    });
    return ranked;
}
