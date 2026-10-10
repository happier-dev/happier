import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    projectSessionAccessCapabilitiesV1,
    projectSessionSharedMetadataV1,
    SessionCurrentProjectionRecordV1Schema,
    V2SessionRecordSchema,
    type V2SessionRecord,
    type SessionCurrentProjectionRecordV1,
    ABSENT_SESSION_FOLLOW_FACTS_V1,
    NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
    projectViewerReadStateV1,
    resolveSessionEffectiveNotificationV1,
    resolveSessionPersonalAttentionV1,
    resolveSessionPersonalRelevanceV1,
    SessionViewerProjectionV1Schema,
    type SessionViewerProjectionV1,
} from '@happier-dev/protocol';

export function createSessionDataKeyFixture(fill = 7): Uint8Array {
    return new Uint8Array(ENCRYPTED_DATA_KEY_V1_BYTES).fill(fill);
}

export function createSessionAccessFixture(
    level: NonNullable<Session['access']>['level'] = 'owner',
    capabilities: Partial<NonNullable<Session['access']>['capabilities']> = {},
): NonNullable<Session['access']> {
    const owner = level === 'owner';
    const admin = owner || level === 'admin';
    return { role: owner ? 'owner' : 'recipient', level, capabilities: {
        readTranscript: true, submitAgentInput: level !== 'view', editSessionRecords: level !== 'view',
        approveRuntimePermissions: owner, manageAccess: admin, managePermissionDelegation: owner,
        managePublicLink: owner, archiveSession: admin, renameSession: admin,
        assignResponsibility: admin, stopSession: owner, deleteSession: owner,
        ...capabilities,
    } };
}

export function createSessionFixture(overrides: Partial<Session> = {}): Session {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    return {
        id: 'session-1',
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
        access: createSessionAccessFixture(overrides.accessLevel ?? 'owner', {
            approveRuntimePermissions: overrides.canApprovePermissions ?? overrides.accessLevel == null,
        }),
        seq: 1,
        createdAt,
        updatedAt,
        active: false,
        activeAt: updatedAt,
        metadata: {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        } as Session['metadata'],
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

/** A Home's current plaintext owner row, projected through the real metadata/access owners. */
export function createPlainV2SessionRecordFixture(overrides: Partial<Pick<V2SessionRecord,
    'id' | 'seq' | 'createdAt' | 'updatedAt' | 'active' | 'activeAt' | 'archivedAt' | 'metadataVersion' | 'agentStateVersion'
>> & { metadata?: Session['metadata'] } = {}): V2SessionRecord {
    const base = createSessionFixture({ id: overrides.id ?? 'session-1' });
    const { metadata = base.metadata, ...facts } = overrides;
    const owner = createSessionOwnerMetadataV1({ metadata: metadata ?? {} });
    if (!owner.ok) throw new Error(`Invalid Session owner fixture metadata: ${owner.unsupportedFields.join(', ')}`);
    return V2SessionRecordSchema.parse({
        id: base.id,
        seq: base.seq,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        active: base.active,
        activeAt: base.activeAt,
        archivedAt: null,
        metadataVersion: base.metadataVersion,
        agentStateVersion: base.agentStateVersion,
        agentState: null,
        ...facts,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
        metadataLayoutVersion: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        share: null,
        effectiveAccess: {
            v: 1,
            level: 'owner',
            sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
        },
    });
}

/** The negotiated current HTTP projection includes an explicit responsibility pair. */
export function createPlainSessionCurrentProjectionRecordFixture(
    overrides: Parameters<typeof createPlainV2SessionRecordFixture>[0]
        & Partial<Pick<SessionCurrentProjectionRecordV1, 'responsibleAccountId' | 'responsibleAccount'>> = {},
) {
    const { responsibleAccountId = null, responsibleAccount = null, ...recordOverrides } = overrides;
    const record = createPlainV2SessionRecordFixture(recordOverrides);
    return SessionCurrentProjectionRecordV1Schema.parse({
        ...record,
        responsibleAccountId,
        responsibleAccount,
    });
}

/** Owner HTTP fixture with no Follow, discussion, pin or explicit attention rows. */
export function createSessionOwnerViewerFixture(session: Session): SessionViewerProjectionV1 {
    if (session.viewer) return SessionViewerProjectionV1Schema.parse(session.viewer);
    if (session.access?.level !== 'owner' || session.responsibleAccountId != null) {
        throw new Error('Non-owner or assigned Session fixtures require an explicit viewer projection');
    }
    const readState = projectViewerReadStateV1({ tracked: true, visibleSessionSeq: session.seq,
        row: typeof session.lastViewedSessionSeq === 'number'
            ? { lastViewedSessionSeq: session.lastViewedSessionSeq, unreadSince: session.unreadSince ?? null } : null });
    const follow = ABSENT_SESSION_FOLLOW_FACTS_V1;
    return SessionViewerProjectionV1Schema.parse({
        readState,
        follow,
        notification: resolveSessionEffectiveNotificationV1({ facts: follow, isSessionOwner: true }),
        relevance: resolveSessionPersonalRelevanceV1({ ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, ownedByMe: true }),
        attention: resolveSessionPersonalAttentionV1({
            tracked: true, accessible: session.access.capabilities.readTranscript, accountSuspended: false,
            contentAvailable: session.encryptedContentAvailability === 'ready',
            visibleSessionSeq: session.seq, readState, latestReadyEventSeq: session.latestReadyEventSeq ?? null,
            hasPrimarySessionFailure: session.latestTurnStatus === 'failed'
                && session.lastRuntimeIssue?.scope === 'primary_session' && session.lastRuntimeIssue.status === 'failed',
            pendingBlockedCount: session.pendingBlockedCount ?? 0,
            pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? 0,
            pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? 0,
            capabilities: { canSubmitAgentInput: session.access.capabilities.submitAgentInput,
                canApprovePermissions: session.access.capabilities.approveRuntimePermissions },
            responsible: false, discussion: { hasUnread: false, hasMention: false },
            attentionStanding: 'none', reminderDue: false,
        }),
    });
}

export function createSessionListRenderableSessionFixture(
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;
    const activeAt = overrides.activeAt ?? updatedAt;

    return {
        id: 'session-1',
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
        access: createSessionAccessFixture(overrides.accessLevel ?? 'owner', {
            approveRuntimePermissions: overrides.canApprovePermissions ?? overrides.accessLevel == null,
        }),
        seq: 1,
        createdAt,
        updatedAt,
        active: false,
        activeAt,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        thinkingGraceUntil: null,
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
        pendingRequestObservedAt: null,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...overrides,
    };
}
