import { readSessionViewerAttentionSignature } from '@/sync/domains/session/readState/sessionViewerAttention';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    serializeExternalSessionJsonForComparison,
    serializeExternalSessionSourceForComparison,
} from '@/sync/domains/session/external/serializeExternalSessionSourceForComparison';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import {
    readPendingAgentStateCompletedRequestSignature,
    readPendingAgentStateRequestSignature,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionContentAvailability, type SessionContentAvailabilitySubject } from '@/sync/domains/session/encryptedContentAvailability';
import { buildSessionListRowFilterFacts } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { listSessionListLookupServerSessions } from '@/sync/domains/session/listing/sessionListLookupState';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { collectRecordIds, forEachRecordValue } from './recordIteration';
import {
    createActivityStoreSigner,
    observeActivityStore,
    readActivityStoreChangeScope,
    type ActivityStoreObservation,
} from './activityStoreSignatures';

type StoreActivityAttentionSource = Pick<
    ActivityAttentionSource,
    | 'concurrentSessionListCacheByServerId'
    | 'isDataReady'
    | 'ordinarySessionListMembershipByServerId'
    | 'sessionListIndexByServerId'
    | 'sessionListRowsByServerId'
    | 'sessionMessagesById'
    | 'sessionsById'
    | 'workspacePathDisplayModeV1'
    | 'workspaceRefsV1'
    | 'followRuleWorkspaceRefsV1'
    | 'followRuleTagAssignmentsBySessionKey'
    | 'followRuleFolderAssignmentsBySessionKey'
>;

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ConcurrentSessionListCacheByServerId = {};

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readObjectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : null;
}

function joinSignatureParts(parts: readonly unknown[]): string {
    return parts.map((part) => {
        const value = part == null ? '' : String(part);
        return `${value.length}:${value}`;
    }).join('');
}

function buildWorkspaceDisplaySettingsSignature(state: StorageState, includeFollowRuleFacts: boolean): string {
    const ruleWorkspaceRefs = includeFollowRuleFacts ? readProjectAccountWorkspaceRefs(state) : undefined;
    return joinSignatureParts([
        includeFollowRuleFacts ? ruleWorkspaceRefs === undefined ? 'unavailable' : 'available' : '',
        ...readProjectWorkspaceRefs(state).map((ref) => joinSignatureParts([
            ref.id,
            ref.serverId,
            ref.machineId,
            ref.rootPath,
            ref.label,
            includeFollowRuleFacts ? ref.projectKey : '',
        ])),
    ]);
}

function readFollowRuleFactsSignature(row: Session | SessionListRenderableSession, serverId: string): string {
    return JSON.stringify([
        buildSessionListRowFilterFacts(row, serverId, { nowMs: 0, includeStatus: false }),
        row.ownerAccountId, row.origin, row.viewer?.follow, row.viewer?.relevance, row.viewer?.readState,
    ]);
}

function buildFollowRuleOrganizationSignature(state: StorageState, personalMembershipByServerId: Readonly<Record<string, readonly string[]>>,
    ruleMembershipByServerId: Readonly<Record<string, readonly string[]>>): string {
    const keys = new Set<string>();
    forEachRecordValue(state.sessions, session => {
        if (session.serverId) keys.add(buildSessionOrganizationSessionKey(session.serverId, session.id));
    });
    for (const entry of listSessionListLookupServerSessions(state)) {
        keys.add(buildSessionOrganizationSessionKey(entry.serverId, entry.session.id));
    }
    for (const membership of [personalMembershipByServerId, ruleMembershipByServerId])
        for (const [serverId, ids] of Object.entries(membership))
            for (const id of ids) keys.add(buildSessionOrganizationSessionKey(serverId, id));
    return JSON.stringify([...keys].sort().map(key => {
        const folder = state.sessionOrganizationFolderAssignmentsBySessionKey[key];
        return [key, state.sessionOrganizationTagAssignmentsBySessionKey[key]?.tagIds ?? null,
            folder === undefined ? [] : [folder.folderId]];
    }));
}

function readRuntimeIssueSignature(issue: SessionRuntimeIssueV1 | null | undefined): string {
    if (!issue) return '';
    return joinSignatureParts([
        issue.v,
        issue.scope,
        issue.status,
        issue.code,
        issue.source,
        readNumber(issue.occurredAt) ?? '',
        readNumber(issue.sessionSeq) ?? '',
        readString(issue.agentId),
        readString(issue.agentTurnId),
        readString(issue.sanitizedPreview),
    ]);
}

function readLinkedExternalSessionSignature(metadata: unknown): string {
    const link = readExternalSessionLink(metadata);
    if (!link) return '';
    return joinSignatureParts([
        link.v,
        link.agentId,
        link.machineId,
        link.remoteSessionId,
        serializeExternalSessionSourceForComparison(link.source),
        readNumber(link.lastKnownActivityAtMs) ?? '',
        serializeExternalSessionJsonForComparison(link.runtimeDescriptorV1),
        serializeExternalSessionJsonForComparison(link.linkData),
    ]);
}

function readExternalSessionAttentionSignature(metadata: unknown): string {
    const record = readObjectRecord(metadata);
    const attention = readObjectRecord(record?.externalSessionAttentionV1);
    if (attention?.v !== 1) return '';
    return joinSignatureParts([
        readString(attention.observedProgressToken),
        readString(attention.viewedProgressToken),
        readNumber(attention.observedAtMs) ?? '',
        readNumber(attention.viewedAtMs) ?? '',
    ]);
}

function readSessionMetadataActivitySignature(metadata: unknown): string {
    const record = readObjectRecord(metadata);
    const readState = readObjectRecord(record?.readStateV1);
    const displayTitle = readSessionDisplayTitleField({ metadata });
    return joinSignatureParts([
        readString(record?.path),
        readString(record?.host),
        readString(record?.homeDir),
        readString(record?.machineId),
        readString(record?.name),
        displayTitle.value ?? '',
        displayTitle.updatedAt ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        readLinkedExternalSessionSignature(metadata),
        readExternalSessionAttentionSignature(metadata),
    ]);
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasRenderablePendingRequestProjection(renderable: SessionListRenderableSession): boolean {
    return renderable.hasPendingPermissionRequests === true || renderable.hasPendingUserActionRequests === true;
}

function buildHiddenSessionSignature(session: Readonly<{
    id: string;
    metadata?: unknown;
    metadataUnavailable?: boolean;
    serverId?: string | null;
    viewer?: Session['viewer'];
    archivedAt?: number | null;
}> & SessionContentAvailabilitySubject): string {
    return joinSignatureParts([
        session.id,
        readSessionContentAvailability(session),
        session.metadataUnavailable === true ? 1 : 0,
        isUserFacingSession(session) ? 1 : 0,
        session.serverId ?? '',
        session.viewer?.attention.presentation ?? '',
        session.viewer?.attention.needsAttention === true ? 1 : 0,
        session.viewer?.attention.reasons.join(',') ?? '',
        session.viewer?.readState.state ?? '',
        session.archivedAt ?? '',
    ]);
}

function buildSessionActivitySignature(session: Session): string {
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const visibilitySession = {
        id: session.id,
        encryptionMode: session.encryptionMode,
        encryptedContentAvailability: session.encryptedContentAvailability,
        serverId: session.serverId,
        viewer: session.viewer,
        archivedAt: session.archivedAt,
        metadata: ownerMetadata,
        metadataUnavailable: session.metadataLayoutVersion === 1 && ownerMetadata == null,
    };
    if (
        !isUserFacingSession(visibilitySession)
        && !isVoiceConversationCustodySessionMetadata(ownerMetadata)
    ) {
        return buildHiddenSessionSignature(visibilitySession);
    }
    const agentState = session.agentState;
    return joinSignatureParts([
        session.id,
        readSessionContentAvailability(session),
        readSessionViewerAttentionSignature(session),
        JSON.stringify(session.access?.audienceContext ?? null),
        session.access?.capabilities.submitAgentInput === true ? 1 : 0,
        session.access?.capabilities.approveRuntimePermissions === true ? 1 : 0,
        session.serverId ?? '',
        readSessionManagerSessionIdV1(session) ?? '',
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        readNumber(session.optimisticThinkingAt) ?? '',
        session.runtimeActivityState ?? '',
        readNumber(session.runtimeActivityActiveCount) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readRuntimeIssueSignature(session.lastRuntimeIssue),
        readNumber(session.lastTurnCompletedAt) ?? '',
        readNumber(session.seq) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(session.pendingVersion) ?? '',
        readNumber(session.pendingCount) ?? '',
        readNumber(session.pendingBlockedCount) ?? '',
        hasProjectedPendingRequestCounts(session) ? readNumber(session.updatedAt) ?? '' : '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readNumber(session.agentStateVersion) ?? '',
        readPendingAgentStateRequestSignature(agentState),
        readPendingAgentStateCompletedRequestSignature(agentState),
        readSessionMetadataActivitySignature(ownerMetadata),
    ]);
}

function buildHiddenRenderableSignature(renderable: SessionListRenderableSession): string {
    return joinSignatureParts([
        renderable.id,
        readSessionContentAvailability(renderable),
        readSessionViewerAttentionSignature(renderable),
        JSON.stringify(renderable.access?.audienceContext ?? null),
        renderable.metadataUnavailable === true ? 1 : 0,
        isUserFacingSession(renderable) ? 1 : 0,
    ]);
}

function buildRenderableActivitySignature(renderable: SessionListRenderableSession): string {
    if (
        !isUserFacingSession(renderable)
        && !isVoiceConversationCustodySessionMetadata(renderable.metadata)
    ) {
        return buildHiddenRenderableSignature(renderable);
    }

    return joinSignatureParts([
        renderable.id,
        readSessionContentAvailability(renderable),
        readSessionViewerAttentionSignature(renderable),
        readSessionManagerSessionIdV1(renderable) ?? '',
        JSON.stringify(renderable.access?.audienceContext ?? null),
        renderable.access?.capabilities.submitAgentInput === true ? 1 : 0,
        renderable.access?.capabilities.approveRuntimePermissions === true ? 1 : 0,
        readNumber(renderable.seq) ?? '',
        renderable.hasUnreadMessages === true ? 1 : 0,
        renderable.metadataUnavailable === true ? 1 : 0,
        renderable.active === true ? 1 : 0,
        readNumber(renderable.activeAt) ?? '',
        renderable.presence,
        renderable.thinking === true ? 1 : 0,
        readNumber(renderable.thinkingAt) ?? '',
        readNumber(renderable.optimisticThinkingAt) ?? '',
        renderable.runtimeActivityState ?? '',
        readNumber(renderable.runtimeActivityActiveCount) ?? '',
        renderable.latestTurnStatus ?? '',
        readNumber(renderable.latestTurnStatusObservedAt) ?? '',
        readNumber(renderable.meaningfulActivityAt) ?? '',
        readRuntimeIssueSignature(renderable.lastRuntimeIssue),
        readNumber(renderable.lastTurnCompletedAt) ?? '',
        readNumber(renderable.latestReadyEventSeq) ?? '',
        readNumber(renderable.pendingVersion) ?? '',
        readNumber(renderable.pendingCount) ?? '',
        readNumber(renderable.pendingBlockedCount) ?? '',
        hasRenderablePendingRequestProjection(renderable) ? readNumber(renderable.updatedAt) ?? '' : '',
        renderable.hasPendingPermissionRequests === true ? 1 : 0,
        renderable.hasPendingUserActionRequests === true ? 1 : 0,
        readNumber(renderable.pendingRequestObservedAt) ?? '',
        readNumber(renderable.agentStateVersion) ?? '',
        readSessionMetadataActivitySignature(renderable.metadata),
    ]);
}

function buildSessionListIndexSignature(
    indexByServerId: StorageState['sessionListIndexByServerId'],
): string {
    return joinSignatureParts(collectRecordIds(indexByServerId ?? {}).sort().map((serverId) => {
        const items = indexByServerId?.[serverId] ?? [];
        const itemSignature = Array.isArray(items)
            ? joinSignatureParts(items.map((item: SessionListIndexItem) => (
                item.type === 'session'
                    ? joinSignatureParts(['s', item.sessionId, item.serverId ?? '', item.serverName ?? ''])
                    : joinSignatureParts(['h', item.type])
            )))
            : '';
        return joinSignatureParts([serverId, itemSignature]);
    }));
}

function buildConcurrentCacheSignature(
    cacheByServerId: StorageState['concurrentSessionListCacheByServerId'],
): string {
    return joinSignatureParts(collectRecordIds(cacheByServerId ?? {}).sort().map((serverId) => {
        const entry = cacheByServerId?.[serverId];
        return joinSignatureParts([
            serverId,
            entry?.serverName ?? '',
            // Home currentness is part of every Session's context line, so a Home going offline or
            // recovering must rebuild this projection (Lane 07.4 §2). Only the phase belongs here:
            // a reachable Home contributes no currentness words, and a Home that cannot be reached
            // cannot advance its last success, so adding the timestamp would rebuild every
            // Activity row on each ordinary refresh for no visible difference.
            entry?.listObservation?.phase ?? '',
        ]);
    }));
}

export function readActivityAttentionStoreSource(
    state: StorageState,
    includeSessionMessages: boolean,
    includeFollowRuleFacts: boolean,
): StoreActivityAttentionSource {
    return {
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRowsByServerId: state.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId:
            state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
        ...(includeSessionMessages ? { sessionMessagesById: state.sessionMessages } : {}),
        workspaceRefsV1: readProjectWorkspaceRefs(state),
        ...(includeFollowRuleFacts ? { followRuleWorkspaceRefsV1: readProjectAccountWorkspaceRefs(state),
            followRuleTagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey,
            followRuleFolderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey } : {}),
        workspacePathDisplayModeV1: 'name',
    };
}

export function createActivityAttentionStoreSourceSelector(
    personalMembershipByServerId: Readonly<Record<string, readonly string[]>> = {},
    options: Readonly<{ includeSessionMessages?: boolean; detailAddresses?: readonly SessionAddress[]; includeFollowRuleFacts?: boolean;
        ruleMembershipByServerId?: Readonly<Record<string, readonly string[]>> }> = {},
): (state: StorageState) => StoreActivityAttentionSource {
    const includeSessionMessages = options.includeSessionMessages !== false;
    const includeFollowRuleFacts = options.includeFollowRuleFacts === true;
    const ruleMembershipByServerId = options.ruleMembershipByServerId ?? {};
    const signer = createActivityStoreSigner({
        signSession: (session, state) => {
            const serverId = session.serverId ?? state.profileScope?.serverId;
            return joinSignatureParts([
                buildSessionActivitySignature(session),
                includeFollowRuleFacts && serverId ? readFollowRuleFactsSignature(session, serverId) : '',
            ]);
        },
        signRow: (row, serverId) => joinSignatureParts([
            buildRenderableActivitySignature(row), includeFollowRuleFacts ? readFollowRuleFactsSignature(row, serverId) : '',
        ]),
        fixedRowMemberships: [personalMembershipByServerId, ruleMembershipByServerId],
        transcripts: includeSessionMessages ? { fixedMemberships: [], detailAddresses: options.detailAddresses } : null,
    });
    const signatures = { index: '', cache: '', workspace: '', organization: '' };
    let observation: ActivityStoreObservation | null = null;
    let previousSource: StoreActivityAttentionSource | null = null;
    let previousInputs: StoreActivityAttentionSource | null = null;
    const replaceSignature = (key: keyof typeof signatures, next: string) => {
        if (signatures[key] === next) return false;
        signatures[key] = next;
        return true;
    };

    return (state) => {
        const inputs = readActivityAttentionStoreSource(state, includeSessionMessages, includeFollowRuleFacts);
        const sessionsChanged = !previousInputs || previousInputs.sessionsById !== inputs.sessionsById;
        const membershipChanged = !previousInputs
            || previousInputs.ordinarySessionListMembershipByServerId !== inputs.ordinarySessionListMembershipByServerId;
        const rowsChanged = !previousInputs || previousInputs.sessionListRowsByServerId !== inputs.sessionListRowsByServerId;
        const indexChanged = !previousInputs || previousInputs.sessionListIndexByServerId !== inputs.sessionListIndexByServerId;
        const cacheChanged = !previousInputs
            || previousInputs.concurrentSessionListCacheByServerId !== inputs.concurrentSessionListCacheByServerId;
        const organizationChanged = includeFollowRuleFacts && (!previousInputs
            || previousInputs.followRuleTagAssignmentsBySessionKey !== inputs.followRuleTagAssignmentsBySessionKey
            || previousInputs.followRuleFolderAssignmentsBySessionKey !== inputs.followRuleFolderAssignmentsBySessionKey);
        const transcriptsMoved = includeSessionMessages && previousInputs?.sessionMessagesById !== inputs.sessionMessagesById;
        const messagesChanged = includeSessionMessages && (sessionsChanged || membershipChanged || transcriptsMoved);
        const workspaceChanged = !previousInputs || previousInputs.workspaceRefsV1 !== inputs.workspaceRefsV1
            || previousInputs.followRuleWorkspaceRefsV1 !== inputs.followRuleWorkspaceRefsV1
            || previousInputs.workspacePathDisplayModeV1 !== inputs.workspacePathDisplayModeV1;
        const scope = readActivityStoreChangeScope(observation, state, state.sessionListRenderableDelta);
        observation = observeActivityStore(state, state.sessionListRenderableDelta);
        if (previousSource && previousInputs?.isDataReady === inputs.isDataReady
            && !sessionsChanged && !membershipChanged && !rowsChanged && !indexChanged
            && !cacheChanged && !messagesChanged && !workspaceChanged && !organizationChanged) {
            return previousSource;
        }

        // Store domains publish immutable references, and the store names the Sessions one revision
        // changed: an unrelated notification signs nothing, a row-level one signs only its Sessions.
        let moved = signer.update(state, scope, {
            sessions: sessionsChanged, rows: rowsChanged, membership: membershipChanged, transcripts: transcriptsMoved,
        });
        if (indexChanged && replaceSignature('index', buildSessionListIndexSignature(state.sessionListIndexByServerId))) moved = true;
        if (cacheChanged && replaceSignature('cache', buildConcurrentCacheSignature(state.concurrentSessionListCacheByServerId))) moved = true;
        if (workspaceChanged && replaceSignature('workspace', buildWorkspaceDisplaySettingsSignature(state, includeFollowRuleFacts))) moved = true;
        // Organization keys come from the Sessions, member rows and fixed memberships signed above, so a
        // row-level publication moves this part only together with one of those; assignments are its own input.
        if (includeFollowRuleFacts && (organizationChanged
            || scope.complete && (sessionsChanged || membershipChanged || rowsChanged || cacheChanged))
            && replaceSignature('organization', buildFollowRuleOrganizationSignature(state, personalMembershipByServerId, ruleMembershipByServerId))) {
            moved = true;
        }
        const readinessChanged = previousInputs?.isDataReady !== inputs.isDataReady;
        previousInputs = inputs;

        if (previousSource && !moved && !readinessChanged) {
            return previousSource;
        }

        previousSource = options.detailAddresses && includeSessionMessages
            ? { ...inputs, sessionMessagesById: Object.fromEntries(signer.potentialSessionIds().flatMap(id => {
                const messages = state.sessionMessages[id];
                return messages ? [[id, messages]] : [];
            })) }
            : inputs;
        return previousSource;
    };
}
