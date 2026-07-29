import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
    ExternalSessionOperationSocketCommandV1Schema,
    makeExternalSessionHistoricalImportBatchIdV1,
    validateExternalSessionOperationSocketBatchV1,
    type ExternalSessionMaterializationPublicationV1,
    type ExternalSessionOperationClaimV1,
    type ExternalSessionOperationSocketBatchLimitsV1,
    type ExternalSessionOperationSocketCommandV1,
    type ExternalSessionOperationSocketResponseV1,
    type ExternalSessionPriorStableStorageV1,
} from "@happier-dev/protocol";

import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { initializeExternalLinkedSessionStorage } from "@/app/session/externalLinkedSessionStorageInitialization";
import { updateSessionMetadataEnvelopeTupleInTx } from "@/app/session/sessionWriteService";
import { writeHistoricalSessionMessageBatchInTx } from "@/app/session/sessionTranscriptWrite";
import { inTx, type Tx } from "@/storage/inTx";

const HISTORICAL_IMPORT_NAMESPACE = "external_sessions";
const HISTORICAL_IMPORT_KIND = "historical_import";

class HistoricalImportDiscardConflictError extends Error {
    constructor() {
        super("Historical import discard row ownership no longer matches.");
        this.name = "HistoricalImportDiscardConflictError";
    }
}

type HistoricalImportInsertedSequenceSpan = Readonly<{
    firstSeq: number;
    lastSeq: number;
}>;

type HistoricalImportJob = Readonly<{
    v: 1;
    machineId: string;
    claim: ExternalSessionOperationClaimV1;
    revision: number;
    priorStorageState: "machine_only" | "snapshot_complete";
    acceptedThroughServerSeq: number | null;
    /**
     * Pre-span current-dev job compatibility. No released/predecessor writer exists;
     * remove after retained development jobs are completed or discarded.
     */
    insertedMessageIds: readonly string[] | null;
    /**
     * Exact sequence ranges allocated by the canonical historical writer for this
     * unpublished job. `null` together with `insertedMessageIds: null` means an
     * older job lacks sufficient ownership evidence and cannot be discarded.
     */
    insertedSequenceSpans: readonly HistoricalImportInsertedSequenceSpan[] | null;
    state: "importing" | "finalized" | "discarded";
    admission: PersistedTakeoverAdmission | null;
}>;

type PersistedTakeoverAdmissionCommand = Extract<
    ExternalSessionOperationSocketCommandV1,
    { kind: "admit_persisted_takeover" }
>;

type PersistedTakeoverAdmission = Readonly<
    Pick<
        PersistedTakeoverAdmissionCommand,
        | "attemptId"
        | "expectedSessionMetadataVersion"
        | "metadataPatch"
        | "expectedSessionSeq"
        | "expectedPending"
        | "expectedPublication"
    >
>;

function errorResponse(
    errorCode: Extract<ExternalSessionOperationSocketResponseV1, { kind: "error" }>["errorCode"],
    message: string,
): Extract<ExternalSessionOperationSocketResponseV1, { kind: "error" }> {
    return { v: 1, kind: "error", errorCode, message };
}

function readInsertedSequenceSpans(
    value: unknown,
): readonly HistoricalImportInsertedSequenceSpan[] | null {
    if (!Array.isArray(value)) return null;
    const spans: HistoricalImportInsertedSequenceSpan[] = [];
    for (const candidate of value) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return null;
        }
        const record = candidate as Record<string, unknown>;
        if (
            typeof record.firstSeq !== "number"
            || !Number.isSafeInteger(record.firstSeq)
            || record.firstSeq < 1
            || typeof record.lastSeq !== "number"
            || !Number.isSafeInteger(record.lastSeq)
            || record.lastSeq < record.firstSeq
        ) {
            return null;
        }
        const prior = spans.at(-1);
        if (prior && record.firstSeq <= prior.lastSeq + 1) return null;
        spans.push({
            firstSeq: record.firstSeq,
            lastSeq: record.lastSeq,
        });
    }
    return spans;
}

function readJob(value: unknown): HistoricalImportJob | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const claim = record.claim;
    if (
        record.v !== 1
        || typeof record.machineId !== "string"
        || !record.machineId
        || typeof record.revision !== "number"
        || !Number.isSafeInteger(record.revision)
        || record.revision < 0
        || (record.priorStorageState !== "machine_only" && record.priorStorageState !== "snapshot_complete")
        || (
            record.acceptedThroughServerSeq !== null
            && (
                typeof record.acceptedThroughServerSeq !== "number"
                || !Number.isSafeInteger(record.acceptedThroughServerSeq)
                || record.acceptedThroughServerSeq < 0
            )
        )
        || (
            record.insertedMessageIds !== undefined
            && record.insertedMessageIds !== null
            && (
                !Array.isArray(record.insertedMessageIds)
                || record.insertedMessageIds.some((id) => typeof id !== "string" || !id)
                || new Set(record.insertedMessageIds).size !== record.insertedMessageIds.length
            )
        )
        || (
            record.insertedSequenceSpans !== undefined
            && record.insertedSequenceSpans !== null
            && readInsertedSequenceSpans(record.insertedSequenceSpans) === null
        )
        || (
            Array.isArray(record.insertedMessageIds)
            && Array.isArray(record.insertedSequenceSpans)
        )
        || (
            record.state !== "importing"
            && record.state !== "finalized"
            && record.state !== "discarded"
        )
    ) {
        return null;
    }
    const parsedClaim = ExternalSessionOperationSocketCommandV1Schema.safeParse({
        v: 1,
        kind: "inspect",
        claim,
        expectedRevision: record.revision,
    });
    if (!parsedClaim.success) return null;
    const admissionInput = record.admission;
    let admission: PersistedTakeoverAdmission | null = null;
    if (admissionInput !== undefined && admissionInput !== null) {
        if (typeof admissionInput !== "object" || Array.isArray(admissionInput)) return null;
        const parsedAdmission = ExternalSessionOperationSocketCommandV1Schema.safeParse({
            v: 1,
            kind: "admit_persisted_takeover",
            claim: parsedClaim.data.claim,
            expectedRevision: record.revision,
            ...admissionInput,
        });
        if (!parsedAdmission.success || parsedAdmission.data.kind !== "admit_persisted_takeover") {
            return null;
        }
        admission = {
            attemptId: parsedAdmission.data.attemptId,
            expectedSessionMetadataVersion: parsedAdmission.data.expectedSessionMetadataVersion,
            metadataPatch: parsedAdmission.data.metadataPatch,
            expectedSessionSeq: parsedAdmission.data.expectedSessionSeq,
            expectedPending: parsedAdmission.data.expectedPending,
            expectedPublication: parsedAdmission.data.expectedPublication,
        };
    }
    return {
        v: 1,
        machineId: record.machineId,
        claim: parsedClaim.data.claim,
        revision: record.revision,
        priorStorageState: record.priorStorageState,
        acceptedThroughServerSeq: record.acceptedThroughServerSeq as number | null,
        insertedMessageIds: Array.isArray(record.insertedMessageIds)
            ? record.insertedMessageIds as string[]
            : null,
        insertedSequenceSpans: Array.isArray(record.insertedSequenceSpans)
            ? readInsertedSequenceSpans(record.insertedSequenceSpans)
            : null,
        state: record.state,
        admission,
    };
}

function claimsEqual(
    left: ExternalSessionOperationClaimV1,
    right: ExternalSessionOperationClaimV1,
): boolean {
    return left.sessionId === right.sessionId
        && left.operationId === right.operationId
        && left.operationClaimId === right.operationClaimId;
}

function admissionsEqual(
    left: PersistedTakeoverAdmission,
    right: PersistedTakeoverAdmissionCommand,
): boolean {
    return left.attemptId === right.attemptId
        && left.expectedSessionMetadataVersion === right.expectedSessionMetadataVersion
        && isDeepStrictEqual(left.metadataPatch, right.metadataPatch)
        && left.expectedSessionSeq === right.expectedSessionSeq
        && left.expectedPending.version === right.expectedPending.version
        && left.expectedPending.count === right.expectedPending.count
        && left.expectedPending.blockedCount === right.expectedPending.blockedCount
        && left.expectedPublication.materializationPublicationId
            === right.expectedPublication.materializationPublicationId
        && left.expectedPublication.materializedThroughSourceAt
            === right.expectedPublication.materializedThroughSourceAt
        && left.expectedPublication.publishedThroughServerSeq
            === right.expectedPublication.publishedThroughServerSeq;
}

function takeoverAdmittedResponse(
    job: HistoricalImportJob,
    attemptId: string,
): Extract<ExternalSessionOperationSocketResponseV1, { kind: "takeover_admitted" }> {
    return {
        v: 1,
        kind: "takeover_admitted",
        claim: job.claim,
        revision: job.revision,
        attemptId,
    };
}

function localIdForOperation(operationId: string): string {
    return `historical-import:${operationId}`;
}

async function readJobInTx(
    tx: Tx,
    actorUserId: string,
    command: ExternalSessionOperationSocketCommandV1,
): Promise<HistoricalImportJob | null> {
    const row = await tx.sessionSystemRecord.findUnique({
        where: {
            accountId_sessionId_namespace_localId: {
                accountId: actorUserId,
                sessionId: command.claim.sessionId,
                namespace: HISTORICAL_IMPORT_NAMESPACE,
                localId: localIdForOperation(command.claim.operationId),
            },
        },
        select: { content: true },
    });
    return row ? readJob(row.content) : null;
}

async function writeJobInTx(
    tx: Tx,
    actorUserId: string,
    job: HistoricalImportJob,
): Promise<void> {
    const {
        insertedMessageIds,
        insertedSequenceSpans,
        ...jobWithoutDiscardOwnership
    } = job;
    const content = {
        ...jobWithoutDiscardOwnership,
        ...(insertedMessageIds === null ? {} : { insertedMessageIds }),
        ...(insertedSequenceSpans === null ? {} : { insertedSequenceSpans }),
    };
    await tx.sessionSystemRecord.upsert({
        where: {
            accountId_sessionId_namespace_localId: {
                accountId: actorUserId,
                sessionId: job.claim.sessionId,
                namespace: HISTORICAL_IMPORT_NAMESPACE,
                localId: localIdForOperation(job.claim.operationId),
            },
        },
        create: {
            accountId: actorUserId,
            sessionId: job.claim.sessionId,
            namespace: HISTORICAL_IMPORT_NAMESPACE,
            kind: HISTORICAL_IMPORT_KIND,
            localId: localIdForOperation(job.claim.operationId),
            content,
        },
        update: {
            kind: HISTORICAL_IMPORT_KIND,
            content,
        },
    });
}

function appendInsertedSequenceSpans(
    spans: readonly HistoricalImportInsertedSequenceSpan[],
    insertedSeqs: readonly number[],
): readonly HistoricalImportInsertedSequenceSpan[] {
    if (insertedSeqs.length === 0) return spans;
    const next = spans.map((span) => ({ ...span }));
    for (const seq of [...insertedSeqs].sort((left, right) => left - right)) {
        const prior = next.at(-1);
        if (prior && seq <= prior.lastSeq) {
            throw new HistoricalImportDiscardConflictError();
        }
        if (prior && seq === prior.lastSeq + 1) {
            next[next.length - 1] = { ...prior, lastSeq: seq };
        } else {
            next.push({ firstSeq: seq, lastSeq: seq });
        }
    }
    return next;
}

function insertedSequenceSpanRowCount(
    spans: readonly HistoricalImportInsertedSequenceSpan[],
): number {
    return spans.reduce(
        (count, span) => count + (span.lastSeq - span.firstSeq + 1),
        0,
    );
}

function authorizeJob(
    job: HistoricalImportJob,
    transportMachineId: string,
    command: ExternalSessionOperationSocketCommandV1,
): ExternalSessionOperationSocketResponseV1 | null {
    if (job.machineId !== transportMachineId) {
        return errorResponse("wrong_machine_socket", "Historical import belongs to another machine.");
    }
    if (!claimsEqual(job.claim, command.claim)) {
        return errorResponse("wrong_operation_claim", "Historical import claim does not match.");
    }
    if (job.revision !== command.expectedRevision) {
        return errorResponse("stale_revision", "Historical import revision is stale.");
    }
    return null;
}

function authorizeDiscardJob(
    job: HistoricalImportJob,
    transportMachineId: string,
    command: Extract<ExternalSessionOperationSocketCommandV1, { kind: "discard" }>,
): ExternalSessionOperationSocketResponseV1 | null {
    if (job.machineId !== transportMachineId) {
        return errorResponse("wrong_machine_socket", "Historical import belongs to another machine.");
    }
    if (!claimsEqual(job.claim, command.claim)) {
        return errorResponse("wrong_operation_claim", "Historical import claim does not match.");
    }
    // The daemon operation record advances for interruption/cancellation without
    // a server command. Its exact current revision is validated by the daemon
    // action owner; the server rejects only revisions older than its last bind.
    if (command.expectedRevision < job.revision) {
        return errorResponse("stale_revision", "Historical import revision is stale.");
    }
    return null;
}

function terminalResponse(
    job: HistoricalImportJob,
    publication: ExternalSessionMaterializationPublicationV1 | null,
): Extract<
    ExternalSessionOperationSocketResponseV1,
    { kind: "finalized" | "discarded" | "error" }
> | null {
    if (job.state === "finalized") {
        if (
            publication === null
            || publication.publishedThroughServerSeq !== (job.acceptedThroughServerSeq ?? 0)
        ) {
            return errorResponse(
                "internal_error",
                "Finalized historical import publication is unavailable.",
            );
        }
        return {
            v: 1,
            kind: "finalized",
            claim: job.claim,
            revision: job.revision,
            acceptedThroughServerSeq: job.acceptedThroughServerSeq ?? 0,
            publication,
        };
    }
    if (job.state === "discarded") {
        return {
            v: 1,
            kind: "discarded",
            claim: job.claim,
            revision: job.revision,
        };
    }
    return null;
}

function readMaterializationPublication(
    session: Readonly<{
        materializationPublicationId: string | null;
        materializedThroughSourceAt: bigint | null;
        publishedThroughServerSeq: number | null;
    }>,
): ExternalSessionMaterializationPublicationV1 | null {
    const materializedThroughSourceAt = session.materializedThroughSourceAt === null
        ? Number.NaN
        : Number(session.materializedThroughSourceAt);
    if (
        !session.materializationPublicationId
        || !Number.isSafeInteger(materializedThroughSourceAt)
        || materializedThroughSourceAt < 0
        || session.publishedThroughServerSeq === null
        || !Number.isSafeInteger(session.publishedThroughServerSeq)
        || session.publishedThroughServerSeq < 0
    ) {
        return null;
    }
    return {
        materializationPublicationId: session.materializationPublicationId,
        materializedThroughSourceAt,
        publishedThroughServerSeq: session.publishedThroughServerSeq,
    };
}

function readPriorStableStorage(
    job: HistoricalImportJob,
    session: Parameters<typeof readMaterializationPublication>[0],
): ExternalSessionPriorStableStorageV1 | null {
    if (job.priorStorageState === "machine_only") {
        return { state: "machine_only" };
    }
    const publication = readMaterializationPublication(session);
    return publication
        ? { state: "snapshot_complete", publication }
        : null;
}

function inspectPriorStableStorage(
    session: Readonly<{
        currentStorageState: string;
        seq: number;
        acceptedThroughServerSeq: number | null;
        materializationPublicationId: string | null;
        materializedThroughSourceAt: bigint | null;
        publishedThroughServerSeq: number | null;
    }>,
): ExternalSessionPriorStableStorageV1 | null {
    if (session.currentStorageState === "machine_only") {
        return { state: "machine_only" };
    }
    if (session.currentStorageState === "snapshot_complete") {
        const publication = readMaterializationPublication(session);
        return publication
            ? { state: "snapshot_complete", publication }
            : null;
    }
    if (
        session.currentStorageState === "hosted"
        && session.seq === 0
        && session.acceptedThroughServerSeq === null
        && session.materializationPublicationId === null
        && session.materializedThroughSourceAt === null
        && session.publishedThroughServerSeq === null
    ) {
        return { state: "machine_only" };
    }
    return null;
}

function priorStableStorageEqual(
    left: ExternalSessionPriorStableStorageV1,
    right: ExternalSessionPriorStableStorageV1,
): boolean {
    if (left.state !== right.state) return false;
    if (left.state === "machine_only" || right.state === "machine_only") {
        return true;
    }
    return left.publication.materializationPublicationId
        === right.publication.materializationPublicationId
        && left.publication.materializedThroughSourceAt
            === right.publication.materializedThroughSourceAt
        && left.publication.publishedThroughServerSeq
            === right.publication.publishedThroughServerSeq;
}

function authorizeResumeJob(
    job: HistoricalImportJob,
    transportMachineId: string,
    command: ExternalSessionOperationSocketCommandV1,
): ExternalSessionOperationSocketResponseV1 | null {
    if (job.machineId !== transportMachineId) {
        return errorResponse("wrong_machine_socket", "Historical import belongs to another machine.");
    }
    if (!claimsEqual(job.claim, command.claim)) {
        return errorResponse("wrong_operation_claim", "Historical import claim does not match.");
    }
    // The daemon operation revision is canonical and can advance through several
    // durable local states between server acknowledgements. A bound current
    // revision advances this job; any older client is stale after that point.
    if (command.expectedRevision < job.revision) {
        return errorResponse("stale_revision", "Historical import revision is stale.");
    }
    return null;
}

/**
 * Server-owned historical-import command.
 *
 * It binds one authenticated machine/operation claim, delegates every transcript row to the
 * canonical historical writer, and publishes the accepted sequence ceiling atomically. It owns
 * no daemon operation lifecycle, retries, scheduler, attention, Pending, or hosted-turn effects.
 */
export async function executeExternalSessionHistoricalImportCommand(params: Readonly<{
    actorUserId: string;
    transportMachineId: string;
    command: unknown;
    limits: ExternalSessionOperationSocketBatchLimitsV1;
}>): Promise<ExternalSessionOperationSocketResponseV1> {
    const parsed = ExternalSessionOperationSocketCommandV1Schema.safeParse(params.command);
    if (!parsed.success) {
        return errorResponse("invalid_state", "Invalid historical import command.");
    }
    const command = parsed.data;
    const batchValidation = validateExternalSessionOperationSocketBatchV1(command, params.limits);
    if (!batchValidation.ok) {
        return errorResponse(
            batchValidation.errorCode,
            batchValidation.errorCode === "too_many_items"
                ? "Historical import command exceeds the negotiated item ceiling."
                : "Historical import command exceeds the negotiated socket byte ceiling.",
        );
    }
    if (command.kind !== "batch") {
        const serializedBytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
        if (serializedBytes > params.limits.maxSerializedBytes) {
            return errorResponse("serialized_bytes_exceeded", "Historical import command exceeds the socket byte ceiling.");
        }
    }
    if (
        command.kind === "batch"
        && command.batchId !== makeExternalSessionHistoricalImportBatchIdV1(
            command.items.map((item) => item.localId),
        )
    ) {
        return errorResponse(
            "batch_conflict",
            "Historical import batch id does not match its ordered stable item identities.",
        );
    }

    try {
        return await inTx(async (tx) => {
        let session = await tx.session.findFirst({
            where: { id: command.claim.sessionId, accountId: params.actorUserId },
            select: {
                id: true,
                metadataVersion: true,
                currentStorageState: true,
                seq: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
                pendingVersion: true,
                pendingCount: true,
                pendingBlockedCount: true,
                active: true,
                thinking: true,
            },
        });
        if (!session) return errorResponse("wrong_session", "Session is unavailable.");
        let job = await readJobInTx(tx, params.actorUserId, command);
        if (command.kind === "inspect") {
            if (job) {
                const rejection = authorizeResumeJob(
                    job,
                    params.transportMachineId,
                    command,
                );
                if (rejection) return rejection;
                const priorStableStorage = job.priorStorageState === "machine_only"
                    ? { state: "machine_only" as const }
                    : job.state === "importing"
                        ? readPriorStableStorage(job, session)
                        : null;
                return priorStableStorage
                    ? {
                        v: 1,
                        kind: "authority",
                        claim: command.claim,
                        revision: command.expectedRevision,
                        priorStableStorage,
                    }
                    : errorResponse(
                        "internal_error",
                        "Historical import prior storage authority is unavailable.",
                    );
            }
            const priorStableStorage = inspectPriorStableStorage(session);
            return priorStableStorage
                ? {
                    v: 1,
                    kind: "authority",
                    claim: command.claim,
                    revision: command.expectedRevision,
                    priorStableStorage,
                }
                : errorResponse(
                    "storage_mode_conflict",
                    "Session has no inspectable historical storage authority.",
                );
        }
        const isNewBegin = command.kind === "begin" && !job;
        if (command.kind === "begin" && !job) {
            const currentPriorStableStorage = inspectPriorStableStorage(session);
            if (
                !currentPriorStableStorage
                || !priorStableStorageEqual(
                    currentPriorStableStorage,
                    command.expectedPriorStableStorage,
                )
            ) {
                return errorResponse(
                    "storage_mode_conflict",
                    "Historical import prior storage authority changed before begin.",
                );
            }
        }
        if (
            session.currentStorageState === "hosted"
            && isNewBegin
        ) {
            const initialized = await initializeExternalLinkedSessionStorage(
                tx,
                session,
                params.actorUserId,
            );
            if (!initialized.ok) {
                return errorResponse(
                    "storage_mode_conflict",
                    initialized.reason === "unsafe_authority"
                        ? "Hosted session contains server-owned state and cannot be reclassified for materialization."
                        : "Session storage authority changed while materialization began.",
                );
            }
            session = { ...session, currentStorageState: initialized.session.currentStorageState };
        }

        if (command.kind === "begin") {
            if (!job) {
                if (
                    session.currentStorageState !== "machine_only"
                    && session.currentStorageState !== "snapshot_complete"
                ) {
                    return errorResponse("invalid_state", "Session cannot begin historical import.");
                }
                job = {
                    v: 1,
                    machineId: params.transportMachineId,
                    claim: command.claim,
                    revision: command.expectedRevision,
                    priorStorageState: session.currentStorageState,
                    acceptedThroughServerSeq: null,
                    insertedMessageIds: null,
                    insertedSequenceSpans: [],
                    state: "importing",
                    admission: null,
                };
                await writeJobInTx(tx, params.actorUserId, job);
            } else {
                const rejection = authorizeResumeJob(
                    job,
                    params.transportMachineId,
                    command,
                );
                if (rejection) return rejection;
                const priorStableStorage = readPriorStableStorage(job, session);
                if (
                    !priorStableStorage
                    || !priorStableStorageEqual(
                        priorStableStorage,
                        command.expectedPriorStableStorage,
                    )
                ) {
                    return errorResponse(
                        "storage_mode_conflict",
                        "Historical import prior storage authority no longer matches begin.",
                    );
                }
                if (command.expectedRevision > job.revision) {
                    job = { ...job, revision: command.expectedRevision };
                    await writeJobInTx(tx, params.actorUserId, job);
                }
            }
            const rejection = authorizeJob(job, params.transportMachineId, command);
            if (rejection) return rejection;
            const terminal = terminalResponse(
                job,
                readMaterializationPublication(session),
            );
            if (terminal) return terminal;
            if (job.state !== "importing") {
                return errorResponse("invalid_state", "Historical import is already finalized.");
            }
            const priorStableStorage = readPriorStableStorage(job, session);
            if (!priorStableStorage) {
                return errorResponse(
                    "internal_error",
                    "Historical import prior storage authority is unavailable.",
                );
            }
            return {
                v: 1,
                kind: "ready",
                claim: command.claim,
                revision: job.revision,
                historicalImportJobId: localIdForOperation(command.claim.operationId),
                limits: params.limits,
                priorStableStorage,
                ...(job.acceptedThroughServerSeq === null
                    ? {}
                    : { acceptedThroughServerSeq: job.acceptedThroughServerSeq }),
            };
        }

        if (command.kind === "resume") {
            if (!job) return errorResponse("wrong_operation", "Historical import operation was not begun.");
            const rejection = authorizeResumeJob(job, params.transportMachineId, command);
            if (rejection) return rejection;
            if (command.expectedRevision > job.revision) {
                job = { ...job, revision: command.expectedRevision };
                await writeJobInTx(tx, params.actorUserId, job);
            }
            const terminal = terminalResponse(
                job,
                readMaterializationPublication(session),
            );
            if (terminal) return terminal;
            const priorStableStorage = readPriorStableStorage(job, session);
            if (!priorStableStorage) {
                return errorResponse(
                    "internal_error",
                    "Historical import prior storage authority is unavailable.",
                );
            }
            return {
                v: 1,
                kind: "ready",
                claim: command.claim,
                revision: job.revision,
                historicalImportJobId: localIdForOperation(command.claim.operationId),
                limits: params.limits,
                priorStableStorage,
                ...(job.acceptedThroughServerSeq === null
                    ? {}
                    : { acceptedThroughServerSeq: job.acceptedThroughServerSeq }),
            };
        }

        if (!job) return errorResponse("wrong_operation", "Historical import operation was not begun.");
        const rejection = command.kind === "discard"
            ? authorizeDiscardJob(job, params.transportMachineId, command)
            : command.kind === "admit_persisted_takeover"
                ? authorizeResumeJob(job, params.transportMachineId, command)
                : authorizeJob(job, params.transportMachineId, command);
        if (rejection) return rejection;

        if (command.kind === "admit_persisted_takeover") {
            if (job.admission) {
                if (
                    !admissionsEqual(job.admission, command)
                    || job.state !== "finalized"
                    || session.currentStorageState !== "hosted"
                    || session.acceptedThroughServerSeq !== null
                    || session.materializationPublicationId !== null
                    || session.materializedThroughSourceAt !== null
                    || session.publishedThroughServerSeq !== null
                ) {
                    return errorResponse(
                        "invalid_state",
                        "Persisted takeover admission no longer matches canonical authority.",
                    );
                }
                const metadataRetry =
                    await updateSessionMetadataEnvelopeTupleInTx(tx, {
                        actorUserId: params.actorUserId,
                        sessionId: session.id,
                        ...command.metadataPatch,
                    });
                if (!metadataRetry.ok) {
                    return errorResponse(
                        "invalid_state",
                        "Persisted takeover link retirement no longer matches canonical metadata.",
                    );
                }
                if (command.expectedRevision > job.revision) {
                    job = { ...job, revision: command.expectedRevision };
                    await writeJobInTx(tx, params.actorUserId, job);
                }
                return takeoverAdmittedResponse(job, command.attemptId);
            }

            const publication = command.expectedPublication;
            if (
                job.state !== "finalized"
                || session.currentStorageState !== "snapshot_complete"
                || session.acceptedThroughServerSeq !== null
                || session.metadataVersion !== command.expectedSessionMetadataVersion
                || command.metadataPatch.sharedMetadata.expectedVersion
                    !== command.expectedSessionMetadataVersion
                || session.seq !== command.expectedSessionSeq
                || session.pendingVersion !== command.expectedPending.version
                || session.pendingCount !== command.expectedPending.count
                || session.pendingBlockedCount !== command.expectedPending.blockedCount
                || session.active
                || session.thinking
                || session.materializationPublicationId
                    !== publication.materializationPublicationId
                || session.materializedThroughSourceAt
                    !== BigInt(publication.materializedThroughSourceAt)
                || session.publishedThroughServerSeq
                    !== publication.publishedThroughServerSeq
                || job.acceptedThroughServerSeq
                    !== publication.publishedThroughServerSeq
            ) {
                return errorResponse(
                    "invalid_state",
                    "Persisted takeover admission fences do not match canonical authority.",
                );
            }

            const metadataUpdated =
                await updateSessionMetadataEnvelopeTupleInTx(tx, {
                    actorUserId: params.actorUserId,
                    sessionId: session.id,
                    ...command.metadataPatch,
                });
            if (!metadataUpdated.ok) {
                return errorResponse(
                    "invalid_state",
                    "Persisted takeover link retirement changed during admission.",
                );
            }

            const updated = await tx.session.updateMany({
                where: {
                    id: session.id,
                    accountId: params.actorUserId,
                    currentStorageState: "snapshot_complete",
                    acceptedThroughServerSeq: null,
                    metadataVersion: metadataUpdated.sharedMetadata.version,
                    seq: command.expectedSessionSeq,
                    pendingVersion: command.expectedPending.version,
                    pendingCount: command.expectedPending.count,
                    pendingBlockedCount: command.expectedPending.blockedCount,
                    active: false,
                    thinking: false,
                    materializationPublicationId:
                        publication.materializationPublicationId,
                    materializedThroughSourceAt:
                        BigInt(publication.materializedThroughSourceAt),
                    publishedThroughServerSeq:
                        publication.publishedThroughServerSeq,
                },
                data: {
                    currentStorageState: "hosted",
                    acceptedThroughServerSeq: null,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                },
            });
            if (updated.count !== 1) {
                return errorResponse(
                    "invalid_state",
                    "Persisted takeover authority changed during admission.",
                );
            }

            job = {
                ...job,
                revision: command.expectedRevision,
                admission: {
                    attemptId: command.attemptId,
                    expectedSessionMetadataVersion: command.expectedSessionMetadataVersion,
                    metadataPatch: command.metadataPatch,
                    expectedSessionSeq: command.expectedSessionSeq,
                    expectedPending: command.expectedPending,
                    expectedPublication: command.expectedPublication,
                },
            };
            await writeJobInTx(tx, params.actorUserId, job);
            return takeoverAdmittedResponse(job, command.attemptId);
        }

        if (command.kind === "batch") {
            if (job.state !== "importing") {
                return errorResponse("invalid_state", "Historical import is not accepting batches.");
            }
            const existingLocalIds = new Set(
                (await tx.sessionMessage.findMany({
                    where: {
                        sessionId: session.id,
                        localId: { in: command.items.map((item) => item.localId) },
                    },
                    select: { localId: true },
                })).flatMap((message) => message.localId ? [message.localId] : []),
            );
            const written = await writeHistoricalSessionMessageBatchInTx(tx, {
                sessionId: session.id,
                storagePolicy: readEncryptionFeatureEnv(process.env).storagePolicy,
                items: command.items.map((item) => ({
                    localId: item.localId,
                    sidechainId: item.sidechainId,
                    messageRole: item.messageRole,
                    content: item.content,
                    ...(item.sourceCreatedAtMs === undefined
                        ? {}
                        : { sourceCreatedAt: new Date(item.sourceCreatedAtMs) }),
                    ...(item.sourceUpdatedAtMs === undefined
                        ? {}
                        : { sourceUpdatedAt: new Date(item.sourceUpdatedAtMs) }),
                })),
            });
            if (!written.ok) {
                return errorResponse(
                    written.error === "stable-item-conflict" ? "batch_conflict" : "invalid_state",
                    `Historical import batch rejected: ${written.error}.`,
                );
            }
            const acceptedThroughServerSeq = Math.max(
                job.acceptedThroughServerSeq ?? 0,
                written.lastSeq ?? 0,
            );
            const insertedMessages = written.messages.filter((message) => (
                message.localId !== null
                && !existingLocalIds.has(message.localId)
            ));
            const insertedMessageIds = job.insertedMessageIds === null
                ? null
                : [
                    ...job.insertedMessageIds,
                    ...insertedMessages.map((message) => message.id),
                ];
            const insertedSequenceSpans = job.insertedSequenceSpans === null
                ? null
                : appendInsertedSequenceSpans(
                    job.insertedSequenceSpans,
                    insertedMessages.map((message) => message.seq),
                );
            job = {
                ...job,
                acceptedThroughServerSeq,
                insertedMessageIds,
                insertedSequenceSpans,
            };
            await writeJobInTx(tx, params.actorUserId, job);
            if (job.priorStorageState === "machine_only") {
                await tx.session.update({
                    where: { id: session.id },
                    data: {
                        currentStorageState: "server_partial",
                        acceptedThroughServerSeq,
                    },
                });
            }
            return {
                v: 1,
                kind: "batch_accepted",
                claim: command.claim,
                revision: job.revision,
                batchId: command.batchId,
                acceptedThroughServerSeq,
            };
        }

        if (command.kind === "finalize") {
            if (job.state === "finalized") {
                return terminalResponse(
                    job,
                    readMaterializationPublication(session),
                )!;
            }
            const acceptedThroughServerSeq = job.acceptedThroughServerSeq ?? 0;
            if (
                job.state !== "importing"
                || command.expectedAcceptedThroughServerSeq !== acceptedThroughServerSeq
            ) {
                return errorResponse("stale_revision", "Historical import accepted ceiling does not match.");
            }
            const publication: ExternalSessionMaterializationPublicationV1 = {
                materializationPublicationId: randomUUID(),
                materializedThroughSourceAt: Date.now(),
                publishedThroughServerSeq: acceptedThroughServerSeq,
            };
            await tx.session.update({
                where: { id: session.id },
                data: {
                    currentStorageState: "snapshot_complete",
                    acceptedThroughServerSeq: null,
                    materializationPublicationId:
                        publication.materializationPublicationId,
                    materializedThroughSourceAt:
                        BigInt(publication.materializedThroughSourceAt),
                    publishedThroughServerSeq: acceptedThroughServerSeq,
                },
            });
            job = {
                ...job,
                state: "finalized",
            };
            await writeJobInTx(tx, params.actorUserId, job);
            return terminalResponse(job, publication)!;
        }

        if (command.kind === "discard") {
            if (job.state === "discarded") {
                return terminalResponse(job, null)!;
            }
            if (
                job.state !== "importing"
                || job.priorStorageState !== "machine_only"
                || (
                    job.insertedMessageIds === null
                    && job.insertedSequenceSpans === null
                )
                || (
                    job.acceptedThroughServerSeq === null
                        ? session.currentStorageState !== "machine_only"
                        : session.currentStorageState !== "server_partial"
                )
                || session.materializationPublicationId !== null
                || session.publishedThroughServerSeq !== null
            ) {
                return errorResponse(
                    "invalid_state",
                    "Historical import lacks exact unpublished discard authority.",
                );
            }
            if (job.insertedMessageIds !== null && job.insertedMessageIds.length > 0) {
                const deleted = await tx.sessionMessage.deleteMany({
                    where: {
                        sessionId: session.id,
                        id: { in: [...job.insertedMessageIds] },
                    },
                });
                if (deleted.count !== job.insertedMessageIds.length) {
                    throw new HistoricalImportDiscardConflictError();
                }
            }
            if (
                job.insertedSequenceSpans !== null
                && job.insertedSequenceSpans.length > 0
            ) {
                const deleted = await tx.sessionMessage.deleteMany({
                    where: {
                        sessionId: session.id,
                        OR: job.insertedSequenceSpans.map((span) => ({
                            seq: {
                                gte: span.firstSeq,
                                lte: span.lastSeq,
                            },
                        })),
                    },
                });
                if (
                    deleted.count
                    !== insertedSequenceSpanRowCount(job.insertedSequenceSpans)
                ) {
                    throw new HistoricalImportDiscardConflictError();
                }
            }
            await tx.session.update({
                where: { id: session.id },
                data: {
                    currentStorageState: "machine_only",
                    acceptedThroughServerSeq: null,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                },
            });
            job = {
                ...job,
                revision: command.expectedRevision,
                acceptedThroughServerSeq: null,
                insertedMessageIds: null,
                insertedSequenceSpans: [],
                state: "discarded",
            };
            await writeJobInTx(tx, params.actorUserId, job);
            return terminalResponse(job, null)!;
        }

        return errorResponse("invalid_state", "Historical import command is invalid.");
        });
    } catch (error) {
        if (error instanceof HistoricalImportDiscardConflictError) {
            return errorResponse("invalid_state", error.message);
        }
        throw error;
    }
}
