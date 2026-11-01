import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionCurrentProjectionRecordV1Schema, type SessionCurrentProjectionRecordV1 } from '@happier-dev/protocol/sessions/listing/response';
import { V2SessionByIdResponseSchema, V2SessionRecordSchema, type V2SessionRecord, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { ABSENT_SESSION_FOLLOW_FACTS_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { projectViewerReadStateV1 } from '@happier-dev/protocol/sessions/personal/readState';
import { NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, resolveSessionPersonalRelevanceV1 } from '@happier-dev/protocol/sessions/personal/relevance';
import { resolveSessionEffectiveNotificationV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { QUIET_SESSION_PERSONAL_ATTENTION_V1, resolveSessionPersonalAttentionV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { SessionViewerProjectionV1Schema, type SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';

/** Synthetic daemon filesystem reply; Session directory approval and admission stay real. */
export function createExistingSessionDirectoryPreflightResult(raw: unknown) {
    const request = SessionCreationTargetPreparationRequestV1Schema.parse(raw);
    if (request.directory.kind !== 'path') throw new Error('Expected an existing Session directory path');
    return SessionCreationTargetPreparationResultV1Schema.parse({
        ok: true, directory: request.directory.path, directoryKind: 'path',
        directoryCreationRequired: false, checkout: null,
    });
}

export function createSessionViewerFixture(overrides: Partial<SessionViewerProjectionV1> = {}): SessionViewerProjectionV1 {
    const follow = overrides.follow ?? ABSENT_SESSION_FOLLOW_FACTS_V1;
    return SessionViewerProjectionV1Schema.parse({
        latestFailureSeq: null,
        readState: { state: 'not_started' },
        relevance: { relevant: follow.follows, reasons: follow.follows ? ['followed_by_me'] : [] },
        attention: QUIET_SESSION_PERSONAL_ATTENTION_V1,
        notification: resolveSessionEffectiveNotificationV1({ facts: follow, isSessionOwner: false }),
        ...overrides, follow,
    });
}

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

export function createSessionFixture(
    overrides: Partial<Session> = {},
    options: Readonly<{ memoryEnabled?: boolean }> = {},
): Session {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    const session: Session = {
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
    if (options.memoryEnabled !== undefined) {
        const field = session.metadataLayoutVersion === 1 ? 'ownerMetadataView' : 'metadata';
        const metadata = session[field];
        if (!metadata) throw new Error('A Session memory fixture requires readable owner metadata');
        const work = metadata.work;
        session[field] = { ...metadata, work: {
            ...(work && typeof work === 'object' && !Array.isArray(work) ? work : {}),
            memoryEnabled: options.memoryEnabled,
        } };
    }
    return session;
}

/** A Home's current plaintext owner row, projected through the real metadata/access owners. */
export function createPlainV2SessionRecordFixture(overrides: Partial<Pick<V2SessionRecord,
    'id' | 'seq' | 'createdAt' | 'updatedAt' | 'active' | 'activeAt' | 'archivedAt' | 'metadataVersion' | 'agentStateVersion' | 'manager' | 'managedSessions'
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
): SessionCurrentProjectionRecordV1 {
    const { responsibleAccountId = null, responsibleAccount = null, ...recordOverrides } = overrides;
    const record = createPlainV2SessionRecordFixture(recordOverrides);
    return SessionCurrentProjectionRecordV1Schema.parse({
        ...record,
        responsibleAccountId,
        responsibleAccount,
    });
}

/** A current plaintext Home response for a seeded Session, including recipient privacy. */
export function createPlainSessionByIdResponseFixture(session: Session): V2SessionByIdResponse {
    if (session.encryptionMode !== 'plain') {
        throw new Error('A plaintext Session HTTP fixture cannot serialize an encrypted Session');
    }
    const record = createPlainSessionCurrentProjectionRecordFixture({
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt, archivedAt: session.archivedAt,
        metadata: readSessionOwnerMetadataView(session),
        metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
        manager: session.manager ?? undefined, managedSessions: session.managedSessions ?? undefined,
        responsibleAccountId: session.responsibleAccountId ?? null,
        responsibleAccount: session.responsibleAccount ?? null,
    });
    const { ownerMetadata: _ownerMetadata, ...recipientRecord } = record;
    const access = session.access;
    return V2SessionByIdResponseSchema.parse({ session: {
        ...(access && access.level !== 'owner' ? recipientRecord : record),
        agentState: (access && access.level !== 'owner') || session.agentState === null
            ? null : JSON.stringify(session.agentState),
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        lastRuntimeIssue: session.lastRuntimeIssue,
        lastViewedSessionSeq: session.lastViewedSessionSeq,
        unreadSince: session.unreadSince,
        ...(access ? {
            effectiveAccess: { v: 1, level: access.level,
                capabilities: access.capabilities, sources: access.sources ?? [] },
            ...(access.level !== 'owner' ? { share: { accessLevel: access.level,
                canApprovePermissions: access.capabilities.approveRuntimePermissions } } : {}),
        } : {}),
        pendingVersion: session.pendingVersion, pendingCount: session.pendingCount,
        pendingActivationAuthorization: session.pendingActivationAuthorization ?? undefined,
    } });
}

/** A locked layout-zero E2EE Session: genuine ciphertext, with no recipient key published. */
export async function createLockedEncryptedSessionByIdResponseFixture(session: Session): Promise<V2SessionByIdResponse> {
    if (session.encryptionMode !== 'e2ee' || isSessionContentReadable(readSessionContentAvailability(session))) {
        throw new Error('A locked encrypted Session HTTP fixture requires an unreadable E2EE Session');
    }
    const { AES256Encryption } = await import('@/sync/encryption/encryptor');
    const { encodeBase64 } = await import('@/encryption/base64');
    const cipher = new AES256Encryption(createSessionDataKeyFixture());
    const [metadata] = await cipher.encrypt([readSessionOwnerMetadataView(session) ?? {}]);
    if (!metadata) throw new Error('Expected encrypted Session fixture metadata');
    const access = session.access;
    return V2SessionByIdResponseSchema.parse({ session: {
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt,
        encryptionMode: 'e2ee', metadataLayoutVersion: 0,
        metadata: encodeBase64(metadata, 'base64'), metadataVersion: session.metadataVersion,
        agentState: null, agentStateVersion: session.agentStateVersion,
        dataEncryptionKey: null,
        responsibleAccountId: session.responsibleAccountId ?? null,
        responsibleAccount: session.responsibleAccount ?? null,
        ...(access ? { effectiveAccess: { v: 1, level: access.level,
            capabilities: access.capabilities, sources: access.sources ?? [] } } : {}),
    } });
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
        latestFailureSeq: null,
        follow,
        notification: resolveSessionEffectiveNotificationV1({ facts: follow, isSessionOwner: true }),
        relevance: resolveSessionPersonalRelevanceV1({ ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, ownedByMe: true }),
        attention: resolveSessionPersonalAttentionV1({
            tracked: true, accessible: session.access.capabilities.readTranscript, accountSuspended: false,
            contentAvailable: isSessionContentReadable(readSessionContentAvailability(session)),
            visibleSessionSeq: session.seq, readState, latestReadyEventSeq: session.latestReadyEventSeq ?? null,
            latestFailureSeq: null,
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
