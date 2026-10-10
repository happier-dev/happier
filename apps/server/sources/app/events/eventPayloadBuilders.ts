import { ExternalSessionStorageStateV1Schema, type SessionViewerProjectionV1 } from "@happier-dev/protocol";
import { AccountProfile } from "@/types";
import { getPublicUrl } from "@/storage/blob/files";
import { type UpdatePayload, type EphemeralPayload, type EphemeralEvent } from "./eventPayloadTypes";
import {
    MachineKindFromLegacyProjectionSchema,
    type MachineKind,
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
    parseSessionRuntimeActivityProjectionFields,
    type AutomationRunStateV3,
    type PendingActivationAuthorizationV1,
    type ManagedWakeTargetV1,
    type ParticipantExecutionRunRecipientRoutingIdentityV1,
    SessionMetadataRecipientProjectionV1Schema,
    type PrimaryTurnStatusV1,
    type SessionMessageDeliveryResolutionV1,
    type SessionMessageAccountActorV1,
    type SessionMessageAttentionImpact,
    type SessionMetadataRecipientProjectionV1,
    type SessionOwnerMetadataEnvelopeV1,
    type SessionMessageRole,
    type SessionRuntimeIssueV1,
    type SessionTranscriptObservationProvenanceV1,
} from "@happier-dev/protocol";
import { applySessionTranscriptPublicationCeiling } from "@/app/session/sessionTranscriptPublicationPolicy";
import { projectSessionInputAdmissionReceipt } from "@/app/session/messages/sessionInputAdmission";
import { serializeMachineKeyBasis } from "@/app/machines/machineSerialization";
import type { MachineKeyBasisV1 } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";
import type { DevcontainerChildProjectionV1 } from "@happier-dev/protocol/machines/managed/devcontainerV1";

type UpdateMessagePayloadInput = Readonly<{
    id: string;
    seq: number;
    currentStorageState?: unknown;
    acceptedThroughServerSeq?: unknown;
    materializationPublicationId?: unknown;
    materializedThroughSourceAt?: unknown;
    publishedThroughServerSeq?: unknown;
    messageRole?: SessionMessageRole | null;
    content: any;
    localId: string | null;
    sidechainId?: string | null;
    deliveryResolution?: SessionMessageDeliveryResolutionV1 | null;
    createdAt: Date;
    updatedAt: Date;
    sourceCreatedAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1 | null;
    /**
     * Sanitized authenticated Account actor, already evaluated by the server
     * projector. Absent means an unmigrated producer; `null` is an explicit
     * retraction.
     */
    accountActor?: SessionMessageAccountActorV1 | null;
    /** Trusted database receipt, validated before authenticated wire publication. */
    inputAdmissionReceipt?: unknown;
}>;

type UpdateMessagePayloadOptions = Readonly<{
    attentionImpact?: SessionMessageAttentionImpact;
}>;

function serializeUpdateMessage(message: UpdateMessagePayloadInput, options?: UpdateMessagePayloadOptions) {
    return {
        id: message.id,
        seq: message.seq,
        content: message.content,
        localId: message.localId,
        ...(typeof message.messageRole === "string" ? { messageRole: message.messageRole } : {}),
        ...(typeof message.sidechainId === "string" && message.sidechainId ? { sidechainId: message.sidechainId } : {}),
        ...(message.deliveryResolution ? { deliveryResolution: message.deliveryResolution } : {}),
        ...(options?.attentionImpact ? { attentionImpact: options.attentionImpact } : {}),
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime(),
        ...(message.sourceCreatedAt ? { sourceCreatedAt: message.sourceCreatedAt.getTime() } : {}),
        ...(message.sourceUpdatedAt ? { sourceUpdatedAt: message.sourceUpdatedAt.getTime() } : {}),
        ...(message.transcriptObservationProvenance
            ? { transcriptObservationProvenance: message.transcriptObservationProvenance }
            : {}),
        // Explicit object-or-null from a current producer; omitted only when the
        // publisher predates the projection. Deliberately whitelisted rather
        // than spread, so private source-row fields cannot reach the wire.
        ...("accountActor" in message ? { accountActor: message.accountActor ?? null } : {}),
        ...projectSessionInputAdmissionReceipt(message.inputAdmissionReceipt),
    };
}

function normalizeSessionEncryptionMode(value: string | null | undefined): "e2ee" | "plain" {
    return value === "plain" ? "plain" : "e2ee";
}

export function buildNewSessionUpdate(session: {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion?: number;
    ownerMetadata?: string | null;
    agentState: string | null;
    agentStateVersion: number;
    /**
     * The creating owner's own envelope, already Base64-projected by the
     * canonical `(Session, Account)` tuple projector. This builder never reads a
     * Session column for key material, so it cannot resurrect the owner/share
     * branch the tuple replaced.
     */
    dataEncryptionKey: string | null;
    encryptionMode: string | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
    meaningfulActivityAt?: Date | null;
    /** The persisted storage state (`hosted` by default; `machine_only` for an external-session import). */
    currentStorageState?: string | null;
}, updateSeq: number, updateId: string, metadataProjection?: Readonly<{
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion?: number;
    ownerMetadata?: SessionOwnerMetadataEnvelopeV1;
    agentState: string | null;
    agentStateVersion: number;
}>, viewer?: SessionViewerProjectionV1): UpdatePayload {
    const projected = metadataProjection ?? session;
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-session',
            id: session.id,
            // Compatibility: some clients use `sid` for sessionId.
            sid: session.id,
            ...(viewer ? { viewer } : {}),
            seq: applySessionTranscriptPublicationCeiling(session.seq, session),
            metadata: projected.metadata,
            metadataVersion: projected.metadataVersion,
            ...(typeof projected.metadataLayoutVersion === "number"
                ? { metadataLayoutVersion: projected.metadataLayoutVersion }
                : {}),
            ...(
                "ownerMetadata" in projected
                && projected.ownerMetadata !== undefined
                ? { ownerMetadata: projected.ownerMetadata }
                : {}),
            agentState: projected.agentState,
            agentStateVersion: projected.agentStateVersion,
            dataEncryptionKey: session.dataEncryptionKey,
            encryptionMode: normalizeSessionEncryptionMode(session.encryptionMode),
            active: session.active,
            activeAt: session.lastActiveAt.getTime(),
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime(),
            meaningfulActivityAt: (session.meaningfulActivityAt ?? session.createdAt).getTime(),
            // Clients decide which transcript reader may run from the storage state; without it a
            // fresh import reads as a legacy linked session until the next list refresh.
            ...(ExternalSessionStorageStateV1Schema.safeParse(session.currentStorageState).success
                ? { currentStorageState: session.currentStorageState }
                : {}),
        },
        createdAt: Date.now()
    };
}

export function buildNewMessageUpdate(
    message: UpdateMessagePayloadInput,
    sessionId: string,
    updateSeq: number,
    updateId: string,
    options?: UpdateMessagePayloadOptions,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-message',
            sid: sessionId,
            // Compatibility: some clients use `id` for sessionId.
            id: sessionId,
            message: serializeUpdateMessage(message, options),
        },
        createdAt: Date.now()
    };
}

export function buildMessageUpdatedUpdate(
    message: UpdateMessagePayloadInput,
    sessionId: string,
    updateSeq: number,
    updateId: string,
    options?: UpdateMessagePayloadOptions,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'message-updated',
            sid: sessionId,
            // Compatibility: some clients use `id` for sessionId.
            id: sessionId,
            message: serializeUpdateMessage(message, options),
        },
        createdAt: Date.now()
    };
}

export function buildPendingResolvedMessageUpdate(
    message: UpdateMessagePayloadInput,
    sessionId: string,
    updateSeq: number,
    updateId: string,
    eventKind: "new-message" | "message-updated" = "new-message",
): UpdatePayload {
    const buildMessageUpdate = eventKind === "message-updated"
        ? buildMessageUpdatedUpdate
        : buildNewMessageUpdate;
    return buildMessageUpdate(
        message,
        sessionId,
        updateSeq,
        updateId,
        { attentionImpact: SESSION_MESSAGE_USER_ATTENTION_IMPACT },
    );
}

export function buildUpdateSessionUpdate(
    sessionId: string,
    updateSeq: number,
    updateId: string,
    metadata?: { value: string | null; version: number },
    agentState?: { value: string | null; version: number },
    projection?: {
        viewer?: SessionViewerProjectionV1;
        active?: boolean;
        activeAt?: number;
        lastViewedSessionSeq?: number;
        pendingPermissionRequestCount?: number;
        pendingUserActionRequestCount?: number;
        pendingRequestObservedAt?: number | null;
        latestReadyEventSeq?: number | null;
        latestReadyEventAt?: number | null;
        latestReadyEventLocalId?: string;
        latestTurnId?: string | null;
        latestTurnStatus?: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt?: number | null;
        lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
        rollbackEligibleTurnStarts?: readonly number[];
        runtimeActivityState?: 'active' | 'idle' | 'unknown';
        runtimeActivityActiveCount?: number;
        runtimeActivityObservedAt?: number | null;
        runtimeActivityRevision?: number;
        meaningfulActivityAt?: number;
        archivedAt?: number | null;
    },
): UpdatePayload {
    const runtimeActivity = parseSessionRuntimeActivityProjectionFields(projection);
    if (runtimeActivity.kind === "invalid") {
        throw new Error("Invalid Runtime Activity projection");
    }
    const runtimeActivityFields = runtimeActivity.kind === "valid"
        ? {
            runtimeActivityState: runtimeActivity.projection.state,
            runtimeActivityActiveCount: runtimeActivity.projection.activeCount,
            runtimeActivityObservedAt: runtimeActivity.projection.observedAt,
            runtimeActivityRevision: runtimeActivity.projection.revision,
        }
        : {};
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-session',
            ...(projection?.viewer ? { viewer: projection.viewer } : {}),
            id: sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: sessionId,
            metadata,
            agentState,
            ...(projection && "active" in projection ? { active: projection.active } : {}),
            ...(typeof projection?.activeAt === "number" ? { activeAt: projection.activeAt } : {}),
            ...(typeof projection?.lastViewedSessionSeq === 'number' ? { lastViewedSessionSeq: projection.lastViewedSessionSeq } : {}),
            ...(typeof projection?.pendingPermissionRequestCount === 'number'
                ? { pendingPermissionRequestCount: projection.pendingPermissionRequestCount }
                : {}),
            ...(typeof projection?.pendingUserActionRequestCount === 'number'
                ? { pendingUserActionRequestCount: projection.pendingUserActionRequestCount }
                : {}),
            ...(typeof projection?.pendingRequestObservedAt === 'number' || projection?.pendingRequestObservedAt === null
                ? { pendingRequestObservedAt: projection.pendingRequestObservedAt }
                : {}),
            ...(typeof projection?.latestReadyEventSeq === 'number' || projection?.latestReadyEventSeq === null
                ? { latestReadyEventSeq: projection.latestReadyEventSeq }
                : {}),
            ...(typeof projection?.latestReadyEventAt === 'number' || projection?.latestReadyEventAt === null
                ? { latestReadyEventAt: projection.latestReadyEventAt }
                : {}),
            ...(projection?.latestReadyEventLocalId
                ? { latestReadyEventLocalId: projection.latestReadyEventLocalId }
                : {}),
            ...(projection && 'latestTurnId' in projection ? { latestTurnId: projection.latestTurnId ?? null } : {}),
            ...(projection && 'latestTurnStatus' in projection ? { latestTurnStatus: projection.latestTurnStatus ?? null } : {}),
            ...(projection && 'latestTurnStatusObservedAt' in projection
                ? { latestTurnStatusObservedAt: projection.latestTurnStatusObservedAt ?? null }
                : {}),
            ...(projection && 'lastRuntimeIssue' in projection ? { lastRuntimeIssue: projection.lastRuntimeIssue ?? null } : {}),
            ...(Array.isArray(projection?.rollbackEligibleTurnStarts)
                ? { rollbackEligibleTurnStarts: projection.rollbackEligibleTurnStarts }
                : {}),
            ...runtimeActivityFields,
            ...(typeof projection?.meaningfulActivityAt === "number" && Number.isFinite(projection.meaningfulActivityAt)
                ? { meaningfulActivityAt: projection.meaningfulActivityAt }
                : {}),
            ...(typeof projection?.archivedAt === 'number' || projection?.archivedAt === null
                ? { archivedAt: projection.archivedAt }
                : {}),
        },
        createdAt: Date.now()
    };
}

/**
 * Publishes the existing update-session event from the strict layout-v1
 * recipient projection. Parsing here keeps the wire builder from accepting a
 * partial owner tuple or an additive private field on the shared-only branch.
 */
export function buildSessionMetadataRecipientUpdate(
    sessionId: string,
    updateSeq: number,
    updateId: string,
    projection: SessionMetadataRecipientProjectionV1,
): UpdatePayload {
    const recipientProjection =
        SessionMetadataRecipientProjectionV1Schema.parse(projection);
    const agentState =
        "agentState" in recipientProjection
        && "agentStateVersion" in recipientProjection
        && (
            typeof recipientProjection.agentState === "string"
            || recipientProjection.agentState === null
        )
        && typeof recipientProjection.agentStateVersion === "number"
            ? {
                value: recipientProjection.agentState,
                version: recipientProjection.agentStateVersion,
            }
            : undefined;
    const ownerMetadata =
        "ownerMetadata" in recipientProjection
            ? {
                ownerMetadata: {
                    value: recipientProjection.ownerMetadata,
                },
            }
            : {};

    const payload = buildUpdateSessionUpdate(
        sessionId,
        updateSeq,
        updateId,
        {
            value: recipientProjection.metadata,
            version: recipientProjection.metadataVersion,
        },
        agentState,
    );
    const recipientBody: UpdatePayload["body"] = {
        ...payload.body,
        metadataLayoutVersion: recipientProjection.metadataLayoutVersion,
        ...ownerMetadata,
    };
    if (agentState === undefined) delete recipientBody.agentState;
    return {
        ...payload,
        body: recipientBody,
    };
}

export function buildPendingChangedUpdate(
    data: {
        sessionId: string;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount?: number;
        recipient?: ParticipantExecutionRunRecipientRoutingIdentityV1;
        changedByAccountId?: string;
        meaningfulActivityAt?: Date | number;
        pendingActivationRequestId?: string;
        pendingActivationAuthorization?: PendingActivationAuthorizationV1 | null;
        managedWakeTargetV1?: ManagedWakeTargetV1;
    },
    updateSeq: number,
    updateId: string,
): UpdatePayload {
    const meaningfulActivityAt = data.meaningfulActivityAt instanceof Date
        ? data.meaningfulActivityAt.getTime()
        : data.meaningfulActivityAt;
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "pending-changed",
            // Compatibility: some clients use `sid` or `sessionId`.
            sid: data.sessionId,
            sessionId: data.sessionId,
            pendingVersion: data.pendingVersion,
            pendingCount: data.pendingCount,
            ...(typeof data.pendingBlockedCount === "number" ? { pendingBlockedCount: data.pendingBlockedCount } : {}),
            ...(data.recipient ? { recipient: data.recipient } : {}),
            ...(typeof data.changedByAccountId === "string" ? { changedByAccountId: data.changedByAccountId } : {}),
            ...(typeof data.pendingActivationRequestId === "string"
                ? { pendingActivationRequestId: data.pendingActivationRequestId }
                : {}),
            ...(data.pendingActivationAuthorization !== undefined
                ? { pendingActivationAuthorization: data.pendingActivationAuthorization }
                : {}),
            ...(data.managedWakeTargetV1 ? { managedWakeTargetV1: data.managedWakeTargetV1 } : {}),
            ...(typeof meaningfulActivityAt === "number" && Number.isFinite(meaningfulActivityAt)
                ? { meaningfulActivityAt }
                : {}),
        },
        createdAt: Date.now(),
    };
}

export function buildAutomationUpsertUpdate(
    data: { automationId: string; version: number; enabled: boolean; updatedAt: number },
    updateSeq: number,
    updateId: string,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "automation-upsert",
            automationId: data.automationId,
            version: data.version,
            enabled: data.enabled,
            updatedAt: data.updatedAt,
        },
        createdAt: Date.now(),
    };
}

export function buildAutomationDeleteUpdate(
    data: { automationId: string; deletedAt: number },
    updateSeq: number,
    updateId: string,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "automation-delete",
            automationId: data.automationId,
            deletedAt: data.deletedAt,
        },
        createdAt: Date.now(),
    };
}

export function buildAutomationRunUpdatedUpdate(
    data: {
        runId: string;
        automationId: string;
        state: AutomationRunStateV3;
        scheduledAt: number;
        startedAt?: number | null;
        finishedAt?: number | null;
        updatedAt: number;
        machineId?: string | null;
        attempt?: number;
    },
    updateSeq: number,
    updateId: string,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "automation-run-updated",
            runId: data.runId,
            automationId: data.automationId,
            state: data.state,
            scheduledAt: data.scheduledAt,
            startedAt: data.startedAt ?? null,
            finishedAt: data.finishedAt ?? null,
            updatedAt: data.updatedAt,
            machineId: data.machineId ?? null,
            ...(typeof data.attempt === "number" ? { attempt: data.attempt } : {}),
        },
        createdAt: Date.now(),
    };
}

export function buildAutomationAssignmentUpdatedUpdate(
    data: { machineId: string; automationId: string; enabled: boolean; updatedAt: number },
    updateSeq: number,
    updateId: string,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: "automation-assignment-updated",
            machineId: data.machineId,
            automationId: data.automationId,
            enabled: data.enabled,
            updatedAt: data.updatedAt,
        },
        createdAt: Date.now(),
    };
}

export function buildDeleteSessionUpdate(sessionId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-session',
            sid: sessionId,
            // Compatibility: some clients use `id` for sessionId.
            id: sessionId
        },
        createdAt: Date.now()
    };
}

export function buildUpdateAccountUpdate(userId: string, profile: Partial<AccountProfile>, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-account',
            id: userId,
            ...profile,
            avatar: profile.avatar ? { ...profile.avatar, url: getPublicUrl(profile.avatar.path) } : undefined
        },
        createdAt: Date.now()
    };
}

/**
 * Content-free post-commit hint to read the canonical AccountChange feed.
 * The cursor remains the sole durable ordering authority; this wake carries no
 * changed entity, settings, availability, or plugin payload.
 */
export function buildAccountChangeWakeUpdate(changeCursor: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: changeCursor,
        body: { t: 'account-change' },
        createdAt: Date.now(),
    };
}

export function buildAccountSettingsChangedUpdate(settingsVersion: number, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'account-settings-changed',
            settingsVersion,
        },
        createdAt: Date.now(),
    };
}

export function buildNewMachineUpdate(machine: {
    id: string;
    devcontainerChild?: DevcontainerChildProjectionV1 | null;
    kind?: MachineKind;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    installationId?: string | null;
    installationPublicKey?: Uint8Array | null;
    contentPublicKeyFingerprint?: string | null;
    replacedByMachineId?: string | null;
    replacedAt?: Date | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    active: boolean;
    lastActiveAt: Date;
    revokedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-machine',
            devcontainerChild: machine.devcontainerChild ?? null,
            kind: MachineKindFromLegacyProjectionSchema.parse(machine.kind),
            machineId: machine.id,
            seq: machine.seq,
            metadata: machine.metadata,
            metadataVersion: machine.metadataVersion,
            daemonState: machine.daemonState,
            daemonStateVersion: machine.daemonStateVersion,
            dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
            keyBasis: serializeMachineKeyBasis(machine),
            installationId: machine.installationId ?? null,
            installationPublicKey: machine.installationPublicKey ? Buffer.from(machine.installationPublicKey).toString('base64') : null,
            contentPublicKeyFingerprint: machine.contentPublicKeyFingerprint ?? null,
            replacedByMachineId: machine.replacedByMachineId ?? null,
            replacedAt: machine.replacedAt ? machine.replacedAt.getTime() : null,
            replacementReason: machine.replacementReason ?? null,
            replacementSource: machine.replacementSource ?? null,
            replacementActorUserId: machine.replacementActorUserId ?? null,
            active: machine.active,
            activeAt: machine.lastActiveAt.getTime(),
            revokedAt: machine.revokedAt ? machine.revokedAt.getTime() : null,
            createdAt: machine.createdAt.getTime(),
            updatedAt: machine.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateMachineUpdate(
    machineId: string,
    updateSeq: number,
    updateId: string,
    metadata?: { value: string; version: number },
    daemonState?: { value: string | null; version: number },
    extra?: {
        devcontainerChild?: DevcontainerChildProjectionV1 | null;
        dataEncryptionKey?: string | null;
        keyBasis?: MachineKeyBasisV1;
        active?: boolean;
        activeAt?: number;
        revokedAt?: number | null;
        replacedByMachineId?: string | null;
        replacedAt?: number | null;
        replacementReason?: string | null;
        replacementSource?: string | null;
        replacementActorUserId?: string | null;
    },
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-machine',
            machineId,
            metadata,
            daemonState,
            ...(extra ?? {}),
        },
        createdAt: Date.now()
    };
}

export function buildSessionActivityEphemeral(sessionId: string, active: boolean, activeAt: number, thinking?: boolean): EphemeralPayload {
    return {
        type: 'activity',
        id: sessionId,
        active,
        activeAt,
        thinking: thinking || false
    };
}

export function buildMachineActivityEphemeral(machineId: string, active: boolean, activeAt: number): EphemeralPayload {
    return {
        type: 'machine-activity',
        id: machineId,
        active,
        activeAt
    };
}

export function buildUsageEphemeral(
    sessionId: Extract<EphemeralEvent, { type: 'usage' }>['id'],
    key: string,
    tokens: Record<string, number>,
    cost: Record<string, number>,
): Extract<EphemeralEvent, { type: 'usage' }> {
    return {
        type: 'usage',
        id: sessionId,
        key,
        tokens,
        cost,
        timestamp: Date.now()
    };
}

export function buildTeamCredentialUsageChangedEphemeral(resourceId: string): EphemeralPayload {
    return { type: 'team-credential-usage-changed', resourceId };
}

export function buildMachineStatusEphemeral(machineId: string, online: boolean): EphemeralPayload {
    return {
        type: 'machine-status',
        machineId,
        online,
        timestamp: Date.now()
    };
}

export { buildNewArtifactUpdate, buildUpdateArtifactUpdate } from './artifactEventPayloadBuilders';

export function buildDeleteArtifactUpdate(artifactId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-artifact',
            artifactId
        },
        createdAt: Date.now()
    };
}

export function buildRelationshipUpdatedEvent(
    data: {
        uid: string;
        status: 'none' | 'requested' | 'pending' | 'friend' | 'rejected';
        timestamp: number;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'relationship-updated',
            ...data
        },
        createdAt: Date.now()
    };
}

export function buildNewFeedPostUpdate(feedItem: {
    id: string;
    body: any;
    cursor: string;
    createdAt: number;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-feed-post',
            id: feedItem.id,
            body: feedItem.body,
            cursor: feedItem.cursor,
            createdAt: feedItem.createdAt
        },
        createdAt: Date.now()
    };
}

export function buildKVBatchUpdateUpdate(
    changes: Array<{ key: string; value: string | null; version: number }>,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'kv-batch-update',
            changes
        },
        createdAt: Date.now()
    };
}

export function buildSessionSharedUpdate(share: {
    id: string;
    sessionId: string;
    sharedByUser: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: any | null;
    };
    accessLevel: 'view' | 'edit' | 'admin';
    canApprovePermissions: boolean;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'session-shared',
            sessionId: share.sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: share.sessionId,
            shareId: share.id,
            sharedBy: share.sharedByUser,
            accessLevel: share.accessLevel,
            canApprovePermissions: share.canApprovePermissions,
            createdAt: share.createdAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildSessionShareUpdatedUpdate(
    shareId: string,
    sessionId: string,
    accessLevel: 'view' | 'edit' | 'admin',
    canApprovePermissions: boolean,
    updatedAt: Date,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'session-share-updated',
            sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: sessionId,
            shareId,
            accessLevel,
            canApprovePermissions,
            updatedAt: updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildSessionShareRevokedUpdate(
    shareId: string,
    sessionId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'session-share-revoked',
            sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: sessionId,
            shareId
        },
        createdAt: Date.now()
    };
}

export function buildPublicShareCreatedUpdate(publicShare: {
    id: string;
    sessionId: string;
    token: string;
    expiresAt: Date | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'public-share-created',
            sessionId: publicShare.sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: publicShare.sessionId,
            publicShareId: publicShare.id,
            token: publicShare.token,
            expiresAt: publicShare.expiresAt?.getTime() ?? null,
            maxUses: publicShare.maxUses,
            isConsentRequired: publicShare.isConsentRequired,
            createdAt: publicShare.createdAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildPublicShareUpdatedUpdate(publicShare: {
    id: string;
    sessionId: string;
    expiresAt: Date | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'public-share-updated',
            sessionId: publicShare.sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: publicShare.sessionId,
            publicShareId: publicShare.id,
            expiresAt: publicShare.expiresAt?.getTime() ?? null,
            maxUses: publicShare.maxUses,
            isConsentRequired: publicShare.isConsentRequired,
            updatedAt: publicShare.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildPublicShareDeletedUpdate(
    sessionId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'public-share-deleted',
            sessionId,
            // Compatibility: some clients use `sid` for sessionId.
            sid: sessionId
        },
        createdAt: Date.now()
    };
}
