import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { readReviewCommentChangesHintV1, type ReviewCommentChangesHintV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { isProviderAccountUsageChangeEntityIdV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentReceiptCompletionWakeV1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import {
    ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1,
    isAutomationDefinitionChangeV1,
    ChangeKindSchema,
    HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
    MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1,
    isAccountCurrentnessChangeV1,
    readAccountSettingsVersionChangeV1,
    isMachineProjectionChangeKindV1,
    SessionOrganizationChangeHintSchema,
    readWorkflowFolderAssignmentChangeEntityIdV1,
    SESSION_ORGANIZATION_FOLDERS_CHANGE_ENTITY_ID_V1,
    TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
    TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1,
    readConnectedServicesAccountChangeV1,
    isProviderAccountUsageRefreshChangeEntityIdV1,
    readSessionUpdatedMessageChangeHintV1,
    readSessionFollowReceiverAvailabilityChangedV1,
    readSessionFollowSourceChangedV1,
    readSessionUsageAccountingChangedV1,
    artifactKindsMayIncludeKindV1,
    readArtifactKindsChangeHintV1,
    PluginDomainChangeEntrySchema,
    type ChangeKind,
} from '@happier-dev/protocol/changes';
import { AuthoringMemoryChangeHintV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { readSavedSecretDisclosureActivityEntityIdV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ProjectAccountRowChangeHintV1Schema, PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1, buildProjectAccountRowPhysicalKeyV1, parseProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { SessionDraftChangeHintV1Schema, type SessionDraftChangeHintV1 } from '@happier-dev/protocol/drafts/sessionDrafts';
import { SessionDraftChangeHintV2Schema, canonicalSessionDraftAddressV2, readSessionDraftAccountChangeEntityIdV2, type SessionDraftAddressV2, type SessionDraftChangeHintV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { isProfileCatalogAccountChangeEntityIdV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { launchProfileArtifactSharingAdapterV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { workflowDefinitionArtifactSharingAdapterV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { parseConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { ManagedMachinePolicyChangeHintV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { isSessionSystemRecordChangeKind } from '@/sync/domains/sessionSystemRecords/changeWatch';
import type { HomeAccountChangeEvent } from './homeAccountChange';
import type { SessionListRowMembershipFacets } from '@/sync/domains/session/listing/sessionListQuerySelection';
import { isSessionSystemRecordChangeEntityV1, isSessionSystemRecordUnchangedHintV1, readSessionSystemRecordChangeV1, SESSION_ROW_ONLY_HINT_KEYS } from '@happier-dev/protocol/sessions/board/changeHint';

export type PlannedKvAction =
    | { type: 'none' }
    | { type: 'refresh-feature'; feature: 'todos' }
    | { type: 'bulk-keys'; feature: 'todos'; keys: string[] };

export type PlannedSessionOrganizationAction =
    | { mode: 'none' }
    | {
        mode: 'snapshot';
        assignmentSessionIds: string[];
        folderIds: string[];
        tagIds: string[];
        deletedTagIds: string[];
        orderScopes: Array<{ scopeKind: 'pinned' | 'folder' | 'tag' | 'workspace' | 'group'; scopeKey: string }>;
        includeFolders: boolean;
        includeTags: boolean;
        includeLabels: boolean;
    };

export type UnsupportedChangeMarker = {
    cursor: string;
    kind: string;
    entityId: string;
};

export type PlannedSessionTranscriptRepair = Readonly<{
    sessionId: string;
    minSeq: number;
    messageIds: string[];
    messageSeqs?: Readonly<Record<string, number>>;
    /** Committed row revisions (ms) named by every hint for that message; absent means unknown. */
    messageUpdatedAts?: Readonly<Record<string, number>>;
}>;

export type ChangeCheckpointDecision =
    | 'critical'
    | 'unsupported';

export type ChangeCheckpointBlockedReason =
    | 'unsupported-kind'
    | 'unsupported-hint'
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
    discussion: { plannerOwner: 'discussions', snapshotDomain: 'discussions-level-triggered' },
    feed: { plannerOwner: 'feed', snapshotDomain: 'feed' },
    friends: { plannerOwner: 'friends', snapshotDomain: 'friends' },
    friend_request: { plannerOwner: 'friends', snapshotDomain: 'friends' },
    friend_accepted: { plannerOwner: 'friends', snapshotDomain: 'friends' },
    kv: { plannerOwner: 'kv', snapshotDomain: 'todos' },
    machine: { plannerOwner: 'machines', snapshotDomain: 'machines' },
    machineRecipientAccess: { plannerOwner: 'machines', snapshotDomain: 'machines' },
    machinePool: { plannerOwner: 'machine-pools', snapshotDomain: 'machine-pools' },
    pet: { plannerOwner: 'pets', snapshotDomain: 'pets' },
    savedSecretResource: { plannerOwner: 'saved-secrets', snapshotDomain: 'saved-secret-resource-catalog' },
    pluginDomain: { plannerOwner: 'plugin-domain', snapshotDomain: 'plugin-domain-level-triggered' },
    session: { plannerOwner: 'sessions', snapshotDomain: 'sessions-and-session-messages' },
    share: { plannerOwner: 'sessions', snapshotDomain: 'sessions' },
} satisfies Record<ChangeKind, ChangeCheckpointCoverageEntry>;

/** Undefined on the delivered wake means recovery when it carries the legacy unaddressed key. */
export type WorkflowSectionChanges = 'none' | 'all' | readonly string[];

export type PlannedChangeActions = {
    changes: ApiChangeEntry[];
    /** The planner's resource/source/authority decision, independent of unrelated Account domains. */
    machineResourcesAffect: boolean;
    /** Structural managed membership/access invalidation; exact content uses the row ids below. */
    managedMachineInventoryAffect: boolean;
    /** Exact row reads suffice; absent means structural/access/unknown recovery. */
    managedMachineChangedIds?: readonly string[];
    /** Account cursor consumed before this page; absent callers retain conservative accounting. */
    afterCursor?: number;
    workflowRunIdsToRefresh: string[];
    sessionIdsToCatchUp: string[];
    /**
     * Listed Sessions whose change can only have altered their own row. They are
     * refreshed by id; only `invalidate.sessions` re-reads which Sessions are listed.
     * Empty whenever `invalidate.sessions` is set, since that refresh hydrates them too.
     */
    sessionRowRefreshIds: string[];
    sessionTranscriptRepairs: PlannedSessionTranscriptRepair[];
    sessionFolderAssignmentSessionIds: string[];
    sessionOrganization: PlannedSessionOrganizationAction;
    workflowSectionChanges: WorkflowSectionChanges;
    /** Organizer-private resource membership affects only these collection spaces. */
    resourceSpaceMembershipSpaceIds?: readonly string[];
    unsupportedChanges: UnsupportedChangeMarker[];
    invalidate: {
        sessions: boolean;
        sessionFolderAssignments: boolean;
        machines: boolean;
        machinePools: boolean;
        artifacts: boolean;
        settings: boolean;
        profile: boolean;
        publicProfile: boolean;
        friends: boolean;
        feed: boolean;
        automations: boolean;
        pets: boolean;
        savedSecretResources: boolean;
    };
    kv: PlannedKvAction;
    sessionDrafts?: Array<{ address: SessionDraftAddressV2; revision: number }>;
    authoringMemoryKeys?: string[];
    projectAccountRowKeys?: string[];
};

function claimsProjectAccountRow(change: ApiChangeEntry): boolean {
    return change.kind === 'account' && (change.entityId.startsWith(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1)
        || (isRecord(change.hint) && 'projectAccountRow' in change.hint));
}

export function getChangeProjectAccountRowHint(change: ApiChangeEntry) {
    if (change.kind !== 'account') return null;
    const key = parseProjectAccountRowPhysicalKeyV1(change.entityId);
    if (!key) return null;
    const parsed = ProjectAccountRowChangeHintV1Schema.safeParse(change.hint);
    return parsed.success && buildProjectAccountRowPhysicalKeyV1(parsed.data.key) === buildProjectAccountRowPhysicalKeyV1(key)
        ? parsed.data : null;
}

export function getChangeAuthoringMemoryHint(change: ApiChangeEntry) {
    if (change.kind !== 'account') return null;
    const parsed = AuthoringMemoryChangeHintV1Schema.safeParse(change.hint);
    return parsed.success ? parsed.data : null;
}

/** Every protocol-owned private Account row key (catalogs, controls, preferences) lives under this namespace. */
function isPrivateAccountRowEntityId(entityId: string): boolean {
    return entityId.startsWith('@happier/account/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

const knownChangeKinds = new Set<string>(ChangeKindSchema.options);

function isKnownChangeKind(kind: string): kind is ChangeKind {
    return knownChangeKinds.has(kind);
}

/** Kind-only relevance never claims that advisory entities have been consumed. */
export function accountChangeKindsAffectSessionSnapshots(changeKinds: readonly string[] | undefined): boolean {
    return changeKinds === undefined || changeKinds.length === 0 || changeKinds.some(kind =>
        !isKnownChangeKind(kind) || kind === 'account' || isSessionSystemRecordChangeKind(kind));
}

export function readWorkflowRunAccountChangeRunId(entityId: string): string | null {
    return entityId.startsWith('workflow-run:') ? entityId.slice('workflow-run:'.length) : null;
}

/** A Run receipt changes its own projection; Discussion publication has its own change kind. */
export function isWorkflowRunOnlyAccountChange(
    changeKinds: readonly string[] | undefined,
    entityIds: readonly string[] | undefined,
): boolean {
    return changeKinds !== undefined && changeKinds.length > 0 && changeKinds.every(kind => kind === 'account')
        && entityIds !== undefined && entityIds.length > 0
        && entityIds.every(entityId => Boolean(readWorkflowRunAccountChangeRunId(entityId)));
}

/** Machine/Preset readers consume resource, source and authority changes, never unrelated content. */
export function accountChangeKindsAffectMachineResources(
    changeKinds: readonly string[] | undefined,
    entityIds: readonly string[] | undefined,
): boolean {
    if (changeKinds?.length && changeKinds.every(kind => kind === 'account') && entityIds?.length) {
        return plannedChangesAffectMachineResources(planSyncActionsFromChanges(entityIds.map(entityId => ({
            kind: 'account', entityId, cursor: 0, changedAt: 0,
        }))));
    }
    return changeKinds === undefined || changeKinds.length === 0 || changeKinds.some(kind => !isKnownChangeKind(kind)
        || kind === 'account' || isMachineProjectionChangeKindV1(kind) || kind === 'machinePool'
        || kind === 'pluginDomain' || kind === 'savedSecretResource');
}

/** Detailed pages retain each entity's kind, so unrelated mixed pages can stay quiet too. */
export function plannedChangesAffectMachineResources(planned: PlannedChangeActions): boolean {
    return planned.unsupportedChanges.length > 0 || planned.machineResourcesAffect;
}

/** Team counts include the resource catalogs plus Session, sharing and Discussion membership. */
export function plannedChangesAffectTeamSharedResources(planned: PlannedChangeActions): boolean {
    return plannedChangesAffectMachineResources(planned) || planned.invalidate.artifacts
        || planned.changes.some(change => change.kind === 'session' || change.kind === 'share' || change.kind === 'discussion');
}

export function accountChangeKindsAffectManagedMachineInventory(
    changeKinds: readonly string[] | undefined,
    entityIds: readonly string[] | undefined,
): boolean {
    if (changeKinds?.length && changeKinds.every(kind => kind === 'account') && entityIds?.length) {
        return plannedChangesAffectManagedMachineInventory(planSyncActionsFromChanges(entityIds.map(entityId => ({
            kind: 'account', entityId, cursor: 0, changedAt: 0,
        }))));
    }
    return changeKinds === undefined || changeKinds.length === 0 || changeKinds.some(kind => !isKnownChangeKind(kind)
        || kind === 'account' || kind === MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1);
}

export function plannedChangesAffectManagedMachineInventory(planned: PlannedChangeActions): boolean {
    return planned.unsupportedChanges.length > 0 || planned.managedMachineInventoryAffect
        || (planned.managedMachineChangedIds?.length ?? 0) > 0;
}

function hasPendingHint(change: ApiChangeEntry): boolean {
    const hint = change.hint;
    return (
        isRecord(hint)
        && (typeof hint.pendingVersion === 'number' || typeof hint.pendingCount === 'number')
    );
}

function hasSessionFolderAssignmentHint(change: ApiChangeEntry): boolean {
    const hint = change.hint;
    return isRecord(hint) && (
        hint.sessionFolderAssignment === true
        || hint.sessionFolderAssignments === true
    );
}

function hasSessionOrganizationHint(change: ApiChangeEntry): boolean {
    return SessionOrganizationChangeHintSchema.safeParse(change.hint).success;
}

function readSessionOrganizationHint(change: ApiChangeEntry) {
    const parsed = SessionOrganizationChangeHintSchema.safeParse(change.hint);
    return parsed.success ? parsed.data : null;
}

export function getChangeSessionDraftHint(change: ApiChangeEntry): SessionDraftChangeHintV1 | SessionDraftChangeHintV2 | null {
    if (change.kind !== 'account') return null;
    const schema = isRecord(change.hint) && change.hint.v === 2
        ? SessionDraftChangeHintV2Schema
        : SessionDraftChangeHintV1Schema;
    const parsed = schema.safeParse(change.hint);
    return parsed.success ? parsed.data : null;
}

function readHintStringArray(change: ApiChangeEntry, key: string): string[] {
    const hint = change.hint;
    if (!isRecord(hint)) return [];
    const value = hint[key];
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
}

function readOrganizationOrderScopes(change: ApiChangeEntry): Array<{ scopeKind: 'pinned' | 'folder' | 'tag' | 'workspace' | 'group'; scopeKey: string }> {
    const hint = change.hint;
    if (!isRecord(hint) || !Array.isArray(hint.orderScopes)) return [];
    const out: Array<{ scopeKind: 'pinned' | 'folder' | 'tag' | 'workspace' | 'group'; scopeKey: string }> = [];
    for (const scope of hint.orderScopes) {
        if (!isRecord(scope)) continue;
        const scopeKind = typeof scope.scopeKind === 'string' ? scope.scopeKind : '';
        const scopeKey = typeof scope.scopeKey === 'string' ? scope.scopeKey.trim() : '';
        if (
            (scopeKind === 'pinned' || scopeKind === 'folder' || scopeKind === 'tag' || scopeKind === 'workspace' || scopeKind === 'group')
            && scopeKey
        ) {
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

function requiresFollowSessionRefresh(change: ApiChangeEntry): boolean {
    return change.kind === 'account' && change.entityId === ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID;
}

export function changeRequiresSavedSecretCatalogRefresh(change: Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>): boolean {
    return change.kind === 'savedSecretResource'
        || (change.kind === 'account' && change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || readConnectedServicesAccountChangeV1(change) !== null
        || isAccountCurrentnessChangeV1(change);
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
    if (isSessionSystemRecordChangeEntityV1(change)) {
        return readSessionSystemRecordChangeV1(change)
            ? { kind, cursor, entityId, decision: 'critical', plannerOwner: 'session-system-records',
                snapshotDomain: 'session-system-records', materializationProof: 'session-system-records-invalidation' }
            : { kind, cursor, entityId, decision: 'unsupported', plannerOwner: 'session-system-records',
                snapshotDomain: null, materializationProof: null, blockedReason: 'unsupported-hint' };
    }
    if (kind === 'account' && isProfileCatalogAccountChangeEntityIdV1(entityId)) {
        return { kind, cursor, entityId, decision: 'critical', plannerOwner: 'profile-catalog',
            snapshotDomain: 'profile-catalog', materializationProof: 'profile-catalog-wake' };
    }

    if (claimsProjectAccountRow(change)) {
        return getChangeProjectAccountRowHint(change)
            ? { kind, cursor, entityId, decision: 'critical', plannerOwner: 'project-account-rows',
                snapshotDomain: 'project-account-rows', materializationProof: 'project-account-rows' }
            : { kind, cursor, entityId, decision: 'unsupported', plannerOwner: 'project-account-rows',
                snapshotDomain: null, materializationProof: null, blockedReason: 'unsupported-hint' };
    }

    if (getChangeAuthoringMemoryHint(change)) {
        return { kind, cursor, entityId, decision: 'critical', plannerOwner: 'authoring-memory',
            snapshotDomain: 'authoring-memory', materializationProof: 'authoring-memory' };
    }

    if (requiresFollowSessionRefresh(change)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'critical',
            plannerOwner: 'sessions',
            snapshotDomain: 'sessions',
            materializationProof: 'sessions',
        };
    }

    if (kind === 'account' && readWorkflowRunAccountChangeRunId(entityId)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'critical',
            plannerOwner: 'workflow-runs',
            snapshotDomain: 'workflow-run',
            materializationProof: 'workflow-run',
        };
    }

    if (getChangeSessionDraftHint(change)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'critical',
            plannerOwner: 'session-drafts',
            snapshotDomain: 'session-drafts',
            materializationProof: 'session-draft',
        };
    }

    if ((kind === 'account' || kind === 'session') && hasSessionOrganizationHint(change)) {
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

    if (isSessionSystemRecordChangeKind(kind)) {
        if (kind === 'session' && hasSessionFolderAssignmentHint(change)) {
            return {
                kind,
                cursor,
                entityId,
                decision: 'critical',
                plannerOwner: 'sessions',
                snapshotDomain: 'session-folder-assignments',
                materializationProof: 'session-folder-assignment-refresh',
            };
        }

        if (hasPendingHint(change)) {
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

    }

    if (kind === 'account' && hasSessionFolderAssignmentHint(change)) {
        return {
            kind,
            cursor,
            entityId,
            decision: 'critical',
            plannerOwner: 'sessions',
            snapshotDomain: 'session-folder-assignments',
            materializationProof: 'session-folder-assignment-refresh',
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

/**
 * Hint keys that only row-level Session writes carry: transcript commits and edits,
 * shared metadata, read cursors, pending-queue and ready projections
 * metadata, agent-state and runtime-activity writes, and discussions.
 *
 * AccountChange rows are coalesced per Session, so a hint describes only the latest
 * write. A hidden membership fact is still recovered: the exact row refresh re-reads
 * archive state, and a deleted or revoked Session fails that read and escalates to a
 * list refresh. Any hint outside this set (archive, deletion, responsibility, or a
 * future producer) conservatively re-reads the list.
 */
export function isRowLevelSessionChangeHint(hint: unknown): boolean {
    if (hint === null || hint === undefined) return true;
    if (!isRecord(hint)) return false;
    const keys = Object.keys(hint);
    return keys.every((key) => SESSION_ROW_ONLY_HINT_KEYS.has(key))
        // `v` alone versions some other hint family; it is not a row write by itself.
        && keys.some((key) => key !== 'v');
}

export type SessionChangePlanningContext = Readonly<{
    /**
     * Whether this Session is already in a loaded list membership of the planned Home.
     * Its presence also marks a focused-Home plan whose batch-read rows are placed
     * into lists in place, so loaded and unloaded row writes both stay row-level.
     */
    isSessionListMember?(sessionId: string): boolean;
    afterCursor?: number;
}>;

/**
 * A Session-only wake's explicit empty record set proves known row-only writes
 * at publication. Without a feed cursor, only retained rows use exact placement.
 */
export function planSyncActionsFromHomeWake(
    changes: ApiChangeEntry[],
    rowOnly = false,
    isSessionListMember?: (sessionId: string) => boolean,
): PlannedChangeActions {
    const knownRows = rowOnly && isSessionListMember && changes.length > 0
        && changes.every(change => change.kind === 'session' && isSessionListMember(change.entityId));
    return planSyncActionsFromChanges(changes, knownRows ? { isSessionListMember } : undefined);
}

export function planSyncActionsFromChanges(
    changes: ApiChangeEntry[],
    context?: SessionChangePlanningContext,
): PlannedChangeActions {
    const sessionIds = new Set<string>();
    const sessionRowRefreshIds = new Set<string>();
    const sessionTranscriptRepairs = new Map<string, {
        minSeq: number;
        messageIds: Set<string>;
        messageSeqs: Record<string, number>;
        // `null` once any hint for the message lacks its revision: that message keeps its read.
        messageUpdatedAts: Map<string, number | null>;
    }>();
    const sessionFolderAssignmentSessionIds = new Set<string>();
    const organizationAssignmentSessionIds = new Set<string>();
    const organizationFolderIds = new Set<string>();
    const organizationTagIds = new Set<string>();
    const organizationDeletedTagIds = new Set<string>();
    const organizationOrderScopes = new Map<string, { scopeKind: 'pinned' | 'folder' | 'tag' | 'workspace' | 'group'; scopeKey: string }>();
    const unsupportedChanges: UnsupportedChangeMarker[] = [];
    let invalidateSessions = false;
    let invalidateSessionFolderAssignments = false;
    let organizationRefresh = false;
    const changedWorkflowAssignments = new Set<string>();
    let workflowSectionsNeedSnapshot = false;
    const resourceSpaceMembershipSpaceIds = new Set<string>();
    let organizationIncludeFolders = false;
    let organizationIncludeTags = false;
    let organizationIncludeLabels = false;
    let invalidateMachines = false;
    let machineResourcesAffect = false;
    let managedMachineInventoryAffect = false;
    const managedMachineChangedIds = new Set<string>();
    let invalidateMachinePools = false;
    let invalidateArtifacts = false;
    let invalidateSettings = false;
    let invalidateProfile = false;
    let invalidatePublicProfile = false;
    let invalidateFriends = false;
    let invalidateFeed = false;
    let invalidateAutomations = false;
    let invalidatePets = false;
    let invalidateSavedSecretResources = false;

    let kvFull = false;
    const kvKeys = new Set<string>();
    const sessionDrafts = new Map<string, { address: SessionDraftAddressV2; revision: number }>();
    const authoringMemoryKeys = new Set<string>();
    const projectAccountRowKeys = new Set<string>();
    const workflowRunIdsToRefresh = new Set<string>();

    for (const change of changes) {
        const kind = change.kind;
        if (!isKnownChangeKind(String(kind))) {
            invalidatePublicProfile = true;
            unsupportedChanges.push({
                cursor: String(change.cursor),
                kind: String(kind),
                entityId: String(change.entityId ?? ''),
            });
            continue;
        }

        if (kind !== 'account' && accountChangeKindsAffectMachineResources([kind], [change.entityId])) {
            machineResourcesAffect = true;
        }
        if (kind === MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1) managedMachineInventoryAffect = true;

        // Reserved row hints are admitted before any generic Account refresh privilege.
        if (kind === 'account' && change.entityId === 'public-profile') {
            invalidatePublicProfile = true;
            continue;
        }
        if (kind === 'account' && (isProfileCatalogAccountChangeEntityIdV1(change.entityId)
            || change.entityId === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1
            || change.entityId === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1)) continue;
        // Deployment observers consume these exact keys. They change neither
        // Account settings/profile nor Session membership on content-free wakes.
        if (isDeploymentAccountChange(change)) continue;
        if (isSessionSystemRecordChangeEntityV1(change)) {
            if (!readSessionSystemRecordChangeV1(change)) unsupportedChanges.push({ cursor: String(change.cursor), kind: String(kind), entityId: change.entityId });
            continue;
        }
        if (claimsProjectAccountRow(change)) {
            if (getChangeProjectAccountRowHint(change)) projectAccountRowKeys.add(change.entityId);
            else unsupportedChanges.push({ cursor: String(change.cursor), kind: String(kind), entityId: change.entityId });
            continue;
        }

        const sessionDraftHint = getChangeSessionDraftHint(change);
        if (sessionDraftHint) {
            const key = canonicalSessionDraftAddressV2(sessionDraftHint.address);
            const current = sessionDrafts.get(key);
            if (!current || sessionDraftHint.revision > current.revision) {
                sessionDrafts.set(key, { address: sessionDraftHint.address, revision: sessionDraftHint.revision });
            }
            continue;
        }
        // A content-free wake names only the draft row (each composer keystroke writes one);
        // its feed row carries the hint above. It changes neither Settings nor the profile.
        if (kind === 'account' && readSessionDraftAccountChangeEntityIdV2(change.entityId) !== null) continue;

        if (isSessionSystemRecordChangeKind(kind)) {
            if (kind === 'session' && hasSessionFolderAssignmentHint(change)) {
                if (typeof change.entityId === 'string' && change.entityId.length > 0) {
                    sessionFolderAssignmentSessionIds.add(change.entityId);
                    organizationAssignmentSessionIds.add(change.entityId);
                }
                for (const folderId of readHintStringArray(change, 'folderIds')) organizationFolderIds.add(folderId);
                invalidateSessionFolderAssignments = true;
                organizationRefresh = true;
                continue;
            }
            if (kind === 'session' && hasSessionOrganizationHint(change)) {
                const organizationHint = readSessionOrganizationHint(change);
                organizationRefresh = true;
                if (typeof change.entityId === 'string' && change.entityId.length > 0) {
                    organizationAssignmentSessionIds.add(change.entityId);
                }
                for (const sessionId of readHintStringArray(change, 'sessionIds')) organizationAssignmentSessionIds.add(sessionId);
                for (const folderId of readHintStringArray(change, 'folderIds')) organizationFolderIds.add(folderId);
                for (const tagId of readHintStringArray(change, 'tagIds')) organizationTagIds.add(tagId);
                for (const tagId of organizationHint?.deletedTagIds ?? []) organizationDeletedTagIds.add(tagId);
                for (const scope of readOrganizationOrderScopes(change)) organizationOrderScopes.set(`${scope.scopeKind}:${scope.scopeKey}`, scope);
                const hintScope = isRecord(change.hint) && typeof change.hint.scope === 'string' ? change.hint.scope : '';
                // A standing change moves rows between the attention band and the rest of the
                // list exactly the way a pin change moves them in and out of the pinned group,
                // so the session list has to be re-read for both.
                if (hintScope === 'pins' || hintScope === 'attentionStandings') {
                    invalidateSessions = true;
                }
                organizationIncludeFolders = organizationIncludeFolders || hintScope === 'folders' || hintScope === 'folderAssignments';
                organizationIncludeTags = organizationIncludeTags || hintScope === 'tags' || hintScope === 'tagAssignments';
                organizationIncludeLabels = organizationIncludeLabels || hintScope === 'labels';
                continue;
            }
            // A focused-Home plan (it carries list membership context) batch-reads the
            // row and places it by the Home's published membership facts, whether or
            // not the row is loaded yet (`placeSessionListRows`). Without that context
            // an unloaded row stays a conservative list refresh.
            const rowLevel = kind === 'session'
                && typeof change.entityId === 'string'
                && change.entityId.length > 0
                && (context?.isSessionListMember !== undefined)
                && isRowLevelSessionChangeHint(change.hint);
            if (rowLevel) {
                sessionRowRefreshIds.add(change.entityId);
            } else {
                invalidateSessions = true;
            }
            if (typeof change.entityId === 'string' && change.entityId.length > 0) {
                sessionIds.add(change.entityId);
                const updatedMessage = readSessionUpdatedMessageChangeHintV1(change);
                if (updatedMessage) {
                    let repair = sessionTranscriptRepairs.get(change.entityId);
                    if (!repair) {
                        repair = { minSeq: updatedMessage.seq, messageIds: new Set(), messageSeqs: {}, messageUpdatedAts: new Map() };
                        sessionTranscriptRepairs.set(change.entityId, repair);
                    }
                    repair.minSeq = Math.min(repair.minSeq, updatedMessage.seq);
                    repair.messageIds.add(updatedMessage.messageId);
                    repair.messageSeqs[updatedMessage.messageId] = updatedMessage.seq;
                    const knownUpdatedAt = repair.messageUpdatedAts.get(updatedMessage.messageId);
                    repair.messageUpdatedAts.set(updatedMessage.messageId,
                        updatedMessage.updatedAt === undefined || knownUpdatedAt === null ? null
                            : Math.max(knownUpdatedAt ?? updatedMessage.updatedAt, updatedMessage.updatedAt));
                }
            }
            continue;
        }

        if (kind === 'account' && change.entityId !== 'self' && ManagedMachinePolicyChangeHintV1Schema.safeParse(change.hint).success) {
            machineResourcesAffect = true;
            managedMachineChangedIds.add(change.entityId);
            continue;
        }

        if (kind === 'account') {
            if (change.entityId.startsWith(MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1)) continue;
            // Receiver demand is routed separately from the ordinary Session
            // projection. This key changes neither Settings nor the Account profile.
            if (readSessionFollowReceiverChangeV1(change) !== null) continue;
            // Disclosure changes only the exact activity reader, never secret material or Settings.
            if (readSavedSecretDisclosureActivityEntityIdV1(change.entityId) !== null) continue;
            const authoringMemoryHint = getChangeAuthoringMemoryHint(change);
            if (authoringMemoryHint) {
                authoringMemoryKeys.add(authoringMemoryHint.key);
                continue;
            }
            if (changeRequiresSavedSecretCatalogRefresh(change)) {
                invalidateSavedSecretResources = true;
                machineResourcesAffect = true;
            }
            if (change.entityId !== 'self' && readConnectedServicesAccountChangeV1(change)) {
                // The Account profile owns Connected Service status and descriptors;
                // these dedicated rows do not change encrypted Account settings.
                invalidateProfile = true;
                machineResourcesAffect = true;
                continue;
            }
            if (change.entityId === ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1) {
                // Linked providers live on the Account profile; encrypted Settings are unchanged.
                invalidateProfile = true;
                machineResourcesAffect = true;
                continue;
            }
            const runId = readWorkflowRunAccountChangeRunId(change.entityId);
            if (runId !== null) {
                if (runId) workflowRunIdsToRefresh.add(runId);
                continue;
            }
            if (change.entityId === ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID) {
                if (requiresFollowSessionRefresh(change)) invalidateSessions = true;
                continue;
            }
            // Saved recipes are materialized by the shared presets resource. Preserve
            // their exact routing key without refreshing unrelated Account settings.
            if (change.entityId === MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1) {
                machineResourcesAffect = true;
                continue;
            }
            if (
                change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
                || change.entityId === TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1
                || change.entityId === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1
                || isProviderAccountUsageChangeEntityIdV1(change.entityId)
            ) {
                // Scoped snapshot materialization consumes these stable entity
                // IDs before the cursor advances. Usage observations likewise
                // wake Usage, not Account profile or encrypted Settings readers.
                if (!isProviderAccountUsageChangeEntityIdV1(change.entityId)) {
                    machineResourcesAffect = true;
                }
                if (change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
                    || change.entityId === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1) managedMachineInventoryAffect = true;
                // Team and Group membership are also authorization inputs for
                // shared Saved Secrets, so retire material at this same wake
                // and let the catalog owner re-observe current grants.
                continue;
            }
            if (
                change.entityId === 'session-folder-assignments'
                || hasSessionFolderAssignmentHint(change)
            ) {
                invalidateSessionFolderAssignments = true;
                organizationRefresh = true;
                for (const folderId of readHintStringArray(change, 'folderIds')) organizationFolderIds.add(folderId);
                continue;
            }
            const organizationHint = readSessionOrganizationHint(change);
            const workflowAssignmentId = readWorkflowFolderAssignmentChangeEntityIdV1(change.entityId);
            if (change.entityId === SESSION_ORGANIZATION_FOLDERS_CHANGE_ENTITY_ID_V1
                || organizationHint?.scope === 'folders'
                || (change.entityId === 'session-organization' && !organizationHint)) {
                workflowSectionsNeedSnapshot = true;
            } else if (workflowAssignmentId !== null) {
                changedWorkflowAssignments.add(workflowAssignmentId);
            } else if (organizationHint?.scope === 'folderAssignments') {
                for (const id of organizationHint.resourceIds ?? []) changedWorkflowAssignments.add(id);
            }
            if (organizationHint) {
                if (organizationHint?.scope === 'resourceSpaceMemberships') {
                    for (const spaceId of organizationHint.spaceIds ?? []) resourceSpaceMembershipSpaceIds.add(spaceId);
                    continue;
                }
                organizationRefresh = true;
                for (const sessionId of readHintStringArray(change, 'sessionIds')) organizationAssignmentSessionIds.add(sessionId);
                for (const folderId of readHintStringArray(change, 'folderIds')) organizationFolderIds.add(folderId);
                for (const tagId of readHintStringArray(change, 'tagIds')) organizationTagIds.add(tagId);
                for (const tagId of organizationHint?.deletedTagIds ?? []) organizationDeletedTagIds.add(tagId);
                for (const scope of readOrganizationOrderScopes(change)) organizationOrderScopes.set(`${scope.scopeKind}:${scope.scopeKey}`, scope);
                const hintScope = isRecord(change.hint) && typeof change.hint.scope === 'string' ? change.hint.scope : '';
                // A standing change moves rows between the attention band and the rest of the
                // list exactly the way a pin change moves them in and out of the pinned group,
                // so the session list has to be re-read for both.
                if (hintScope === 'pins' || hintScope === 'attentionStandings') {
                    invalidateSessions = true;
                }
                organizationIncludeFolders = organizationIncludeFolders || hintScope === 'folders' || hintScope === 'folderAssignments';
                organizationIncludeTags = organizationIncludeTags || hintScope === 'tags' || hintScope === 'tagAssignments';
                organizationIncludeLabels = organizationIncludeLabels || hintScope === 'labels';
                continue;
            }
            invalidateSettings = true;
            // Private Account catalog rows live beside, not in, the Account profile, and no
            // server Machine projection reads them (a fresh Account's first boot initializes
            // several). Unknown Account ids keep the conservative Settings + Profile recovery.
            if (readAccountSettingsVersionChangeV1(change) === null && !isPrivateAccountRowEntityId(change.entityId)) {
                machineResourcesAffect = true;
                if (!isProviderAccountUsageRefreshChangeEntityIdV1(change.entityId)) managedMachineInventoryAffect = true;
            }
            if (!isPrivateAccountRowEntityId(change.entityId)) {
                invalidateProfile = true;
                // Settings versions carry no public identity or publication change.
                if (readAccountSettingsVersionChangeV1(change) === null) invalidatePublicProfile = true;
            }
            continue;
        }

        if (isMachineProjectionChangeKindV1(kind)) {
            invalidateMachines = true;
            continue;
        }

        if (kind === 'machinePool') {
            invalidateMachinePools = true;
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

        if (changeRequiresSavedSecretCatalogRefresh(change)) {
            invalidateSavedSecretResources = true;
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

    return {
        changes: [...changes],
        machineResourcesAffect,
        managedMachineInventoryAffect,
        ...(managedMachineInventoryAffect || unsupportedChanges.length || managedMachineChangedIds.size === 0 ? {} : { managedMachineChangedIds: [...managedMachineChangedIds] }),
        ...(context?.afterCursor !== undefined ? { afterCursor: context.afterCursor } : {}),
        workflowRunIdsToRefresh: [...workflowRunIdsToRefresh].sort(),
        sessionIdsToCatchUp: Array.from(sessionIds).sort(),
        sessionRowRefreshIds: invalidateSessions ? [] : Array.from(sessionRowRefreshIds).sort(),
        sessionTranscriptRepairs: Array.from(sessionTranscriptRepairs.entries())
            .map(([sessionId, repair]) => {
                const messageUpdatedAts = Object.fromEntries([...repair.messageUpdatedAts]
                    .filter((entry): entry is [string, number] => entry[1] !== null));
                return {
                    sessionId,
                    minSeq: repair.minSeq,
                    messageIds: Array.from(repair.messageIds).sort(),
                    messageSeqs: repair.messageSeqs,
                    ...(Object.keys(messageUpdatedAts).length > 0 ? { messageUpdatedAts } : {}),
                };
            })
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
        sessionFolderAssignmentSessionIds: Array.from(sessionFolderAssignmentSessionIds).sort(),
        workflowSectionChanges: workflowSectionsNeedSnapshot ? 'all'
            : changedWorkflowAssignments.size ? [...changedWorkflowAssignments] : 'none',
        sessionOrganization: organizationRefresh
            ? {
                mode: 'snapshot',
                assignmentSessionIds: Array.from(organizationAssignmentSessionIds).sort(),
                folderIds: Array.from(organizationFolderIds).sort(),
                tagIds: Array.from(organizationTagIds).sort(),
                deletedTagIds: Array.from(organizationDeletedTagIds).sort(),
                orderScopes: Array.from(organizationOrderScopes.values()),
                includeFolders: organizationIncludeFolders,
                includeTags: organizationIncludeTags,
                includeLabels: organizationIncludeLabels,
            }
            : { mode: 'none' },
        resourceSpaceMembershipSpaceIds: [...resourceSpaceMembershipSpaceIds].sort(),
        unsupportedChanges,
        invalidate: {
            sessions: invalidateSessions,
            sessionFolderAssignments: invalidateSessionFolderAssignments,
            machines: invalidateMachines,
            machinePools: invalidateMachinePools,
            artifacts: invalidateArtifacts,
            settings: invalidateSettings,
            profile: invalidateProfile,
            publicProfile: invalidatePublicProfile,
            friends: invalidateFriends,
            feed: invalidateFeed,
            automations: invalidateAutomations,
            pets: invalidatePets,
            savedSecretResources: invalidateSavedSecretResources,
        },
        kv,
        authoringMemoryKeys: [...authoringMemoryKeys].sort(),
        projectAccountRowKeys: [...projectAccountRowKeys].sort(),
        sessionDrafts: [...sessionDrafts.values()].sort((left, right) => (
            canonicalSessionDraftAddressV2(left.address).localeCompare(canonicalSessionDraftAddressV2(right.address))
        )),
    };
}

/**
 * Projects the canonical materialization plan onto filtered-list membership.
 *
 * Most membership-changing facts already require the incumbent Sessions refresh.
 * Team/Group changes and tag organization changes are the two strict-query-only
 * additions: released owner/direct Session snapshots do not consume them, while
 * the filtered query does. Keeping the projection here prevents each list consumer
 * from reinterpreting raw AccountChange hints.
 */
export function plannedChangesAffectSessionListQuery(
    planned: PlannedChangeActions,
): boolean | 'structural' {
    if (plannedChangesAffectEverySessionListQuery(planned)) return true;
    // A row-level write leaves ordinary-answerable corpora as they are, but a
    // structural selection (Team, tag, attention, scope) may be decided by that row.
    return planned.sessionRowRefreshIds.length > 0 ? 'structural' : false;
}

/** Membership inputs the planned row-level Session writes can move; null keeps the conservative re-read. */
export function plannedSessionListRowMembershipFacets(
    planned: PlannedChangeActions,
): SessionListRowMembershipFacets | null {
    const rowIds = new Set(planned.sessionRowRefreshIds);
    if (rowIds.size === 0) return null;
    let metadata = false;
    let activity = false;
    for (const change of planned.changes) {
        if (change.kind !== 'session' || !rowIds.has(change.entityId)) continue;
        // A hint-less row write names no input, so it may move any of them.
        if (!isRecord(change.hint)) return { attention: true, metadata: true, activity: true };
        for (const key of Object.keys(change.hint)) {
            if (ROW_METADATA_HINT_KEYS.has(key)) metadata = true;
            else if (ROW_ACTIVITY_HINT_KEYS.has(key)) activity = true;
        }
    }
    // Every row-only hint (transcript, Agent state, readiness, read cursor, pending)
    // can change personal attention, so attention stays movable.
    return { attention: true, metadata, activity };
}

const ROW_METADATA_HINT_KEYS: ReadonlySet<string> = new Set(['metadataVersion', 'sharedMetadataVersion']);
const ROW_ACTIVITY_HINT_KEYS: ReadonlySet<string> = new Set(['runtimeActivityRevision', 'latestTurnStatusObservedAt', 'meaningfulActivityAt']);

export type ReviewCommentChange = ReviewCommentChangesHintV1['changes'][number] & Readonly<{ reviewId: string }>;

/** Route receiver work using the feed cursor that preceded these coalesced changes. */
export function plannedSessionFollowSourceIds(planned: PlannedChangeActions): readonly string[] {
    const sourceIds = new Set<string>();
    const afterCursor = planned.afterCursor ?? Number.NaN;
    for (const change of planned.changes) {
        const receiverSource = readSessionFollowReceiverChangeV1(change);
        if (receiverSource !== null) sourceIds.add(receiverSource);
        else if (change.entityId && (change.kind === 'share'
            || (change.kind === 'session' && (
                readSessionFollowSourceChangedV1(change, afterCursor)
                || readSessionFollowReceiverAvailabilityChangedV1(change, afterCursor) !== false
            )))) sourceIds.add(change.entityId);
    }
    return [...sourceIds];
}

/** The Review publication owner supplies bodyless revisions; consumers never reinterpret raw hints. */
export function plannedReviewCommentChanges(planned: PlannedChangeActions): readonly ReviewCommentChange[] | undefined {
    const result: ReviewCommentChange[] = [];
    for (const change of planned.changes) {
        if (change.kind !== 'artifact') continue;
        const hint = readReviewCommentChangesHintV1(change.hint);
        if (hint) result.push(...hint.changes.map(item => ({ reviewId: change.entityId, ...item })));
        else if (artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint) ?? undefined, [REVIEW_ARTIFACT_KIND_V1])) return undefined;
    }
    return result;
}

/** The existing focused Home fanout consumes this decision, not copied key/hint classifiers. */
/** A partial page cannot exclude a kind whose retained change has no classification. */
export function plannedArtifactKinds(planned: PlannedChangeActions): readonly string[] | undefined {
    const kinds = new Set<string>();
    for (const change of planned.changes) {
        if (change.kind !== 'artifact') continue;
        const changedKinds = readArtifactKindsChangeHintV1(change.hint);
        if (changedKinds === null) return undefined;
        for (const kind of changedKinds) kinds.add(kind);
    }
    return kinds.size > 0 ? [...kinds].sort() : undefined;
}

/** One relevance decision for exact-kind observers of early wakes and consumed pages. */
export function homeAccountChangeAffectsArtifactKinds(event: HomeAccountChangeEvent, selectedKinds: readonly string[]): boolean {
    if (event.source === 'connected' || event.source === 'snapshot' || !event.changeKinds?.length) return true;
    if (!event.changeKinds.includes('artifact')) return false;
    return artifactKindsMayIncludeKindV1(event.artifactKinds, selectedKinds);
}

/** Detailed organization hints select spaces; an early bodyless organization wake retains recovery. */
export function homeAccountChangeAffectsResourceSpaceMembership(event: HomeAccountChangeEvent, spaceId: string | undefined): boolean {
    if (spaceId === undefined) return false;
    if (event.resourceSpaceMembershipSpaceIds !== undefined) return event.resourceSpaceMembershipSpaceIds.includes(spaceId);
    return event.changeKinds?.includes('account') === true && event.entityIds?.includes('session-organization') === true;
}

/**
 * Profiles are Profile rows, the legacy Settings source, their saved secrets and launch-profile
 * Artifacts. An Artifact row of another known kind (Runs, Discussions, documents) cannot change
 * them; rows without kind hints stay conservative.
 */
export function plannedChangesAffectProfileCatalog(planned: PlannedChangeActions): boolean {
    // The catalog reads the Settings document (its legacy source), not other private Account rows.
    const settingsDocument = planned.invalidate.settings && planned.changes.some(change =>
        change.kind === 'account' && !isPrivateAccountRowEntityId(change.entityId));
    if (settingsDocument || planned.invalidate.savedSecretResources
        || planned.changes.some(change => change.kind === 'account' && isProfileCatalogAccountChangeEntityIdV1(change.entityId))) return true;
    return plannedArtifactChangesMayBeKind(planned, launchProfileArtifactSharingAdapterV1.kind);
}

/** A saved workflow's Artifact kind, from the protocol's sharing owner. */
const WORKFLOW_DEFINITION_ARTIFACT_KIND = workflowDefinitionArtifactSharingAdapterV1.kind;

/** Whether a planned Artifact row can be of this kind; a row without kind hints can be any kind. */
function plannedArtifactChangesMayBeKind(planned: PlannedChangeActions, kind: string): boolean {
    if (!planned.invalidate.artifacts) return false;
    const changedKinds = plannedArtifactKinds(planned);
    return artifactKindsMayIncludeKindV1(changedKinds, [kind]);
}

export type SessionReadinessChanges = 'all' | Readonly<{
    sessionIds: readonly string[];
    machineIds: readonly string[];
}>;

/** Selection is observed from admitted Session keys; content arrivals are not readiness demand. */
export function plannedSessionReadinessChanges(planned: PlannedChangeActions): SessionReadinessChanges {
    if (planned.unsupportedChanges.length > 0 || planned.invalidate.settings || planned.invalidate.profile
        || planned.invalidate.savedSecretResources) return 'all';
    const sessionIds = new Set<string>();
    const machineIds = new Set<string>();
    for (const change of planned.changes) {
        if (change.kind === 'share') sessionIds.add(change.entityId);
        if (isMachineProjectionChangeKindV1(change.kind)) machineIds.add(change.entityId);
        if (change.kind === 'account' && (change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
            || change.entityId === TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1
            || change.entityId === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1)) return 'all';
        if (change.kind === 'pluginDomain') {
            const parsed = PluginDomainChangeEntrySchema.safeParse(change);
            if (!parsed.success || parsed.data.hint.pluginDomain === 'availability'
                || parsed.data.hint.pluginDomain === 'settings') return 'all';
        }
    }
    return { sessionIds: [...sessionIds], machineIds: [...machineIds] };
}

/** Advisory wakes reuse the same planner; missing identity pairs retain conservative recovery. */
export function planSessionReadinessWake(changeKinds: readonly string[] | undefined, entityIds?: readonly string[]): SessionReadinessChanges {
    if (!changeKinds?.length) return 'all';
    const planned = planSyncActionsFromChanges(changeKinds.length === 1 && entityIds?.length
        ? entityIds.map(entityId => ({ kind: changeKinds[0]!, entityId, cursor: 0, changedAt: 0 }))
        : changeKinds.map(kind => ({ kind, entityId: '', cursor: 0, changedAt: 0 })));
    const changes = plannedSessionReadinessChanges(planned);
    if (changes === 'all') return changes;
    if (!changes.sessionIds.length && !changes.machineIds.length) return changes;
    if (!entityIds?.length) return 'all';
    return { sessionIds: changes.sessionIds.length ? entityIds : [], machineIds: changes.machineIds.length ? entityIds : [] };
}

export { AUTOMATION_SOURCE_STATUS_CHANGE_ENTITY_ID } from '@happier-dev/protocol/changes';

/**
 * Private trigger projections consume definitions, their sources and access, never Machine liveness or Run receipts.
 * The only Artifact a trigger names is a saved workflow (`TriggerTargetV1`), so Run, Discussion and document rows
 * cannot change one; rows without kind hints stay conservative.
 */
export function plannedChangesAffectWorkflowTriggers(planned: PlannedChangeActions): boolean {
    if (planned.changes.some(isAutomationDefinitionChangeV1) || planned.invalidate.settings || planned.invalidate.profile
        || plannedArtifactChangesMayBeKind(planned, WORKFLOW_DEFINITION_ARTIFACT_KIND)
        || planned.invalidate.savedSecretResources || planned.unsupportedChanges.length > 0) return true;
    return planned.changes.some(change => {
        if (change.kind === 'share' || change.kind === 'machineRecipientAccess') return true;
        if (change.kind !== 'pluginDomain') return false;
        const parsed = PluginDomainChangeEntrySchema.safeParse(change);
        // Collection/KV/webhook receipts cannot change the trigger definition or its authoring source.
        return !parsed.success || parsed.data.hint.pluginDomain === 'availability' || parsed.data.hint.pluginDomain === 'settings';
    });
}

/** Kind-only routing for secondary Homes; unknown Account/plugin facts retain the existing recovery read. */
export function accountChangeKindsAffectWorkflowTriggers(changeKinds: readonly string[] | undefined): boolean {
    return changeKinds === undefined || changeKinds.length === 0 || changeKinds.some(kind => !isKnownChangeKind(kind)
        || kind === 'account' || kind === 'automation' || kind === 'artifact' || kind === 'share'
        || kind === 'machineRecipientAccess' || kind === 'pluginDomain' || kind === 'savedSecretResource');
}

/**
 * Saved definitions, their trigger summaries and their access. A library row is its Artifact, the
 * Automations naming it and its shared audience: Account Settings and profile rows, Machine rows
 * and the scheduler's source-status row change none of them. Settings and profile can change the
 * Machine-contributed sources, which is the separate plugin-source fact below.
 */
export function plannedChangesAffectWorkflowDefinitions(planned: PlannedChangeActions): boolean {
    // A saved definition is a `workflow-definition.v1` Artifact: Runs, Discussions and documents are not.
    if (plannedArtifactChangesMayBeKind(planned, WORKFLOW_DEFINITION_ARTIFACT_KIND) || planned.invalidate.savedSecretResources
        || planned.unsupportedChanges.length > 0) return true;
    if (planned.changes.some(isAutomationDefinitionChangeV1)) return true;
    return plannedChangesAffectWorkflowTriggers({ ...planned, invalidate: { ...planned.invalidate,
        settings: false, profile: false, artifacts: false } });
}

/** Precise unrelated kinds cannot change saved definitions, triggers or access. */
export function accountChangeKindsAffectWorkflowDefinitions(changeKinds: readonly string[] | undefined): boolean {
    return accountChangeKindsAffectWorkflowTriggers(changeKinds);
}

/** Machine-contributed Workflow sources (the serving Machine's projection) also follow Machine rows. */
/**
 * The Automation ids when Automation rows are the only saved-definition change. Each library row
 * carries its triggers' Automation ids, so the library re-reads only the rows that show them.
 */
export function plannedWorkflowDefinitionAutomationIds(planned: PlannedChangeActions): readonly string[] | undefined {
    const ids = planned.changes.filter(isAutomationDefinitionChangeV1).map(change => change.entityId);
    if (ids.length === 0 || plannedChangesAffectWorkflowDefinitions({ ...planned,
        changes: planned.changes.filter(change => change.kind !== 'automation'),
        invalidate: { ...planned.invalidate, automations: false } })) return undefined;
    return [...new Set(ids)];
}

export function plannedChangesAffectWorkflowPluginSources(planned: PlannedChangeActions): boolean {
    return plannedChangesAffectWorkflowDefinitions(planned) || planned.invalidate.machines
        || planned.invalidate.settings || planned.invalidate.profile;
}

export function accountChangeKindsAffectWorkflowPluginSources(changeKinds: readonly string[] | undefined): boolean {
    return accountChangeKindsAffectWorkflowDefinitions(changeKinds)
        || changeKinds?.some(kind => isMachineProjectionChangeKindV1(kind)) === true;
}

/** The bus admits coarse/known kinds; exact focused-page decisions remain authoritative. */
export function homeAccountChangeAffectsProfileCatalog(
    event: Pick<HomeAccountChangeEvent, 'changeKinds' | 'profileCatalogAffects' | 'sessionSystemRecords'>,
): boolean {
    return event.profileCatalogAffects ?? (event.changeKinds === undefined || event.changeKinds.some(kind =>
        (kind === 'account' && event.sessionSystemRecords === undefined) || kind === 'artifact' || kind === 'savedSecretResource'));
}

/** Readers consume the producer's publication/visible identity decision; unknown wakes recover. */
export function homeAccountChangeAffectsPublicProfile(
    event: Pick<HomeAccountChangeEvent, 'publicProfileAffects'>,
): boolean {
    return event.publicProfileAffects ?? true;
}

/** Material belongs to resources, legacy Settings and their existing access/currentness owner. */
export function homeAccountChangeAffectsSavedSecretCatalog(
    event: Pick<HomeAccountChangeEvent, 'changeKinds' | 'entityIds' | 'accountSettingsAffects' | 'sessionSystemRecords' | 'savedSecretCatalogAffects'>,
): boolean {
    if (event.savedSecretCatalogAffects !== undefined) return event.savedSecretCatalogAffects;
    if (event.changeKinds === undefined || event.changeKinds.length === 0 || event.accountSettingsAffects === true) return true;
    if (event.changeKinds.includes('savedSecretResource')) return true;
    if (!event.changeKinds.includes('account')) return false;
    if (event.entityIds === undefined) return event.sessionSystemRecords === undefined;
    return event.entityIds.some(entityId => changeRequiresSavedSecretCatalogRefresh({ kind: 'account', entityId }));
}

/** Account rows and their legacy KV source share the planner's Settings admission. */
export function homeAccountChangeAffectsPrivateAccountRows(
    event: Pick<HomeAccountChangeEvent, 'changeKinds' | 'accountSettingsAffects'>,
): boolean {
    return event.accountSettingsAffects !== false || event.changeKinds?.includes('kv') === true;
}

function isDeploymentAccountChange(change: Readonly<{ kind: string; entityId: string; hint?: unknown }>): boolean {
    return readDeploymentAccountChangeV1(change) !== null
        || (change.kind === 'account' && change.hint === undefined
            && readDeploymentReceiptCompletionWakeV1(change.entityId) !== null);
}

/** Usage observes opened Machine inputs directly and consumes neither draft nor workflow Run rows. */
export function plannedChangesAffectUsageQuery(planned: PlannedChangeActions): boolean {
    const workflowEntityIds = new Set(planned.workflowRunIdsToRefresh.map(runId => `workflow-run:${runId}`));
    return planned.changes.some(change => {
        if (change.kind === 'kv') return !isRecord(change.hint) || change.hint.full === true
            || !Array.isArray(change.hint.keys) || change.hint.keys.includes(USAGE_COACH_SUPPRESSIONS_KV_KEY);
        if (readSessionFollowReceiverChangeV1(change) !== null) return false;
        if (readSessionSystemRecordChangeV1(change)?.address.namespace === 'surface') return false;
        if (['machine', 'machinePool', 'artifact', 'feed', 'friends', 'friend_request', 'friend_accepted',
            'pet', 'automation', 'kv', 'pluginDomain', 'savedSecretResource'].includes(change.kind)) return false;
        if (change.kind === 'account' && (change.entityId === 'public-profile'
            || change.entityId.startsWith(MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1)
            || change.entityId === NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1
            || workflowEntityIds.has(change.entityId) || getChangeSessionDraftHint(change)
            || isDeploymentAccountChange(change))) return false;
        // Session evidence, allowances, settings and unknown changes retain
        // their incumbent freshness/admission path, including on mixed pages.
        return true;
    });
}

/** Private evidence and allowance/configuration inputs do not replace admitted accounting. */
export function plannedChangesAffectUsageAccounting(planned: PlannedChangeActions): boolean {
    const relevant = planned.changes.filter(change => {
        if (change.kind === 'kv') return false;
        // Compact records publish private evidence, independently of UsageEvent
        // accounting changes. Socket wakes retain the canonical entity without
        // its feed hint; malformed detailed hints still require recovery.
        if (readSessionSystemRecordChangeV1(change) !== null
            || (change.hint === undefined && isSessionSystemRecordChangeEntityV1(change))) return false;
        // Access rosters and independent Discussions alter private evidence,
        // not the Account-owned UsageEvent/report population. Actual access
        // and usage transitions publish their independent changes as well.
        if (change.kind === 'share' || change.kind === 'machineRecipientAccess' || change.kind === 'discussion') return false;
        // The Settings owner observes the consumed Usage keys. A coarse
        // version wake cannot establish that accounting or its prices changed.
        if (readAccountSettingsVersionChangeV1(change) !== null) return false;
        if (change.kind === 'session') {
            // Transcript arrival still refreshes private evidence. Usage rows
            // have their own push; a bare message-sequence hint is not one.
            // An explicit accounting hint retains its cursor-relative proof.
            if (isRecord(change.hint) && change.hint.usageAccountingChanged === undefined
                && 'lastMessageSeq' in change.hint && getChangeTargetMessageSeq(change) !== null
                && isSessionSystemRecordUnchangedHintV1(change.hint)) return false;
            return planned.afterCursor === undefined || readSessionUsageAccountingChangedV1(change, planned.afterCursor);
        }
        if (change.kind !== 'account' || isAccountCurrentnessChangeV1(change)) return true;
        // Home/Team administration publishes reconstructible rosters and
        // policy. Account-owned UsageEvents retain their independent push.
        if (change.entityId === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1
            || change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
            || change.entityId.startsWith(MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1)) return false;
        // These canonical rows contain service configuration, allowances or
        // Machine policy, not UsageEvents, message counts or entered prices.
        // Other self changes and unknown Account rows remain conservative.
        return !isProviderAccountUsageChangeEntityIdV1(change.entityId)
            && (change.entityId === 'self' || readConnectedServicesAccountChangeV1(change) === null)
            && parseConnectedAccountCatalogPhysicalKeyV1(change.entityId) === null
            && !ManagedMachinePolicyChangeHintV1Schema.safeParse(change.hint).success;
    });
    return plannedChangesAffectUsageQuery({ ...planned, changes: relevant });
}

function plannedChangesAffectEverySessionListQuery(planned: PlannedChangeActions): boolean {
    if (planned.invalidate.sessions) return true;
    if (
        planned.sessionOrganization.mode === 'snapshot'
        && planned.sessionOrganization.includeTags
    ) {
        return true;
    }
    return planned.changes.some((change) => {
        if (change.kind !== 'account') return false;
        if (
            change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
            || change.entityId === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1
        ) return true;
        // Restricted-Team admission reads Home sign-in currentness. Dedicated
        // Connected Service rows describe provider integration credentials;
        // legacy `self` rows still carry the coarse Account currentness signal.
        return isAccountCurrentnessChangeV1(change);
    });
}
