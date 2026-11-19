import { decodeSessionStoredContent, encodeSessionStoredContent, sessionStoredContentWhere, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { decodeStoredSessionMessage } from "@/storage/sessionMessageContent";
import { refreshTeamCredentialUsageCountersInTx } from '@/app/teams/credentials/teamCredentialUsageCounters';
import { UsageSessionTimingV1Schema, UsageTimingBoundsV1Schema, type UsageTimingBoundsV1, type UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { nextSessionUsageTiming } from './metadata/sessionUsageTiming';
import { normalizeSessionMessageContentForStorage } from "@/app/session/normalizeSessionMessageContentForStorage";
import { projectSessionInputRepliesFromTurnInTx } from './messages/sessionMessageReply';
import * as z from 'zod/mini';
import { buildSessionInputAdmissionReceipt, isSameSessionInputAdmissionIssuer, SessionInputPermissionModesDisjointError } from "./messages/sessionInputAdmission";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { assertSessionCapabilityInTx, assertSessionOwnerInTx, buildSessionDeliveryAccessSelect, readSessionAccessProjectionContextInTx, readSessionDeliveryAccessInTx, resolveSessionAccessForOperation, type SessionCapabilityAssertion, type EffectiveSessionAccess, type SessionCapability, type SessionDeliveryAccess } from "@/app/session/access/sessionAccess";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "@/app/session/access/sessionRecipients";
import { markSessionProjectionRecipientsChanged, type SessionRecipientCursor, type SessionRecipientPublication } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { sessionRecipientPublicationResult, type SessionRecipientPublicationResult } from "@/app/session/changeTracking/sessionRecipientPublicationResult";
import { writeLegacySessionTupleInTx } from "@/app/session/metadata/writeLegacySessionTuple";
import type { SessionCurrentViewPublicationSourceV1 } from "@/app/session/metadata/publishSessionCurrentViewUpdates";
import { resolveSessionAccountChangePublications } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { acquireSessionAccountCursorLocksInTx, prepareSessionAccountCursorLocks } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { sessionAccessGrantMutationCursorLockOptions } from "@/app/session/access/sessionAccessGrantService";
import { acquireSessionAccessTransitionCursorLocksInTx } from "@/app/session/access/sessionAccessTransitionEffects";
import { reconcileAutonomousExchangeAcceptedTurnInTx } from "@/app/session/pending/reconcileAutonomousExchangeAcceptedTurnInTx";
import { observeCreateSessionMessageStage } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { db } from "@/storage/db";
import { afterTx, inReadSnapshot, inTx, transactionResult, type TransactionResult, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, isPrismaErrorCode, prismaRuntime } from "@/storage/prisma";
import { readPrismaUniqueConstraint } from "@/storage/prismaErrors";
import { resolveDbSqlDialect } from "@/config/databaseProvider";
import type { SessionTranscriptSurfaceItemReferenceInputV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { log, warn } from "@/utils/logging/log";
import type { Prisma } from "@prisma/client";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { scheduleSessionPersonalEvent } from "@/app/session/personal/publishPersonalEvent";
import { acceptSessionPersonalEventOnceInTx, canSessionFollowEventSelectAnyCandidate } from '@/app/session/personal/eventEligibility';
import { readSessionFollowCandidatesInTx } from '@/app/session/personal/followFacts';
import { SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT, agentEventLocalIdAttentionImpact, buildAgentEventLocalId, type SessionMessageAttentionImpact } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { AccountEncryptionMigrateSessionsDirectiveSchema, type AccountEncryptionMigrateSessionsDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@happier-dev/protocol/sessions/control/contract';
import { ExactSessionTurnEndMutationV1Schema, SessionTurnMutationActionV1Schema, SessionTurnMutationV1Schema, type SessionTurnMutationActionV1, type SessionTurnMutationDecisionV1, type SessionTurnMutationReceiptV1, type SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { sanitizeSessionRuntimeIssueV1, type PrimaryTurnStatusV1, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionRuntimeActivityProjectionSchema, SessionRuntimeActivitySnapshotSchema, type SessionRuntimeActivityState } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { SessionTranscriptObservationProvenanceV1Schema, isRecoveredHistoryTranscriptObservationProvenance, type SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionInputAdmissionReceiptV1Schema, type SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageAuthorAccountIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1, SessionOwnerMetadataEnvelopeV1Schema, SessionSharedMetadataV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataInactiveModelIntentOwnerPatchV1Schema, SESSION_METADATA_LAYOUT_VERSION_V1, type SessionMetadataInactiveModelIntentExpectationV1, type SessionOwnerMetadataEnvelopeV1, type SessionMetadataOwnerMigrationPatchV1, type SessionMetadataOwnerPatchV1, type SessionMetadataInactiveModelIntentOwnerPatchV1, type SessionMetadataPublisherPreconditionV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionUserActionRequiredOccurrenceV1Schema, type SessionUserActionRequiredOccurrenceV1 } from '@happier-dev/protocol/sessions/userActionRequiredOccurrenceV1';
import { SessionDisplayProjectionV1Schema, validateSessionDisplayProjectionV1, type SessionDisplayProjectionV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { validateSessionOwnerDisplayEnvelopeForAccountModeV1 } from '@happier-dev/protocol';
import { projectSessionDisplayForRecipient } from './metadata/sessionMetadataRecipientProjection';
import { type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { isDeepStrictEqual } from "node:util";
import {
    scheduleSessionActivityRemoteAlerts,
    type SubmitSessionActivityRemoteAlertsParams,
} from "@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts";
import { parseSessionMessageSidechainId } from "./parseSessionMessageSidechainId";
import {
    didSessionActivityBadgeSignalChange,
    type SessionActivityBadgeInputs,
} from "@/app/activity/accountActivityBadge";
import {
    type SessionReadCursorOperation,
} from "./readCursor/resolveSessionReadCursorOperation";
import { applyViewerReadCursorOperation, applyViewerReadCursorOperationInTx, type ApplyViewerReadCursorOperationResult } from "./personal/readState";
import { parseSessionMessageRole, resolveSessionMessageRole } from "./messageRole/resolveSessionMessageRole";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import {
    fenceExactCurrentPublisherAuthorityInTx,
    hasExactCurrentPublisherAuthorityInTx,
} from "./pending/hasExactCurrentPublisherAuthorityInTx";
import {
    compareSessionMessageContentAndRole,
    admitSessionTranscriptSurfaceItemReferenceInTx,
    resolveSurvivingSessionMessageAuthorAccountIdInTx,
    validateSessionTranscriptWriteAuthorityInTx,
    validateSessionTranscriptStoredContent,
    writeSessionTranscriptMessageInTx,
    type SessionTranscriptStoragePolicy,
    type SessionTranscriptWriteRejectionCode,
} from "./sessionTranscriptWrite";
import { parseStoredSessionTurnFacts, parseStoredSessionTurnTranscriptAnchors } from "./turns/parseSessionTurnState";
import { deriveSessionTurnTranscriptAnchorProjection } from "./turns/sessionTurnTranscriptAnchorProjection";
import { decideSessionTurnMutation, resolveSessionTurnTerminalStatus } from "./turns/decideSessionTurnMutation";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    buildSessionMessagePublicationWhere,
    SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    type SessionTranscriptPublicationFields,
    type SessionTranscriptPublicationRecipientProjectionRow,
} from "./sessionTranscriptPublicationPolicy";
import { createPlainTranscriptRecordReader, resolveMessageAttentionImpact, type PlainTranscriptRecordReader } from "./messageAttentionImpact";
import {
    isTerminalPrimaryTurnStatus,
    maxReadSeq,
    normalizeReadSeq,
    parseStoredPrimaryTurnStatus,
} from "./readCursor/manualUnreadBoundary";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { markAccountChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import {
    parsePersistedSessionOwnerMetadataEnvelopeV1,
} from "@/app/session/metadata/sessionOwnerMetadataPersistence";
import {
    admitSessionLifecycleAutomationRunsTx,
    type SessionLifecycleAdmissionResult,
} from "@/app/automations/automationSessionLifecycleAdmission";
import { rejoinAutomationOccurrenceInsertRace } from "@/app/automations/automationOccurrencePersistence";
import { producesAutomationSessionLifecycleOccurrence } from "@/app/automations/automationSessionLifecycleTerminalTruth";
import { SESSION_MESSAGE_WRITE_SELECT, SessionMessageRowRevisionRaceError, updateSessionMessageAtCurrentRevisionInTx } from './sessionMessageRevisionWrite';
import { loadSessionRollbackEligibleTurnStartsInTx } from "./turns/sessionRollbackEligibilityProjection";
import { SessionTeamCredentialBindingMetadataPatchV1Schema, type SessionTeamCredentialBindingMetadataPatchV1, type SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { TEAM_CREDENTIAL_ROUTES_V1, type TeamCredentialRouteV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import {
    readSessionTeamCredentialBindingsForSlotInTx,
    isSessionTeamCredentialBindingIntentCurrentInTx,
    validateExistingSessionTeamCredentialResourceInTx,
    writeSessionTeamCredentialBindingsInTx,
} from "@/app/teams/credentials/sessionBinding";

export {
    writeHistoricalSessionMessageBatch,
    writeHistoricalSessionMessageBatchInTx,
    writeHistoricalSessionMessageInTx,
} from "./sessionTranscriptWrite";

type RecipientCursor = SessionRecipientCursor;
type SessionWriteInTxResult<T> = T | SessionRecipientPublicationResult<T>;
const JSON_PARSE_FAILED = Symbol("json-parse-failed");

function scheduleSessionLifecycleAdmissionDiagnostics(params: Readonly<{
    tx: Tx;
    admissions: readonly SessionLifecycleAdmissionResult[];
    accountId: string;
    sourceSessionId: string;
    sourceTurnId: string;
}>): void {
    for (const admission of params.admissions) {
        const result = admission.result;
        if (result.kind !== "ineligible") continue;
        afterTx(params.tx, () => {
            warn(
                {
                    module: "session-write",
                    event: "automation_session_lifecycle_admission_ineligible",
                    reason: result.reason,
                    triggerId: admission.triggerId,
                    accountId: params.accountId,
                    sourceSessionId: params.sourceSessionId,
                    sourceTurnId: params.sourceTurnId,
                },
                "Session lifecycle Automation admission was ineligible after Session settlement",
            );
        });
    }
}

type AccountEncryptionMigrationSessionRow = Readonly<{
    id: string;
    accountId: string;
    encryptionMode: string;
    displayProjectionV1: string | null;
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion: number;
    ownerMetadata: string | null;
    usageTimingV1?: unknown;
    agentState: string | null;
    agentStateVersion: number;
    archivedAt: Date | null;
}>;

export class SessionAccountEncryptionMigrationConflictError
    extends Error {
    constructor() {
        super(
            "Session account-encryption migration lost its tuple precondition",
        );
        this.name =
            "SessionAccountEncryptionMigrationConflictError";
    }
}

export type SessionAccountEncryptionMigrationResult =
    | Readonly<{
        status: "applied";
        sessions: readonly Readonly<{
            session: AccountEncryptionMigrationSessionRow;
            ownerCursor: number;
        }>[];
      }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type SessionAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

export type SessionAccountEncryptionMigrationInTxResult =
    | Exclude<SessionAccountEncryptionMigrationResult, { status: "applied" }>
    | (Readonly<{
        status: "applied";
        sessions: readonly Readonly<{
            session: AccountEncryptionMigrationSessionRow;
            ownerCursor: AccountChangePublication;
        }>[];
    }> & TransactionResult<Extract<SessionAccountEncryptionMigrationResult, { status: "applied" }>>);

async function readAccountEncryptionMigrationSessionRows(
    tx: Tx,
    accountId: string,
): Promise<readonly AccountEncryptionMigrationSessionRow[]> {
    return await tx.session.findMany({
        where: {
            accountId,
            OR: [
                { metadataLayoutVersion: { not: 0 } },
                { ownerMetadata: { not: null } },
            ],
        },
        orderBy: { id: "asc" },
        select: withSessionContentSelect({
            id: true,
            accountId: true,
            encryptionMode: true,
            displayProjectionV1: true,
            metadata: true,
            metadataVersion: true,
            usageTimingV1: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
        }),
    }).then(decodeSessionStoredContent);
}

function classifySessionAccountEncryptionMigrationInventory(
    params: Readonly<{
        rows: readonly AccountEncryptionMigrationSessionRow[];
        mode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateSessionsDirective;
        envelopeSide: "source" | "target";
    }>,
):
    | Readonly<{
        status: "ready";
        itemsById: ReadonlyMap<
            string,
            Extract<
                AccountEncryptionMigrateSessionsDirective,
                Readonly<{ action: "migrate" }>
            >["items"][number]
        >;
      }>
    | Readonly<{
        status:
            | "not_empty"
            | "migration_incomplete"
            | "invalid_content";
      }> {
    if (params.directive.action === "assert_empty") {
        return params.rows.length === 0
            ? { status: "ready", itemsById: new Map() }
            : { status: "not_empty" };
    }
    const parsedRows = params.rows.map((row) => ({
        row,
        ownerMetadata:
            parsePersistedSessionOwnerMetadataEnvelopeV1({
                metadataLayoutVersion: row.metadataLayoutVersion,
                accountMode: params.mode,
                ownerMetadata: row.ownerMetadata,

            }),
    }));
    if (
        parsedRows.some(({ row, ownerMetadata }) =>
            row.metadataLayoutVersion
                !== SESSION_METADATA_LAYOUT_VERSION_V1
            || ownerMetadata === null)
    ) {
        return { status: "invalid_content" };
    }
    const itemsById = new Map(
        params.directive.items.map((item) => [
            item.sessionId,
            item,
        ]),
    );
    if (
        itemsById.size !== params.directive.items.length
        || itemsById.size !== params.rows.length
    ) {
        return { status: "migration_incomplete" };
    }
    for (const { row } of parsedRows) {
        const item = itemsById.get(row.id);
        const encodedEnvelopeInput = item?.[
            params.envelopeSide === "source"
                ? "expectedOwnerMetadata"
                : "ownerMetadata"
        ];
        const envelopeResult =
            SessionOwnerMetadataEnvelopeV1Schema.safeParse(
                encodedEnvelopeInput,
            );
        if (
            !item
            || item.expectedMetadataLayoutVersion
                !== SESSION_METADATA_LAYOUT_VERSION_V1
            || item.expectedMetadataVersion
                !== row.metadataVersion
            || item.expectedAgentStateVersion
                !== row.agentStateVersion
        ) {
            return { status: "migration_incomplete" };
        }
        if (!envelopeResult.success) {
            return { status: "invalid_content" };
        }
        if (
            !validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1({
                accountMode: params.mode,
                envelope: envelopeResult.data,
            }).ok
            || !doesStoredSessionOwnerMetadataMatchEnvelope({
                stored: row.ownerMetadata,
                envelope: envelopeResult.data,
                accountMode: params.mode,

            })
        ) {
            return { status: "migration_incomplete" };
        }
    }
    return { status: "ready", itemsById };
}

function doesStoredSessionOwnerMetadataMatchEnvelope(
    params: Readonly<{
        stored: string | null;
        envelope: SessionOwnerMetadataEnvelopeV1;
        accountMode: "plain" | "e2ee";

    }>,
): boolean {
    const storedEnvelope =
        parsePersistedSessionOwnerMetadataEnvelopeV1({
            metadataLayoutVersion:
                SESSION_METADATA_LAYOUT_VERSION_V1,
            accountMode: params.accountMode,
            ownerMetadata: params.stored,

        });
    return storedEnvelope !== null
        && isDeepStrictEqual(storedEnvelope, params.envelope);
}

/**
 * Canonical Session tuple owner for Account-mode owner-envelope rewrites.
 *
 * The Account transition already holds exclusive Account admission. This
 * owner inventories active and archived layout-1 Sessions, validates the exact
 * source tuple, changes owner metadata/display, and advances the owner's canonical
 * Account Session-change cursor. Shared recipients are not published because
 * their visible Session bytes do not change.
 */
export async function migrateSessionAccountEncryptionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        directive: unknown;
    }>,
): Promise<SessionAccountEncryptionMigrationInTxResult> {
    const directiveResult =
        AccountEncryptionMigrateSessionsDirectiveSchema.safeParse(
            params.directive,
        );
    if (!directiveResult.success) {
        return { status: "invalid_content" };
    }
    const directive = directiveResult.data;
    const rows =
        await readAccountEncryptionMigrationSessionRows(
            params.tx,
            params.accountId,
        );
    const sourceInventory =
        classifySessionAccountEncryptionMigrationInventory({
            rows,
            mode: params.fromMode,
            directive,
            envelopeSide: "source",
        });
    if (sourceInventory.status !== "ready") {
        return sourceInventory;
    }
    if (directive.action === "assert_empty") {
        return { status: "applied", sessions: [], ...transactionResult(() => ({ status: "applied" as const, sessions: [] })) };
    }
    for (const item of directive.items) {
        if (!validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1({
            accountMode: params.toMode,
            envelope: item.ownerMetadata,
        }).ok || (item.ownerDisplay !== undefined && !validateSessionOwnerDisplayEnvelopeForAccountModeV1({
            accountMode: params.toMode, envelope: item.ownerDisplay,
        }).ok)) {
            return { status: "invalid_content" };
        }
    }

    const rowsById = new Map(
        rows.map((row) => [row.id, row]),
    );
    const sessions: Array<{
        session: AccountEncryptionMigrationSessionRow;
        ownerCursor: AccountChangePublication;
    }> = [];
    for (const item of directive.items) {
        const row = rowsById.get(item.sessionId);
        if (!row) {
            return { status: "migration_incomplete" };
        }
        const targetEnvelope = item.ownerMetadata;
        const nextOwnerMetadata =
            JSON.stringify(
                targetEnvelope,
            );
        // Account-private content and display change in this same tuple CAS.
        // The Session-key shared leaf and its outer linkage stay byte-exact.
        const sharedDisplay = projectSessionDisplayForRecipient({
            session: row,
            recipient: { type: 'shared', accountId: null, ownerAccountMode: params.fromMode },
        });
        const nextDisplayProjectionV1 = sharedDisplay ? JSON.stringify({ ...sharedDisplay,
            ...(item.ownerDisplay !== undefined ? { owner: item.ownerDisplay } : {}),
        }) : null;
        const updated = await params.tx.session.updateMany({
            where: {
                accountId: params.accountId,
                id: item.sessionId,
                metadataLayoutVersion:
                    SESSION_METADATA_LAYOUT_VERSION_V1,
                metadataVersion:
                    item.expectedMetadataVersion,
                ownerMetadata: row.ownerMetadata,
                displayProjectionV1: row.displayProjectionV1,
                agentStateVersion:
                    item.expectedAgentStateVersion,
            },
            data: {
                ownerMetadata: nextOwnerMetadata,
                usageTimingV1: nextSessionUsageTiming({ current: row.usageTimingV1, metadataWritten: true, metadataChanged: true, agentStateWritten: false, agentStateChanged: false }),
                displayProjectionV1: nextDisplayProjectionV1,
            },
        });
        if (updated.count !== 1) {
            throw new
                SessionAccountEncryptionMigrationConflictError();
        }
        const ownerCursor = await markAccountChanged(
            params.tx,
            {
                accountId: params.accountId,
                kind: "session",
                entityId: item.sessionId,
            });
        sessions.push({
            session: {
                ...row,
                ownerMetadata: nextOwnerMetadata,
                displayProjectionV1: nextDisplayProjectionV1,
            },
            ownerCursor,
        });
    }
    return {
        status: "applied",
        sessions,
        ...transactionResult(() => ({
            status: "applied" as const,
            sessions: sessions.map(({ session, ownerCursor }) => ({ session, ownerCursor: ownerCursor.resolveCursor() })),
        })),
    };
}

/**
 * Read-only exact post-state matcher used by Account-transition replay.
 */
export async function matchSessionAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: unknown;
    }>,
): Promise<SessionAccountEncryptionMigrationPostStateResult> {
    const directiveResult =
        AccountEncryptionMigrateSessionsDirectiveSchema.safeParse(
            params.directive,
        );
    if (!directiveResult.success) {
        return { status: "mismatch" };
    }
    const rows =
        await readAccountEncryptionMigrationSessionRows(
            params.tx,
            params.accountId,
        );
    const inventory =
        classifySessionAccountEncryptionMigrationInventory({
            rows,
            mode: params.toMode,
            directive: directiveResult.data,
            envelopeSide: "target",
        });
    if (inventory.status !== 'ready') return { status: 'mismatch' };
    if (directiveResult.data.action === 'migrate') {
        for (const row of rows) {
            const item = inventory.itemsById.get(row.id)!;
            if (item.ownerDisplay !== undefined && !validateSessionOwnerDisplayEnvelopeForAccountModeV1({
                accountMode: params.toMode, envelope: item.ownerDisplay,
            }).ok) return { status: 'mismatch' };
            const storedDisplay = SessionDisplayProjectionV1Schema.safeParse(parseJsonForComparison(row.displayProjectionV1 ?? ''));
            if (!storedDisplay.success) continue;
            const sharedDisplay = projectSessionDisplayForRecipient({ session: row,
                recipient: { type: 'shared', accountId: null, ownerAccountMode: params.toMode } });
            // Unavailable optional display never makes matching full content
            // unusable. A current shared projection, however, must carry the
            // exact admitted target owner leaf (or its deliberate absence).
            if (!sharedDisplay) continue;
            const expectedDisplay = { ...sharedDisplay,
                ...(item.ownerDisplay !== undefined ? { owner: item.ownerDisplay } : {}) };
            if (!isDeepStrictEqual(storedDisplay.data, expectedDisplay)) return { status: 'mismatch' };
        }
    }
    return { status: 'matched' };
}

function parseJsonForComparison(
    value: string,
): unknown | typeof JSON_PARSE_FAILED {
    try {
        return JSON.parse(value);
    } catch {
        return JSON_PARSE_FAILED;
    }
}

type SessionMessageWriteRow = {
    id: string;
    sessionId: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    createdAt: Date;
    updatedAt: Date;
    sourceCreatedAt: Date | null;
    sourceUpdatedAt: Date | null;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1 | null;
    /**
     * Server-internal admission evidence carried to the immediate publisher so
     * it can project the sanitized Account actor without rereading the row.
     * Neither field is ever serialized onto the wire.
     */
    inputAdmissionReceipt: SessionInputAdmissionReceiptV1 | null;
    authorAccountId: string | null;
};

type SessionMessageWriteRowInput = Omit<
    SessionMessageWriteRow,
    "messageRole" | "transcriptObservationProvenance" | "inputAdmissionReceipt"
> & Readonly<{
    inputAdmissionReceipt: unknown;
    messageRole: unknown;
    transcriptObservationProvenance: unknown;
    rowRevision?: bigint;
}>;

function toSessionMessageWriteRow(row: SessionMessageWriteRowInput): SessionMessageWriteRow {
    const {
        transcriptObservationProvenance: rawProvenance,
        rowRevision: _rowRevision,
        ...rest
    } = row;
    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(rawProvenance);
    return {
        ...rest,
        messageRole: parseSessionMessageRole(row.messageRole),
        inputAdmissionReceipt: createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(row.inputAdmissionReceipt).data ?? null,
        ...(provenance.success ? { transcriptObservationProvenance: provenance.data } : {}),
    };
}

export async function updateSessionMessageActivityProjection(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        created: Pick<SessionMessageWriteRow, "seq" | "createdAt" | "localId">;
        trustedSessionEventType?: "ready";
    }>,
): Promise<SessionReadyProjectionUpdate | undefined> {
    // Meaningful activity is written by the transcript writer's sequence update
    // (`writeSessionTranscriptMessageInTx` `recordsMeaningfulActivity`), not here.
    if (params.trustedSessionEventType !== "ready") return undefined;

    const readyProjection: SessionReadyProjectionUpdate = {
        latestReadyEventSeq: params.created.seq,
        latestReadyEventAt: params.created.createdAt.getTime(),
        ...(params.created.localId ? { latestReadyEventLocalId: params.created.localId } : {}),
    };
    const update = await tx.session.updateMany({
        where: {
            id: params.sessionId,
            OR: [
                { latestReadyEventSeq: null },
                { latestReadyEventSeq: { lt: params.created.seq } },
            ],
        },
        data: {
            latestReadyEventSeq: params.created.seq,
            latestReadyEventAt: params.created.createdAt,
        },
    });
    return update.count > 0 ? readyProjection : undefined;
}

export function resolveReadyProjectionEventType(params: Readonly<{
    actorUserId: string;
    sessionOwnerId: string;
    content: PrismaJson.SessionMessageContent;
    requestedSessionEventType?: "ready";
    readPlainRecord?: PlainTranscriptRecordReader;
}>): "ready" | undefined {
    if (params.actorUserId !== params.sessionOwnerId) return undefined;
    if (params.requestedSessionEventType === "ready") return "ready";
    if (params.content.t !== "plain") return undefined;

    const record = (params.readPlainRecord ?? createPlainTranscriptRecordReader(params.content))();
    if (!record) return undefined;

    return record.role === "agent"
        && record.content.type === "event"
        && record.content.data.type === "ready"
        ? "ready"
        : undefined;
}

/** The original publisher's existing opaque local ID keeps encrypted event bodies private. */
function readPublishedOriginalFollowEvent(content: PrismaJson.SessionMessageContent, localId: string | null, readPlainRecord: PlainTranscriptRecordReader): Readonly<{ kind: 'goal_changed' | 'update_posted' }> | undefined {
    if (content.t === 'plain') {
        const record = readPlainRecord();
        if (!record || record.role !== 'agent' || record.content.type !== 'event') return undefined;
        if (record.sidechainId || 'sidechainId' in record.content && record.content.sidechainId) return undefined;
        const type = record.content.data.type;
        return type === 'goal-changed' ? { kind: 'goal_changed' } : type === 'worker-report' ? { kind: 'update_posted' } : undefined;
    }
    for (const [type, kind] of [['goal-changed', 'goal_changed'], ['worker-report', 'update_posted']] as const) {
        const prefix = `${buildAgentEventLocalId(type, [])}:`;
        if (localId?.startsWith(prefix) && localId.length > prefix.length) return { kind };
    }
    return undefined;
}

function resolveSessionOwnedAttentionImpact(sessionTag: string): SessionMessageAttentionImpact | null {
    return sessionTag === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG
        ? SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT
        : null;
}


/** The fields one select names, from a row read with a wider select. */
function pickSelectedFields<Row extends object, Select extends Readonly<Record<string, true>>>(
    row: Row,
    select: Select,
): Pick<Row, Extract<keyof Select, keyof Row>> {
    return Object.fromEntries(Object.keys(select).filter(key => key in row)
        .map(key => [key, (row as Record<string, unknown>)[key]])) as Pick<Row, Extract<keyof Select, keyof Row>>;
}

function selectSessionActivityBadgeInputs() {
    return {
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        latestReadyEventSeq: true,
        latestTurnId: true,
        pendingCount: true,
        pendingBlockedCount: true,
        pendingPermissionRequestCount: true,
        pendingUserActionRequestCount: true,
        latestTurnStatus: true,
        lastRuntimeIssue: true,
        active: true,
        archivedAt: true,
    } as const;
}

function toSessionActivityBadgeInputs(
    value: SessionActivityBadgeInputs | null | undefined,
): SessionActivityBadgeInputs {
    return {
        ...(value ?? {}),
        seq: value?.seq ?? 0,
        pendingCount: value?.pendingCount ?? 0,
        pendingBlockedCount: value?.pendingBlockedCount ?? 0,
        pendingPermissionRequestCount: value?.pendingPermissionRequestCount ?? 0,
        pendingUserActionRequestCount: value?.pendingUserActionRequestCount ?? 0,
        latestTurnStatus: value?.latestTurnStatus ?? null,
        lastRuntimeIssue: value?.lastRuntimeIssue ?? null,
        active: value?.active ?? true,
        archivedAt: value?.archivedAt ?? null,
    };
}

function parseStoredRuntimeIssue(value: unknown): SessionRuntimeIssueV1 | null {
    if (!value) return null;
    if (typeof value === "string") {
        try {
            return sanitizeSessionRuntimeIssueV1(JSON.parse(value));
        } catch {
            return null;
        }
    }
    return sanitizeSessionRuntimeIssueV1(value);
}

function buildLegacyThinkingProjectionWriteData(params: Readonly<{
    latestTurnStatus: unknown;
    latestTurnStatusObservedAt: bigint | number | null;
}>): { thinking?: boolean; thinkingAt?: Date } {
    const latestTurnStatus = parseStoredPrimaryTurnStatus(params.latestTurnStatus);
    const observedAt =
        typeof params.latestTurnStatusObservedAt === "bigint"
            ? Number(params.latestTurnStatusObservedAt)
            : params.latestTurnStatusObservedAt;
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
        return {};
    }
    if (latestTurnStatus === "in_progress") {
        return {
            thinking: true,
            thinkingAt: new Date(observedAt),
        };
    }
    if (isTerminalPrimaryTurnStatus(latestTurnStatus) || latestTurnStatus === "waiting") {
        return {
            thinking: false,
            thinkingAt: new Date(observedAt),
        };
    }
    return {};
}

const SESSION_MUTATION_CONTEXT_SELECT = {
    tag: true, encryptionMode: true, agentStateVersion: true, latestTurnStatusObservedAt: true,
    projectKey: true, runtimeMachineTarget: true, ...selectSessionActivityBadgeInputs(),
} as const;
type SessionMutationContextState = Prisma.SessionGetPayload<{ select: typeof SESSION_MUTATION_CONTEXT_SELECT }>;

export type SessionMutationContextResult =
    | {
        ok: true;
        sessionOwnerId: string;
        access: EffectiveSessionAccess;
        sessionTag: string;
        sessionEncryptionMode: "e2ee" | "plain";
        recipientAccountIds: string[];
        sessionActivityBadgeInputs: SessionActivityBadgeInputs;
        /** The same locked Session read, for writers that decide from its turn and storage facts. */
        sessionState: SessionMutationContextState;
        /** The same locked read's access facts for the actor, which the write's fan-out decides from. */
        deliveryAccess: SessionDeliveryAccess;
      }
    | { ok: false; error: "session-not-found" | "forbidden" };

type SessionMutationContextTypedResult = Exclude<SessionMutationContextResult, { ok: false }>
    | { ok: false; error: "session-not-found" | "forbidden" | "authentication_required" | "authentication_unavailable" | "unavailable" };

type SessionMutationContextInput =
    | Readonly<{ actorUserId: string; sessionId: string; kind: "owner"; admittedAccess?: EffectiveSessionAccess }>
    | Readonly<{ actorUserId: string; sessionId: string; kind: "capability"; capability: SessionCapability; authentication: SessionAccessAuthentication; preserveAccessFailure?: boolean }>;
type SessionMutationContextPreservingInput = Readonly<{
    actorUserId: string;
    sessionId: string;
    kind: "capability";
    capability: SessionCapability;
    authentication: SessionAccessAuthentication;
    preserveAccessFailure: true;
}>;

function isTypedSessionMutationContextInput(input: SessionMutationContextInput): input is SessionMutationContextPreservingInput {
    return input.kind === "capability" && input.preserveAccessFailure === true;
}

function mapSessionMutationContextFailure(
    input: SessionMutationContextInput,
    reason: "authentication_required" | "authentication_unavailable" | "unavailable",
): "forbidden" | "authentication_required" | "authentication_unavailable" | "unavailable" {
    return isTypedSessionMutationContextInput(input) ? reason : "forbidden";
}

function mapSharedEditorAccessFailure(
    error: Extract<SessionMutationContextTypedResult, { ok: false }>["error"],
): Extract<UpdateSessionMetadataEnvelopeTupleResult, { ok: false }>["error"] {
    if (error === "authentication_required") return "session_access_authentication_required";
    if (error === "authentication_unavailable") return "session_access_authentication_unavailable";
    return error === "unavailable" ? "forbidden" : error;
}

function loadSessionMutationContextInTx(
    tx: Tx,
    params: SessionMutationContextPreservingInput,
): Promise<SessionMutationContextTypedResult>;
function loadSessionMutationContextInTx(
    tx: Tx,
    params: SessionMutationContextInput,
): Promise<SessionMutationContextResult>;

async function loadSessionMutationContextInTx(
    tx: Tx,
    params: SessionMutationContextInput,
): Promise<SessionMutationContextResult | SessionMutationContextTypedResult> {
    // Loading the context adds no audience: an exact scope this attempt already
    // admitted (for example by the publisher fence) is not censused again.
    await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId], [], { reuseHeldAudience: true });
    return readSessionMutationContextInTx(tx, params);
}

function readSessionMutationContextInTx(
    tx: Tx,
    params: SessionMutationContextPreservingInput,
): Promise<SessionMutationContextTypedResult>;
function readSessionMutationContextInTx(
    tx: Tx,
    params: SessionMutationContextInput,
): Promise<SessionMutationContextResult>;
async function readSessionMutationContextInTx(
    tx: Tx,
    params: SessionMutationContextInput,
): Promise<SessionMutationContextResult | SessionMutationContextTypedResult> {
    const contextSelect = SESSION_MUTATION_CONTEXT_SELECT;
    const input = { tx, accountId: params.actorUserId, sessionId: params.sessionId };
    // One Session read (after the Session lock) serves the context, the access decision and the
    // current recipients: the access projection already carries the recipient census's Session facts.
    const row = await tx.session.findUnique({ where: { id: params.sessionId },
        select: withSessionContentSelect({ ...buildSessionDeliveryAccessSelect([params.actorUserId],
            await readSessionAccessProjectionContextInTx(tx, [params.actorUserId])), ...contextSelect }) }).then(decodeSessionStoredContent);
    if (!row) return { ok: false, error: "session-not-found" };
    const session = pickSelectedFields(row, contextSelect);
    const admitted: SessionCapabilityAssertion = params.kind === "owner" && !params.admittedAccess
        ? await assertSessionOwnerInTx({ ...input, row })
        : params.kind === "capability"
            ? await assertSessionCapabilityInTx({ ...input, capability: params.capability, authentication: params.authentication, row })
            : params.admittedAccess ? { ok: true as const, access: params.admittedAccess } : { ok: false, reason: "unavailable" };
    if (!admitted.ok) return { ok: false, error: mapSessionMutationContextFailure(params, admitted.reason) };
    return {
        ok: true,
        sessionOwnerId: session.accountId,
        access: admitted.access,
        sessionTag: session.tag,
        sessionEncryptionMode: session.encryptionMode === "plain" ? "plain" : "e2ee",
        recipientAccountIds: await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: params.sessionId, session: row }),
        sessionActivityBadgeInputs: toSessionActivityBadgeInputs(session),
        sessionState: session,
        deliveryAccess: new Map([[params.actorUserId, row]]),
    };
}

async function loadSessionMutationContextPreservingAccessFailureInTx(
    tx: Tx,
    params: SessionMutationContextPreservingInput,
): Promise<SessionMutationContextTypedResult> {
    return loadSessionMutationContextInTx(tx, params);
}

/** Loads mutation context only after canonical input admission in this transaction. */
export async function loadSessionInputMutationContextInTx(tx: Tx, params: { actorUserId: string; sessionId: string; authentication: SessionAccessAuthentication }): Promise<SessionMutationContextResult> {
    return loadSessionMutationContextInTx(tx, { ...params, kind: "capability", capability: "submitAgentInput" });
}

async function loadSessionMutationContextForCapabilityInTx(
    tx: Tx,
    params: { actorUserId: string; sessionId: string; authentication: SessionAccessAuthentication },
    capability: SessionCapability,
): Promise<SessionMutationContextResult> {
    return loadSessionMutationContextInTx(tx, { ...params, kind: "capability", capability });
}

/** Publisher and storage-owner mutation context never broadens to collaborators. */
export async function loadSessionOwnerMutationContextInTx(tx: Tx, params: { actorUserId: string; sessionId: string }): Promise<SessionMutationContextResult> {
    return loadSessionMutationContextInTx(tx, { actorUserId: params.actorUserId, sessionId: params.sessionId, kind: "owner" });
}

/** The violated unique constraint as names: its fields (SQLite) or its index name (PostgreSQL, MySQL). */
function readUniqueConstraintNames(error: unknown): string[] {
    const constraint = readPrismaUniqueConstraint(error);
    return constraint?.index !== undefined ? [constraint.index] : [...(constraint?.fields ?? [])];
}

/** A P2002 naming SessionMessage (sessionId, localId). A violation that names no constraint
 * stays a candidate; the create path's winner comparison adjudicates it from current rows. */
function isSessionMessageLocalIdConflict(error: unknown): boolean {
    if (!isPrismaErrorCode(error, "P2002")) return false;
    const names = readUniqueConstraintNames(error).join(",");
    return names === "" || (names.includes("localId") && names.includes("sessionId"));
}

function isDuplicateSessionTurnMutationRace(error: unknown): boolean {
    if (!isPrismaErrorCode(error, "P2002")) return false;
    const targetFields = readUniqueConstraintNames(error);
    if (targetFields.length === 0) return true;
    const joined = targetFields.join(",");
    return (
        (joined.includes("sessionId") && joined.includes("mutationId"))
        || (joined.includes("sessionId") && joined.includes("turnId"))
    );
}

export type CreateSessionMessageResult =
    | {
        ok: true;
        didWrite: true;
        didUpdate: false;
        badgeAttentionChanged: boolean;
        attentionImpact: SessionMessageAttentionImpact;
        message: SessionMessageWriteRow;
        recipientCursors: RecipientCursor[];
        /** Server-internal: the recipients' committed access facts for the local fan-out. */
        deliveryAccess: SessionDeliveryAccess;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: true;
        badgeAttentionChanged: boolean;
        attentionImpact: SessionMessageAttentionImpact;
        message: SessionMessageWriteRow;
        /** Present when the content changed: the stored revision it replaced. */
        previousRevision?: Readonly<{ updatedAt: Date; sourceUpdatedAt: Date | null }>;
        recipientCursors: RecipientCursor[];
        /** Server-internal: the recipients' committed access facts for the local fan-out. */
        deliveryAccess: SessionDeliveryAccess;
      }
    | {
        ok: true;
        didWrite: false;
        didUpdate: false;
        badgeAttentionChanged: false;
        message: SessionMessageWriteRow;
        recipientCursors: [];
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "internal"; code?: SessionTranscriptWriteRejectionCode | SessionInputPermissionModesDisjointError["code"] }
    | { ok: false; error: "local-id-conflict" };

type CreateSessionMessageParamsBase = Readonly<{
    usageTimingV1?: UsageTimingBoundsV1 | null;
    /** Classified by the ingress, never inferred from a user-looking role or content. */
    actorUserId: string;
    sessionId: string;
    localId?: string | null;
    /**
     * A reserved local-ID operation may opt out of ordinary content correction:
     * only an exact stored message is replayable; every difference is refused.
     */
    localIdConflictPolicy?: "identical-or-conflict";
    sidechainId?: string | null;
    messageRole?: unknown;
    trustedSessionEventType?: "ready";
    trustedAttentionImpact?: SessionMessageAttentionImpact;
    publisherAuthority?: CurrentSessionPublisherAuthority;
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams['runtimeComposition'];
    trustedSourceTimestamps?: Readonly<{ createdAt: number; updatedAt: number }>;
    trustedTranscriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
    trustedSurfaceItemReference?: SessionTranscriptSurfaceItemReferenceInputV1;
}>;

type CreateSessionMessageParams = CreateSessionMessageParamsBase & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionMessageContent; ciphertext?: never }>
) & (
    | Readonly<{ inputAdmission: "authenticatedAccount"; authentication: SessionAccessAuthentication }>
    | Readonly<{ inputAdmission: "transcriptOnly"; authentication?: never }>
);

export type SessionReadyProjectionUpdate = Readonly<{
    latestReadyEventSeq: number;
    latestReadyEventAt: number;
    latestReadyEventLocalId?: string;
}>;

type SuccessfulSessionEditAccess = Extract<SessionMutationContextResult, { ok: true }>;

type TrustedLocalIdReconciliation =
    | {
        status: "not-found";
        access: SuccessfulSessionEditAccess;
        resolvedRole: SessionMessageRole | null;
        attentionImpact: SessionMessageAttentionImpact;
      }
    | {
        status: "reconciled";
        result: SessionWriteInTxResult<CreateSessionMessageResult>;
      };

function resolveSessionMessageRoleForWrite(params: Readonly<{
    content: PrismaJson.SessionMessageContent;
    suppliedRole: unknown;
    sessionId: string;
    storageMode: "e2ee" | "plain";
}>): SessionMessageRole | null {
    return resolveSessionMessageRole({
        content: params.content,
        suppliedRole: params.suppliedRole,
        telemetry: {
            sessionId: params.sessionId,
            storageMode: params.storageMode,
            source: "session-message",
        },
    }).messageRole;
}

async function reconcileExistingTrustedLocalIdInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    localId: string;
    sidechainId: string | null;
    content: PrismaJson.SessionMessageContent;
    suppliedRole: unknown;
    trustedAttentionImpact?: SessionMessageAttentionImpact;
    publisherAuthority?: CurrentSessionPublisherAuthority;
    sourceCreatedAt: Date;
    sourceUpdatedAt: Date;
    usageTimingV1?: UsageTimingBoundsV1 | null;
    provenance: SessionTranscriptObservationProvenanceV1;
    surfaceItemReference?: SessionTranscriptSurfaceItemReferenceInputV1;
    storagePolicy: SessionTranscriptStoragePolicy;
}>): Promise<TrustedLocalIdReconciliation> {
    if (
        !params.publisherAuthority
        || !await fenceExactCurrentPublisherAuthorityInTx(
            params.tx,
            params.publisherAuthority,
            params.actorUserId,
            params.sessionId,
            { admittedWork: true },
        )
    ) {
        return { status: "reconciled", result: { ok: false, error: "forbidden" } };
    }

    const accessStartedAt = Date.now();
    const access = await loadSessionOwnerMutationContextInTx(params.tx, {
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
    });
    observeCreateSessionMessageStage({
        stage: "access",
        durationMs: Date.now() - accessStartedAt,
        result: access.ok ? "ok" : "error",
    });
    if (!access.ok) {
        return { status: "reconciled", result: { ok: false, error: access.error } };
    }

    // Existing trusted local-id rows can advance their source watermark or
    // backfill role without traversing the insert writer. Delegate their
    // content admission to that same canonical owner before either mutation.
    const storageAdmission = validateSessionTranscriptStoredContent({
        content: params.content,
        sessionEncryptionMode: access.sessionEncryptionMode,
        storagePolicy: params.storagePolicy,
    });
    if (!storageAdmission.ok) {
        return {
            status: "reconciled",
            result: {
                ok: false,
                error: "invalid-params",
                code: storageAdmission.code,
            },
        };
    }

    const resolvedRole = resolveSessionMessageRoleForWrite({
        content: params.content,
        suppliedRole: params.suppliedRole,
        sessionId: params.sessionId,
        storageMode: access.sessionEncryptionMode,
    });
    const trustedLocalIdAttentionImpact = access.sessionOwnerId === params.actorUserId && resolvedRole === "event"
        ? agentEventLocalIdAttentionImpact(params.localId)
        : null;
    const attentionImpact = resolveMessageAttentionImpact({
        content: params.content,
        localId: params.localId ?? null,
        explicitAttentionImpact:
            resolveSessionOwnedAttentionImpact(access.sessionTag)
            ?? params.trustedAttentionImpact
            ?? trustedLocalIdAttentionImpact
            ?? undefined,
    });
    const existing = await params.tx.sessionMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
        select: SESSION_MESSAGE_WRITE_SELECT,
    }).then(row => decodeStoredSessionMessage(row));
    if (!existing) {
        return {
            status: "not-found",
            access,
            resolvedRole,
            attentionImpact,
        };
    }

    // A pre-provenance writer may already have committed this deterministic
    // history local id before transcript-observation metadata existed. The
    // local id remains the idempotency authority: acknowledge that exact
    // recovered-history effect without rewriting randomized ciphertext or
    // allowing a live observation to cross the compatibility seam.
    if (
        existing.transcriptObservationProvenance == null
        && isRecoveredHistoryTranscriptObservationProvenance(params.provenance)
    ) {
        if ((existing.sidechainId ?? null) !== params.sidechainId) {
            return { status: "reconciled", result: { ok: false, error: "invalid-params" } };
        }
        return {
            status: "reconciled",
            result: {
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: toSessionMessageWriteRow(existing),
                recipientCursors: [],
            },
        };
    }

    const parsedExistingProvenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(
        existing.transcriptObservationProvenance,
    );
    if (
        (existing.sidechainId ?? null) !== params.sidechainId
        || !parsedExistingProvenance.success
        || !isDeepStrictEqual(parsedExistingProvenance.data, params.provenance)
        || existing.sourceCreatedAt?.getTime() !== params.sourceCreatedAt.getTime()
        || existing.sourceUpdatedAt === null
        || params.sourceUpdatedAt.getTime() < existing.sourceUpdatedAt.getTime()
    ) {
        return { status: "reconciled", result: { ok: false, error: "invalid-params" } };
    }

    const contentRoleComparison = compareSessionMessageContentAndRole({
        existing,
        candidate: { content: params.content, messageRole: resolvedRole },
    });
    if (contentRoleComparison.kind === "role-conflict") {
        return {
            status: "reconciled",
            result: {
                ok: false,
                error: "invalid-params",
                code: "session_message_role_conflict",
            },
        };
    }
    const advancesWatermark = params.sourceUpdatedAt.getTime() > existing.sourceUpdatedAt.getTime();
    const backfillsRole = contentRoleComparison.kind === "match" && contentRoleComparison.backfillsRole;
    if (contentRoleComparison.kind === "match" && !advancesWatermark && !backfillsRole) {
        return {
            status: "reconciled",
            result: {
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: toSessionMessageWriteRow(existing),
                recipientCursors: [],
            },
        };
    }

    const writeAuthority = await validateSessionTranscriptWriteAuthorityInTx(params.tx, {
        sessionId: params.sessionId,
        writeAuthority: "hosted",
    });
    if (!writeAuthority.ok) {
        return {
            status: "reconciled",
            result: {
                ok: false,
                error: "invalid-params",
                code: writeAuthority.code,
            },
        };
    }

    if (contentRoleComparison.kind === "match") {
        const updated = await updateSessionMessageAtCurrentRevisionInTx({
            tx: params.tx,
            id: existing.id,
            rowRevision: existing.rowRevision,
            data: {
                ...(advancesWatermark ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
                ...(backfillsRole ? { messageRole: resolvedRole } : {}),
                rowRevision: { increment: BigInt(1) },
            },
        });
        if (!backfillsRole) {
            return {
                status: "reconciled",
                result: {
                    ok: true,
                    didWrite: false,
                    didUpdate: false,
                    badgeAttentionChanged: false,
                    message: toSessionMessageWriteRow(updated),
                    recipientCursors: [],
                },
            };
        }
        const recipientCursors = await markSessionProjectionRecipientsChanged({
            tx: params.tx,
            sessionId: params.sessionId,
            hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id, updatedMessageUpdatedAt: updated.updatedAt.getTime() },
            // Transcript rows never change owner metadata (Memory locality).
            memoryLocalityChanged: false,
            recipientAccountIds: access.recipientAccountIds,
            // Every createSessionMessage caller pushes `message-updated` to each recipient.
            sessionAudienceReceivesUpdate: true,
        });
        return {
            status: "reconciled",
            result: sessionRecipientPublicationResult({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                attentionImpact,
                message: toSessionMessageWriteRow(updated),
                recipientCursors,
                deliveryAccess: await readSessionDeliveryAccessInTx(params.tx, { sessionId: params.sessionId,
                    recipientAccountIds: recipientCursors.map(cursor => cursor.accountId), known: access.deliveryAccess }),
            }),
        };
    }

    const admittedSurfaceItemReference = await admitSessionTranscriptSurfaceItemReferenceInTx(params.tx, {
        accountId: access.sessionOwnerId, sessionId: params.sessionId,
        sessionEncryptionMode: access.sessionEncryptionMode, surfaceItemReference: params.surfaceItemReference,
    });
    const updated = await updateSessionMessageAtCurrentRevisionInTx({
        tx: params.tx,
        id: existing.id,
        rowRevision: existing.rowRevision,
        data: {
            content: params.content,
            usageTimingV1: params.usageTimingV1 ?? prismaRuntime.DbNull,
            surfaceItemReference: admittedSurfaceItemReference ?? prismaRuntime.DbNull,
            sidechainId: params.sidechainId,
            messageRole: resolvedRole,
            sourceUpdatedAt: params.sourceUpdatedAt,
            rowRevision: { increment: BigInt(1) },
        },
    });
    const recipientCursors = await markSessionProjectionRecipientsChanged({
        tx: params.tx,
        sessionId: params.sessionId,
        hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id, updatedMessageUpdatedAt: updated.updatedAt.getTime() },
        // Transcript rows never change owner metadata (Memory locality).
        memoryLocalityChanged: false,
        recipientAccountIds: access.recipientAccountIds,
        // Every createSessionMessage caller pushes `message-updated` to each recipient.
        sessionAudienceReceivesUpdate: true,
    });
    return {
        status: "reconciled",
        result: sessionRecipientPublicationResult({
            ok: true,
            didWrite: false,
            didUpdate: true,
            badgeAttentionChanged: false,
            attentionImpact,
            message: toSessionMessageWriteRow(updated),
            // The stored revision this content replaced: publishers relay a producer's
            // append only when it names exactly this base.
            previousRevision: { updatedAt: existing.updatedAt, sourceUpdatedAt: existing.sourceUpdatedAt },
            recipientCursors,
            deliveryAccess: await readSessionDeliveryAccessInTx(params.tx, { sessionId: params.sessionId,
                recipientAccountIds: recipientCursors.map(cursor => cursor.accountId), known: access.deliveryAccess }),
        }),
    };
}

export async function createSessionMessage(params: CreateSessionMessageParams): Promise<CreateSessionMessageResult> {
    return await createSessionMessageAttempt(params, true);
}

async function createSessionMessageAttempt(
    params: CreateSessionMessageParams,
    retryOnRowRevisionRace: boolean,
): Promise<CreateSessionMessageResult> {
    if (params.usageTimingV1 !== undefined && params.usageTimingV1 !== null && !UsageTimingBoundsV1Schema.safeParse(params.usageTimingV1).success) return { ok: false, error: 'invalid-params' };
    const totalStartedAt = Date.now();
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const directTokenInput = params.inputAdmission === "authenticatedAccount" && params.authentication.apiTokenGrant !== undefined;
    if (directTokenInput && (
        params.messageRole !== undefined && params.messageRole !== null && params.messageRole !== "user"
        || params.trustedSessionEventType !== undefined
        || params.trustedTranscriptObservationProvenance !== undefined
        || params.trustedSurfaceItemReference !== undefined
    )) return { ok: false, error: "invalid-params" };
    const localId = typeof params.localId === "string" ? params.localId : null;
    const parsedSidechainId = parseSessionMessageSidechainId(params.sidechainId, { emptyString: "invalid" });
    if (!parsedSidechainId.ok) {
        return { ok: false, error: "invalid-params" };
    }
    const sidechainId = parsedSidechainId.sidechainId;
    const sourceTimestamps = params.trustedSourceTimestamps;
    const hasTrustedProvenance = params.trustedTranscriptObservationProvenance !== undefined;
    if (params.trustedSurfaceItemReference !== undefined && !hasTrustedProvenance) {
        return { ok: false, error: 'invalid-params' };
    }
    if ((sourceTimestamps === undefined) !== !hasTrustedProvenance) {
        return { ok: false, error: "invalid-params" };
    }
    if (sourceTimestamps && (
        !Number.isSafeInteger(sourceTimestamps.createdAt)
        || sourceTimestamps.createdAt < 0
        || !Number.isSafeInteger(sourceTimestamps.updatedAt)
        || sourceTimestamps.updatedAt < sourceTimestamps.createdAt
    )) {
        return { ok: false, error: "invalid-params" };
    }
    const sourceCreatedAt = sourceTimestamps ? new Date(sourceTimestamps.createdAt) : null;
    const sourceUpdatedAt = sourceTimestamps ? new Date(sourceTimestamps.updatedAt) : null;
    if (
        sourceTimestamps
        && (!Number.isFinite(sourceCreatedAt?.getTime()) || !Number.isFinite(sourceUpdatedAt?.getTime()))
    ) {
        return { ok: false, error: "invalid-params" };
    }

    const rawContent = "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionMessageContent) : null;

    if (!sessionId || !actorUserId || !rawContent) {
        return { ok: false, error: "invalid-params" };
    }

    if (rawContent.t === "encrypted" && (!rawContent.c || typeof rawContent.c !== "string")) {
        return { ok: false, error: "invalid-params" };
    }
    if (rawContent.t === "plain" && !("v" in rawContent)) {
        return { ok: false, error: "invalid-params" };
    }
    const content = normalizeSessionMessageContentForStorage(rawContent);
    if (!content) return { ok: false, error: "invalid-params" };
    const readPlainRecord = createPlainTranscriptRecordReader(content);

    const encryptionPolicy = readEncryptionFeatureEnv(process.env);

    const resolveRoleForStorageMode = (storageMode: "e2ee" | "plain") =>
        resolveSessionMessageRoleForWrite({
            content,
            suppliedRole: directTokenInput ? (content.t === "encrypted" ? "user" : undefined) : params.messageRole,
            sessionId,
            storageMode,
        });
    if (directTokenInput && content.t === "plain" && resolveRoleForStorageMode("plain") !== "user") {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx): Promise<SessionWriteInTxResult<CreateSessionMessageResult>> => {
            let access: SuccessfulSessionEditAccess;
            let resolvedRole: SessionMessageRole | null;
            let attentionImpact: SessionMessageAttentionImpact;
            if (localId && hasTrustedProvenance) {
                if (
                    !sourceCreatedAt
                    || !sourceUpdatedAt
                    || !params.trustedTranscriptObservationProvenance
                ) {
                    return { ok: false, error: "invalid-params" };
                }
                const reconciliation = await reconcileExistingTrustedLocalIdInTx({
                    tx,
                    actorUserId,
                    sessionId,
                    localId,
                    sidechainId,
                    content,
                    suppliedRole: params.messageRole,
                    trustedAttentionImpact: params.trustedAttentionImpact,
                    publisherAuthority: params.publisherAuthority,
                    sourceCreatedAt,
                    sourceUpdatedAt,
                    usageTimingV1: params.usageTimingV1,
                    provenance: params.trustedTranscriptObservationProvenance,
                    surfaceItemReference: params.trustedSurfaceItemReference,
                    storagePolicy: encryptionPolicy.storagePolicy,
                });
                if (reconciliation.status === "reconciled") {
                    if (!reconciliation.result.ok) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                    }
                    return reconciliation.result;
                }
                ({ access, resolvedRole, attentionImpact } = reconciliation);
            } else {
                if (hasTrustedProvenance && (
                    !params.publisherAuthority
                    || !await fenceExactCurrentPublisherAuthorityInTx(tx, params.publisherAuthority, actorUserId, sessionId, { admittedWork: true })
                )) {
                    return { ok: false, error: "forbidden" };
                }
                const accessStartedAt = Date.now();
                const accessResult = params.inputAdmission === "authenticatedAccount"
                    ? await loadSessionInputMutationContextInTx(tx, {
                        actorUserId,
                        sessionId,
                        authentication: params.authentication,
                    })
                    : await loadSessionOwnerMutationContextInTx(tx, { actorUserId, sessionId });
                observeCreateSessionMessageStage({
                    stage: "access",
                    durationMs: Date.now() - accessStartedAt,
                    result: accessResult.ok ? "ok" : "error",
                });
                if (!accessResult.ok) {
                    observeCreateSessionMessageStage({
                        stage: "total",
                        durationMs: Date.now() - totalStartedAt,
                        result: "error",
                    });
                    return { ok: false, error: accessResult.error };
                }
                access = accessResult;
                resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);
                const trustedLocalIdAttentionImpact = access.sessionOwnerId === actorUserId && resolvedRole === "event"
                    ? agentEventLocalIdAttentionImpact(localId)
                    : null;
                attentionImpact = resolveMessageAttentionImpact({
                    content,
                    readPlainRecord,
                    localId: localId ?? null,
                    explicitAttentionImpact:
                        resolveSessionOwnedAttentionImpact(access.sessionTag)
                        ?? params.trustedAttentionImpact
                        ?? trustedLocalIdAttentionImpact
                        ?? undefined,
                });
            }

            const persistStartedAt = Date.now();
            // One Follow read serves the writer's read-state stamping and the alert decision below.
            const followCandidates = await readSessionFollowCandidatesInTx(tx, { sessionId, ownerAccountId: access.sessionOwnerId });
            const persisted = await writeSessionTranscriptMessageInTx(tx, {
                usageTimingV1: params.usageTimingV1,
                sessionId,
                activelyFollowingAccountIds: followCandidates.activelyFollowingAccountIds,
                // The sequence write records meaningful activity in the same Session row write.
                recordsMeaningfulActivity: attentionImpact.affectsMeaningfulActivity,
                writeAuthority: "hosted",
                sessionEncryptionMode: access.sessionEncryptionMode,
                storagePolicy: encryptionPolicy.storagePolicy,
                content,
                attentionImpact,
                localId,
                sidechainId,
                messageRole: resolvedRole,
                surfaceItemReference: params.trustedSurfaceItemReference,
                // A collaborator's declared transcript role cannot establish the role of opaque input.
                ...(params.inputAdmission === "authenticatedAccount" && !hasTrustedProvenance
                    && (resolvedRole === "user" || access.access.level !== "owner")
                    ? { inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: access.access,
                        callerInputConstraints: params.authentication.callerInputConstraints ?? params.authentication.apiTokenGrant }) }
                    : {}),
                ...(sourceCreatedAt ? { sourceCreatedAt } : {}),
                ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
                ...(params.trustedTranscriptObservationProvenance
                    ? { transcriptObservationProvenance: params.trustedTranscriptObservationProvenance }
                    : {}),
            });
            if (!persisted.ok) {
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
                return { ok: false, error: "invalid-params", code: persisted.code };
            }
            const created = persisted.message;
            const originalFollowEvent = resolvedRole === 'event' && sidechainId === null
                && actorUserId === access.sessionOwnerId
                && !isRecoveredHistoryTranscriptObservationProvenance(params.trustedTranscriptObservationProvenance)
                && params.publisherAuthority
                // Both trusted branches above already fenced this publisher in
                // this transaction; only an unfenced write reads it here.
                && (hasTrustedProvenance
                    || await hasExactCurrentPublisherAuthorityInTx(tx, params.publisherAuthority, actorUserId, sessionId,
                        undefined, { admittedWork: true }))
                ? readPublishedOriginalFollowEvent(content, localId, readPlainRecord) : undefined;
            if (params.inputAdmission === "authenticatedAccount" && resolvedRole === "user") {
                for (const recipientAccountId of access.recipientAccountIds) {
                    scheduleSessionPersonalEvent(tx, recipientAccountId, {
                        type: "session-personal-event", sessionId, eventId: created.id, event: "human_message",
                        message: { sequenceDomain: "session_transcript", messageSeq: created.seq }, sourceAccountId: actorUserId,
                    });
                }
                afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
                    sessionId,
                    event: "human_message",
                    committedMessage: { domain: "session_transcript", seq: created.seq },
                    sourceAccountId: actorUserId,
                }));
            }
            const readyProjection = await updateSessionMessageActivityProjection(tx, {
                sessionId,
                created,
                trustedSessionEventType: resolveReadyProjectionEventType({
                    actorUserId,
                    sessionOwnerId: access.sessionOwnerId,
                    content,
                    readPlainRecord,
                    requestedSessionEventType: params.trustedSessionEventType,
                }),
            });
            if (
                !(params.inputAdmission === "authenticatedAccount" && resolvedRole === "user")
                && attentionImpact.affectsUnread
                && !readyProjection
            ) {
                // The canonical attention-impact classifier distinguishes a
                // newly published material message from replay/history and
                // non-attention system rows without reading ciphertext here.
                for (const recipientAccountId of access.recipientAccountIds) {
                    scheduleSessionPersonalEvent(tx, recipientAccountId, {
                        type: "session-personal-event", sessionId, eventId: created.id, event: "message",
                        message: { sequenceDomain: "session_transcript", messageSeq: created.seq },
                        ...(originalFollowEvent ? { followEvent: originalFollowEvent } : {}),
                    });
                }
                // Most streamed lines can reach nobody (no candidate's Follow selects them): no alert work.
                if (canSessionFollowEventSelectAnyCandidate({ event: "message", candidates: followCandidates,
                    ...(originalFollowEvent ? { followEvent: originalFollowEvent } : {}) })) afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
                    sessionId,
                    event: "message",
                    committedMessage: { domain: "session_transcript", seq: created.seq },
                    ...(originalFollowEvent ? { followEvent: originalFollowEvent } : {}),
                    // Only the native main-session agent/event observer owns
                    // this semantic sender. Raw user observations have no
                    // protected human admission and remain Home-owned.
                    ...(params.runtimeComposition && (resolvedRole === 'agent' || resolvedRole === 'event')
                        && sidechainId === null && actorUserId === access.sessionOwnerId
                        && !isRecoveredHistoryTranscriptObservationProvenance(params.trustedTranscriptObservationProvenance)
                        ? { runtimeComposition: params.runtimeComposition } : {}),
                }));
            }
            observeCreateSessionMessageStage({
                stage: "persist",
                durationMs: Date.now() - persistStartedAt,
                result: "ok",
            });

            const changeTrackingStartedAt = Date.now();
            const recipientCursors = await markSessionProjectionRecipientsChanged({
                tx,
                sessionId,
                hint: { lastMessageSeq: created.seq, lastMessageId: created.id },
                // Transcript rows never change owner metadata (Memory locality).
                memoryLocalityChanged: false,
                recipientAccountIds: access.recipientAccountIds,
                publication: persisted.publication,
                // Every createSessionMessage caller pushes `new-message` to each recipient.
                sessionAudienceReceivesUpdate: true,
            });
            observeCreateSessionMessageStage({
                stage: "change_tracking",
                durationMs: Date.now() - changeTrackingStartedAt,
                result: "ok",
            });

            const nextSessionActivityBadgeInputs = {
                ...access.sessionActivityBadgeInputs,
                seq: created.seq,
            };
            const badgeAttentionChanged = didSessionActivityBadgeSignalChange(
                access.sessionActivityBadgeInputs,
                nextSessionActivityBadgeInputs,
            );

            observeCreateSessionMessageStage({
                stage: "total",
                durationMs: Date.now() - totalStartedAt,
                result: "ok",
            });

            return sessionRecipientPublicationResult({
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged,
                attentionImpact,
                message: toSessionMessageWriteRow(created),
                recipientCursors,
                deliveryAccess: await readSessionDeliveryAccessInTx(tx, { sessionId,
                    recipientAccountIds: recipientCursors.map(cursor => cursor.accountId), known: access.deliveryAccess }),
                ...(readyProjection ? { readyProjection } : {}),
            });
        }, { isolationLevel: "ReadCommitted" });
    } catch (e) {
        if (e instanceof SessionInputPermissionModesDisjointError) {
            return { ok: false, error: "invalid-params", code: e.code };
        }
        if (e instanceof SessionMessageRowRevisionRaceError && retryOnRowRevisionRace) {
            // The conditional update did not mutate or publish. Restart through
            // the same owner once so access, publisher currentness, authority,
            // and the winner comparison are all evaluated from current rows.
            return await createSessionMessageAttempt(params, false);
        }
        if (localId && isSessionMessageLocalIdConflict(e)) {
            if (hasTrustedProvenance) {
                try {
                    return await inTx(async (tx): Promise<SessionWriteInTxResult<CreateSessionMessageResult>> => {
                        if (
                            !sourceCreatedAt
                            || !sourceUpdatedAt
                            || !params.trustedTranscriptObservationProvenance
                        ) {
                            return { ok: false, error: "invalid-params" };
                        }
                        const reconciliation = await reconcileExistingTrustedLocalIdInTx({
                            tx,
                            actorUserId,
                            sessionId,
                            localId,
                            sidechainId,
                            content,
                            suppliedRole: params.messageRole,
                            trustedAttentionImpact: params.trustedAttentionImpact,
                            publisherAuthority: params.publisherAuthority,
                            sourceCreatedAt,
                            sourceUpdatedAt,
                            usageTimingV1: params.usageTimingV1,
                            provenance: params.trustedTranscriptObservationProvenance,
                            storagePolicy: encryptionPolicy.storagePolicy,
                        });
                        return reconciliation.status === "reconciled"
                            ? reconciliation.result
                            : { ok: false, error: "invalid-params" };
                    }, { isolationLevel: "ReadCommitted" });
                } catch (error) {
                    if (error instanceof SessionMessageRowRevisionRaceError && retryOnRowRevisionRace) {
                        return await createSessionMessageAttempt(params, false);
                    }
                    return { ok: false, error: "internal" };
                }
            }
            try {
                return await inTx(async (tx): Promise<SessionWriteInTxResult<CreateSessionMessageResult>> => {
                    const accessStartedAt = Date.now();
                    const access = params.inputAdmission === "authenticatedAccount"
                        ? await loadSessionInputMutationContextInTx(tx, {
                            actorUserId,
                            sessionId,
                            authentication: params.authentication,
                        })
                        : await loadSessionOwnerMutationContextInTx(tx, { actorUserId, sessionId });
                    observeCreateSessionMessageStage({
                        stage: "access",
                        durationMs: Date.now() - accessStartedAt,
                        result: access.ok ? "ok" : "error",
                    });
                    if (!access.ok) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return { ok: false as const, error: access.error };
                    }

                    const existing = await tx.sessionMessage.findUnique({
                        where: { sessionId_localId: { sessionId, localId } },
                        select: SESSION_MESSAGE_WRITE_SELECT,
                    }).then(row => decodeStoredSessionMessage(row));
                    if (!existing) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return { ok: false as const, error: "internal" as const };
                    }
                    const requiresIdenticalLocalId = params.localIdConflictPolicy === "identical-or-conflict";
                    if ((existing.sidechainId ?? null) !== sidechainId) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return requiresIdenticalLocalId
                            ? { ok: false as const, error: "local-id-conflict" as const }
                            : { ok: false as const, error: "invalid-params" as const };
                    }

                    const resolvedRole = resolveRoleForStorageMode(access.sessionEncryptionMode);
                    const storedReceipt = existing.inputAdmissionReceipt == null ? null
                        : createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(existing.inputAdmissionReceipt);
                    const admittedReceipt = params.inputAdmission === "authenticatedAccount"
                        && (resolvedRole === "user" || access.access.level !== "owner")
                        ? buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access: access.access,
                            callerInputConstraints: params.authentication.callerInputConstraints ?? params.authentication.apiTokenGrant })
                        : null;
                    if (storedReceipt !== null && (!storedReceipt.success
                        || admittedReceipt !== null && !isSameSessionInputAdmissionIssuer(storedReceipt.data, admittedReceipt))) {
                        return { ok: false as const, error: "local-id-conflict" as const };
                    }
                    const settledReceipt = storedReceipt?.success ? storedReceipt.data : admittedReceipt;
                    const derivedAuthor = deriveSessionMessageAuthorAccountIdV1({
                        messageRole: parseSessionMessageRole(existing.messageRole) ?? resolvedRole,
                        inputAdmissionReceipt: settledReceipt,
                    });
                    if (existing.authorAccountId != null && existing.authorAccountId !== derivedAuthor) {
                        return { ok: false as const, error: "local-id-conflict" as const };
                    }
                    const needsReceiptBackfill = storedReceipt === null && admittedReceipt !== null;
                    const survivingAuthor = existing.authorAccountId == null
                        ? await resolveSurvivingSessionMessageAuthorAccountIdInTx(tx, derivedAuthor)
                        : existing.authorAccountId;
                    const needsAuthorBackfill = existing.authorAccountId == null && survivingAuthor !== null;
                    const needsAdmissionBackfill = needsReceiptBackfill || needsAuthorBackfill;
                    const trustedLocalIdAttentionImpact = access.sessionOwnerId === actorUserId && resolvedRole === "event"
                        ? agentEventLocalIdAttentionImpact(localId)
                        : null;
                    const attentionImpact = resolveMessageAttentionImpact({
                        content,
                        localId: localId ?? null,
                        explicitAttentionImpact:
                            resolveSessionOwnedAttentionImpact(access.sessionTag)
                            ?? params.trustedAttentionImpact
                            ?? trustedLocalIdAttentionImpact
                            ?? undefined,
                    });
                    const contentRoleComparison = compareSessionMessageContentAndRole({
                        existing,
                        candidate: { content, messageRole: resolvedRole },
                    });
                    if (requiresIdenticalLocalId) {
                        if (contentRoleComparison.kind === "match" && !contentRoleComparison.backfillsRole && !needsAdmissionBackfill) {
                            observeCreateSessionMessageStage({
                                stage: "total",
                                durationMs: Date.now() - totalStartedAt,
                                result: "ok",
                            });
                            return {
                                ok: true as const,
                                didWrite: false as const,
                                didUpdate: false as const,
                                badgeAttentionChanged: false as const,
                                message: toSessionMessageWriteRow(existing),
                                recipientCursors: [],
                            };
                        }
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return { ok: false as const, error: "local-id-conflict" as const };
                    }
                    if (contentRoleComparison.kind === "role-conflict") {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return {
                            ok: false as const,
                            error: "invalid-params" as const,
                            code: "session_message_role_conflict" as const,
                        };
                    }
                    if (contentRoleComparison.kind === "match" && !contentRoleComparison.backfillsRole && !needsAdmissionBackfill) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "ok",
                        });
                        return {
                            ok: true as const,
                            didWrite: false as const,
                            didUpdate: false as const,
                            badgeAttentionChanged: false as const,
                            message: toSessionMessageWriteRow(existing),
                            recipientCursors: [],
                        };
                    }

                    const duplicateStorageAdmission = validateSessionTranscriptStoredContent({
                        content,
                        sessionEncryptionMode: access.sessionEncryptionMode,
                        storagePolicy: encryptionPolicy.storagePolicy,
                    });
                    if (!duplicateStorageAdmission.ok) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return {
                            ok: false as const,
                            error: "invalid-params" as const,
                            code: duplicateStorageAdmission.code,
                        };
                    }
                    const duplicateWriteAuthority = await validateSessionTranscriptWriteAuthorityInTx(tx, {
                        sessionId,
                        writeAuthority: "hosted",
                    });
                    if (!duplicateWriteAuthority.ok) {
                        observeCreateSessionMessageStage({
                            stage: "total",
                            durationMs: Date.now() - totalStartedAt,
                            result: "error",
                        });
                        return {
                            ok: false as const,
                            error: "invalid-params" as const,
                            code: duplicateWriteAuthority.code,
                        };
                    }

                    const duplicateUpdateStartedAt = Date.now();
                    const updated = await updateSessionMessageAtCurrentRevisionInTx({
                        tx,
                        id: existing.id,
                        rowRevision: existing.rowRevision,
                        data: contentRoleComparison.kind === "match"
                            ? {
                                ...(contentRoleComparison.backfillsRole ? { messageRole: resolvedRole } : {}),
                                ...(needsReceiptBackfill ? { inputAdmissionReceipt: admittedReceipt! } : {}),
                                ...(needsAuthorBackfill ? { authorAccountId: survivingAuthor } : {}),
                                rowRevision: { increment: BigInt(1) },
                            }
                            : {
                                content,
                                usageTimingV1: params.usageTimingV1 ?? prismaRuntime.DbNull,
                                sidechainId,
                                messageRole: resolvedRole,
                                ...(needsReceiptBackfill ? { inputAdmissionReceipt: admittedReceipt! } : {}),
                                ...(needsAuthorBackfill ? { authorAccountId: survivingAuthor } : {}),
                                rowRevision: { increment: BigInt(1) },
                            },
                    });
                    observeCreateSessionMessageStage({
                        stage: "persist",
                        durationMs: Date.now() - duplicateUpdateStartedAt,
                        result: "ok",
                    });

                    if (contentRoleComparison.kind === "match" && !contentRoleComparison.backfillsRole && !needsAdmissionBackfill) {
                        return {
                            ok: true as const,
                            didWrite: false as const,
                            didUpdate: false as const,
                            badgeAttentionChanged: false as const,
                            message: toSessionMessageWriteRow(updated),
                            recipientCursors: [],
                        };
                    }

                    const duplicateChangeTrackingStartedAt = Date.now();
                    const recipientCursors = await markSessionProjectionRecipientsChanged({
                        tx,
                        sessionId,
                        hint: { updatedMessageSeq: updated.seq, updatedMessageId: updated.id, updatedMessageUpdatedAt: updated.updatedAt.getTime() },
                        // Transcript rows never change owner metadata (Memory locality).
                        memoryLocalityChanged: false,
                        recipientAccountIds: access.recipientAccountIds,
                        // Every createSessionMessage caller pushes `message-updated` to each recipient.
                        sessionAudienceReceivesUpdate: true,
                    });
                    observeCreateSessionMessageStage({
                        stage: "change_tracking",
                        durationMs: Date.now() - duplicateChangeTrackingStartedAt,
                        result: "ok",
                    });

                    observeCreateSessionMessageStage({
                        stage: "total",
                        durationMs: Date.now() - totalStartedAt,
                        result: "ok",
                    });

                    return sessionRecipientPublicationResult({
                        ok: true as const,
                        didWrite: false as const,
                        didUpdate: true as const,
                        badgeAttentionChanged: false as const,
                        attentionImpact,
                        message: toSessionMessageWriteRow(updated),
                        recipientCursors,
                    });
                }, { isolationLevel: "ReadCommitted" });
            } catch (error) {
                if (error instanceof SessionInputPermissionModesDisjointError) {
                    return { ok: false, error: "invalid-params", code: error.code };
                }
                if (error instanceof SessionMessageRowRevisionRaceError && retryOnRowRevisionRace) {
                    return await createSessionMessageAttempt(params, false);
                }
                observeCreateSessionMessageStage({
                    stage: "total",
                    durationMs: Date.now() - totalStartedAt,
                    result: "error",
                });
                return { ok: false, error: "internal" };
            }
        }
        observeCreateSessionMessageStage({
            stage: "total",
            durationMs: Date.now() - totalStartedAt,
            result: "error",
        });
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionMetadataResult =
    | { ok: true; version: number; metadata: string; recipientCursors: RecipientCursor[]; badgeAttentionChanged: boolean; privateReadCursor?: Extract<ApplyViewerReadCursorOperationResult, { ok: true }> }
    | { ok: false; error: "invalid-params" | "forbidden" | "publisher-superseded" | "session-not-found" | "version-mismatch" | "metadata_privacy_upgrade_required" | "internal"; current?: { version: number; metadata: string } };

export async function updateSessionMetadata(params: {
    actorUserId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
    expectedVersion: number;
    metadataCiphertext: string;
    usageTimingV1?: UsageSessionTimingV1;
    readCursorHintV1?: { lastViewedSessionSeq: number };
    publisherAuthority?: CurrentSessionPublisherAuthority;
    publishCurrentView?: true;
}): Promise<UpdateSessionMetadataResult> {
    if (params.usageTimingV1 !== undefined && !UsageSessionTimingV1Schema.safeParse(params.usageTimingV1).success) return { ok: false, error: 'invalid-params' };
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const metadataCiphertext = typeof params.metadataCiphertext === "string" ? params.metadataCiphertext : "";
    const expectedVersion = typeof params.expectedVersion === "number" ? params.expectedVersion : NaN;
    const lastViewedSessionSeqHint =
        typeof params.readCursorHintV1?.lastViewedSessionSeq === "number" && Number.isFinite(params.readCursorHintV1.lastViewedSessionSeq)
            ? Math.max(0, Math.floor(params.readCursorHintV1.lastViewedSessionSeq))
            : null;

    if (!sessionId || !actorUserId || !metadataCiphertext || !Number.isFinite(expectedVersion)) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx): Promise<UpdateSessionMetadataResult | TransactionResult<UpdateSessionMetadataResult>> => {
            const operationAccess = await resolveSessionAccessForOperation(tx, {
                accountId: actorUserId,
                sessionId,
                authentication: params.authentication,
            });
            if (operationAccess.status !== "allowed" || operationAccess.access.level !== "owner") {
                return { ok: false, error: "forbidden" };
            }
            const access = await loadSessionMutationContextInTx(tx, {
                actorUserId,
                sessionId,
                kind: "owner",
                admittedAccess: operationAccess.access,
            });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }
            if (
                params.publisherAuthority
                && !await fenceExactCurrentPublisherAuthorityInTx(
                    tx,
                    params.publisherAuthority,
                    actorUserId,
                    sessionId,
                    { admittedWork: true },
                )
            ) {
                return { ok: false, error: "publisher-superseded" };
            }

            const written = await writeLegacySessionTupleInTx(tx, {
                sessionId, metadata: { ciphertext: metadataCiphertext, expectedVersion }, usageTimingV1: params.usageTimingV1,
            });
            if (!written.ok) {
                if (written.error === "version-mismatch") return {
                    ok: false, error: "version-mismatch",
                    ...(written.current ? { current: { version: written.current.metadata.version,
                        metadata: written.current.metadata.value } } : {}),
                };
                if (written.error === "session-not-found" || written.error === "metadata_privacy_upgrade_required") {
                    return { ok: false, error: written.error };
                }
                return { ok: false, error: "internal" };
            }
            let privateReadCursor: Extract<Awaited<ReturnType<typeof applyViewerReadCursorOperationInTx>>, { ok: true }> | undefined;
            if (typeof lastViewedSessionSeqHint === "number") {
                const read = await applyViewerReadCursorOperationInTx(tx, {
                    accountId: actorUserId, sessionId,
                    operation: { kind: "advance", lastViewedSessionSeq: lastViewedSessionSeqHint },
                    authentication: params.authentication,
                });
                if (!read.ok) throw new Error("Released metadata read hint could not update the viewer frontier");
                privateReadCursor = read;
            }
            const recipientCursors = written.didWrite ? await markSessionProjectionRecipientsChanged({
                tx, sessionId, recipientAccountIds: access.recipientAccountIds,
                hint: { metadataVersion: written.metadata.version }, followSourceChanged: false, usageAccountingChanged: false,
                ...(params.publishCurrentView ? { currentViewPublication: { kind: 'legacy_v0', sessionOwnerId: access.sessionOwnerId } } as const : {}),
            }) : [];
            return transactionResult(() => ({
                ok: true as const, version: written.metadata.version, metadata: written.metadata.value,
                recipientCursors: resolveSessionAccountChangePublications(recipientCursors),
                badgeAttentionChanged: false,
                ...(privateReadCursor ? { privateReadCursor: privateReadCursor.resolveResult() } : {}),
            }));
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdateSessionAgentStateResult =
    | {
        ok: true;
        version: number;
        agentState: string | null;
        recipientCursors: RecipientCursor[];
        badgeAttentionChanged: boolean;
        pendingPermissionRequestCount?: number;
        pendingUserActionRequestCount?: number;
        pendingRequestObservedAt?: number | null;
      }
    | { ok: false; error: "invalid-params" | "forbidden" | "session-not-found" | "version-mismatch" | "metadata_privacy_upgrade_required" | "internal"; current?: { version: number; agentState: string | null } };

export type SessionRuntimeActivityProjectionUpdate = {
    runtimeActivityState: SessionRuntimeActivityState;
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityRevision: number;
};

export type SessionRuntimeActivityProjectionInTxResult =
    | { status: "applied"; projection: SessionRuntimeActivityProjectionUpdate; becameIdle?: true }
    | { status: "unchanged"; projection: SessionRuntimeActivityProjectionUpdate }
    | { status: "rejected"; reason: "invalid-params" | "invalid_storage" | "not_found" | "revision_overflow" | "contention" };

export type AuthorizedSessionRuntimeActivityProjectionResult =
    | { status: "applied"; projection: SessionRuntimeActivityProjectionUpdate; recipientCursors: RecipientCursor[]; becameIdle?: true }
    | { status: "unchanged"; projection: SessionRuntimeActivityProjectionUpdate; recipientCursors: [] }
    | { status: "rejected"; reason: "invalid-params" | "invalid_storage" | "not_found" | "unauthorized" | "archived" | "superseded" | "revision_overflow" | "contention" };

function normalizeRuntimeActivityInteger(value: unknown): number | null {
    if (typeof value === "bigint") {
        const numberValue = Number(value);
        return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStoredRuntimeActivityProjection(value: Readonly<{
    runtimeActivityState?: unknown;
    runtimeActivityActiveCount?: unknown;
    runtimeActivityObservedAt?: unknown;
    runtimeActivityRevision?: unknown;
}>): SessionRuntimeActivityProjectionUpdate | null {
    const observedAt = value.runtimeActivityObservedAt === null
        ? null
        : normalizeRuntimeActivityInteger(value.runtimeActivityObservedAt);
    const revision = normalizeRuntimeActivityInteger(value.runtimeActivityRevision);
    const parsed = SessionRuntimeActivityProjectionSchema.safeParse({
        state: value.runtimeActivityState,
        activeCount: value.runtimeActivityActiveCount,
        observedAt,
        revision,
    });
    if (!parsed.success) return null;
    return {
        runtimeActivityState: parsed.data.state,
        runtimeActivityActiveCount: parsed.data.activeCount,
        runtimeActivityObservedAt: parsed.data.observedAt,
        runtimeActivityRevision: parsed.data.revision,
    };
}

function runtimeActivityProjectionEquals(
    a: SessionRuntimeActivityProjectionUpdate,
    b: Pick<SessionRuntimeActivityProjectionUpdate, "runtimeActivityState" | "runtimeActivityActiveCount">,
): boolean {
    return a.runtimeActivityState === b.runtimeActivityState
        && a.runtimeActivityActiveCount === b.runtimeActivityActiveCount;
}

export async function clearSessionRuntimeActivityProjectionInTx(params: {
    tx: Tx;
    sessionId: string;
}): Promise<
    | { didWrite: false }
    | { didWrite: true; projection: SessionRuntimeActivityProjectionUpdate }
> {
    const result = await writeSessionRuntimeActivityProjectionInTx({
        ...params,
        state: "unknown",
        activeCount: 0,
    });
    if (result.status === "applied") return { didWrite: true, projection: result.projection };
    if (result.status === "unchanged" || result.reason === "not_found") return { didWrite: false };
    if (result.reason === "invalid_storage") throw new Error("Invalid stored Runtime Activity projection");
    if (result.reason === "revision_overflow") throw new Error("Runtime Activity revision overflow");
    if (result.reason === "contention") throw new Error("Runtime Activity projection changed concurrently");
    throw new Error("Invalid Runtime Activity clear request");
}

/**
 * Clears the CURRENT runtime's turn, issue, request and thinking projections when the runtime
 * that published them is being replaced.
 *
 * These are plaintext projections derived from a live Agent process, not Session
 * history: once that process is gone they describe nothing, and a stale nonzero
 * count keeps a permission badge lit against a runtime that no longer exists.
 * `agentState` is cleared by the caller's own metadata write; these columns are
 * its derived siblings and must go with it.
 *
 * The request counters normally clear at strict idle, but failed-turn state and
 * crash leftovers can outlive the source process. The cutover retires those
 * projections together; historical SessionTurn rows remain unchanged.
 */
export async function clearSessionSourceRuntimeProjectionsInTx(params: {
    tx: Tx;
    sessionId: string;
    previousTurnStatusObservedAt: bigint | null;
}): Promise<{
    latestTurnId: null;
    latestTurnStatus: null;
    latestTurnStatusObservedAt: number | null;
    lastRuntimeIssue: null;
}> {
    // A cutover starts a new current runtime, while SessionTurn rows retain history.
    // Stay in the runner's clock domain so the target's next turn remains newer.
    const primaryTurnProjection = {
        latestTurnId: null, latestTurnStatus: null,
        latestTurnStatusObservedAt: params.previousTurnStatusObservedAt === null ? null : Number(params.previousTurnStatusObservedAt) + 1,
        lastRuntimeIssue: null,
    };
    await params.tx.session.updateMany({
        where: { id: params.sessionId },
        data: {
            ...primaryTurnProjection,
            latestTurnStatusObservedAt: primaryTurnProjection.latestTurnStatusObservedAt === null ? null : BigInt(primaryTurnProjection.latestTurnStatusObservedAt),
            thinking: false,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
        },
    });
    return primaryTurnProjection;
}

export async function writeSessionRuntimeActivityProjectionInTx(params: {
    tx: Tx;
    sessionId: string;
    state: unknown;
    activeCount: unknown;
}): Promise<SessionRuntimeActivityProjectionInTxResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const snapshot = SessionRuntimeActivitySnapshotSchema.safeParse({
        state: params.state,
        activeCount: params.activeCount,
    });
    if (!sessionId || !snapshot.success) {
        return { status: "rejected", reason: "invalid-params" };
    }

    await acquireSessionAccountCursorLocksInTx(params.tx, [sessionId]);
    const current = await params.tx.session.findUnique({
        where: { id: sessionId },
        select: {
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!current) {
        return { status: "rejected", reason: "not_found" };
    }

    const normalizedCurrent = parseStoredRuntimeActivityProjection(current);
    if (!normalizedCurrent) {
        return { status: "rejected", reason: "invalid_storage" };
    }
    const candidate: SessionRuntimeActivityProjectionUpdate = {
        runtimeActivityState: snapshot.data.state,
        runtimeActivityActiveCount: snapshot.data.activeCount,
        runtimeActivityObservedAt: normalizedCurrent.runtimeActivityObservedAt,
        runtimeActivityRevision: normalizedCurrent.runtimeActivityRevision,
    };
    if (runtimeActivityProjectionEquals(normalizedCurrent, candidate)) {
        return { status: "unchanged", projection: normalizedCurrent };
    }

    if (normalizedCurrent.runtimeActivityRevision >= Number.MAX_SAFE_INTEGER) {
        return { status: "rejected", reason: "revision_overflow" };
    }
    const projection: SessionRuntimeActivityProjectionUpdate = {
        ...candidate,
        runtimeActivityObservedAt: Date.now(),
        runtimeActivityRevision: normalizedCurrent.runtimeActivityRevision + 1,
    };

    const write = await params.tx.session.updateMany({
        where: {
            id: sessionId,
            runtimeActivityRevision: current.runtimeActivityRevision,
        },
        data: {
            runtimeActivityState: projection.runtimeActivityState,
            runtimeActivityActiveCount: projection.runtimeActivityActiveCount,
            runtimeActivityObservedAt: BigInt(projection.runtimeActivityObservedAt!),
            runtimeActivityRevision: BigInt(projection.runtimeActivityRevision),
        },
    });
    return write.count === 1
        ? {
            status: "applied",
            projection,
            ...(normalizedCurrent.runtimeActivityState !== "idle" && projection.runtimeActivityState === "idle"
                ? { becameIdle: true as const }
                : {}),
        }
        : { status: "rejected", reason: "contention" };
}

/** Preserves explicit idle on observer loss; every other valid Activity becomes unknown. */
export async function writeSessionRuntimeActivityObserverLossInTx(params: {
    tx: Tx;
    sessionId: string;
}): Promise<SessionRuntimeActivityProjectionInTxResult> {
    const current = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!current) return { status: "rejected", reason: "not_found" };
    const normalized = parseStoredRuntimeActivityProjection(current);
    if (!normalized) return { status: "rejected", reason: "invalid_storage" };
    if (normalized.runtimeActivityState === "idle") {
        return { status: "unchanged", projection: normalized };
    }
    return await writeSessionRuntimeActivityProjectionInTx({
        ...params,
        state: "unknown",
        activeCount: 0,
    });
}

type SessionRuntimeActivityPublisher = Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
    boundCommittedFence: Date;
}>;

/** Read publisher identity and Activity data without reopening request admission. */
async function readSessionRuntimeActivityPublisherInTx(tx: Tx, params: SessionRuntimeActivityPublisher) {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            active: true, archivedAt: true, lastActiveAt: true, publisherGenerationLastActiveAt: true,
            runtimeActivityState: true, runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true, runtimeActivityRevision: true,
        },
    });
    if (!session) return { status: "rejected", reason: "not_found" } as const;
    if (session.archivedAt !== null) return { status: "rejected", reason: "archived" } as const;
    if (!session.active || session.lastActiveAt.getTime() !== params.boundCommittedFence.getTime()
        || session.publisherGenerationLastActiveAt?.getTime() !== params.boundCommittedFence.getTime()) {
        return { status: "rejected", reason: "superseded" } as const;
    }
    return { status: "current", session } as const;
}

/** Applies a complete Activity snapshot only for the exact current authenticated publisher fence. */
export async function updateSessionRuntimeActivityProjection(params: SessionRuntimeActivityPublisher & {
    state: unknown;
    activeCount: unknown;
}): Promise<AuthorizedSessionRuntimeActivityProjectionResult> {
    const snapshot = SessionRuntimeActivitySnapshotSchema.safeParse({
        state: params.state,
        activeCount: params.activeCount,
    });
    if (!snapshot.success) return { status: "rejected", reason: "invalid-params" };
    // Reoffering the already committed snapshot changes no state, timestamp or
    // cursor. Linearize that acknowledgement at one coherent read of publisher
    // authority and Activity instead of waiting for unrelated Account writers.
    const unchanged = await inReadSnapshot(async (tx): Promise<AuthorizedSessionRuntimeActivityProjectionResult | null> => {
        const publisher = await readSessionRuntimeActivityPublisherInTx(tx, params);
        if (publisher.status === "rejected") return publisher;
        const projection = parseStoredRuntimeActivityProjection(publisher.session);
        if (!projection) return { status: "rejected", reason: "invalid_storage" };
        return runtimeActivityProjectionEquals(projection, {
            runtimeActivityState: snapshot.data.state,
            runtimeActivityActiveCount: snapshot.data.activeCount,
        }) ? { status: "unchanged", projection, recipientCursors: [] } : null;
    }, { transactionClass: "session.runtime-activity" });
    if (unchanged) return unchanged;
    return await inTx(async (tx): Promise<SessionWriteInTxResult<AuthorizedSessionRuntimeActivityProjectionResult>> => {
        // Stabilize Account admission and serialize publisher replacement at
        // the Session resource. Account cursor publication runs after domain
        // work, while RC observes the current admitted Session row.
        await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId]);
        const publisher = await readSessionRuntimeActivityPublisherInTx(tx, params);
        if (publisher.status === "rejected") return publisher;
        const activity = await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: params.sessionId,
            state: snapshot.data.state,
            activeCount: snapshot.data.activeCount,
        });
        if (activity.status === "rejected") return activity;
        if (activity.status === "unchanged") return { ...activity, recipientCursors: [] };
        const recipientCursors = await markSessionProjectionRecipientsChanged({
            tx,
            sessionId: params.sessionId,
            hint: { runtimeActivityRevision: activity.projection.runtimeActivityRevision },
            usageAccountingChanged: false,
            followSourceChanged: false,
            memoryInputsChanged: false,
        });
        return sessionRecipientPublicationResult({ ...activity, recipientCursors });
    }, { isolationLevel: "ReadCommitted", transactionClass: "session.runtime-activity" });
}

/** Normalize the session-wide request summary from its Agent-state owner. */
function normalizePendingRequestActivitySummary(
    summary: Readonly<{
        pendingPermissionRequestCount?: number;
        pendingUserActionRequestCount?: number;
        pendingRequestNewestCreatedAt?: number | null;
    }>,
) {
    const count = (value: number | undefined) =>
        typeof value === "number" && Number.isFinite(value)
            ? Math.max(0, Math.floor(value))
            : undefined;
    const permissionCount = count(summary.pendingPermissionRequestCount);
    const userActionCount = count(summary.pendingUserActionRequestCount);
    const hasCounts = permissionCount !== undefined || userActionCount !== undefined;
    const newestCreatedAt = typeof summary.pendingRequestNewestCreatedAt === "number"
        && Number.isFinite(summary.pendingRequestNewestCreatedAt)
        ? Math.max(0, Math.floor(summary.pendingRequestNewestCreatedAt))
        : null;
    return {
        ...(permissionCount !== undefined
            ? { pendingPermissionRequestCount: permissionCount } : {}),
        ...(userActionCount !== undefined
            ? { pendingUserActionRequestCount: userActionCount } : {}),
        ...(hasCounts ? { pendingRequestObservedAt:
            (permissionCount ?? 0) + (userActionCount ?? 0) > 0
                ? new Date(newestCreatedAt ?? Date.now()) : null,
        } : {}),
    };
}

/** Both Agent-state writers publish the same committed request occurrence. */
async function publishCommittedSessionRequestOccurrencesInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    ownerAccountId: string;
    sourceSession: import("@/app/automations/automationSessionLifecycleSubjects").AutomationSessionLifecycleSourceFacts;
    recipientAccountIds: readonly string[];
    agentStateVersion: number;
    source: Readonly<{ latestTurnId: string | null; latestTurnStatus: string | null; seq: number }>;
    occurrences: readonly SessionUserActionRequiredOccurrenceV1[];
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams['runtimeComposition'];
}>): Promise<void> {
    for (const occurrence of input.occurrences) {
        const sourceTurn = await tx.sessionTurn.findUnique({
            where: { sessionId_turnId: { sessionId: input.sessionId, turnId: occurrence.sourceTurnId } },
            select: { initiator: true, workDepth: true, workflowInvocationJson: true },
        });
        const lifecycleAdmissions = await admitSessionLifecycleAutomationRunsTx({
            tx, accountId: input.ownerAccountId,
            sourceSession: input.sourceSession, recipientAccountIds: input.recipientAccountIds,
            ...(sourceTurn ? { sourceTurnFacts: parseStoredSessionTurnFacts(sourceTurn) } : {}),
            occurrence: {
                v: 1, kind: 'sessionLifecycle', event: 'userActionRequired', sourceSessionId: input.sessionId,
                sourceTurnId: occurrence.sourceTurnId, requestId: occurrence.requestId,
                requestKind: occurrence.requestKind, occurredAt: occurrence.occurredAt,
            },
        });
        scheduleSessionLifecycleAdmissionDiagnostics({
            tx, admissions: lifecycleAdmissions, accountId: input.ownerAccountId,
            sourceSessionId: input.sessionId, sourceTurnId: occurrence.sourceTurnId,
        });
        // Only this exact, still non-terminal primary Turn establishes personal
        // delivery. Counts or a later decrypted snapshot cannot replace it.
        if (occurrence.sourceTurnId !== input.source.latestTurnId
            || isTerminalPrimaryTurnStatus(parseStoredPrimaryTurnStatus(input.source.latestTurnStatus))) continue;
        const event = occurrence.requestKind === 'permission' ? 'permission_required' as const : 'user_action_required' as const;
        const onceOccurrence = {
            event: occurrence.requestKind === 'permission'
                || occurrence.followEvent?.kind === 'needs_you' && occurrence.followEvent.type === 'approval'
                ? 'permission_required' as const : 'user_action_required' as const,
            turnId: occurrence.sourceTurnId, requestId: occurrence.requestId,
            agentStateVersion: input.agentStateVersion, transcriptSeq: input.source.seq,
        };
        const acceptedOnceAccountIds = await acceptSessionPersonalEventOnceInTx(tx, {
            sessionId: input.sessionId, event, followEvent: occurrence.followEvent, onceOccurrence,
        });
        afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
            sessionId: input.sessionId, event, committedRequestId: occurrence.requestId,
            committedTurnId: occurrence.sourceTurnId,
            followEvent: occurrence.followEvent, onceOccurrence, acceptedOnceAccountIds,
            ...(input.runtimeComposition ? { runtimeComposition: input.runtimeComposition } : {}),
        }));
    }
}

export async function updateSessionAgentState(params: {
    actorUserId: string;
    sessionId: string;
    expectedVersion: number;
    agentStateCiphertext: string | null;
    usageTimingV1?: UsageSessionTimingV1;
    publishCurrentView?: true;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    pendingRequestNewestCreatedAt?: number | null;
    userActionRequiredOccurrences?: readonly SessionUserActionRequiredOccurrenceV1[];
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams["runtimeComposition"];
    restrictedRuntimePrecondition?: Readonly<{
        publisherAuthority: CurrentSessionPublisherAuthority;
        principal: VerifiedEphemeralSessionRunnerPrincipal;
    }>;
}): Promise<UpdateSessionAgentStateResult> {
    if (params.usageTimingV1 !== undefined && !UsageSessionTimingV1Schema.safeParse(params.usageTimingV1).success) return { ok: false, error: 'invalid-params' };
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const expectedVersion = typeof params.expectedVersion === "number" ? params.expectedVersion : NaN;
    const agentStateCiphertext =
        typeof params.agentStateCiphertext === "string" || params.agentStateCiphertext === null ? params.agentStateCiphertext : undefined;
    const parsedUserActionRequiredOccurrences =
        z.array(SessionUserActionRequiredOccurrenceV1Schema).safeParse(
            params.userActionRequiredOccurrences ?? [],
        );

    if (
        !sessionId
        || !actorUserId
        || !Number.isFinite(expectedVersion)
        || agentStateCiphertext === undefined
        || !parsedUserActionRequiredOccurrences.success
    ) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx): Promise<SessionWriteInTxResult<UpdateSessionAgentStateResult>> => {
            if (parsedUserActionRequiredOccurrences.data.length > 0) {
                await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [], { includeLifecyclePublications: true });
            }
            if (
                params.restrictedRuntimePrecondition
                && (
                    !await verifyCurrentMaterializedRunnerPrincipalInTx(
                        tx,
                        params.restrictedRuntimePrecondition.principal,
                    )
                    || !await fenceExactCurrentPublisherAuthorityInTx(
                        tx,
                        params.restrictedRuntimePrecondition.publisherAuthority,
                        actorUserId,
                        sessionId,
                        { admittedWork: true },
                    )
                )
            ) {
                return { ok: false, error: "forbidden" };
            }
            const access = await loadSessionOwnerMutationContextInTx(tx, {
                actorUserId,
                sessionId,
            });
            if (!access.ok) {
                return { ok: false, error: access.error };
            }

            // An attention occurrence makes this the canonical Automation
            // admission transaction, so it takes the same existing Account
            // transition fence terminal settlement takes, in the same order:
            // before the AgentState row it settles can change.
            if (parsedUserActionRequiredOccurrences.data.length > 0) {
                const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
                    tx,
                    access.sessionOwnerId,
                    "content",
                );
                if (accountFence.status !== "ready") {
                    return { ok: false, error: "internal" };
                }
            }

            const pendingSummary = normalizePendingRequestActivitySummary(params);
            const written = await writeLegacySessionTupleInTx(tx, {
                sessionId, agentState: { ciphertext: agentStateCiphertext, expectedVersion }, usageTimingV1: params.usageTimingV1,
                activitySummary: pendingSummary,
            });
            if (!written.ok) {
                if (written.error === "version-mismatch") return {
                    ok: false, error: "version-mismatch",
                    ...(written.current ? { current: { version: written.current.agentState.version,
                        agentState: written.current.agentState.value } } : {}),
                };
                if (written.error === "session-not-found" || written.error === "metadata_privacy_upgrade_required") {
                    return { ok: false, error: written.error };
                }
                return { ok: false, error: "internal" };
            }
            if (!written.didWrite) return {
                ok: true, version: written.agentState.version, agentState: written.agentState.value,
                recipientCursors: [], badgeAttentionChanged: false,
            };
            await publishCommittedSessionRequestOccurrencesInTx(tx, {
                sessionId, ownerAccountId: access.sessionOwnerId, source: written.previous,
                sourceSession: { ...access.sessionState, id: sessionId }, recipientAccountIds: access.recipientAccountIds,
                agentStateVersion: written.agentState.version, occurrences: parsedUserActionRequiredOccurrences.data,
                ...(params.runtimeComposition ? { runtimeComposition: params.runtimeComposition } : {}),
            });
            const recipientCursors = await markSessionProjectionRecipientsChanged({
                tx, sessionId, recipientAccountIds: access.recipientAccountIds,
                hint: { agentStateVersion: written.agentState.version },
                usageAccountingChanged: false,
                // Agent state is not a Memory input (eligibility reads transcript seq, metadata, archive).
                memoryInputsChanged: false,
                ...(params.publishCurrentView ? { currentViewPublication: { kind: 'legacy_v0', sessionOwnerId: access.sessionOwnerId } } as const : {}),
            });
            const settledPendingRequestObservedAt = pendingSummary.pendingRequestObservedAt instanceof Date
                ? pendingSummary.pendingRequestObservedAt.getTime() : pendingSummary.pendingRequestObservedAt;
            const badgeAttentionChanged = didSessionActivityBadgeSignalChange(
                toSessionActivityBadgeInputs(written.previous),
                { ...toSessionActivityBadgeInputs(written.previous), ...pendingSummary },
            );
            return sessionRecipientPublicationResult({
                ok: true, version: written.agentState.version, agentState: written.agentState.value,
                recipientCursors, badgeAttentionChanged,
                ...(pendingSummary.pendingPermissionRequestCount !== undefined
                    ? { pendingPermissionRequestCount: pendingSummary.pendingPermissionRequestCount } : {}),
                ...(pendingSummary.pendingUserActionRequestCount !== undefined
                    ? { pendingUserActionRequestCount: pendingSummary.pendingUserActionRequestCount } : {}),
                ...(settledPendingRequestObservedAt !== undefined
                    ? { pendingRequestObservedAt: settledPendingRequestObservedAt } : {}),
            });
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ApplySessionTurnMutationNoOpReason =
    | "duplicate-mutation"
    | "terminal-turn"
    | "stale-in-progress"
    | "no-current-turn";

export type ApplySessionTurnMutationResult =
    | {
        ok: true;
        didApply: boolean;
        reason?: ApplySessionTurnMutationNoOpReason;
        receipt: SessionTurnMutationReceiptV1;
        latestTurnId: string | null;
        latestTurnStatus: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt: number | null;
        lastRuntimeIssue: SessionRuntimeIssueV1 | null;
        recipientCursors: RecipientCursor[];
        badgeAttentionChanged: boolean;
        rollbackEligibleTurnStarts?: number[];
        /** Server-internal: an applied mutation's Session recipient projection, returned by its own update (null when nothing applied). */
        recipientProjection: SessionTranscriptPublicationRecipientProjectionRow | null;
        /** Server-internal: an applied mutation's recipients' committed access facts for the local fan-out. */
        deliveryAccess?: SessionDeliveryAccess;
      }
    | {
        ok: false;
        error: "invalid-params";
        code?: SessionTranscriptWriteRejectionCode | "session_team_credential_binding_rejected";
        reason?: SessionTeamCredentialBindingRejectionV1;
      }
    | { ok: false; error: "forbidden" | "session-not-found" | "internal" };

type SessionTurnApplicationRow = Readonly<{
    id: string;
    sessionId: string;
    turnId: string;
    agentId: string | null;
    agentTurnId: string | null;
    status: string;
    initiator: string;
    workDepth: number;
    workflowInvocationJson: string | null;
    startedAt: bigint | number;
    updatedAt: bigint | number;
    terminalAt: bigint | number | null;
    lastRuntimeIssueJson: string | null;
    transcriptAnchorsJson: string | null;
    rollbackState: string | null;
    rollbackReason: string | null;
    agentRollbackOrdinal: number | null;
    rollbackUpdatedAt: bigint | number | null;
    lastMutationId: string | null;
}>;

class SessionTurnTeamCredentialBindingCurrentnessError extends Error {
    constructor(readonly reason: SessionTeamCredentialBindingRejectionV1) {
        super(reason);
        this.name = "SessionTurnTeamCredentialBindingCurrentnessError";
    }
}

async function resolveSessionTurnTeamCredentialWitnessInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    actorAccountId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{
    usageActorAccountId: string | null;
    teamCredentialResourceId: string | null;
    credentialDeliveryMode: TeamCredentialRouteV1 | null;
}>> {
    const bindings = await readSessionTeamCredentialBindingsForSlotInTx(params.tx, {
        sessionId: params.sessionId,
        slot: { kind: "provider_model" },
        deliveryModes: TEAM_CREDENTIAL_ROUTES_V1,
    });
    if (bindings.length > 1) {
        throw new SessionTurnTeamCredentialBindingCurrentnessError("resource_corrupt");
    }
    const binding = bindings[0];
    if (!binding) {
        return {
            usageActorAccountId: null,
            teamCredentialResourceId: null,
            credentialDeliveryMode: null,
        };
    }
    const admission = await validateExistingSessionTeamCredentialResourceInTx(params.tx, {
        sessionId: params.sessionId,
        accountId: params.actorAccountId,
        resourceId: binding.resourceId,
        // The witness names the accepted resource and route; its recorded
        // revision is not a lock. The resource's policy is admitted as it is
        // now (`teams-lane-10/11` A2(4)).
        deliveryMode: binding.deliveryMode,
        authentication: params.authentication,
    });
    if (!admission.ok) {
        throw new SessionTurnTeamCredentialBindingCurrentnessError(admission.reason);
    }
    return {
        usageActorAccountId: params.actorAccountId,
        teamCredentialResourceId: admission.binding.resourceId,
        credentialDeliveryMode: admission.binding.deliveryMode,
    };
}

type SessionTurnMaterializedSession = Readonly<{
    latestTurnId?: string | null;
    latestTurnStatus?: string | null;
    latestTurnStatusObservedAt?: bigint | number | null;
    lastRuntimeIssue?: string | null;
}>;

function toObservedAtNumber(value: bigint | number | null | undefined): number | null {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toObservedAtBigInt(value: number): bigint {
    return BigInt(Math.max(0, Math.floor(value)));
}

function readObservedAtNumber(value: unknown): number | null {
    return typeof value === "bigint" || typeof value === "number" ? toObservedAtNumber(value) : null;
}

function materializedSessionTurnState(session: SessionTurnMaterializedSession): Pick<
    Extract<ApplySessionTurnMutationResult, { ok: true }>,
    "latestTurnId" | "latestTurnStatus" | "latestTurnStatusObservedAt" | "lastRuntimeIssue"
> {
    return {
        latestTurnId: session.latestTurnId ?? null,
        latestTurnStatus: parseStoredPrimaryTurnStatus(session.latestTurnStatus),
        latestTurnStatusObservedAt: toObservedAtNumber(session.latestTurnStatusObservedAt),
        lastRuntimeIssue: parseStoredRuntimeIssue(session.lastRuntimeIssue),
    };
}

function sessionTurnRowStatus(row: SessionTurnApplicationRow | null): PrimaryTurnStatusV1 | null {
    return parseStoredPrimaryTurnStatus(row?.status);
}

function sessionTurnRowRuntimeIssue(row: SessionTurnApplicationRow | null): SessionRuntimeIssueV1 | null {
    return parseStoredRuntimeIssue(row?.lastRuntimeIssueJson);
}

function buildTranscriptAnchorsJson(mutation: SessionTurnMutationV1): string | undefined {
    if (
        mutation.action !== "begin"
        && mutation.action !== "append_transcript_anchors"
        && mutation.action !== "mark_rollback_eligible"
        && mutation.action !== "complete"
    ) {
        return undefined;
    }
    return mutation.transcriptAnchors ? JSON.stringify(mutation.transcriptAnchors) : undefined;
}

function parseTranscriptAnchorsJson(value: string | null | undefined): Record<string, unknown> {
    return parseStoredSessionTurnTranscriptAnchors(value) as Record<string, unknown> | undefined ?? {};
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isTrustedAnchorSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function hasTrustedRollbackAnchorsJson(value: string | null | undefined): boolean {
    const anchors = parseTranscriptAnchorsJson(value);
    return isTrustedAnchorSeq(anchors.startUserMessageSeq)
        && (
            isTrustedAnchorSeq(anchors.endSeqInclusive)
            || anchors.providerCheckpoint !== undefined
        );
}

function mergeTranscriptAnchorsJson(
    currentJson: string | null | undefined,
    mutation: SessionTurnMutationV1,
): string | undefined {
    if (
        mutation.action !== "begin"
        && mutation.action !== "append_transcript_anchors"
        && mutation.action !== "mark_rollback_eligible"
        && mutation.action !== "complete"
    ) {
        return undefined;
    }
    if (!mutation.transcriptAnchors) return undefined;
    const existing = parseTranscriptAnchorsJson(currentJson);
    const incoming = mutation.transcriptAnchors as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing, ...incoming };
    const existingSeqs = Array.isArray(existing.userMessageSeqs) ? existing.userMessageSeqs : [];
    const incomingSeqs = Array.isArray(incoming.userMessageSeqs) ? incoming.userMessageSeqs : [];
    const userMessageSeqs = [...existingSeqs, ...incomingSeqs]
        .map(readFiniteNumber)
        .filter((value): value is number => value !== undefined);
    if (userMessageSeqs.length > 0) {
        merged.userMessageSeqs = [...new Set(userMessageSeqs)].sort((a, b) => a - b);
    }
    return JSON.stringify(merged);
}

class InvalidSessionTurnCompletionAnchorError extends Error {}

async function assertValidFinalAssistantAnchor(params: Readonly<{
    tx: Tx;
    mutation: SessionTurnMutationV1;
    transcriptAnchorsJson: string | null | undefined;
}>): Promise<void> {
    if ((params.mutation.action !== "complete" && params.mutation.action !== "append_transcript_anchors")
        || !params.mutation.transcriptAnchors) return;
    if (!Object.prototype.hasOwnProperty.call(params.mutation.transcriptAnchors, "finalAssistantMessageSeq")) return;
    const finalSeq = params.mutation.transcriptAnchors.finalAssistantMessageSeq;
    if (finalSeq === null || finalSeq === undefined) return;
    const anchors = parseTranscriptAnchorsJson(params.transcriptAnchorsJson);
    const startSeqInclusive = readFiniteNumber(anchors.startSeqInclusive);
    const endSeqInclusive = readFiniteNumber(anchors.endSeqInclusive);
    if (
        startSeqInclusive === undefined
        || endSeqInclusive === undefined
        || finalSeq < startSeqInclusive
        || finalSeq > endSeqInclusive
    ) {
        throw new InvalidSessionTurnCompletionAnchorError("Final assistant anchor is outside the turn transcript range");
    }
    const row = await params.tx.sessionMessage.findFirst({
        where: {
            sessionId: params.mutation.sessionId,
            seq: finalSeq,
        },
        select: {
            seq: true,
            messageRole: true,
            sidechainId: true,
        },
    });
    if (!row || row.seq !== finalSeq || row.messageRole !== "agent" || row.sidechainId !== null) {
        throw new InvalidSessionTurnCompletionAnchorError("Final assistant anchor does not identify one main-chain assistant row");
    }
}

function resolveSessionTurnLastRuntimeIssue(mutation: SessionTurnMutationV1): SessionRuntimeIssueV1 | null {
    return mutation.action === "fail" ? sanitizeSessionRuntimeIssueV1(mutation.issue) : null;
}

function mapSessionTurnNoOpReasonToDecision(reason: ApplySessionTurnMutationNoOpReason): SessionTurnMutationDecisionV1 {
    if (reason === "duplicate-mutation") return "duplicate-mutation";
    if (reason === "stale-in-progress") return "stale-in-progress";
    if (reason === "terminal-turn") return "stale-terminal";
    return "missing-turn";
}

function buildSessionTurnMutationReceipt(params: {
    mutation: SessionTurnMutationV1;
    decision: SessionTurnMutationDecisionV1;
    appliedAt?: number;
    turnId?: string | null;
}): SessionTurnMutationReceiptV1 {
    return {
        v: 1,
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        ...(params.turnId ? { turnId: params.turnId } : "turnId" in params.mutation && params.mutation.turnId ? { turnId: params.mutation.turnId } : {}),
        action: params.mutation.action,
        decision: params.decision,
        observedAt: params.mutation.observedAt,
        appliedAt: params.appliedAt ?? Date.now(),
    };
}

function isSessionTurnMutationDecision(value: unknown): value is SessionTurnMutationDecisionV1 {
    return value === "applied"
        || value === "duplicate-mutation"
        || value === "duplicate-terminal"
        || value === "missing-turn"
        || value === "stale-in-progress"
        || value === "stale-terminal";
}

function parseSessionTurnMutationAction(value: unknown): SessionTurnMutationActionV1 | null {
    const parsed = SessionTurnMutationActionV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function storedSessionTurnMutationReceipt(params: {
    row: {
        sessionId?: unknown;
        mutationId?: unknown;
        turnId?: unknown;
        action?: unknown;
        decision?: unknown;
        observedAt?: unknown;
        appliedAt?: unknown;
    };
    mutation: SessionTurnMutationV1;
}): SessionTurnMutationReceiptV1 {
    const turnId = typeof params.row.turnId === "string" ? params.row.turnId : undefined;
    const observedAt = readObservedAtNumber(params.row.observedAt) ?? params.mutation.observedAt;
    const appliedAt = readObservedAtNumber(params.row.appliedAt) ?? Date.now();
    const action = parseSessionTurnMutationAction(params.row.action) ?? params.mutation.action;
    return {
        v: 1,
        sessionId: typeof params.row.sessionId === "string" ? params.row.sessionId : params.mutation.sessionId,
        mutationId: typeof params.row.mutationId === "string" ? params.row.mutationId : params.mutation.mutationId,
        ...(turnId ? { turnId } : {}),
        action,
        decision: isSessionTurnMutationDecision(params.row.decision) ? params.row.decision : "duplicate-mutation",
        observedAt,
        appliedAt,
    };
}

function buildSessionTurnReceiptData(
    mutation: SessionTurnMutationV1,
    decision: SessionTurnMutationDecisionV1,
    appliedAt: number,
    turnId?: string | null,
) {
    return {
        sessionId: mutation.sessionId,
        mutationId: mutation.mutationId,
        turnId: turnId ?? ("turnId" in mutation ? mutation.turnId ?? null : null),
        action: mutation.action,
        decision,
        observedAt: toObservedAtBigInt(mutation.observedAt),
        appliedAt: toObservedAtBigInt(appliedAt),
    };
}

async function createSessionTurnMutationReceipt(
    tx: Tx,
    mutation: SessionTurnMutationV1,
    decision: SessionTurnMutationDecisionV1,
    turnId?: string | null,
): Promise<
    | { status: "created"; receipt: SessionTurnMutationReceiptV1 }
    | { status: "duplicate"; receipt: SessionTurnMutationReceiptV1 | null }
> {
    const appliedAt = Date.now();
    try {
        await tx.sessionTurnMutationReceipt.create({
            data: buildSessionTurnReceiptData(mutation, decision, appliedAt, turnId),
        });
        return {
            status: "created",
            receipt: buildSessionTurnMutationReceipt({
                mutation,
                decision,
                appliedAt,
                turnId,
            }),
        };
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            const existingReceipt = await tx.sessionTurnMutationReceipt.findUnique({
                where: {
                    sessionId_mutationId: {
                        sessionId: mutation.sessionId,
                        mutationId: mutation.mutationId,
                    },
                },
            });
            return {
                status: "duplicate",
                receipt: existingReceipt ? storedSessionTurnMutationReceipt({ row: existingReceipt, mutation }) : null,
            };
        }
        throw error;
    }
}

async function updateSessionTurnMutationReceipt(
    tx: Tx,
    mutation: SessionTurnMutationV1,
    decision: SessionTurnMutationDecisionV1,
    turnId: string | null,
): Promise<SessionTurnMutationReceiptV1> {
    const appliedAt = Date.now();
    await tx.sessionTurnMutationReceipt.update({
        where: {
            sessionId_mutationId: {
                sessionId: mutation.sessionId,
                mutationId: mutation.mutationId,
            },
        },
        data: {
            turnId,
            action: mutation.action,
            decision,
            observedAt: toObservedAtBigInt(mutation.observedAt),
            appliedAt: toObservedAtBigInt(appliedAt),
        },
    });
    return buildSessionTurnMutationReceipt({
        mutation,
        decision,
        appliedAt,
        turnId,
    });
}

async function loadMaterializedSessionTurnState(tx: Tx, sessionId: string) {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            latestTurnId: true,
            latestTurnStatus: true,
            latestTurnStatusObservedAt: true,
            lastRuntimeIssue: true,
        },
    });
    return session ? materializedSessionTurnState(session) : null;
}

function createSessionTurnNoOpResult(params: {
    reason: ApplySessionTurnMutationNoOpReason;
    state: ReturnType<typeof materializedSessionTurnState>;
    receipt: SessionTurnMutationReceiptV1;
}): Extract<ApplySessionTurnMutationResult, { ok: true }> {
    return {
        ok: true,
        didApply: false,
        reason: params.reason,
        receipt: params.receipt,
        ...params.state,
        recipientCursors: [],
        badgeAttentionChanged: false,
        recipientProjection: null,
    };
}

function createSessionTurnAppliedResult(params: {
    mutation: SessionTurnMutationV1;
    turn: SessionTurnApplicationRow;
    receipt: SessionTurnMutationReceiptV1;
    state?: ReturnType<typeof materializedSessionTurnState>;
    recipientCursors: SessionRecipientPublication[];
    badgeAttentionChanged: boolean;
    rollbackEligibleTurnStarts?: number[];
    recipientProjection: SessionTranscriptPublicationRecipientProjectionRow;
    deliveryAccess: SessionDeliveryAccess;
}): SessionWriteInTxResult<Extract<ApplySessionTurnMutationResult, { ok: true }>> {
    const result = {
        ok: true,
        didApply: true,
        receipt: params.receipt,
        latestTurnId: params.state?.latestTurnId ?? params.turn.turnId,
        latestTurnStatus: params.state?.latestTurnStatus ?? sessionTurnRowStatus(params.turn),
        latestTurnStatusObservedAt: params.state?.latestTurnStatusObservedAt ?? params.mutation.observedAt,
        lastRuntimeIssue: params.state?.lastRuntimeIssue ?? sessionTurnRowRuntimeIssue(params.turn),
        recipientCursors: params.recipientCursors,
        badgeAttentionChanged: params.badgeAttentionChanged,
        recipientProjection: params.recipientProjection,
        deliveryAccess: params.deliveryAccess,
        ...(params.rollbackEligibleTurnStarts !== undefined
            ? { rollbackEligibleTurnStarts: params.rollbackEligibleTurnStarts }
            : {}),
    } as const;
    return params.recipientCursors.length > 0
        ? sessionRecipientPublicationResult(result)
        : { ...result, recipientCursors: [] };
}

async function applySessionTurnMutationWithOwnerAccessInTx(params: {
    tx: Tx;
    actorUserId: string;
    turnMutation: SessionTurnMutationV1;
    markParticipants: boolean;
    principal:
        | Readonly<{ kind: "credential"; authentication: SessionAccessAuthentication }>
        | Readonly<{ kind: "session_owner_runtime" }>;
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams["runtimeComposition"];
}): Promise<SessionWriteInTxResult<ApplySessionTurnMutationResult>> {
    const tx = params.tx;
    const sessionId = params.turnMutation.sessionId;
    const terminalStatus = resolveSessionTurnTerminalStatus(params.turnMutation);
    // These annotations change only SessionTurn and its durable receipt. They
    // publish neither a Session projection nor an Account cursor. Serialize all
    // turn mutations at Session instead of making annotations join that audience.
    const annotationOnly = params.turnMutation.action === "attach_agent_turn_id"
        || params.turnMutation.action === "append_transcript_anchors";
    if (!annotationOnly) {
        await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [], {
            includeLifecyclePublications: producesAutomationSessionLifecycleOccurrence(params.turnMutation.action),
        });
    }
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    if (dialect !== "sqlite") {
        await tx.$queryRawUnsafe(
            dialect === "postgres"
                ? 'SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE'
                : 'SELECT `id` FROM `Session` WHERE `id` = ? FOR UPDATE',
            sessionId,
        );
    }
    // Compatible Account admission precedes the Session resource lock; turn
    // decisions and receipt reservation follow it, with cursor publication last.
    const access = await readSessionMutationContextInTx(tx, {
        actorUserId: params.actorUserId,
        sessionId,
        ...(params.principal.kind === "credential"
            ? { kind: "capability", capability: "submitAgentInput", authentication: params.principal.authentication } as const
            : { kind: "owner" } as const),
    });
        if (!access.ok) {
            return { ok: false, error: access.error };
        }

        // The context's one locked Session read carries the storage authority and turn facts.
        const session = access.sessionState;
        const writeAuthority = session.currentStorageState === "hosted" ? { accountId: session.accountId } : null;
        if (!writeAuthority) {
            return {
                ok: false,
                error: "invalid-params",
                code: "session_storage_authority_mismatch",
            };
        }

        const existingReceipt = await tx.sessionTurnMutationReceipt.findUnique({
            where: {
                sessionId_mutationId: {
                    sessionId: params.turnMutation.sessionId,
                    mutationId: params.turnMutation.mutationId,
                },
            },
        });
        if (existingReceipt) {
            const state = await loadMaterializedSessionTurnState(tx, params.turnMutation.sessionId);
            if (!state) return { ok: false, error: "session-not-found" };
            return createSessionTurnNoOpResult({
                reason: "duplicate-mutation",
                state,
                receipt: storedSessionTurnMutationReceipt({ row: existingReceipt, mutation: params.turnMutation }),
            });
        }

        // Every terminal settlement is a canonical exact-turn Automation
        // admission transaction, not completion alone. Take the existing
        // Account transition fence before a new mutation receipt or
        // SessionTurn can be changed so a non-current Account cannot commit
        // the turn without its eligible Run. A committed mutation receipt
        // remains independently replayable above.
        if (terminalStatus !== null) {
            const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
                tx,
                writeAuthority.accountId,
                "content",
            );
            if (accountFence.status !== "ready") {
                return { ok: false, error: "internal" };
            }
        }

        const reservationResult = await createSessionTurnMutationReceipt(tx, params.turnMutation, "stale-in-progress");
        if (reservationResult.status === "duplicate") {
            const state = await loadMaterializedSessionTurnState(tx, params.turnMutation.sessionId);
            if (!state) return { ok: false, error: "session-not-found" };
            return createSessionTurnNoOpResult({
                reason: "duplicate-mutation",
                state,
                receipt: reservationResult.receipt ?? buildSessionTurnMutationReceipt({
                    mutation: params.turnMutation,
                    decision: "duplicate-mutation",
                }),
            });
        }

        if (params.turnMutation.action === 'session_opened') {
            const state = materializedSessionTurnState(session);
            const issue = state.lastRuntimeIssue;
            const resolved = issue?.scope === 'primary_session' && issue.status === 'failed'
                && readSessionStartupFailurePreview(issue.code) !== null
                && params.turnMutation.observedAt > Math.max(issue.occurredAt, state.latestTurnStatusObservedAt ?? 0);
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation,
                resolved ? 'applied' : 'stale-terminal', session.latestTurnId);
            if (!resolved) return createSessionTurnNoOpResult({ reason: 'terminal-turn', state, receipt });
            // Opening resolves the Session's startup projection, not the failed
            // historical turn. Advance its existing freshness frontier so a late
            // heartbeat of that turn cannot restore the resolved issue.
            const publication = await tx.session.update({ where: { id: sessionId }, select: SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT, data: {
                lastRuntimeIssue: null,
                latestTurnStatusObservedAt: toObservedAtBigInt(params.turnMutation.observedAt),
            } });
            const recipientCursors = params.markParticipants ? await markSessionProjectionRecipientsChanged({
                tx, sessionId, recipientAccountIds: access.recipientAccountIds, publication,
                hint: { latestTurnStatusObservedAt: params.turnMutation.observedAt },
                usageAccountingChanged: false,
                // Turn rows and the latest-status projection: no transcript seq, metadata or archive change.
                memoryInputsChanged: false,
                // Participant-marking callers (applySessionTurnMutation) publish through publishSessionTurnMutationUpdate.
                sessionAudienceReceivesUpdate: true,
            }) : [];
            return sessionRecipientPublicationResult({ ok: true as const, didApply: true, receipt,
                ...state, lastRuntimeIssue: null, latestTurnStatusObservedAt: params.turnMutation.observedAt,
                recipientCursors, recipientProjection: publication,
                deliveryAccess: await readSessionDeliveryAccessInTx(tx, { sessionId,
                    recipientAccountIds: recipientCursors.map(cursor => cursor.accountId), known: access.deliveryAccess }),
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(toSessionActivityBadgeInputs(session),
                    { ...toSessionActivityBadgeInputs(session), lastRuntimeIssue: null }),
            });
        }

        const requestedTurnId = "turnId" in params.turnMutation ? params.turnMutation.turnId : undefined;
        const targetTurnId = requestedTurnId ?? session.latestTurnId ?? null;
        if (!targetTurnId) {
            const reason = "no-current-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), null);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        const currentTurn = await tx.sessionTurn.findUnique({
            where: {
                sessionId_turnId: {
                    sessionId: params.turnMutation.sessionId,
                    turnId: targetTurnId,
                },
            },
        }) as SessionTurnApplicationRow | null;
        const transition = await decideSessionTurnMutation({
            mutation: params.turnMutation, currentTurn, targetTurnId, requestedTurnId,
            latestTurnId: session.latestTurnId, terminalStatus,
            loadLatestTurnStatus: async turnId => {
                const latest = await tx.sessionTurn.findUnique({
                    where: { sessionId_turnId: { sessionId, turnId } },
                    select: { status: true },
                });
                return latest?.status ?? null;
            },
        });
        if (!transition.ok) {
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, transition.decision, targetTurnId);
            return createSessionTurnNoOpResult({
                reason: transition.reason, state: materializedSessionTurnState(session), receipt,
            });
        }
        const { updatesRollbackFacet } = transition;
        const observedAt = toObservedAtBigInt(params.turnMutation.observedAt);
        const transcriptAnchorsJson = currentTurn
            ? mergeTranscriptAnchorsJson(currentTurn.transcriptAnchorsJson, params.turnMutation)
            : buildTranscriptAnchorsJson(params.turnMutation);
        const transcriptAnchorProjection = deriveSessionTurnTranscriptAnchorProjection(
            transcriptAnchorsJson ?? currentTurn?.transcriptAnchorsJson,
        );
        await assertValidFinalAssistantAnchor({
            tx,
            mutation: params.turnMutation,
            transcriptAnchorsJson,
        });
        const lastRuntimeIssue = resolveSessionTurnLastRuntimeIssue(params.turnMutation);
        const lastRuntimeIssueJson = lastRuntimeIssue === null ? null : JSON.stringify(lastRuntimeIssue);

        if (params.turnMutation.action === "mark_rollback_eligible" && !hasTrustedRollbackAnchorsJson(transcriptAnchorsJson ?? currentTurn?.transcriptAnchorsJson)) {
            const reason = "terminal-turn";
            const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, mapSessionTurnNoOpReasonToDecision(reason), targetTurnId);
            return createSessionTurnNoOpResult({
                reason,
                state: materializedSessionTurnState(session),
                receipt,
            });
        }

        let teamCredentialWitness: Awaited<ReturnType<typeof resolveSessionTurnTeamCredentialWitnessInTx>> | null = null;
        if (!currentTurn && params.turnMutation.action === "begin") {
            if (params.principal.kind !== "credential") {
                throw new SessionTurnTeamCredentialBindingCurrentnessError("authentication_unavailable");
            }
            teamCredentialWitness = await resolveSessionTurnTeamCredentialWitnessInTx({
                tx,
                sessionId: params.turnMutation.sessionId,
                actorAccountId: params.actorUserId,
                authentication: params.principal.authentication,
            });
        }
        let appliedTurn: SessionTurnApplicationRow;
        if (!currentTurn) {
            try {
                appliedTurn = await tx.sessionTurn.create({
                    data: {
                        sessionId: params.turnMutation.sessionId,
                        turnId: targetTurnId,
                        agentId: params.turnMutation.agentId ?? null,
                        agentTurnId: "agentTurnId" in params.turnMutation ? params.turnMutation.agentTurnId ?? null : null,
                        status: "in_progress",
                        // Only insertion establishes facts; re-begin updates
                        // the existing turn without changing its origin.
                        initiator: params.turnMutation.action === "begin" ? params.turnMutation.initiator ?? "user" : "user",
                        workDepth: params.turnMutation.action === "begin" ? params.turnMutation.workDepth ?? 0 : 0,
                        workflowInvocationJson: params.turnMutation.action === "begin" && params.turnMutation.workflowInvocation
                            ? JSON.stringify(params.turnMutation.workflowInvocation) : null,
                        startedAt: observedAt,
                        updatedAt: observedAt,
                        terminalAt: null,
                        lastRuntimeIssueJson: null,
                        transcriptAnchorsJson: transcriptAnchorsJson ?? null,
                        ...transcriptAnchorProjection,
                        rollbackState: null,
                        rollbackReason: null,
                        agentRollbackOrdinal: null,
                        rollbackUpdatedAt: null,
                        lastMutationId: params.turnMutation.mutationId,
                        ...(teamCredentialWitness ?? {}),
                    },
                }) as SessionTurnApplicationRow;
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) {
                    throw error;
                }
                const state = await loadMaterializedSessionTurnState(tx, params.turnMutation.sessionId);
                if (!state) return { ok: false, error: "session-not-found" };
                const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, "duplicate-mutation", targetTurnId);
                return createSessionTurnNoOpResult({
                    reason: "duplicate-mutation",
                    state,
                    receipt,
                });
            }
        } else {
            const nextStatus = terminalStatus ?? currentTurn.status;
            appliedTurn = await tx.sessionTurn.update({
                where: { id: currentTurn.id },
                data: {
                    agentId: params.turnMutation.agentId ?? currentTurn.agentId,
                    ...("agentTurnId" in params.turnMutation && params.turnMutation.agentTurnId
                        ? { agentTurnId: params.turnMutation.agentTurnId }
                        : {}),
                    status: nextStatus,
                    updatedAt: observedAt,
                    ...(terminalStatus ? { terminalAt: observedAt } : {}),
                    ...(terminalStatus ? { lastRuntimeIssueJson } : {}),
                    ...(transcriptAnchorsJson !== undefined ? { transcriptAnchorsJson } : {}),
                    ...transcriptAnchorProjection,
                    ...(params.turnMutation.action === "mark_rollback_eligible"
                        ? {
                            rollbackState: "eligible",
                            agentRollbackOrdinal: params.turnMutation.agentRollbackOrdinal ?? currentTurn.agentRollbackOrdinal,
                            rollbackUpdatedAt: observedAt,
                        }
                        : {}),
                    ...(params.turnMutation.action === "mark_rolled_back"
                        ? {
                            rollbackState: "rolled_back",
                            agentRollbackOrdinal: params.turnMutation.agentRollbackOrdinal ?? currentTurn.agentRollbackOrdinal,
                            rollbackUpdatedAt: observedAt,
                        }
                        : {}),
                    lastMutationId: params.turnMutation.mutationId,
                },
            }) as SessionTurnApplicationRow;
        }

        // A late first turn establishes the pre-limit start boundary used by recorded spend.
        if (!currentTurn) await refreshTeamCredentialUsageCountersInTx(tx, { sessionIds: [sessionId], changedObservedAts: [] });

        if (params.turnMutation.action === 'begin') {
            await reconcileAutonomousExchangeAcceptedTurnInTx(tx, {
                sessionId: params.turnMutation.sessionId, turnId: targetTurnId,
                ...(params.turnMutation.startingInputId
                    ? { startingInputId: params.turnMutation.startingInputId } : {}),
            });
        }
        await projectSessionInputRepliesFromTurnInTx(tx, appliedTurn);

        const lifecycleEvent = !currentTurn && params.turnMutation.action === "begin"
            ? "parentTurnStarted" as const
            : currentTurn?.status === "in_progress"
            ? appliedTurn.status === "completed"
                ? "parentTurnCompleted" as const
                : appliedTurn.status === "failed"
                    ? "parentTurnFailed" as const
                    : appliedTurn.status === "cancelled"
                        ? "parentTurnCancelled" as const
                        : null
            : null;
        if (lifecycleEvent !== null) {
            const lifecycleAdmissions = await admitSessionLifecycleAutomationRunsTx({
                tx,
                accountId: writeAuthority.accountId,
                sourceSession: { ...session, id: sessionId }, recipientAccountIds: access.recipientAccountIds,
                sourceTurnFacts: parseStoredSessionTurnFacts(appliedTurn),
                occurrence: {
                    v: 1,
                    kind: "sessionLifecycle",
                    event: lifecycleEvent,
                    sourceSessionId: params.turnMutation.sessionId,
                    sourceTurnId: targetTurnId,
                    occurredAt: params.turnMutation.observedAt,
                    ...('automationLifecycleFacts' in params.turnMutation
                        ? { facts: params.turnMutation.automationLifecycleFacts } : {}),
                },
            });
            scheduleSessionLifecycleAdmissionDiagnostics({
                tx,
                admissions: lifecycleAdmissions,
                accountId: writeAuthority.accountId,
                sourceSessionId: params.turnMutation.sessionId,
                sourceTurnId: targetTurnId,
            });
            if (lifecycleEvent === "parentTurnCompleted") {
                // A ready transcript marker is not terminal truth. This owner
                // accepts the exact completed turn, including no-output turns;
                // transport may use only the original validated final anchor.
                const finalAssistantMessageSeq = params.turnMutation.action === "complete"
                    ? params.turnMutation.transcriptAnchors?.finalAssistantMessageSeq
                    : undefined;
                const onceOccurrence = {
                    event: "ready" as const, turnId: targetTurnId,
                    agentStateVersion: session.agentStateVersion, transcriptSeq: session.seq,
                };
                const acceptedOnceAccountIds = await acceptSessionPersonalEventOnceInTx(tx, {
                    sessionId: params.turnMutation.sessionId, event: "ready", onceOccurrence,
                });
                afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
                    sessionId: params.turnMutation.sessionId,
                    event: "ready",
                    committedTurnId: targetTurnId,
                    onceOnly: true,
                    onceOccurrence,
                    acceptedOnceAccountIds,
                    ...(typeof finalAssistantMessageSeq === "number"
                        ? { committedMessage: { domain: "session_transcript", seq: finalAssistantMessageSeq } } : {}),
                    ...(params.runtimeComposition ? { runtimeComposition: params.runtimeComposition } : {}),
                }));
            }
            if (lifecycleEvent === "parentTurnFailed" || lifecycleEvent === "parentTurnCancelled") {
                const event = lifecycleEvent === "parentTurnFailed" ? "failed" : "cancelled";
                const onceOccurrence = { event, turnId: targetTurnId, agentStateVersion: session.agentStateVersion, transcriptSeq: session.seq } as const;
                const acceptedOnceAccountIds = await acceptSessionPersonalEventOnceInTx(tx, {
                    sessionId: params.turnMutation.sessionId, event, onceOccurrence,
                });
                for (const recipientAccountId of access.recipientAccountIds) {
                    scheduleSessionPersonalEvent(tx, recipientAccountId, {
                        type: "session-personal-event", sessionId: params.turnMutation.sessionId,
                        eventId: params.turnMutation.mutationId, event, turnId: targetTurnId,
                    });
                }
                afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
                    sessionId: params.turnMutation.sessionId,
                    event,
                    committedTurnId: targetTurnId,
                    onceOccurrence,
                    acceptedOnceAccountIds,
                    ...(params.runtimeComposition ? { runtimeComposition: params.runtimeComposition } : {}),
                }));
            }
        }

        const nextLatestTurnId = params.turnMutation.action === "begin" ? targetTurnId : session.latestTurnId ?? targetTurnId;
        const shouldMaterialize = nextLatestTurnId === targetTurnId
            && (params.turnMutation.action === "begin" || params.turnMutation.action === "touch_active" || terminalStatus !== null);
        const nextActivityInputs = {
            ...toSessionActivityBadgeInputs(session),
            ...(shouldMaterialize ? { latestTurnStatus: appliedTurn.status } : {}),
            ...(shouldMaterialize ? { lastRuntimeIssue: appliedTurn.lastRuntimeIssueJson ?? null } : {}),
        };
        // Non-current settlements and annotations still change stored Turn facts.
        // The update returns this Session's publication fields for the recipient fanout below and its
        // recipient projection for the after-commit push (no re-read).
        const publication = await tx.session.update({
            where: { id: params.turnMutation.sessionId },
            select: SESSION_TRANSCRIPT_PUBLICATION_RECIPIENT_PROJECTION_SELECT,
            data: shouldMaterialize ? {
                latestTurnId: targetTurnId,
                latestTurnStatus: appliedTurn.status,
                latestTurnStatusObservedAt: observedAt,
                lastRuntimeIssue: appliedTurn.lastRuntimeIssueJson ?? null,
                ...buildLegacyThinkingProjectionWriteData({
                    latestTurnStatus: appliedTurn.status,
                    latestTurnStatusObservedAt: observedAt,
                }),
            } : { updatedAt: new Date() },
        });

        const receipt = await updateSessionTurnMutationReceipt(tx, params.turnMutation, "applied", targetTurnId);

        const updatesRecipientProjection = shouldMaterialize || updatesRollbackFacet;
        const recipientCursors = updatesRecipientProjection && params.markParticipants
            ? await markSessionProjectionRecipientsChanged({
                tx,
                sessionId: params.turnMutation.sessionId,
                recipientAccountIds: access.recipientAccountIds,
                publication,
                hint: { latestTurnStatusObservedAt: params.turnMutation.observedAt },
                usageAccountingChanged: false,
                // Turn rows and the latest-status projection: no transcript seq, metadata or archive change.
                memoryInputsChanged: false,
                // Participant-marking callers (applySessionTurnMutation) publish through publishSessionTurnMutationUpdate.
                sessionAudienceReceivesUpdate: true,
            })
            : [];
        const badgeAttentionChanged = shouldMaterialize
            ? didSessionActivityBadgeSignalChange(toSessionActivityBadgeInputs(session), nextActivityInputs)
            : false;
        const rollbackEligibleTurnStarts = updatesRollbackFacet
            ? await loadSessionRollbackEligibleTurnStartsInTx(tx, params.turnMutation.sessionId)
            : undefined;

        return createSessionTurnAppliedResult({
            mutation: params.turnMutation,
            turn: appliedTurn,
            receipt,
            ...(!shouldMaterialize ? { state: materializedSessionTurnState(session) } : {}),
            recipientCursors,
            badgeAttentionChanged,
            recipientProjection: publication,
            deliveryAccess: await readSessionDeliveryAccessInTx(tx, { sessionId: params.turnMutation.sessionId,
                recipientAccountIds: recipientCursors.map(cursor => cursor.accountId), known: access.deliveryAccess }),
            ...(rollbackEligibleTurnStarts !== undefined ? { rollbackEligibleTurnStarts } : {}),
        });
}

async function applySessionTurnMutationWithOwnerAccess(params: {
    actorUserId: string;
    turnMutation: SessionTurnMutationV1;
    authentication: SessionAccessAuthentication;
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams["runtimeComposition"];
}): Promise<ApplySessionTurnMutationResult> {
    const operation = async () => await inTx(
        async (tx) => await applySessionTurnMutationWithOwnerAccessInTx({
            tx,
            ...params,
            markParticipants: true,
            principal: { kind: "credential", authentication: params.authentication },
        }),
    );
    // Failure, cancellation, and end-of-session settle lifecycle occurrences
    // exactly like completion, so they need the same occurrence-uniqueness
    // restart. Only this caller owns its transaction; the composed in-caller
    // form cannot restart someone else's transaction and is excluded.
    return producesAutomationSessionLifecycleOccurrence(params.turnMutation.action)
        ? await rejoinAutomationOccurrenceInsertRace(operation)
        : await operation();
}

export async function applyLatestSessionTurnEndInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    mutationId: string;
    observedAt: number;
}>): Promise<ApplySessionTurnMutationResult | null> {
    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: { latestTurnId: true },
    });
    if (!session?.latestTurnId) return null;

    const result = await applySessionTurnMutationWithOwnerAccessInTx({
        tx: params.tx,
        actorUserId: params.actorUserId,
        turnMutation: ExactSessionTurnEndMutationV1Schema.parse({
            v: 1,
            sessionId: params.sessionId,
            mutationId: params.mutationId,
            action: "end_session",
            turnId: session.latestTurnId,
            observedAt: params.observedAt,
        }),
        markParticipants: false,
        principal: { kind: "session_owner_runtime" },
    });
    if ("resolveResult" in result) {
        throw new Error("Turn settlement without participant publication returned deferred cursors");
    }
    return result;
}

export async function applySessionTurnMutation(params: {
    actorUserId: string;
    mutation: unknown;
    authentication: SessionAccessAuthentication;
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams["runtimeComposition"];
}): Promise<ApplySessionTurnMutationResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const mutation = SessionTurnMutationV1Schema.safeParse(params.mutation);
    if (!actorUserId || !mutation.success) {
        return { ok: false, error: "invalid-params" };
    }
    const turnMutation = mutation.data;

    try {
        return await applySessionTurnMutationWithOwnerAccess({
            actorUserId,
            turnMutation,
            authentication: params.authentication,
            ...(params.runtimeComposition ? { runtimeComposition: params.runtimeComposition } : {}),
        });
    } catch (error) {
        if (error instanceof InvalidSessionTurnCompletionAnchorError) {
            return { ok: false, error: "invalid-params" };
        }
        if (error instanceof SessionTurnTeamCredentialBindingCurrentnessError) {
            return {
                ok: false,
                error: "invalid-params",
                code: "session_team_credential_binding_rejected",
                reason: error.reason,
            };
        }
        if (isDuplicateSessionTurnMutationRace(error)) {
            try {
                return await applySessionTurnMutationWithOwnerAccess({
                    actorUserId,
                    turnMutation,
                    authentication: params.authentication,
                    ...(params.runtimeComposition ? { runtimeComposition: params.runtimeComposition } : {}),
                });
            } catch (retryError) {
                if (retryError instanceof SessionTurnTeamCredentialBindingCurrentnessError) {
                    return {
                        ok: false,
                        error: "invalid-params",
                        code: "session_team_credential_binding_rejected",
                        reason: retryError.reason,
                    };
                }
                return { ok: false, error: "internal" };
            }
        }
        return { ok: false, error: "internal" };
    }
}

export type ApplySessionReadCursorOperationResult = ApplyViewerReadCursorOperationResult;

/** Released route/socket entry point; viewer storage and admission have one owner. */
export async function applySessionReadCursorOperation(params: {
    actorUserId: string;
    sessionId: string;
    operation: SessionReadCursorOperation;
    authentication: SessionAccessAuthentication;
}): Promise<ApplySessionReadCursorOperationResult> {
    return applyViewerReadCursorOperation({
        accountId: params.actorUserId,
        sessionId: params.sessionId,
        operation: params.operation,
        authentication: params.authentication,
    });
}

export type UpdateSessionReadCursorResult = ApplySessionReadCursorOperationResult;

export async function updateSessionReadCursor(params: {
    actorUserId: string;
    sessionId: string;
    lastViewedSessionSeq: number;
    authentication: SessionAccessAuthentication;
}): Promise<UpdateSessionReadCursorResult> {
    return applySessionReadCursorOperation({
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
        operation: { kind: "advance", lastViewedSessionSeq: params.lastViewedSessionSeq },
        authentication: params.authentication,
    });
}

export type PatchSessionResult =
    | {
        ok: true;
        recipientCursors: RecipientCursor[];
        metadata?: { version: number; value: string | null };
        agentState?: { version: number; value: string | null };
      }
    | {
        ok: false;
        error: "invalid-params" | "forbidden" | "session-not-found" | "session_active" | "session_archived" | "version-mismatch" | "metadata_privacy_upgrade_required" | "internal";
        current?: {
            metadata?: { version: number; value: string | null };
            agentState?: { version: number; value: string | null };
        };
      };

/**
 * Opt-in row precondition for a metadata write whose operation is meaningless on
 * an archived Session.
 *
 * Archive is user intent, and ordinary metadata writers — `setSessionModel`, the
 * Action executor, the patch route — are deliberately still allowed on an
 * archived row. So this is a per-call CAS precondition rather than a property of
 * the `inactive_model_intent` expectation those writers share. It exists because
 * a caller that pre-reads `archivedAt` cannot close the window between that read
 * and its write: the archive route updates the same inactive row with no version
 * of its own, so without the predicate both operations commit and unarchiving
 * later reveals a change the user never saw happen.
 *
 * It is deliberately NOT part of the wire input: the patch route spreads a
 * client body into the tuple owner, and no client may select this precondition.
 */
export type SessionMetadataWritePreconditionsV1 = Readonly<{
    requireUnarchivedSession?: boolean;
}>;

function isExactInactiveModelIntentExpectation(
    value: unknown,
): value is SessionMetadataInactiveModelIntentExpectationV1 {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && (value as { kind?: unknown }).kind === "inactive_model_intent";
}

export async function patchSession(params: {
    actorUserId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
    usageTimingV1?: UsageSessionTimingV1;
    metadata?: { ciphertext: string; expectedVersion: number };
    agentState?: { ciphertext: string | null; expectedVersion: number };
    sessionExpectation?: SessionMetadataInactiveModelIntentExpectationV1;
    publishCurrentView?: true;
}): Promise<PatchSessionResult> {
    try {
        return await inTx(async (tx): Promise<SessionWriteInTxResult<PatchSessionResult>> => {
            const operationAccess = await resolveSessionAccessForOperation(tx, {
                accountId: params.actorUserId,
                sessionId: params.sessionId,
                authentication: params.authentication,
            });
            if (operationAccess.status !== "allowed" || operationAccess.access.level !== "owner") {
                return { ok: false, error: "forbidden" };
            }
            return await patchSessionAfterAdmissionInTx(tx, params, undefined, operationAccess.access);
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

/**
 * Transaction-local layout-zero metadata/AgentState CAS core. `patchSession`
 * wraps it in its own transaction; the Agent-transition current-view commit
 * reuses it so the metadata write and the runtime-projection clears land in ONE
 * transaction. There is no second layout-zero CAS, inactive predicate, or
 * currentness check.
 */
export async function patchSessionInTx(tx: Tx, params: {
    actorUserId: string;
    sessionId: string;
    usageTimingV1?: UsageSessionTimingV1;
    metadata?: { ciphertext: string; expectedVersion: number };
    agentState?: { ciphertext: string | null; expectedVersion: number };
    sessionExpectation?: SessionMetadataInactiveModelIntentExpectationV1;
    publishCurrentView?: true;
}, preconditions?: SessionMetadataWritePreconditionsV1): Promise<SessionWriteInTxResult<PatchSessionResult>> {
    return patchSessionAfterAdmissionInTx(tx, params, preconditions);
}

async function patchSessionAfterAdmissionInTx(
    tx: Tx,
    params: Parameters<typeof patchSessionInTx>[1],
    preconditions?: SessionMetadataWritePreconditionsV1,
    admittedAccess?: EffectiveSessionAccess,
): Promise<SessionWriteInTxResult<PatchSessionResult>> {
    if (params.usageTimingV1 !== undefined && !UsageSessionTimingV1Schema.safeParse(params.usageTimingV1).success) return { ok: false, error: 'invalid-params' };
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const metadata = params.metadata;
    const agentState = params.agentState;
    const sessionExpectation = params.sessionExpectation;

    if (!sessionId || !actorUserId) {
        return { ok: false, error: "invalid-params" };
    }
    if (!metadata && !agentState) {
        return { ok: false, error: "invalid-params" };
    }
    if (metadata && (typeof metadata.ciphertext !== "string" || typeof metadata.expectedVersion !== "number")) {
        return { ok: false, error: "invalid-params" };
    }
    if (agentState && (typeof agentState.expectedVersion !== "number" || (typeof agentState.ciphertext !== "string" && agentState.ciphertext !== null))) {
        return { ok: false, error: "invalid-params" };
    }
    if (
        sessionExpectation !== undefined
        && (
            !metadata
            || !isExactInactiveModelIntentExpectation(sessionExpectation)
        )
    ) {
        return { ok: false, error: "invalid-params" };
    }

    const access = await loadSessionMutationContextInTx(tx, {
        actorUserId,
        sessionId,
        kind: "owner",
        admittedAccess,
    });
    if (!access.ok) {
        return { ok: false, error: access.error };
    }

    const written = await writeLegacySessionTupleInTx(tx, {
        sessionId, metadata, agentState, usageTimingV1: params.usageTimingV1,
        requireInactiveSession: sessionExpectation !== undefined,
        requireUnarchivedSession: preconditions?.requireUnarchivedSession,
    });
    if (!written.ok) return { ...written, ...(written.current ? { current: {
        ...(metadata ? { metadata: written.current.metadata } : {}),
        ...(agentState ? { agentState: written.current.agentState } : {}),
    } } : {}) };
    const recipientCursors = written.didWrite ? await markSessionProjectionRecipientsChanged({
        tx, sessionId, recipientAccountIds: access.recipientAccountIds,
        ...(params.publishCurrentView ? { currentViewPublication: { kind: 'legacy_v0', sessionOwnerId: access.sessionOwnerId } } as const : {}),
        followSourceChanged: written.agentStateChanged,
        usageAccountingChanged: false,
        ...(written.metadataChanged ? {} : { memoryInputsChanged: false as const }),
        hint: {
            ...(written.metadataChanged ? { metadataVersion: written.metadata.version } : {}),
            ...(written.agentStateChanged ? { agentStateVersion: written.agentState.version } : {}),
        },
    }) : [];
    return sessionRecipientPublicationResult({
        ok: true, recipientCursors,
        ...(metadata ? { metadata: written.metadata } : {}),
        ...(agentState ? { agentState: written.agentState } : {}),
    });
}

export type UpdateSessionMetadataEnvelopeTupleInput =
    | (SessionMetadataOwnerMigrationPatchV1 & Readonly<{
        actorUserId: string;
        sessionId: string;
      }>)
    | (SessionMetadataOwnerPatchV1 & Readonly<{
        actorUserId: string;
        sessionId: string;
      }>)
    | (SessionMetadataInactiveModelIntentOwnerPatchV1 & Readonly<{
        actorUserId: string;
        sessionId: string;
      }>)
    | (SessionTeamCredentialBindingMetadataPatchV1 & Readonly<{
        actorUserId: string;
        sessionId: string;
        authentication: SessionAccessAuthentication;
        usageTimingV1?: UsageSessionTimingV1;
      }>)
    | Readonly<{
        mode: "shared_editor";
        actorUserId: string;
        sessionId: string;
        authentication: SessionAccessAuthentication;
        metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
        usageTimingV1?: UsageSessionTimingV1;
        mutationIntent?: "rename_session";
        sharedActionConfirmationSummaryV1?: SessionMetadataOwnerPatchV1['sharedActionConfirmationSummaryV1'];
        sharedMetadata: Readonly<{ ciphertext: string; expectedVersion: number }>;
        displayProjectionV1?: Omit<SessionDisplayProjectionV1, 'owner'> | null;
      }>;

export type UpdateSessionMetadataEnvelopeTupleResult =
    | Readonly<{
        ok: true;
        recipientCursors: RecipientCursor[];
        sessionOwnerId: string;
        ownerAccountMode: "plain" | "e2ee";
        metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
        sharedMetadata: Readonly<{ version: number; value: string }>;
        agentStateVersion: number;
        ownerMetadata: Readonly<{ value: string }>;
        agentState: Readonly<{ version: number; value: string | null }>;
        /** Present only when this owner patch admitted a Project classification; null is "no Project". */
        projectKey?: string | null;
        runtimeProjection?: SessionCurrentViewPublicationSourceV1['runtimeProjection'];
        /** Which private parts this commit changed; absent on an exact retry, which publishes nothing. */
        changed?: SessionCurrentViewPublicationSourceV1['changed'];
      }>
    | Readonly<{
        ok: false;
        error:
            | "invalid-params"
            | "forbidden"
            | "session_access_authentication_required"
            | "session_access_authentication_unavailable"
            | "session-not-found"
            | "session_active"
            | "session_archived"
            | "version-mismatch"
            | "metadata_privacy_upgrade_required"
            | "publisher-superseded"
            | "session_team_credential_binding_rejected"
            | "internal";
        reason?: SessionTeamCredentialBindingRejectionV1;
        current?: Readonly<{
            metadataLayoutVersion: number;
            sharedMetadata: Readonly<{ version: number; value: string }>;
            ownerMetadata?: Readonly<{ value: string }>;
            agentState?: Readonly<{ version: number; value: string | null }>;
        }>;
      }>;

class SessionTeamCredentialBindingMutationError extends Error {
    constructor(readonly reason: SessionTeamCredentialBindingRejectionV1) {
        super(reason);
        this.name = "SessionTeamCredentialBindingMutationError";
    }
}

type ActiveSessionMetadataEnvelopeTupleInput = Exclude<
    UpdateSessionMetadataEnvelopeTupleInput,
    Readonly<{ mode: "owner_migration" }>
>;

type StoredSessionMetadataEnvelopeTuple = Readonly<{
    active: boolean;
    displayProjectionV1: string | null;
    metadataLayoutVersion: number;
    metadataVersion: number;
    metadata: string;
    ownerMetadata: string | null;
    usageTimingV1?: unknown;
    agentStateVersion: number;
    agentState: string | null;
}>;

export function doesStoredSessionDisplayMatchTupleWrite(
    current: string | null,
    requested: SessionDisplayProjectionV1 | null | undefined,
    sharedEditor: boolean,
): boolean {
    if (requested == null) return current === null;
    if (current === null) return false;
    const parsed = SessionDisplayProjectionV1Schema.safeParse(parseJsonValue(current));
    if (!parsed.success) return false;
    const { owner: _owner, ...shared } = parsed.data;
    return isDeepStrictEqual(sharedEditor ? shared : parsed.data, JSON.parse(JSON.stringify(requested)));
}

function isExactMetadataEnvelopeTupleRetry(
    current: StoredSessionMetadataEnvelopeTuple & Readonly<{ projectKey: string | null; projectKeyNone: boolean }>,
    params: ActiveSessionMetadataEnvelopeTupleInput,
): boolean {
    if (
        current.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
        || current.metadataVersion !== params.sharedMetadata.expectedVersion + 1
        || current.metadata !== params.sharedMetadata.ciphertext
        || !doesStoredSessionDisplayMatchTupleWrite(current.displayProjectionV1, params.displayProjectionV1, params.mode === 'shared_editor')
        || (params.mode === "owner" && params.projectKey !== undefined
            && (current.projectKey !== params.projectKey || current.projectKeyNone !== (params.projectKey === null)))
    ) {
        return false;
    }
    if (params.mode === "shared_editor") return true;
    return current.ownerMetadata ===
            JSON.stringify(params.ownerMetadata)
        && (current.agentStateVersion === params.agentState.expectedVersion
            || current.agentStateVersion === params.agentState.expectedVersion + 1)
        && current.agentState === params.agentState.ciphertext;
}

function isExactOwnerMigrationRetry(
    current: StoredSessionMetadataEnvelopeTuple,
    params: SessionMetadataOwnerMigrationPatchV1,
    target: Readonly<{
        sharedMetadata: string;
        ownerMetadata: string;
        agentState: string | null;
        displayProjectionV1: string | null;
    }>,
): boolean {
    return (
        current.metadataLayoutVersion
            === SESSION_METADATA_LAYOUT_VERSION_V1
        && current.metadataVersion
            === params.source.metadata.version + 1
        && current.metadata === target.sharedMetadata
        && current.ownerMetadata === target.ownerMetadata
        && current.agentStateVersion
            === params.source.agentState.version + 1
        && current.agentState === target.agentState
        && current.displayProjectionV1 === target.displayProjectionV1
    );
}

function toOwnerMigrationSuccess(
    current: StoredSessionMetadataEnvelopeTuple,
    recipientCursors: SessionRecipientPublication[],
    sessionOwnerId: string,
    ownerAccountMode: "plain" | "e2ee",
    runtimeProjection?: SessionCurrentViewPublicationSourceV1['runtimeProjection'],
): SessionRecipientPublicationResult<Extract<UpdateSessionMetadataEnvelopeTupleResult, { ok: true }>> {
    return sessionRecipientPublicationResult({
        ok: true,
        recipientCursors,
        sessionOwnerId,
        ownerAccountMode,
        ...(runtimeProjection ? { runtimeProjection } : {}),
        metadataLayoutVersion:
            SESSION_METADATA_LAYOUT_VERSION_V1,
        sharedMetadata: {
            version: current.metadataVersion,
            value: current.metadata,
        },
        agentStateVersion: current.agentStateVersion,
        ownerMetadata: { value: current.ownerMetadata! },
        agentState: {
            version: current.agentStateVersion,
            value: current.agentState,
        },
    });
}

function toOwnerMigrationConflict(
    current: StoredSessionMetadataEnvelopeTuple,
): UpdateSessionMetadataEnvelopeTupleResult {
    return {
        ok: false,
        error:
            current.metadataLayoutVersion
                === SESSION_METADATA_LAYOUT_VERSION_V1
                ? "version-mismatch"
                : "metadata_privacy_upgrade_required",
        current: {
            metadataLayoutVersion:
                current.metadataLayoutVersion,
            sharedMetadata: {
                version: current.metadataVersion,
                value: current.metadata,
            },
            ...(typeof current.ownerMetadata === "string"
                ? {
                    ownerMetadata: {
                        value: current.ownerMetadata,
                    },
                }
                : {}),
            agentState: {
                version: current.agentStateVersion,
                value: current.agentState,
            },
        },
    };
}

function toMetadataEnvelopeTupleSuccess(
    current: StoredSessionMetadataEnvelopeTuple,
    params: ActiveSessionMetadataEnvelopeTupleInput,
    recipientCursors: SessionRecipientPublication[],
    sessionOwnerId: string,
    ownerAccountMode: "plain" | "e2ee",
    runtimeProjection?: SessionCurrentViewPublicationSourceV1['runtimeProjection'],
    changed?: SessionCurrentViewPublicationSourceV1['changed'],
): SessionRecipientPublicationResult<Extract<UpdateSessionMetadataEnvelopeTupleResult, { ok: true }>> {
    return sessionRecipientPublicationResult({
        ok: true,
        recipientCursors,
        sessionOwnerId,
        ownerAccountMode,
        ...(runtimeProjection ? { runtimeProjection } : {}),
        ...(changed ? { changed } : {}),
        ...(params.mode === "owner" && params.projectKey !== undefined
            ? { projectKey: params.projectKey }
            : {}),
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        sharedMetadata: {
            version: current.metadataVersion,
            value: current.metadata,
        },
        agentStateVersion: current.agentStateVersion,
        ownerMetadata: { value: current.ownerMetadata! },
        agentState: {
            version: current.agentStateVersion,
            value: current.agentState,
        },
    });
}

function toMetadataEnvelopeTupleVersionMismatch(
    current: StoredSessionMetadataEnvelopeTuple,
    params: ActiveSessionMetadataEnvelopeTupleInput,
): UpdateSessionMetadataEnvelopeTupleResult {
    return {
        ok: false,
        error: "version-mismatch",
        current: {
            metadataLayoutVersion: current.metadataLayoutVersion,
            sharedMetadata: {
                version: current.metadataVersion,
                value: current.metadata,
            },
            ...(params.mode !== "shared_editor"
                ? {
                    ...(typeof current.ownerMetadata === "string"
                        ? { ownerMetadata: { value: current.ownerMetadata } }
                        : {}),
                    agentState: {
                        version: current.agentStateVersion,
                        value: current.agentState,
                    },
                }
                : {}),
        },
    };
}

function parseSessionMetadataEnvelopeTupleInput(
    params: UpdateSessionMetadataEnvelopeTupleInput & Readonly<{ authentication?: SessionAccessAuthentication }>,
): UpdateSessionMetadataEnvelopeTupleInput | null {
    // Actor identity and authentication are server context. Keep every other
    // field so the canonical strict mutation schema can reject unknown input.
    const { actorUserId, sessionId, authentication: _authentication, ...patch } = params;
    if (typeof actorUserId !== "string" || actorUserId.length === 0
        || typeof sessionId !== "string" || sessionId.length === 0) return null;
    const parsed = patch.mode === "owner_team_credential_binding"
        ? SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse(patch)
        : patch.mode === "owner_inactive_model_intent"
            ? SessionMetadataInactiveModelIntentOwnerPatchV1Schema.safeParse(patch)
            : SessionMetadataTuplePatchV1Schema.safeParse(patch);
    if (!parsed.success) return null;
    if (parsed.data.mode === "shared_editor" || parsed.data.mode === "owner_team_credential_binding") {
        return params.mode === "shared_editor" || params.mode === "owner_team_credential_binding"
            ? { actorUserId, sessionId, ...parsed.data, authentication: params.authentication }
            : null;
    }
    return { actorUserId, sessionId, ...parsed.data,
        // Source witnesses retain their exact caller value; target serialization
        // consumes the canonical parsed projection instead of reparsing it later.
        ...('expectedOwnerMetadata' in params ? { expectedOwnerMetadata: params.expectedOwnerMetadata } : {}),
        ...(_authentication ? { authentication: _authentication } : {}) };
}

function parseJsonValue(value: string): unknown | typeof JSON_PARSE_FAILED {
    try {
        return JSON.parse(value);
    } catch {
        return JSON_PARSE_FAILED;
    }
}

function isValidLayoutOneSessionPayload(params: Readonly<{
    encryptionMode: string | null;
    sharedMetadata: string;
    agentState: string | null;
}>): boolean {
    if (params.encryptionMode !== "plain") return true;
    const sharedMetadata = parseJsonValue(params.sharedMetadata);
    if (
        sharedMetadata === JSON_PARSE_FAILED
        || !SessionSharedMetadataV1Schema.safeParse(sharedMetadata).success
    ) {
        return false;
    }
    if (params.agentState === null) return true;
    const agentState = parseJsonValue(params.agentState);
    return agentState !== JSON_PARSE_FAILED
        && typeof agentState === "object"
        && agentState !== null
        && !Array.isArray(agentState);
}

function validatePlainOwnerMigrationProjection(
    params: SessionMetadataOwnerMigrationPatchV1,
): Readonly<{
    ownerMetadata: string;
    sharedMetadata: string;
    agentState: string | null;
}> | null {
    if (
        params.expectedAccountEncryptionMode !== "plain"
        || !validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1({
            accountMode: "plain",
            envelope: params.target.ownerMetadata,
        }).ok
    ) {
        return null;
    }
    const legacyMetadata = parseJsonValue(
        params.source.metadata.ciphertext,
    );
    const legacyAgentState =
        params.source.agentState.ciphertext === null
            ? null
            : parseJsonValue(params.source.agentState.ciphertext);
    if (
        legacyMetadata === JSON_PARSE_FAILED
        || legacyAgentState === JSON_PARSE_FAILED
    ) {
        return null;
    }
    const ownerProjection = createSessionOwnerMetadataV1({
        metadata: legacyMetadata,
    }, 'stored');
    if (!ownerProjection.ok) return null;
    const canonicalOwnerEnvelope =
        createPlainSessionOwnerMetadataEnvelopeV1(
            ownerProjection.ownerMetadata,
        );
    const canonicalSharedMetadata = projectSessionSharedMetadataV1({
        metadata: legacyMetadata,
        agentState: legacyAgentState ?? undefined,
    });
    const targetSharedMetadata = parseJsonValue(
        params.target.sharedMetadata.ciphertext,
    );
    const targetAgentState =
        params.target.agentState.ciphertext === null
            ? null
            : parseJsonValue(params.target.agentState.ciphertext);
    if (
        targetSharedMetadata === JSON_PARSE_FAILED
        || targetAgentState === JSON_PARSE_FAILED
        || !isDeepStrictEqual(
            canonicalOwnerEnvelope,
            params.target.ownerMetadata,
        )
        || !isDeepStrictEqual(
            canonicalSharedMetadata,
            targetSharedMetadata,
        )
        || !isDeepStrictEqual(legacyAgentState, targetAgentState)
    ) {
        return null;
    }
    return {
        ownerMetadata:
            JSON.stringify(canonicalOwnerEnvelope),
        sharedMetadata: JSON.stringify(canonicalSharedMetadata),
        agentState:
            targetAgentState === null
                ? null
                : JSON.stringify(targetAgentState),
    };
}

/**
 * Canonical Session-row/CAS owner for the CPX-R26 safe/private envelope tuple.
 * The owner-migration wire remains strict, and layout-one owner and
 * shared-editor writes use this same Account-current tuple/CAS path. Legacy
 * layout-zero writers are fenced once layout one exists. Shared editors cannot
 * observe or mutate owner metadata or full Agent state.
 */
export async function updateSessionMetadataEnvelopeTupleInTx(
    tx: Tx,
    params: UpdateSessionMetadataEnvelopeTupleInput,
    preconditions?: SessionMetadataWritePreconditionsV1,
    publication?: Readonly<{ publishCurrentView: true }>,
): Promise<SessionWriteInTxResult<UpdateSessionMetadataEnvelopeTupleResult>> {
    const admitted = parseSessionMetadataEnvelopeTupleInput(params);
    if (admitted === null) {
        return { ok: false, error: "invalid-params" };
    }
    params = admitted;

    // Transaction-composing callers admit their complete audience and lock
    // Session resources before entering the shared metadata mutation body.
    const consent = params.mode === "owner_team_credential_binding" ? params.teamVisibilityGrantConsent : undefined;
    if (consent) {
        await acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId], [],
            { ...sessionAccessGrantMutationCursorLockOptions({ actorAccountId: params.actorUserId, sessionId: params.sessionId,
                subjects: [{ kind: "team", teamId: consent.teamId }],
            }), includeLifecyclePublications: true });
    } else {
        await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId], [params.actorUserId],
            { includeLifecyclePublications: params.mode === 'owner_team_credential_binding' });
    }
    return updateSessionMetadataEnvelopeTupleAfterCursorFenceInTx(tx, params, preconditions, publication);
}

async function updateSessionMetadataEnvelopeTupleAfterCursorFenceInTx(
    tx: Tx,
    params: UpdateSessionMetadataEnvelopeTupleInput,
    preconditions?: SessionMetadataWritePreconditionsV1,
    publication?: Readonly<{ publishCurrentView: true }>,
): Promise<SessionWriteInTxResult<UpdateSessionMetadataEnvelopeTupleResult>> {
    // Publish the same normalized facts this tuple commits. Native requests use
    // this HTTP writer rather than the legacy update-state socket writer.
    const pendingSummary = normalizePendingRequestActivitySummary(
        params.mode === 'owner' || params.mode === 'owner_migration' ? params.activitySummaryV1 ?? {} : {},
    );
    const runtimeProjection = {
        ...pendingSummary,
        pendingRequestObservedAt: pendingSummary.pendingRequestObservedAt === undefined
            ? undefined : pendingSummary.pendingRequestObservedAt?.getTime() ?? null,
    };
    // Same metadata CAS, independent contribution: owner Agent-state refreshes
    // and shared-confirmation settlement cannot replace each other's counts.
    const sharedConfirmationSummary = "sharedActionConfirmationSummaryV1" in params && params.sharedActionConfirmationSummaryV1
        ? { pendingSharedActionConfirmationCount: params.sharedActionConfirmationSummaryV1.pendingPermissionRequestCount }
        : {};

    if (params.mode !== "shared_editor") {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.actorUserId, "content");
    }

    const access = params.mode !== "shared_editor"
        ? await loadSessionOwnerMutationContextInTx(tx, params)
        : params.mutationIntent === "rename_session"
            ? await loadSessionMutationContextPreservingAccessFailureInTx(tx, { ...params, kind: "capability", capability: "renameSession", preserveAccessFailure: true })
            : await loadSessionMutationContextPreservingAccessFailureInTx(tx, { ...params, kind: "capability", capability: "submitAgentInput", preserveAccessFailure: true });
    if (!access.ok) {
        return { ok: false, error: mapSharedEditorAccessFailure(access.error) };
    }

    const account = await tx.account.findUnique({
        where: { id: access.sessionOwnerId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) {
        return { ok: false, error: "forbidden" };
    }
    const accountCurrentness =
        deriveAccountEncryptionCurrentnessFromRow(account);
    if (accountCurrentness.status !== "ready") {
        return { ok: false, error: "invalid-params" };
    }

    const requestedDisplay = params.mode === 'owner_migration'
        ? params.target.displayProjectionV1 : params.displayProjectionV1;
    const displayVersion = params.mode === 'owner_migration'
        ? params.source.metadata.version + 1 : params.sharedMetadata.expectedVersion + 1;
    const displayAdmission = requestedDisplay == null ? null : validateSessionDisplayProjectionV1({
        projection: requestedDisplay,
        sessionMode: access.sessionEncryptionMode === 'plain' ? 'plain' : 'e2ee',
        accountMode: accountCurrentness.currentness.encryptionMode,
        metadataVersion: displayVersion,
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
    });
    if ((displayAdmission !== null && !displayAdmission.ok)
        || (params.mode === 'shared_editor' && requestedDisplay != null && Object.hasOwn(requestedDisplay, 'owner'))) {
        return { ok: false, error: 'invalid-params' };
    }
    const admittedDisplay = displayAdmission?.ok ? displayAdmission.projection : null;

    if (params.mode === "owner_migration") {
        if (
            accountCurrentness.currentness.encryptionMode
                !== params.expectedAccountEncryptionMode
            || !validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1({
                accountMode:
                    accountCurrentness.currentness.encryptionMode,
                envelope: params.target.ownerMetadata,
            }).ok
            || (
                params.expectedAccountEncryptionMode === "e2ee"
                && (
                    accountCurrentness.currentness
                        .contentPublicKeyFingerprint
                    !==
                        params.expectedAccountContentPublicKeyFingerprint
                )
            )
        ) {
            return {
                ok: false,
                error: "metadata_privacy_upgrade_required",
            };
        }
        const plainProjection =
            params.expectedAccountEncryptionMode === "plain"
                ? validatePlainOwnerMigrationProjection(params)
                : null;
        if (
            params.expectedAccountEncryptionMode === "plain"
                ? plainProjection === null
                : !isValidLayoutOneSessionPayload({
                    encryptionMode: access.sessionEncryptionMode,
                    sharedMetadata:
                        params.target.sharedMetadata.ciphertext,
                    agentState: params.target.agentState.ciphertext,
                })
        ) {
            return { ok: false, error: "invalid-params" };
        }
        const nextSharedMetadata =
            plainProjection?.sharedMetadata
            ?? params.target.sharedMetadata.ciphertext;
        const nextOwnerMetadata =
            plainProjection?.ownerMetadata
            ?? JSON.stringify(
                params.target.ownerMetadata,
            );
        const nextAgentState =
            plainProjection?.agentState
            ?? params.target.agentState.ciphertext;
        const nextMetadataVersion =
            params.source.metadata.version + 1;
        const nextAgentStateVersion =
            params.source.agentState.version + 1;
        const target = {
            sharedMetadata: nextSharedMetadata,
            ownerMetadata: nextOwnerMetadata,
            agentState: nextAgentState,
            displayProjectionV1: admittedDisplay ? JSON.stringify(admittedDisplay) : null,
        };
        const current = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: withSessionContentSelect({
                active: true,
                latestTurnId: true,
                latestTurnStatus: true,
                seq: true,
                displayProjectionV1: true,
                metadataLayoutVersion: true,
                metadataVersion: true,
                usageTimingV1: true,
                metadata: true,
                ownerMetadata: true,
                agentStateVersion: true,
                agentState: true,
            }),
        }).then(decodeSessionStoredContent);
        if (!current) return { ok: false, error: "session-not-found" };
        if (isExactOwnerMigrationRetry(current, params, target)) {
            return toOwnerMigrationSuccess(
                current,
                [],
                access.sessionOwnerId,
                accountCurrentness.currentness.encryptionMode,
            );
        }
        if (
            current.metadataLayoutVersion !== 0
            || current.ownerMetadata !== null
            || current.metadataVersion
                !== params.source.metadata.version
            || current.metadata
                !== params.source.metadata.ciphertext
            || current.agentStateVersion
                !== params.source.agentState.version
            || current.agentState
                !== params.source.agentState.ciphertext
        ) {
            return toOwnerMigrationConflict(current);
        }
        const updated = await tx.session.updateMany({
            where: {
                id: params.sessionId,
                metadataLayoutVersion: 0,
                metadataVersion: params.source.metadata.version,
                ownerMetadata: null,
                agentStateVersion:
                    params.source.agentState.version,
                AND: [sessionStoredContentWhere({ metadata: params.source.metadata.ciphertext, agentState: params.source.agentState.ciphertext })],
            },
            data: encodeSessionStoredContent({
                metadataLayoutVersion:
                    SESSION_METADATA_LAYOUT_VERSION_V1,
                usageTimingV1: params.usageTimingV1 ?? { v: 1, metadata: null, agentState: null },
                metadata: nextSharedMetadata,
                metadataVersion: nextMetadataVersion,
                ownerMetadata: nextOwnerMetadata,
                displayProjectionV1: target.displayProjectionV1,
                agentState: nextAgentState,
                agentStateVersion: nextAgentStateVersion,
                ...pendingSummary,
                ...sharedConfirmationSummary,
            }),
        });
        if (updated.count !== 1) {
            const fresh = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: withSessionContentSelect({
                    active: true,
                    displayProjectionV1: true,
                    metadataLayoutVersion: true,
                    metadataVersion: true,
                    usageTimingV1: true,
                    metadata: true,
                    ownerMetadata: true,
                    agentStateVersion: true,
                    agentState: true,
                }),
            }).then(decodeSessionStoredContent);
            if (!fresh) {
                return {
                    ok: false,
                    error: "session-not-found",
                };
            }
            if (isExactOwnerMigrationRetry(
                fresh,
                params,
                target,
            )) {
                return toOwnerMigrationSuccess(
                    fresh,
                    [],
                    access.sessionOwnerId,
                    accountCurrentness.currentness.encryptionMode,
                );
            }
            return toOwnerMigrationConflict(fresh);
        }
        await publishCommittedSessionRequestOccurrencesInTx(tx, {
            sessionId: params.sessionId, ownerAccountId: access.sessionOwnerId, source: current,
            sourceSession: { ...access.sessionState, id: params.sessionId }, recipientAccountIds: access.recipientAccountIds,
            agentStateVersion: nextAgentStateVersion,
            occurrences: params.activitySummaryV1?.newUserActionRequiredOccurrences ?? [],
        });
        const recipientCursors =
            await markSessionProjectionRecipientsChanged({
                tx,
                sessionId: params.sessionId,
                recipientAccountIds: access.recipientAccountIds,
                usageAccountingChanged: false,
            });
        return toOwnerMigrationSuccess(
            {
                active: current.active,
                displayProjectionV1: target.displayProjectionV1,
                metadataLayoutVersion:
                    SESSION_METADATA_LAYOUT_VERSION_V1,
                metadataVersion: nextMetadataVersion,
                metadata: nextSharedMetadata,
                ownerMetadata: nextOwnerMetadata,
                agentStateVersion: nextAgentStateVersion,
                agentState: nextAgentState,
            },
            recipientCursors,
            access.sessionOwnerId,
            accountCurrentness.currentness.encryptionMode,
            runtimeProjection,
        );
    }

    if (
        params.mode !== "shared_editor"
        && (
                !validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1({
                    accountMode:
                        accountCurrentness.currentness.encryptionMode,
                    envelope: params.expectedOwnerMetadata,
                }).ok
                || !validateAdmittedSessionOwnerMetadataEnvelopeForAccountModeV1({
                    accountMode:
                        accountCurrentness.currentness.encryptionMode,
                    envelope: params.ownerMetadata,
                }).ok
        )
    ) {
        return { ok: false, error: "invalid-params" };
    }
    if (
        !isValidLayoutOneSessionPayload({
            encryptionMode: access.sessionEncryptionMode,
            sharedMetadata: params.sharedMetadata.ciphertext,
            agentState:
                params.mode === "shared_editor"
                    ? null
                    : params.agentState.ciphertext,
        })
    ) {
        return { ok: false, error: "invalid-params" };
    }

    if (
        (params.mode === "owner" || params.mode === "owner_team_credential_binding")
        && params.publisherPrecondition
        && !await fenceExactCurrentPublisherAuthorityInTx(
            tx,
            {
                accountId: params.actorUserId,
                machineId: params.publisherPrecondition.machineId,
                sessionId: params.sessionId,
                publisherGeneration: BigInt(params.publisherPrecondition.publisherGeneration),
            },
            params.actorUserId,
            params.sessionId,
            { admittedWork: true },
        )
    ) {
        return { ok: false, error: "publisher-superseded" };
    }

    const current = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: withSessionContentSelect({
            active: true,
            latestTurnId: true,
            latestTurnStatus: true,
            seq: true,
            projectKey: true,
            projectKeyNone: true,
            encryptionMode: true,
            displayProjectionV1: true,
            metadataLayoutVersion: true,
            metadataVersion: true,
            usageTimingV1: true,
            metadata: true,
            ownerMetadata: true,
            agentStateVersion: true,
            agentState: true,
        }),
    }).then(decodeSessionStoredContent);
    if (!current) return { ok: false, error: "session-not-found" };

    const requiresInactiveSession =
        params.mode === "owner_inactive_model_intent"
        || (
            params.mode === "owner_team_credential_binding"
            && params.sessionExpectation !== undefined
        );
    const requireUnarchivedSession = preconditions?.requireUnarchivedSession === true;
    if (
        current.metadataLayoutVersion
        !== SESSION_METADATA_LAYOUT_VERSION_V1
    ) {
        return {
            ok: false,
            error: "metadata_privacy_upgrade_required",
        };
    }
    const currentOwnerMetadata =
        parsePersistedSessionOwnerMetadataEnvelopeV1({
            metadataLayoutVersion: current.metadataLayoutVersion,
            accountMode:
                accountCurrentness.currentness.encryptionMode,
            ownerMetadata: current.ownerMetadata,

        });
    if (currentOwnerMetadata === null) {
        return {
            ok: false,
            error: "metadata_privacy_upgrade_required",
        };
    }
    if (
        isExactMetadataEnvelopeTupleRetry(current, params)
        && (
            params.mode !== "owner_team_credential_binding"
            || (await Promise.all(params.teamCredentialBindings.map((intent) =>
                isSessionTeamCredentialBindingIntentCurrentInTx(tx, {
                    sessionId: params.sessionId,
                    intent,
                })))).every(Boolean)
        )
    ) {
        return toMetadataEnvelopeTupleSuccess(
            current,
            params,
            [],
            access.sessionOwnerId,
            accountCurrentness.currentness.encryptionMode,
        );
    }
    if (requiresInactiveSession && current.active) {
        return { ok: false, error: "session_active" };
    }
    if (
        current.metadataVersion !== params.sharedMetadata.expectedVersion
        || (
            params.mode !== "shared_editor"
            && (
                !doesStoredSessionOwnerMetadataMatchEnvelope({
                    stored: current.ownerMetadata,
                    envelope: params.expectedOwnerMetadata,
                    accountMode:
                        accountCurrentness.currentness.encryptionMode,

                })
                || current.agentStateVersion
                    !== params.agentState.expectedVersion
            )
        )
    ) {
        return toMetadataEnvelopeTupleVersionMismatch(current, params);
    }
    const nextMetadataVersion =
        params.sharedMetadata.expectedVersion + 1;
    const agentStateChanged = params.mode !== "shared_editor"
        && current.agentState !== params.agentState.ciphertext;
    // Writers re-send the exact retained owner envelope when no owner fact changed.
    const ownerMetadataChanged = params.mode !== "shared_editor"
        && !doesStoredSessionOwnerMetadataMatchEnvelope({
            stored: current.ownerMetadata,
            envelope: params.ownerMetadata,
            accountMode: accountCurrentness.currentness.encryptionMode,
        });
    const nextAgentStateVersion = agentStateChanged
        ? params.agentState.expectedVersion + 1
        : current.agentStateVersion;
    const previousDisplay = params.mode === 'shared_editor' && admittedDisplay
        ? projectSessionDisplayForRecipient({
            session: { ...current, accountId: access.sessionOwnerId },
            recipient: { type: 'owner', accountId: access.sessionOwnerId,
                accountMode: accountCurrentness.currentness.encryptionMode },
        })
        : undefined;
    const nextDisplayProjectionV1 = admittedDisplay ? JSON.stringify({
        ...admittedDisplay,
        ...(params.mode === 'shared_editor' && previousDisplay?.owner ? { owner: previousDisplay.owner } : {}),
    }) : null;
    const usageTimingV1 = nextSessionUsageTiming({ current: current.usageTimingV1, supplied: params.usageTimingV1,
        metadataWritten: true, metadataChanged: current.metadata !== params.sharedMetadata.ciphertext || ownerMetadataChanged,
        agentStateWritten: params.mode !== 'shared_editor', agentStateChanged, sharedEditor: params.mode === 'shared_editor' });
    const updateData = params.mode !== "shared_editor"
        ? {
            usageTimingV1,
            displayProjectionV1: nextDisplayProjectionV1,
            metadata: params.sharedMetadata.ciphertext,
            metadataVersion: nextMetadataVersion,
            ownerMetadata:
                JSON.stringify(
                    params.ownerMetadata,
                ),
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            agentState: params.agentState.ciphertext,
            agentStateVersion: nextAgentStateVersion,
            ...(params.mode === "owner" && params.projectKey !== undefined
                ? { projectKey: params.projectKey, projectKeyNone: params.projectKey === null } : {}),
            ...pendingSummary,
            ...sharedConfirmationSummary,
        }
        : {
            usageTimingV1,
            displayProjectionV1: nextDisplayProjectionV1,
            metadata: params.sharedMetadata.ciphertext,
            metadataVersion: nextMetadataVersion,
            ...sharedConfirmationSummary,
        };
    const { count } = await tx.session.updateMany({
        where: {
            id: params.sessionId,
            ...(requiresInactiveSession ? { active: false } : {}),
            ...(requireUnarchivedSession ? { archivedAt: null } : {}),
            metadataLayoutVersion: current.metadataLayoutVersion,
            metadataVersion: params.sharedMetadata.expectedVersion,
            ...(params.mode !== "shared_editor"
                ? {
                    ownerMetadata: current.ownerMetadata,
                    agentStateVersion: params.agentState.expectedVersion,
                }
                : {
                    // The exact retained owner leaf is proved unchanged by this
                    // same durable tuple CAS, not a preceding read alone.
                    ownerMetadata: current.ownerMetadata,
                }),
        },
        data: encodeSessionStoredContent(updateData),
    });

    const nextTuple: StoredSessionMetadataEnvelopeTuple = {
        active: current.active,
        displayProjectionV1: nextDisplayProjectionV1,
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        metadataVersion: nextMetadataVersion,
        metadata: params.sharedMetadata.ciphertext,
        ownerMetadata: params.mode !== "shared_editor"
            ? JSON.stringify(
                params.ownerMetadata,
            )
            : current.ownerMetadata,
        agentStateVersion: nextAgentStateVersion,
        agentState: params.mode !== "shared_editor"
            ? params.agentState.ciphertext
            : current.agentState,
    };
    if (count === 0) {
        const fresh = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: withSessionContentSelect({
                active: true,
                archivedAt: true,
                projectKey: true,
                projectKeyNone: true,
                displayProjectionV1: true,
                metadataLayoutVersion: true,
                metadataVersion: true,
                usageTimingV1: true,
                metadata: true,
                ownerMetadata: true,
                agentStateVersion: true,
                agentState: true,
            }),
        }).then(decodeSessionStoredContent);
        if (!fresh) return { ok: false, error: "session-not-found" };
        if (
            fresh.metadataLayoutVersion
            !== SESSION_METADATA_LAYOUT_VERSION_V1
        ) {
            return {
                ok: false,
                error: "metadata_privacy_upgrade_required",
            };
        }
        if (
            isExactMetadataEnvelopeTupleRetry(fresh, params)
            && (
                params.mode !== "owner_team_credential_binding"
                || (await Promise.all(params.teamCredentialBindings.map((intent) =>
                    isSessionTeamCredentialBindingIntentCurrentInTx(tx, {
                        sessionId: params.sessionId,
                        intent,
                    })))).every(Boolean)
            )
        ) {
            return toMetadataEnvelopeTupleSuccess(
                fresh,
                params,
                [],
                access.sessionOwnerId,
                accountCurrentness.currentness.encryptionMode,
            );
        }
        if (requiresInactiveSession && fresh.active) {
            return { ok: false, error: "session_active" };
        }
        // Losing to a concurrent archive is a distinct state from losing the
        // version CAS: nothing about this write is stale, the Session simply
        // stopped being a legal target for it.
        if (requireUnarchivedSession && fresh.archivedAt !== null) {
            return { ok: false, error: "session_archived" };
        }
        return toMetadataEnvelopeTupleVersionMismatch(fresh, params);
    }

    if (params.mode === "owner_team_credential_binding") {
        const bindingWrite = await writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorUserId,
            intents: params.teamCredentialBindings,
            authentication: params.authentication,
            teamVisibilityGrantConsent: params.teamVisibilityGrantConsent,
        });
        if (!bindingWrite.ok) {
            throw new SessionTeamCredentialBindingMutationError(bindingWrite.reason);
        }
    }

    if (params.mode === 'owner') await publishCommittedSessionRequestOccurrencesInTx(tx, {
        sessionId: params.sessionId, ownerAccountId: access.sessionOwnerId, source: current,
        sourceSession: { ...access.sessionState, id: params.sessionId }, recipientAccountIds: access.recipientAccountIds,
        agentStateVersion: nextAgentStateVersion,
        occurrences: params.activitySummaryV1?.newUserActionRequiredOccurrences ?? [],
    });
    const recipientCursors = await markSessionProjectionRecipientsChanged({
        tx,
        sessionId: params.sessionId,
        recipientAccountIds: access.recipientAccountIds,
        hint: { sharedMetadataVersion: nextMetadataVersion },
        ...(publication?.publishCurrentView ? { currentViewPublication: { kind: 'envelope_tuple_v1', sessionOwnerId: access.sessionOwnerId } } as const : {}),
        followSourceChanged: agentStateChanged,
        usageAccountingChanged: false,
    });
    return toMetadataEnvelopeTupleSuccess(
        nextTuple,
        params,
        recipientCursors,
        access.sessionOwnerId,
        accountCurrentness.currentness.encryptionMode,
        runtimeProjection,
        { ownerMetadata: ownerMetadataChanged, agentState: agentStateChanged },
    );
}

export async function updateSessionMetadataEnvelopeTuple(
    params: UpdateSessionMetadataEnvelopeTupleInput,
): Promise<UpdateSessionMetadataEnvelopeTupleResult> {
    const admitted = parseSessionMetadataEnvelopeTupleInput(params);
    return admitted === null ? { ok: false, error: "invalid-params" }
        : updateAdmittedSessionMetadataEnvelopeTuple(admitted);
}

/** HTTP's canonical strict body parser has already admitted this patch. */
export async function updateAdmittedSessionMetadataEnvelopeTuple(
    params: UpdateSessionMetadataEnvelopeTupleInput,
    publication?: Readonly<{ publishCurrentView: true }>,
): Promise<UpdateSessionMetadataEnvelopeTupleResult> {
    try {
        const consent = params.mode === "owner_team_credential_binding" ? params.teamVisibilityGrantConsent : undefined;
        return await inTx(async (tx) =>
            updateSessionMetadataEnvelopeTupleAfterCursorFenceInTx(tx, params, undefined, publication), {
                // Consent changes access, so admit its prospective Team audience
                // with the strongest intent before the shared CAS body. Ordinary
                // metadata retains its prepared content-audience discovery.
                prepare: consent
                    ? async () => tx => acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId], [],
                        { ...sessionAccessGrantMutationCursorLockOptions({ actorAccountId: params.actorUserId, sessionId: params.sessionId,
                            subjects: [{ kind: "team", teamId: consent.teamId }],
                        }), includeLifecyclePublications: true })
                    : () => prepareSessionAccountCursorLocks([params.sessionId], [params.actorUserId],
                        { includeLifecyclePublications: params.mode === 'owner_team_credential_binding' }),
            });
    } catch (error) {
        if (error instanceof SessionTeamCredentialBindingMutationError) {
            return {
                ok: false,
                error: "session_team_credential_binding_rejected",
                reason: error.reason,
            };
        }
        throw error;
    }
}
