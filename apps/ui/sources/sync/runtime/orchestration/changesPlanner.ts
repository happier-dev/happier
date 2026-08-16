import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { ChangeKindSchema, type ChangeKind } from '@happier-dev/protocol/changes';

export type PlannedKvAction =
    | { type: 'none' }
    | { type: 'refresh-feature'; feature: 'todos' }
    | { type: 'bulk-keys'; feature: 'todos'; keys: string[] };

export type PlannedSessionFolderAssignmentsAction =
    | { mode: 'none' }
    | { mode: 'sessions'; sessionIds: string[]; folderIds: string[] }
    | { mode: 'folders'; folderIds: string[] };

export type PlannedSessionOrganizationAction =
    | { mode: 'none' }
    | {
        mode: 'snapshot';
        assignmentSessionIds: string[];
        folderIds: string[];
        tagIds: string[];
        orderScopes: Array<{ scopeKind: 'pinned' | 'folder' | 'tag' | 'workspace' | 'group'; scopeKey: string }>;
        includeFolders: boolean;
        includeTags: boolean;
        includeLabels: boolean;
    };
type PlannedSessionOrganizationOrderScope = Extract<PlannedSessionOrganizationAction, { mode: 'snapshot' }>['orderScopes'][number];

export type UnsupportedChangeMarker = {
    cursor: string;
    kind: string;
    entityId: string;
};

export type PlannedSessionTranscriptRepair = Readonly<{
    sessionId: string;
    minSeq: number;
    messageIds: string[];
}>;

export type ChangeCheckpointDecision =
    | 'critical'
    | 'unsupported';

export type ChangeCheckpointBlockedReason =
    | 'unsupported-kind'
    | 'partial-materialization'
    | 'pending-not-converged';

export type ChangeCheckpointClassification = {
    kind: string;
    cursor: string;
    entityId: string;
    decision: ChangeCheckpointDecision;
    plannerOwner: string;
    snapshotDomain: string | null;
    materializationProof: string | null;
    blockedReason?: ChangeCheckpointBlockedReason;
};

export type ChangeCheckpointClientState = {
    isSessionMessagesLoaded: (sessionId: string) => boolean;
};

export type ChangeCheckpointCoverageEntry = {
    plannerOwner: string;
    snapshotDomain: string;
};

export const CHANGE_CHECKPOINT_COVERAGE = {
    account: { plannerOwner: 'account', snapshotDomain: 'account-settings-profile' },
    automation: { plannerOwner: 'automations', snapshotDomain: 'automations' },
    artifact: { plannerOwner: 'artifacts', snapshotDomain: 'artifacts' },
    feed: { plannerOwner: 'feed', snapshotDomain: 'feed' },
    friends: { plannerOwner: 'friends', snapshotDomain: 'friends' },
    friend_request: { plannerOwner: 'friends', snapshotDomain: 'friends' },
    friend_accepted: { plannerOwner: 'friends', snapshotDomain: 'friends' },
    kv: { plannerOwner: 'kv', snapshotDomain: 'todos' },
    machine: { plannerOwner: 'machines', snapshotDomain: 'machines' },
    pet: { plannerOwner: 'pets', snapshotDomain: 'account-pets' },
    session: { plannerOwner: 'sessions', snapshotDomain: 'sessions-and-session-messages' },
    share: { plannerOwner: 'sessions', snapshotDomain: 'sessions' },
} satisfies Record<ChangeKind, ChangeCheckpointCoverageEntry>;

export type PlannedChangeActions = {
    changes: ApiChangeEntry[];
    sessionIdsToCatchUp: string[];
    sessionTranscriptRepairs: PlannedSessionTranscriptRepair[];
    unsupportedChanges: UnsupportedChangeMarker[];
    invalidate: {
        sessions: boolean;
        machines: boolean;
        artifacts: boolean;
        settings: boolean;
        profile: boolean;
        friends: boolean;
        feed: boolean;
        automations: boolean;
        pets: boolean;
    };
    kv: PlannedKvAction;
    sessionFolderAssignments: PlannedSessionFolderAssignmentsAction;
    sessionOrganization: PlannedSessionOrganizationAction;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

const knownChangeKinds = new Set<string>(ChangeKindSchema.options);

function isKnownChangeKind(kind: string): kind is ChangeKind {
    return knownChangeKinds.has(kind);
}

function hasPendingHint(change: ApiChangeEntry): boolean {
    const hint = change.hint;
    return (
        isRecord(hint)
        && (typeof hint.pendingVersion === 'number' || typeof hint.pendingCount === 'number')
    );
}

function isSessionFolderAssignmentHint(change: ApiChangeEntry): boolean {
    const hint = change.hint;
    return isRecord(hint) && hint.sessionFolderAssignment === true;
}

function isBulkSessionFolderAssignmentsHint(change: ApiChangeEntry): boolean {
    const hint = change.hint;
    return isRecord(hint) && hint.sessionFolderAssignments === true;
}

function isSessionOrganizationHint(change: ApiChangeEntry): boolean {
    const hint = change.hint;
    return isRecord(hint) && hint.sessionOrganization === true;
}

function isSessionOrganizationMaterializationHint(change: ApiChangeEntry): boolean {
    return isSessionOrganizationHint(change)
        || isSessionFolderAssignmentHint(change)
        || isBulkSessionFolderAssignmentsHint(change);
}

function readHintFolderId(change: ApiChangeEntry): string | null {
    const hint = change.hint;
    if (!isRecord(hint)) return null;
    return typeof hint.folderId === 'string' && hint.folderId.trim() ? hint.folderId.trim() : null;
}

function readHintFolderIds(change: ApiChangeEntry): string[] {
    const hint = change.hint;
    if (!isRecord(hint) || !Array.isArray(hint.folderIds)) return [];
    return Array.from(new Set(
        hint.folderIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim()),
    )).sort();
}

function readHintStringArray(change: ApiChangeEntry, key: string): string[] {
    const hint = change.hint;
    if (!isRecord(hint) || !Array.isArray(hint[key])) return [];
    return Array.from(new Set(
        hint[key]
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim()),
    )).sort();
}

function readHintOrderScopes(change: ApiChangeEntry): PlannedSessionOrganizationOrderScope[] {
    const hint = change.hint;
    if (!isRecord(hint) || !Array.isArray(hint.orderScopes)) return [];
    const out: PlannedSessionOrganizationOrderScope[] = [];
    const seen = new Set<string>();
    for (const raw of hint.orderScopes) {
        if (!isRecord(raw)) continue;
        const scopeKind = raw.scopeKind;
        const scopeKey = typeof raw.scopeKey === 'string' ? raw.scopeKey.trim() : '';
        if (
            (scopeKind === 'pinned' || scopeKind === 'folder' || scopeKind === 'tag' || scopeKind === 'workspace' || scopeKind === 'group')
            && scopeKey
        ) {
            const key = `${scopeKind}:${scopeKey}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ scopeKind, scopeKey });
        }
    }
    return out.sort((left, right) => `${left.scopeKind}:${left.scopeKey}`.localeCompare(`${right.scopeKind}:${right.scopeKey}`));
}

export function getChangeTargetMessageSeq(change: ApiChangeEntry): number | null {
    const hint = change.hint;
    if (!isRecord(hint)) return null;
    const candidate = hint.lastMessageSeq ?? hint.targetMessageSeq;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) return null;
    return Math.trunc(candidate);
}

export function getChangeUpdatedMessageHint(
    change: ApiChangeEntry,
): Readonly<{ seq: number; messageId: string }> | null {
    if (change.kind !== 'session' && change.kind !== 'share') return null;
    const hint = change.hint;
    if (!isRecord(hint)) return null;
    const seq = hint.updatedMessageSeq;
    const messageId = typeof hint.updatedMessageId === 'string' ? hint.updatedMessageId.trim() : '';
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0 || !messageId) return null;
    return { seq: Math.trunc(seq), messageId };
}

export function classifyChangeForCheckpoint(
    change: ApiChangeEntry,
    _clientState: ChangeCheckpointClientState,
): ChangeCheckpointClassification {
    const kind = String(change.kind);
    const cursor = String(change.cursor);
    const entityId = String(change.entityId ?? '');

    if (!isKnownChangeKind(kind)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'unsupported',
            plannerOwner: 'unsupported',
            snapshotDomain: null,
            materializationProof: null,
            blockedReason: 'unsupported-kind',
        };
    }

    const coverage = CHANGE_CHECKPOINT_COVERAGE[kind];

    if ((kind === 'account' || kind === 'session') && isSessionOrganizationMaterializationHint(change)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'critical',
            plannerOwner: 'session-organization',
            snapshotDomain: 'session-organization',
            materializationProof: 'session-organization',
        };
    }

    if ((kind === 'session' || kind === 'share') && hasPendingHint(change)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'critical',
            plannerOwner: coverage.plannerOwner,
            snapshotDomain: coverage.snapshotDomain,
            materializationProof: 'pending-queue-convergence',
        };
    }

    return {
        kind,
        cursor,
        entityId,
        decision: 'critical',
        plannerOwner: coverage.plannerOwner,
        snapshotDomain: coverage.snapshotDomain,
        materializationProof: coverage.snapshotDomain,
    };
}

export function planSyncActionsFromChanges(changes: ApiChangeEntry[]): PlannedChangeActions {
    const sessionIds = new Set<string>();
    const sessionTranscriptRepairs = new Map<string, { minSeq: number; messageIds: Set<string> }>();
    const unsupportedChanges: UnsupportedChangeMarker[] = [];
    let invalidateSessions = false;
    let invalidateMachines = false;
    let invalidateArtifacts = false;
    let invalidateSettings = false;
    let invalidateProfile = false;
    let invalidateFriends = false;
    let invalidateFeed = false;
    let invalidateAutomations = false;
    let invalidatePets = false;
    const assignmentSessionIds = new Set<string>();
    const assignmentFolderIds = new Set<string>();
    let assignmentFolderMode = false;
    const organizationAssignmentSessionIds = new Set<string>();
    const organizationFolderIds = new Set<string>();
    const organizationTagIds = new Set<string>();
    const organizationOrderScopes = new Map<string, { scopeKind: 'pinned' | 'folder' | 'tag' | 'workspace' | 'group'; scopeKey: string }>();
    let organizationIncludeFolders = false;
    let organizationIncludeTags = false;
    let organizationIncludeLabels = false;
    let organizationRefresh = false;

    let kvFull = false;
    const kvKeys = new Set<string>();

    for (const change of changes) {
        const kind = change.kind;
        if (!isKnownChangeKind(String(kind))) {
            unsupportedChanges.push({
                cursor: String(change.cursor),
                kind: String(kind),
                entityId: String(change.entityId ?? ''),
            });
            continue;
        }

        if (kind === 'session' && isSessionFolderAssignmentHint(change)) {
            if (typeof change.entityId === 'string' && change.entityId.length > 0) {
                assignmentSessionIds.add(change.entityId);
                organizationAssignmentSessionIds.add(change.entityId);
            }
            const folderId = readHintFolderId(change);
            if (folderId) {
                assignmentFolderIds.add(folderId);
                organizationFolderIds.add(folderId);
            }
            organizationRefresh = true;
            continue;
        }

        if (kind === 'account' && isBulkSessionFolderAssignmentsHint(change)) {
            assignmentFolderMode = true;
            for (const folderId of readHintFolderIds(change)) {
                assignmentFolderIds.add(folderId);
                organizationFolderIds.add(folderId);
            }
            organizationRefresh = true;
            continue;
        }

        if ((kind === 'account' || kind === 'session') && isSessionOrganizationHint(change)) {
            organizationRefresh = true;
            for (const sessionId of readHintStringArray(change, 'sessionIds')) organizationAssignmentSessionIds.add(sessionId);
            if (kind === 'session' && typeof change.entityId === 'string' && change.entityId.trim()) {
                organizationAssignmentSessionIds.add(change.entityId.trim());
            }
            for (const folderId of readHintStringArray(change, 'folderIds')) organizationFolderIds.add(folderId);
            for (const tagId of readHintStringArray(change, 'tagIds')) organizationTagIds.add(tagId);
            for (const scope of readHintOrderScopes(change)) organizationOrderScopes.set(`${scope.scopeKind}:${scope.scopeKey}`, scope);
            const hint = change.hint;
            if (isRecord(hint)) {
                if (hint.scope === 'pins') {
                    invalidateSessions = true;
                }
                organizationIncludeFolders = organizationIncludeFolders || hint.scope === 'folders';
                organizationIncludeTags = organizationIncludeTags || hint.scope === 'tags';
                organizationIncludeLabels = organizationIncludeLabels || hint.scope === 'labels';
            }
            continue;
        }

        if (kind === 'session' || kind === 'share') {
            invalidateSessions = true;
            if (typeof change.entityId === 'string' && change.entityId.length > 0) {
                sessionIds.add(change.entityId);
                const updatedMessage = getChangeUpdatedMessageHint(change);
                if (updatedMessage) {
                    const existing = sessionTranscriptRepairs.get(change.entityId);
                    if (existing) {
                        existing.minSeq = Math.min(existing.minSeq, updatedMessage.seq);
                        existing.messageIds.add(updatedMessage.messageId);
                    } else {
                        sessionTranscriptRepairs.set(change.entityId, {
                            minSeq: updatedMessage.seq,
                            messageIds: new Set([updatedMessage.messageId]),
                        });
                    }
                }
            }
            continue;
        }

        if (kind === 'account') {
            invalidateSettings = true;
            invalidateProfile = true;
            continue;
        }

        if (kind === 'machine') {
            invalidateMachines = true;
            continue;
        }

        if (kind === 'artifact') {
            invalidateArtifacts = true;
            continue;
        }

        if (kind === 'friends' || kind === 'friend_request' || kind === 'friend_accepted') {
            invalidateFriends = true;
            continue;
        }

        if (kind === 'feed') {
            invalidateFeed = true;
            continue;
        }

        if (kind === 'automation') {
            invalidateAutomations = true;
            continue;
        }

        if (kind === 'pet') {
            invalidatePets = true;
            continue;
        }

        if (kind === 'kv') {
            const hint = change.hint;
            if (!isRecord(hint)) {
                kvFull = true;
                continue;
            }
            if (hint.full === true) {
                kvFull = true;
                continue;
            }
            const keys = hint.keys;
            if (Array.isArray(keys)) {
                for (const key of keys) {
                    if (typeof key === 'string' && key.length > 0) {
                        kvKeys.add(key);
                    }
                }
                continue;
            }
            kvFull = true;
            continue;
        }
    }

    const kv: PlannedKvAction = kvFull
        ? { type: 'refresh-feature', feature: 'todos' }
        : kvKeys.size > 0
            ? { type: 'bulk-keys', feature: 'todos', keys: Array.from(kvKeys).sort() }
            : { type: 'none' };

    const sessionFolderAssignments: PlannedSessionFolderAssignmentsAction = assignmentFolderMode
        ? { mode: 'folders', folderIds: Array.from(assignmentFolderIds).sort() }
        : assignmentSessionIds.size > 0
            ? {
                mode: 'sessions',
                sessionIds: Array.from(assignmentSessionIds).sort(),
                folderIds: Array.from(assignmentFolderIds).sort(),
            }
            : { mode: 'none' };
    const sessionOrganization: PlannedSessionOrganizationAction = organizationRefresh
        ? {
            mode: 'snapshot',
            assignmentSessionIds: Array.from(organizationAssignmentSessionIds).sort(),
            folderIds: Array.from(organizationFolderIds).sort(),
            tagIds: Array.from(organizationTagIds).sort(),
            orderScopes: Array.from(organizationOrderScopes.values()).sort((left, right) =>
                `${left.scopeKind}:${left.scopeKey}`.localeCompare(`${right.scopeKind}:${right.scopeKey}`),
            ),
            includeFolders: organizationIncludeFolders,
            includeTags: organizationIncludeTags,
            includeLabels: organizationIncludeLabels,
        }
        : { mode: 'none' };

    return {
        changes: [...changes],
        sessionIdsToCatchUp: Array.from(sessionIds).sort(),
        sessionTranscriptRepairs: Array.from(sessionTranscriptRepairs.entries())
            .map(([sessionId, repair]) => ({
                sessionId,
                minSeq: repair.minSeq,
                messageIds: Array.from(repair.messageIds).sort(),
            }))
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
        unsupportedChanges,
        invalidate: {
            sessions: invalidateSessions,
            machines: invalidateMachines,
            artifacts: invalidateArtifacts,
            settings: invalidateSettings,
            profile: invalidateProfile,
            friends: invalidateFriends,
            feed: invalidateFeed,
            automations: invalidateAutomations,
            pets: invalidatePets,
        },
        kv,
        sessionFolderAssignments,
        sessionOrganization,
    };
}
