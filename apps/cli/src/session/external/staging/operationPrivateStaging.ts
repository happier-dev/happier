import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import {
    resolveExternalSessionOperationStagingDirectory,
} from '@/session/actions/externalSessions/operationRecordStore';
import { normalizeWorkspaceRelativeMediaPath } from '@/session/media/paths';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic as writeJsonAtomicDefault } from '@/utils/fs/writeJsonAtomic';
import { resolveCanonicalAbsoluteChildPathComparisonIdentity } from '@/utils/path/expandHomeDirPath';

export type ExternalSessionStagingJsonPrimitive = string | number | boolean | null;
export type ExternalSessionStagingJsonValue =
    | ExternalSessionStagingJsonPrimitive
    | readonly ExternalSessionStagingJsonValue[]
    | Readonly<{ [key: string]: ExternalSessionStagingJsonValue }>;

export type ExternalSessionStagingSourceCapture = Readonly<{
    sourceIdentity: string;
    sourceGeneration: string;
    revision: string;
    boundary: string;
}>;

export type ExternalSessionStagingSourceObservation =
    | Readonly<{ availability: 'unreachable' }>
    | Readonly<{ availability: 'unknown' }>
    | Readonly<{
        availability: 'reachable';
        sourceIdentity: string;
        sourceGeneration: string;
        revision: string;
        relationshipToCapture: 'same' | 'appended' | 'rewritten' | 'unknown';
        eof: boolean;
    }>;

export type ExternalSessionStagingSourceOutcome =
    | 'same_revision'
    | 'appended_after_boundary'
    | 'deleted_or_unreachable'
    | 'replaced_or_rewritten'
    | 'unknown';

export type ExternalSessionStagingSourceReadState =
    | Readonly<{
        outcome: 'same_revision' | 'appended_after_boundary';
        eof: boolean;
    }>
    | Readonly<{
        outcome: 'deleted_or_unreachable' | 'replaced_or_rewritten' | 'unknown';
        eof: null;
    }>;

export type ExternalSessionOperationPrivateStagingLimits = Readonly<{
    perOperation: Readonly<{
        maxItems: number;
        maxBytes: number;
    }>;
    aggregate: Readonly<{
        maxItems: number;
        maxBytes: number;
    }>;
}>;

type StagingLifecycle =
    | Readonly<{ state: 'active' }>
    | Readonly<{ state: 'paused'; expiresAtMs: number }>
    | Readonly<{ state: 'discard_required' }>;

type StagingPageReservation = Readonly<{
    captureIndex: number;
    replayOrder: number;
    groupId: string;
    itemCount: number;
    serializedBytes: number;
    contentSha256: string;
    sourceState: ExternalSessionStagingSourceReadState;
    sourceRevision?: string;
    preparedReplay?: Readonly<{
        serializedBytes: number;
        contentSha256: string;
    }>;
    state: 'reserved' | 'committed' | 'acknowledged';
    acceptedThroughServerSeq?: number;
}>;

/**
 * Every fact about the captured pages that a lifecycle or capacity decision
 * needs without opening one file per page. It is derived state: every field is
 * a fold of the page reservation rows, maintained by the same locked mutation
 * that writes the row it describes.
 */
type StagingGroupSummary = Readonly<{
    groupCount: number;
    itemCount: number;
    serializedBytes: number;
    acknowledgedGroupCount: number;
    acknowledgedItemCount: number;
    acceptedThroughServerSeq: number | null;
    pendingGroupIds: readonly string[];
}>;

/**
 * The operation-wide staging facts. A capture stores its page reservations one
 * file per page instead of one growing array here, because an accepted import
 * may capture thousands of pages: folding every prior page's metadata into the
 * file each new page rewrites made staging quadratic in the page count, and it
 * held the Account-wide capacity lock while doing it.
 */
type StagingHeader = Readonly<{
    schemaVersion: 1;
    operationId: string;
    capturedSource: ExternalSessionStagingSourceCapture;
    captureState: 'capturing' | 'complete';
    lifecycle: StagingLifecycle;
    summary: StagingGroupSummary;
    createdWorkspaceMedia: readonly ExternalSessionOperationOwnedWorkspaceMediaPath[];
}>;

export type ExternalSessionOperationOwnedWorkspaceMediaPath = Readonly<{
    workingDirectory: string;
    candidateWorkspaceRelativePath: string;
}>;

type StagingPageGroup = Readonly<{
    schemaVersion: 1;
    captureIndex: number;
    groupId: string;
    items: readonly ExternalSessionStagingJsonValue[];
}>;

type StagingPreparedReplayGroup = Readonly<{
    schemaVersion: 1;
    captureIndex: number;
    groupId: string;
    items: readonly ExternalSessionStagingJsonValue[];
}>;

export type ExternalSessionStagingReplayGroup = Readonly<{
    captureIndex: number;
    groupId: string;
    sourceState: ExternalSessionStagingSourceReadState;
    items: readonly ExternalSessionStagingJsonValue[];
    preparedItems?: readonly ExternalSessionStagingJsonValue[];
}>;

export type ExternalSessionStagingReplayState =
    | Readonly<{ status: 'missing' }>
    | Readonly<{
        status: 'capture_incomplete';
        lifecycle: StagingLifecycle['state'];
        acceptedThroughServerSeq: number | null;
        acknowledgedItemCount: number;
    }>
    | Readonly<{
        status: 'incomplete';
        lifecycle: StagingLifecycle['state'];
        pendingGroupIds: readonly string[];
        acceptedThroughServerSeq: number | null;
        acknowledgedItemCount: number;
    }>
    | Readonly<{
        status: 'ready' | 'discard_required';
        lifecycle?: 'active' | 'paused';
        acceptedThroughServerSeq: number | null;
        acknowledgedItemCount: number;
    }>;

export type ExternalSessionOperationPrivateStagingStore = Readonly<{
    beginOperation(input: Readonly<{
        operationId: string;
        representation: 'content' | 'reference_only';
        capturedSource: ExternalSessionStagingSourceCapture;
    }>): Promise<
        | Readonly<{ status: 'ready'; stagingReference: string }>
        | Readonly<{ status: 'refused'; reason: 'reference_only_unavailable' }>
        | Readonly<{ status: 'conflict'; reason: 'captured_source_mismatch' }>
    >;
    readCapturedSource(input: Readonly<{
        operationId: string;
    }>): Promise<
        | Readonly<{ status: 'missing' }>
        | Readonly<{
            status: 'ready';
            capturedSource: ExternalSessionStagingSourceCapture;
        }>
    >;
    readCaptureCheckpoint(input: Readonly<{
        operationId: string;
    }>): Promise<
        | Readonly<{ status: 'missing' }>
        | Readonly<{
            status: 'ready';
            captureState: StagingHeader['captureState'];
            sourcePagesRead: number;
            stagedItemCount: number;
            capturedThroughSourceRevision: string | null;
        }>
    >;
    readReplayState(operationId: string): Promise<ExternalSessionStagingReplayState>;
    streamReplayGroups(operationId: string): AsyncIterable<ExternalSessionStagingReplayGroup>;
    streamAllGroupsForTerminalCleanup(
        operationId: string,
    ): AsyncIterable<ExternalSessionStagingReplayGroup>;
    /**
     * Atomically retain an exact E2EE publication payload before its first server effect.
     * The receipt remains private to this operation staging and is never a second replay owner.
     */
    persistPreparedReplayGroup(input: Readonly<{
        operationId: string;
        captureIndex: number;
        groupId: string;
        items: readonly unknown[];
    }>): Promise<
        | Readonly<{ status: 'stored' | 'already_stored' }>
        | Readonly<{
            status: 'refused';
            reason: 'per_operation_byte_capacity' | 'aggregate_byte_capacity';
        }>
    >;
    /** Remove a definitely-unpublished prepared receipt so the next attempt can prepare afresh. */
    clearPreparedReplayGroup(input: Readonly<{
        operationId: string;
        captureIndex: number;
        groupId: string;
    }>): Promise<void>;
    recordCreatedWorkspaceMedia(input: Readonly<{
        operationId: string;
        media: readonly ExternalSessionOperationOwnedWorkspaceMediaPath[];
    }>): Promise<void>;
    transferDiscardedWorkspaceMediaOwnership(input: Readonly<{
        operationId: string;
        media: readonly ExternalSessionOperationOwnedWorkspaceMediaPath[];
    }>): Promise<void>;
    /**
     * Resolve paths this operation may unlink. An exact receipt also owned by another
     * operation is discharged from this operation and omitted from the result.
     */
    readCreatedWorkspaceMediaForCleanup(input: Readonly<{
        operationId: string;
        media?: readonly ExternalSessionOperationOwnedWorkspaceMediaPath[];
    }>): Promise<readonly ExternalSessionOperationOwnedWorkspaceMediaPath[]>;
    acknowledgeCreatedWorkspaceMediaCleanup(input: Readonly<{
        operationId: string;
        media: readonly ExternalSessionOperationOwnedWorkspaceMediaPath[];
    }>): Promise<void>;
    appendPageGroup(input: Readonly<{
        operationId: string;
        captureIndex: number;
        replayOrder?: number;
        groupId: string;
        items: readonly unknown[];
        sourceRead: ExternalSessionStagingSourceObservation;
    }>): Promise<
        | Readonly<{ status: 'stored' | 'already_stored'; sourceState: ExternalSessionStagingSourceReadState }>
        | Readonly<{
            status: 'refused';
            reason:
                | 'per_operation_item_capacity'
                | 'per_operation_byte_capacity'
                | 'aggregate_item_capacity'
                | 'aggregate_byte_capacity'
                | 'source_state_not_storable';
            sourceState?: ExternalSessionStagingSourceReadState;
        }>
    >;
    completeCapture(input: Readonly<{ operationId: string }>): Promise<void>;
    reopenAcknowledgedCapture(input: Readonly<{ operationId: string }>): Promise<Readonly<{
        nextCaptureIndex: number;
        nextReplayOrder: number;
    }>>;
    rollbackUnacknowledgedCaptureExtension(input: Readonly<{
        operationId: string;
    }>): Promise<void>;
    resetUnpublishedCapture(input: Readonly<{ operationId: string }>): Promise<void>;
    resumeOperation(input: Readonly<{ operationId: string }>): Promise<void>;
    acknowledgeReplayGroup(input: Readonly<{
        operationId: string;
        captureIndex: number;
        groupId: string;
        acceptedThroughServerSeq: number;
    }>): Promise<void>;
    /**
     * Delete fully acknowledged staging, or staging explicitly marked discard-required, only
     * after the canonical operation owner has durably committed its terminal result.
     */
    cleanupTerminalOperation(input: Readonly<{
        operationId: string;
    }>): Promise<
        | Readonly<{ status: 'completed' }>
        | Readonly<{ status: 'missing' }>
        | Readonly<{ status: 'not_ready' }>
    >;
    pauseOperation(input: Readonly<{
        operationId: string;
        expiresAtMs: number;
    }>): Promise<void>;
    markExpiredPausedWorkDiscardRequired(input: Readonly<{
        operationId: string;
        nowMs: number;
    }>): Promise<
        | Readonly<{ status: 'active' }>
        | Readonly<{ status: 'paused'; expiresAtMs: number }>
        | Readonly<{ status: 'discard_required' }>
    >;
}>;

type StagingPaths = Readonly<{
    rootDirectory: string;
    operationDirectory: string;
    manifestPath: string;
    capacityLockPath: string;
}>;

const OPERATION_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/;

class ExternalSessionStagingError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ExternalSessionStagingError';
        this.code = code;
    }
}

function readNonemptyString(value: string, fieldName: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new ExternalSessionStagingError(
            'external_session_staging_invalid_input',
            `External session staging ${fieldName} is required`,
        );
    }
    return normalized;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readNonnegativeSafeInteger(value: number, fieldName: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ExternalSessionStagingError(
            'external_session_staging_invalid_input',
            `External session staging ${fieldName} must be a nonnegative safe integer`,
        );
    }
    return value;
}

function readPositiveSafeInteger(value: number, fieldName: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ExternalSessionStagingError(
            'external_session_staging_invalid_limits',
            `External session staging ${fieldName} must be a positive safe integer`,
        );
    }
    return value;
}

function normalizeJsonValue(
    value: unknown,
    ancestors: ReadonlySet<object> = new Set<object>(),
): ExternalSessionStagingJsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new ExternalSessionStagingError(
                'external_session_staging_invalid_item',
                'External session staging items must contain only finite JSON numbers',
            );
        }
        return value;
    }
    if (typeof value !== 'object') {
        throw new ExternalSessionStagingError(
            'external_session_staging_invalid_item',
            'External session staging items must be strict JSON values',
        );
    }
    if (ancestors.has(value as object)) {
        throw new ExternalSessionStagingError(
            'external_session_staging_invalid_item',
            'External session staging items must not contain cycles',
        );
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value as object);
    if (Array.isArray(value)) {
        return Object.freeze(value.map((entry) => normalizeJsonValue(entry, nextAncestors)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new ExternalSessionStagingError(
            'external_session_staging_invalid_item',
            'External session staging items must be plain JSON objects',
        );
    }
    const normalized: Record<string, ExternalSessionStagingJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
        const entry = (value as Readonly<Record<string, ExternalSessionStagingJsonValue>>)[key];
        if (entry === undefined) {
            throw new ExternalSessionStagingError(
                'external_session_staging_invalid_item',
                'External session staging items must not contain undefined values',
            );
        }
        normalized[key] = normalizeJsonValue(entry, nextAncestors);
    }
    return Object.freeze(normalized);
}

function normalizeSourceCapture(
    source: ExternalSessionStagingSourceCapture,
): ExternalSessionStagingSourceCapture {
    return Object.freeze({
        sourceIdentity: readNonemptyString(source.sourceIdentity, 'sourceIdentity'),
        sourceGeneration: readNonemptyString(source.sourceGeneration, 'sourceGeneration'),
        revision: readNonemptyString(source.revision, 'revision'),
        boundary: readNonemptyString(source.boundary, 'boundary'),
    });
}

function sourceCapturesEqual(
    left: ExternalSessionStagingSourceCapture,
    right: ExternalSessionStagingSourceCapture,
): boolean {
    return left.sourceIdentity === right.sourceIdentity
        && left.sourceGeneration === right.sourceGeneration
        && left.revision === right.revision
        && left.boundary === right.boundary;
}

export function classifyExternalSessionStagingSourceRead(
    capturedSourceInput: ExternalSessionStagingSourceCapture,
    observation: ExternalSessionStagingSourceObservation,
): ExternalSessionStagingSourceReadState {
    const capturedSource = normalizeSourceCapture(capturedSourceInput);
    if (observation.availability === 'unreachable') {
        return Object.freeze({ outcome: 'deleted_or_unreachable', eof: null });
    }
    if (observation.availability === 'unknown') {
        return Object.freeze({ outcome: 'unknown', eof: null });
    }
    const sourceIdentity = readNonemptyString(observation.sourceIdentity, 'sourceIdentity');
    const sourceGeneration = readNonemptyString(observation.sourceGeneration, 'sourceGeneration');
    const revision = readNonemptyString(observation.revision, 'revision');
    if (
        sourceIdentity !== capturedSource.sourceIdentity
        || sourceGeneration !== capturedSource.sourceGeneration
        || observation.relationshipToCapture === 'rewritten'
    ) {
        return Object.freeze({ outcome: 'replaced_or_rewritten', eof: null });
    }
    if (
        observation.relationshipToCapture === 'same'
        && revision === capturedSource.revision
    ) {
        return Object.freeze({ outcome: 'same_revision', eof: observation.eof });
    }
    if (observation.relationshipToCapture === 'appended') {
        return Object.freeze({ outcome: 'appended_after_boundary', eof: observation.eof });
    }
    return Object.freeze({ outcome: 'unknown', eof: null });
}

function createPageGroup(input: Readonly<{
    captureIndex: number;
    groupId: string;
    items: readonly unknown[];
}>): StagingPageGroup {
    return Object.freeze({
        schemaVersion: 1,
        captureIndex: readNonnegativeSafeInteger(input.captureIndex, 'captureIndex'),
        groupId: readNonemptyString(input.groupId, 'groupId'),
        items: Object.freeze(input.items.map((item) => normalizeJsonValue(item))),
    });
}

function serializePageGroup(group: StagingPageGroup): string {
    return JSON.stringify(group, null, 2);
}

function createPreparedReplayGroup(input: Readonly<{
    captureIndex: number;
    groupId: string;
    items: readonly unknown[];
}>): StagingPreparedReplayGroup {
    return Object.freeze({
        schemaVersion: 1,
        captureIndex: readNonnegativeSafeInteger(input.captureIndex, 'captureIndex'),
        groupId: readNonemptyString(input.groupId, 'groupId'),
        items: Object.freeze(input.items.map((item) => normalizeJsonValue(item))),
    });
}

function serializePreparedReplayGroup(group: StagingPreparedReplayGroup): string {
    return JSON.stringify(group, null, 2);
}

export function measureExternalSessionStagingPageGroup(input: Readonly<{
    captureIndex: number;
    groupId: string;
    items: readonly ExternalSessionStagingJsonValue[];
}>): Readonly<{
    itemCount: number;
    serializedBytes: number;
}> {
    const group = createPageGroup(input);
    return Object.freeze({
        itemCount: group.items.length,
        serializedBytes: new TextEncoder().encode(serializePageGroup(group)).byteLength,
    });
}

function stagingPathsInRoot(rootDirectory: string, operationId: string): StagingPaths {
    const operationKey = createHash('sha256').update(operationId, 'utf8').digest('hex');
    const operationDirectory = join(rootDirectory, operationKey);
    return Object.freeze({
        rootDirectory,
        operationDirectory,
        manifestPath: join(operationDirectory, 'manifest.json'),
        capacityLockPath: join(rootDirectory, '.capacity.lock'),
    });
}

/**
 * Staging and its capacity budget are bound to the same Account partition that
 * owns the operation record, so retained work of one Account can never block or
 * be read by another Account on the same daemon.
 *
 * The partition is the operation's captured Account scope: it is resolved once
 * for an operation and reused for every later staging call on it, so staging
 * never re-derives the current Account per page (an import writes thousands of
 * pages). The captured root is released when the operation's staging is removed,
 * and a fresh process resolves every partition again, so the durable contract —
 * where staging lives, who may read it after a restart, and whose aggregate
 * budget it consumes — is Account-partitioned unconditionally. The capture is
 * process-local and deliberately outlives an Account switch for an operation
 * already in flight; reaching staging at all requires the caller to have first
 * resolved that operation's Account-scoped record.
 */
function createStagingPathResolver(activeServerDir: string): Readonly<{
    forOperation(operationId: string): Promise<StagingPaths>;
    release(operationId: string): void;
}> {
    const capturedRootByOperationId = new Map<string, Promise<string>>();
    return Object.freeze({
        async forOperation(operationId: string): Promise<StagingPaths> {
            let capturedRoot = capturedRootByOperationId.get(operationId);
            if (!capturedRoot) {
                capturedRoot = resolveExternalSessionOperationStagingDirectory(
                    activeServerDir,
                    operationId,
                ).then((directory) => resolvePath(directory));
                capturedRootByOperationId.set(operationId, capturedRoot);
            }
            try {
                return stagingPathsInRoot(await capturedRoot, operationId);
            } catch (error) {
                capturedRootByOperationId.delete(operationId);
                throw error;
            }
        },
        release(operationId: string): void {
            capturedRootByOperationId.delete(operationId);
        },
    });
}

function resolvePageGroupPath(operationDirectory: string, captureIndex: number): string {
    return join(operationDirectory, `page-${String(captureIndex).padStart(12, '0')}.json`);
}

function resolvePreparedReplayGroupPath(
    operationDirectory: string,
    captureIndex: number,
): string {
    return join(operationDirectory, `prepared-${String(captureIndex).padStart(12, '0')}.json`);
}

function resolveGroupRowPath(operationDirectory: string, captureIndex: number): string {
    return join(operationDirectory, `group-${String(captureIndex).padStart(12, '0')}.json`);
}

const GROUP_ROW_FILE_NAME_PATTERN = /^group-(\d+)\.json$/;

/**
 * Once a rollback has atomically contracted its header, rows at or above the
 * admitted group count are only unadmitted metadata. Their page and prepared
 * payloads are removed before that header publication, so an explicit retry
 * can finish this low-cost cleanup from the header without another owner or
 * any background sweep.
 */
async function removeUnadmittedGroupRowMetadata(
    operationDirectory: string,
    firstUnadmittedCaptureIndex: number,
): Promise<void> {
    const entries = await readdir(operationDirectory, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = GROUP_ROW_FILE_NAME_PATTERN.exec(entry.name);
        if (!match) continue;
        const captureIndex = Number(match[1]);
        if (
            !Number.isSafeInteger(captureIndex)
            || captureIndex < firstUnadmittedCaptureIndex
        ) {
            continue;
        }
        await rm(join(operationDirectory, entry.name), { force: true });
    }
}

async function tightenPrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(path, 0o700);
    }
}

function parseLifecycle(value: unknown): StagingLifecycle | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.state === 'active' || record.state === 'discard_required') {
        return Object.freeze({ state: record.state });
    }
    if (
        record.state === 'paused'
        && typeof record.expiresAtMs === 'number'
        && Number.isSafeInteger(record.expiresAtMs)
        && record.expiresAtMs >= 0
    ) {
        return Object.freeze({ state: 'paused', expiresAtMs: record.expiresAtMs });
    }
    return null;
}

function parseSourceReadState(value: unknown): ExternalSessionStagingSourceReadState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        (record.outcome === 'same_revision' || record.outcome === 'appended_after_boundary')
        && typeof record.eof === 'boolean'
    ) {
        return Object.freeze({ outcome: record.outcome, eof: record.eof });
    }
    if (
        (
            record.outcome === 'deleted_or_unreachable'
            || record.outcome === 'replaced_or_rewritten'
            || record.outcome === 'unknown'
        )
        && record.eof === null
    ) {
        return Object.freeze({ outcome: record.outcome, eof: null });
    }
    return null;
}

function parseReservation(value: unknown): StagingPageReservation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const sourceState = parseSourceReadState(record.sourceState);
    const preparedReplay = record.preparedReplay === undefined
        ? undefined
        : parsePreparedReplayReservation(record.preparedReplay);
    if (preparedReplay === null) return null;
    const replayOrder = record.replayOrder === undefined
        ? record.captureIndex
        : record.replayOrder;
    if (
        !Number.isSafeInteger(record.captureIndex)
        || (record.captureIndex as number) < 0
        || !Number.isSafeInteger(replayOrder)
        || typeof record.groupId !== 'string'
        || !record.groupId.trim()
        || !Number.isSafeInteger(record.itemCount)
        || (record.itemCount as number) < 0
        || !Number.isSafeInteger(record.serializedBytes)
        || (record.serializedBytes as number) < 0
        || typeof record.contentSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.contentSha256)
        || (
            record.sourceRevision !== undefined
            && (
                typeof record.sourceRevision !== 'string'
                || !record.sourceRevision.trim()
            )
        )
        || (
            record.state !== 'reserved'
            && record.state !== 'committed'
            && record.state !== 'acknowledged'
        )
        || (
            record.state === 'acknowledged'
                ? (
                    !Number.isSafeInteger(record.acceptedThroughServerSeq)
                    || (record.acceptedThroughServerSeq as number) < 0
                )
                : record.acceptedThroughServerSeq !== undefined
        )
        || !sourceState
    ) {
        return null;
    }
    return Object.freeze({
        captureIndex: record.captureIndex as number,
        replayOrder: replayOrder as number,
        groupId: record.groupId,
        itemCount: record.itemCount as number,
        serializedBytes: record.serializedBytes as number,
        contentSha256: record.contentSha256,
        sourceState,
        ...(record.sourceRevision === undefined
            ? {}
            : { sourceRevision: record.sourceRevision as string }),
        ...(preparedReplay === undefined ? {} : { preparedReplay }),
        state: record.state,
        ...(record.state === 'acknowledged'
            ? { acceptedThroughServerSeq: record.acceptedThroughServerSeq as number }
            : {}),
    });
}

function parsePreparedReplayReservation(value: unknown): Readonly<{
    serializedBytes: number;
    contentSha256: string;
}> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        !Number.isSafeInteger(record.serializedBytes)
        || (record.serializedBytes as number) < 0
        || typeof record.contentSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.contentSha256)
    ) {
        return null;
    }
    return Object.freeze({
        serializedBytes: record.serializedBytes as number,
        contentSha256: record.contentSha256,
    });
}

function parseGroupSummary(value: unknown): StagingGroupSummary | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const pendingGroupIds = record.pendingGroupIds;
    if (
        !isNonnegativeSafeInteger(record.groupCount)
        || !isNonnegativeSafeInteger(record.itemCount)
        || !isNonnegativeSafeInteger(record.serializedBytes)
        || !isNonnegativeSafeInteger(record.acknowledgedGroupCount)
        || !isNonnegativeSafeInteger(record.acknowledgedItemCount)
        || (
            record.acceptedThroughServerSeq !== null
            && !isNonnegativeSafeInteger(record.acceptedThroughServerSeq)
        )
        || !Array.isArray(pendingGroupIds)
        || pendingGroupIds.some(
            (groupId) => typeof groupId !== 'string' || !groupId.trim(),
        )
    ) {
        return null;
    }
    return Object.freeze({
        groupCount: record.groupCount as number,
        itemCount: record.itemCount as number,
        serializedBytes: record.serializedBytes as number,
        acknowledgedGroupCount: record.acknowledgedGroupCount as number,
        acknowledgedItemCount: record.acknowledgedItemCount as number,
        acceptedThroughServerSeq: record.acceptedThroughServerSeq as number | null,
        pendingGroupIds: Object.freeze([...pendingGroupIds as string[]]),
    });
}

function parseHeader(value: unknown): StagingHeader | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const lifecycle = parseLifecycle(record.lifecycle);
    const summary = parseGroupSummary(record.summary);
    if (
        record.schemaVersion !== 1
        || typeof record.operationId !== 'string'
        || !record.operationId.trim()
        || (record.captureState !== 'capturing' && record.captureState !== 'complete')
        || !summary
        || !lifecycle
    ) {
        return null;
    }
    let capturedSource: ExternalSessionStagingSourceCapture;
    try {
        capturedSource = normalizeSourceCapture(record.capturedSource as ExternalSessionStagingSourceCapture);
    } catch {
        return null;
    }
    const createdWorkspaceMediaValue = record.createdWorkspaceMedia ?? [];
    if (!Array.isArray(createdWorkspaceMediaValue)) return null;
    const createdWorkspaceMedia: ExternalSessionOperationOwnedWorkspaceMediaPath[] = [];
    for (const value of createdWorkspaceMediaValue) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const media = value as Record<string, unknown>;
        if (
            typeof media.workingDirectory !== 'string'
            || media.workingDirectory.trim().length === 0
            || typeof media.candidateWorkspaceRelativePath !== 'string'
            || media.candidateWorkspaceRelativePath.trim().length === 0
        ) {
            return null;
        }
        createdWorkspaceMedia.push(Object.freeze({
            workingDirectory: media.workingDirectory,
            candidateWorkspaceRelativePath: media.candidateWorkspaceRelativePath,
        }));
    }
    return Object.freeze({
        schemaVersion: 1,
        operationId: record.operationId,
        capturedSource,
        captureState: record.captureState,
        lifecycle,
        summary,
        createdWorkspaceMedia: Object.freeze(createdWorkspaceMedia),
    });
}

function normalizeOwnedWorkspaceMediaPath(
    value: ExternalSessionOperationOwnedWorkspaceMediaPath,
): ExternalSessionOperationOwnedWorkspaceMediaPath {
    return Object.freeze({
        workingDirectory: readNonemptyString(value.workingDirectory, 'workingDirectory'),
        candidateWorkspaceRelativePath: readNonemptyString(
            value.candidateWorkspaceRelativePath,
            'candidateWorkspaceRelativePath',
        ),
    });
}

function ownedWorkspaceMediaPathKey(
    value: ExternalSessionOperationOwnedWorkspaceMediaPath,
): string {
    const relativePath = normalizeWorkspaceRelativeMediaPath(
        value.candidateWorkspaceRelativePath,
    );
    const canonicalIdentity = relativePath === null
        ? null
        : resolveCanonicalAbsoluteChildPathComparisonIdentity(
            value.workingDirectory,
            relativePath,
        );
    return canonicalIdentity === null
        ? JSON.stringify([
            'raw',
            value.workingDirectory,
            value.candidateWorkspaceRelativePath,
        ])
        : JSON.stringify(['canonical', canonicalIdentity]);
}

async function readJsonFileOrNull(path: string): Promise<unknown | undefined> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        return JSON.parse(raw);
    } catch {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging manifest is malformed',
        );
    }
}

async function readHeader(path: string): Promise<StagingHeader | null> {
    const value = await readJsonFileOrNull(path);
    if (value === undefined) return null;
    const header = parseHeader(value);
    if (!header) {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging manifest is invalid',
        );
    }
    return header;
}

/**
 * A page reservation row. It is the durable fact for exactly one captured page
 * and is rewritten only when that page changes state, so an accepted import
 * pays one bounded write per page instead of rewriting every prior page.
 */
async function readGroupRow(
    operationDirectory: string,
    captureIndex: number,
): Promise<StagingPageReservation | null> {
    const value = await readJsonFileOrNull(
        resolveGroupRowPath(operationDirectory, captureIndex),
    );
    if (value === undefined) return null;
    const reservation = parseReservation(value);
    if (!reservation || reservation.captureIndex !== captureIndex) {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging page reservation is invalid',
        );
    }
    return reservation;
}

/**
 * Capture indexes are dense, so the admitted rows are exactly
 * `0..summary.groupCount - 1`. A row file above that bound was written by a
 * reservation whose header update never landed: it was never admitted, and the
 * next append at that index reconciles or replaces it.
 */
async function readAllGroupRows(
    operationDirectory: string,
    summary: StagingGroupSummary,
): Promise<readonly StagingPageReservation[]> {
    const rows: StagingPageReservation[] = [];
    for (let captureIndex = 0; captureIndex < summary.groupCount; captureIndex += 1) {
        const row = await readGroupRow(operationDirectory, captureIndex);
        if (!row) {
            throw new ExternalSessionStagingError(
                'external_session_staging_corrupt',
                'External session staging page reservation is missing',
            );
        }
        rows.push(row);
    }
    if (new Set(rows.map((row) => row.groupId)).size !== rows.length) {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging page reservations repeat a group id',
        );
    }
    return Object.freeze(rows);
}

const EMPTY_STAGING_GROUP_SUMMARY: StagingGroupSummary = Object.freeze({
    groupCount: 0,
    itemCount: 0,
    serializedBytes: 0,
    acknowledgedGroupCount: 0,
    acknowledgedItemCount: 0,
    acceptedThroughServerSeq: null,
    pendingGroupIds: Object.freeze([]),
});

function reservationSerializedBytes(row: StagingPageReservation): number {
    return row.serializedBytes + (row.preparedReplay?.serializedBytes ?? 0);
}

/**
 * The one place a summary is derived from rows. Incremental maintenance and
 * whole-capture recomputation both go through it, so the two can never disagree
 * about what a captured page contributes.
 */
function summaryWithRowTransition(
    summary: StagingGroupSummary,
    previous: StagingPageReservation | null,
    next: StagingPageReservation | null,
): StagingGroupSummary {
    const pendingGroupIds = summary.pendingGroupIds.filter(
        (groupId) => groupId !== (next ?? previous)?.groupId,
    );
    if (next?.state === 'reserved') pendingGroupIds.push(next.groupId);
    const acknowledgedCheckpoint = next?.state === 'acknowledged'
        && next.itemCount > 0
        && next.acceptedThroughServerSeq !== undefined
        ? next.acceptedThroughServerSeq
        : null;
    return Object.freeze({
        groupCount: summary.groupCount
            - (previous ? 1 : 0)
            + (next ? 1 : 0),
        itemCount: summary.itemCount
            - (previous?.itemCount ?? 0)
            + (next?.itemCount ?? 0),
        serializedBytes: summary.serializedBytes
            - (previous ? reservationSerializedBytes(previous) : 0)
            + (next ? reservationSerializedBytes(next) : 0),
        acknowledgedGroupCount: summary.acknowledgedGroupCount
            - (previous?.state === 'acknowledged' ? 1 : 0)
            + (next?.state === 'acknowledged' ? 1 : 0),
        acknowledgedItemCount: summary.acknowledgedItemCount
            - (previous?.state === 'acknowledged' ? previous.itemCount : 0)
            + (next?.state === 'acknowledged' ? next.itemCount : 0),
        acceptedThroughServerSeq: acknowledgedCheckpoint !== null
            && (
                summary.acceptedThroughServerSeq === null
                || acknowledgedCheckpoint > summary.acceptedThroughServerSeq
            )
            ? acknowledgedCheckpoint
            : summary.acceptedThroughServerSeq,
        pendingGroupIds: Object.freeze(pendingGroupIds),
    });
}

function summarizeGroupRows(
    rows: readonly StagingPageReservation[],
): StagingGroupSummary {
    return rows.reduce(
        (summary, row) => summaryWithRowTransition(summary, null, row),
        EMPTY_STAGING_GROUP_SUMMARY,
    );
}

function stagingSummariesMatch(
    left: StagingGroupSummary,
    right: StagingGroupSummary,
): boolean {
    return left.groupCount === right.groupCount
        && left.itemCount === right.itemCount
        && left.serializedBytes === right.serializedBytes
        && left.acknowledgedGroupCount === right.acknowledgedGroupCount
        && left.acknowledgedItemCount === right.acknowledgedItemCount
        && left.acceptedThroughServerSeq === right.acceptedThroughServerSeq
        && left.pendingGroupIds.length === right.pendingGroupIds.length
        && left.pendingGroupIds.every((groupId, index) => groupId === right.pendingGroupIds[index]);
}

/**
 * Group rows are the durable facts; the header summary is their repairable
 * fold. This is deliberately called only while the existing operation lock is
 * held, on recovery and terminal paths rather than on ordinary page reads.
 */
async function repairHeaderSummaryFromGroupRows(
    paths: StagingPaths,
    header: StagingHeader,
    atomicWrite: (path: string, value: unknown) => Promise<void>,
): Promise<StagingHeader> {
    const summary = summarizeGroupRows(
        await readAllGroupRows(paths.operationDirectory, header.summary),
    );
    if (stagingSummariesMatch(header.summary, summary)) return header;
    const repaired = Object.freeze({ ...header, summary });
    await atomicWrite(paths.manifestPath, repaired);
    return repaired;
}

/**
 * Replay addresses a group by its capture index and carries the group id it was
 * served with. Reading the row that index names and requiring the id to match
 * keeps the id an exact integrity check rather than a whole-capture search key.
 */
async function readAddressedGroupRow(
    operationDirectory: string,
    summary: StagingGroupSummary,
    captureIndex: number,
    groupId: string,
): Promise<StagingPageReservation | null> {
    if (
        !Number.isSafeInteger(captureIndex)
        || captureIndex < 0
        || captureIndex >= summary.groupCount
    ) {
        return null;
    }
    const row = await readGroupRow(operationDirectory, captureIndex);
    return row?.groupId === groupId ? row : null;
}

function parsePageGroup(value: unknown): StagingPageGroup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        record.schemaVersion !== 1
        || !Number.isSafeInteger(record.captureIndex)
        || (record.captureIndex as number) < 0
        || typeof record.groupId !== 'string'
        || !record.groupId.trim()
        || !Array.isArray(record.items)
    ) {
        return null;
    }
    try {
        return createPageGroup({
            captureIndex: record.captureIndex as number,
            groupId: record.groupId,
            items: record.items as ExternalSessionStagingJsonValue[],
        });
    } catch {
        return null;
    }
}

async function readPageGroup(path: string): Promise<StagingPageGroup> {
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, 'utf8'));
    } catch {
        throw new ExternalSessionStagingError(
            'external_session_staging_incomplete',
            'External session staging page is unavailable',
        );
    }
    const page = parsePageGroup(value);
    if (!page) {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging page is invalid',
        );
    }
    return page;
}

function parsePreparedReplayGroup(value: unknown): StagingPreparedReplayGroup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        record.schemaVersion !== 1
        || !Number.isSafeInteger(record.captureIndex)
        || (record.captureIndex as number) < 0
        || typeof record.groupId !== 'string'
        || !record.groupId.trim()
        || !Array.isArray(record.items)
    ) {
        return null;
    }
    try {
        return createPreparedReplayGroup({
            captureIndex: record.captureIndex as number,
            groupId: record.groupId,
            items: record.items as ExternalSessionStagingJsonValue[],
        });
    } catch {
        return null;
    }
}

async function readPreparedReplayGroup(path: string): Promise<StagingPreparedReplayGroup> {
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, 'utf8'));
    } catch {
        throw new ExternalSessionStagingError(
            'external_session_staging_prepared_replay_unavailable',
            'External session staging prepared replay is unavailable',
        );
    }
    const prepared = parsePreparedReplayGroup(value);
    if (!prepared) {
        throw new ExternalSessionStagingError(
            'external_session_staging_prepared_replay_corrupt',
            'External session staging prepared replay is invalid',
        );
    }
    return prepared;
}

function sumReservations(headers: readonly StagingHeader[]): Readonly<{
    itemCount: number;
    serializedBytes: number;
}> {
    let itemCount = 0;
    let serializedBytes = 0;
    for (const header of headers) {
        itemCount += header.summary.itemCount;
        serializedBytes += header.summary.serializedBytes;
    }
    return Object.freeze({ itemCount, serializedBytes });
}

function projectReplayState(
    header: StagingHeader | null,
    operationId: string,
): ExternalSessionStagingReplayState {
    if (!header || header.operationId !== operationId) {
        return Object.freeze({ status: 'missing' as const });
    }
    const acceptedThroughServerSeq = header.summary.acceptedThroughServerSeq;
    const acknowledgedItemCount = header.summary.acknowledgedItemCount;
    if (
        header.captureState !== 'complete'
        && header.lifecycle.state !== 'discard_required'
    ) {
        return Object.freeze({
            status: 'capture_incomplete' as const,
            lifecycle: header.lifecycle.state,
            acceptedThroughServerSeq,
            acknowledgedItemCount,
        });
    }
    if (header.summary.pendingGroupIds.length > 0) {
        return Object.freeze({
            status: 'incomplete' as const,
            lifecycle: header.lifecycle.state,
            pendingGroupIds: header.summary.pendingGroupIds,
            acceptedThroughServerSeq,
            acknowledgedItemCount,
        });
    }
    if (header.lifecycle.state === 'discard_required') {
        return Object.freeze({
            status: 'discard_required' as const,
            acceptedThroughServerSeq,
            acknowledgedItemCount,
        });
    }
    return Object.freeze({
        status: 'ready' as const,
        lifecycle: header.lifecycle.state,
        acceptedThroughServerSeq,
        acknowledgedItemCount,
    });
}

/**
 * Aggregate admission reads one bounded header per operation. It never opens a
 * page reservation row, so an Account holding many large captures still costs
 * one small read per operation.
 */
async function readAllHeaders(rootDirectory: string): Promise<readonly StagingHeader[]> {
    let entries;
    try {
        entries = await readdir(rootDirectory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
        throw error;
    }
    const headers: StagingHeader[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !OPERATION_DIRECTORY_PATTERN.test(entry.name)) continue;
        const header = await readHeader(join(rootDirectory, entry.name, 'manifest.json'));
        if (header) headers.push(header);
    }
    return Object.freeze(headers);
}

function assertOperationLifecycleAcceptsPage(manifest: StagingHeader): void {
    if (manifest.lifecycle.state !== 'active') {
        throw new ExternalSessionStagingError(
            'external_session_staging_not_active',
            'External session staging accepts pages only while active',
        );
    }
}

function assertMatchingReservedGroup(
    reservation: StagingPageReservation,
    page: StagingPageGroup,
    serializedBytes: number,
    contentSha256: string,
    sourceState: ExternalSessionStagingSourceReadState,
    sourceRevision: string | undefined,
    replayOrder: number,
): void {
    if (
        reservation.captureIndex !== page.captureIndex
        || reservation.replayOrder !== replayOrder
        || reservation.groupId !== page.groupId
        || reservation.itemCount !== page.items.length
        || reservation.serializedBytes !== serializedBytes
        || reservation.contentSha256 !== contentSha256
        || JSON.stringify(reservation.sourceState) !== JSON.stringify(sourceState)
        || (
            reservation.sourceRevision !== undefined
            && reservation.sourceRevision !== sourceRevision
        )
    ) {
        throw new ExternalSessionStagingError(
            'external_session_staging_page_conflict',
            'External session staging page retry does not match its reservation',
        );
    }
}

function assertMatchingPreparedReplayGroup(
    reservation: StagingPageReservation,
    prepared: StagingPreparedReplayGroup,
    serializedBytes: number,
    contentSha256: string,
): void {
    if (
        !reservation.preparedReplay
        || reservation.captureIndex !== prepared.captureIndex
        || reservation.groupId !== prepared.groupId
        || reservation.itemCount !== prepared.items.length
        || reservation.preparedReplay.serializedBytes !== serializedBytes
        || reservation.preparedReplay.contentSha256 !== contentSha256
    ) {
        throw new ExternalSessionStagingError(
            'external_session_staging_prepared_replay_conflict',
            'External session staging prepared replay does not match its reservation',
        );
    }
}

export function createExternalSessionOperationPrivateStagingStore(input: Readonly<{
    activeServerDir: string;
    limits: ExternalSessionOperationPrivateStagingLimits;
    persistence?: Readonly<{
        writeJsonAtomic(path: string, value: unknown): Promise<void>;
    }>;
}>): ExternalSessionOperationPrivateStagingStore {
    const activeServerDir = readNonemptyString(input.activeServerDir, 'activeServerDir');
    const limits = Object.freeze({
        perOperation: Object.freeze({
            maxItems: readPositiveSafeInteger(input.limits.perOperation.maxItems, 'perOperation.maxItems'),
            maxBytes: readPositiveSafeInteger(input.limits.perOperation.maxBytes, 'perOperation.maxBytes'),
        }),
        aggregate: Object.freeze({
            maxItems: readPositiveSafeInteger(input.limits.aggregate.maxItems, 'aggregate.maxItems'),
            maxBytes: readPositiveSafeInteger(input.limits.aggregate.maxBytes, 'aggregate.maxBytes'),
        }),
    });
    const atomicWrite = input.persistence?.writeJsonAtomic ?? writeJsonAtomicDefault;
    const stagingPaths = createStagingPathResolver(activeServerDir);
    const resolveStagingPaths = async (
        operationId: string,
    ): Promise<StagingPaths> => await stagingPaths.forOperation(operationId);

    const withCapacityLock = async <T>(
        operationId: string,
        effect: (paths: StagingPaths) => Promise<T>,
    ): Promise<T> => {
        const paths = await resolveStagingPaths(operationId);
        await tightenPrivateDirectory(paths.rootDirectory);
        return await withJsonOwnerFileLock({
            lockPath: paths.capacityLockPath,
            timeoutMs: 5_000,
            staleAfterMs: 30_000,
            pollIntervalMs: 5,
            errorCode: 'external_session_staging_capacity_lock_timeout',
        }, async () => await effect(paths));
    };

    return Object.freeze({
        async beginOperation(beginInput) {
            const operationId = readNonemptyString(beginInput.operationId, 'operationId');
            if (beginInput.representation === 'reference_only') {
                return Object.freeze({
                    status: 'refused' as const,
                    reason: 'reference_only_unavailable' as const,
                });
            }
            const capturedSource = normalizeSourceCapture(beginInput.capturedSource);
            return await withCapacityLock(operationId, async (paths) => {
                const current = await readHeader(paths.manifestPath);
                if (current) {
                    if (
                        current.operationId !== operationId
                        || !sourceCapturesEqual(current.capturedSource, capturedSource)
                    ) {
                        return Object.freeze({
                            status: 'conflict' as const,
                            reason: 'captured_source_mismatch' as const,
                        });
                    }
                    return Object.freeze({
                        status: 'ready' as const,
                        stagingReference: `external-session-operation-staging-v1:${createHash('sha256').update(operationId, 'utf8').digest('hex')}`,
                    });
                }
                await tightenPrivateDirectory(paths.operationDirectory);
                const manifest: StagingHeader = Object.freeze({
                    schemaVersion: 1,
                    operationId,
                    capturedSource,
                    captureState: 'capturing',
                    lifecycle: Object.freeze({ state: 'active' }),
                    summary: EMPTY_STAGING_GROUP_SUMMARY,
                    createdWorkspaceMedia: Object.freeze([]),
                });
                await atomicWrite(paths.manifestPath, manifest);
                return Object.freeze({
                    status: 'ready' as const,
                    stagingReference: `external-session-operation-staging-v1:${createHash('sha256').update(operationId, 'utf8').digest('hex')}`,
                });
            });
        },

        async readCapturedSource(readInput) {
            const operationId = readNonemptyString(readInput.operationId, 'operationId');
            const paths = await resolveStagingPaths(operationId);
            const manifest = await readHeader(paths.manifestPath);
            if (!manifest || manifest.operationId !== operationId) {
                return Object.freeze({ status: 'missing' as const });
            }
            return Object.freeze({
                status: 'ready' as const,
                capturedSource: manifest.capturedSource,
            });
        },

        async readCaptureCheckpoint(readInput) {
            const operationId = readNonemptyString(readInput.operationId, 'operationId');
            const paths = await resolveStagingPaths(operationId);
            const manifest = await readHeader(paths.manifestPath);
            if (!manifest || manifest.operationId !== operationId) {
                return Object.freeze({ status: 'missing' as const });
            }
            // Only the newest captured page carries the revision the capture
            // reached, so this reads exactly that row rather than the corpus.
            const lastCapturedPage = manifest.summary.groupCount === 0
                ? null
                : await readGroupRow(
                    paths.operationDirectory,
                    manifest.summary.groupCount - 1,
                );
            return Object.freeze({
                status: 'ready' as const,
                captureState: manifest.captureState,
                sourcePagesRead: manifest.summary.groupCount,
                stagedItemCount: manifest.summary.itemCount,
                capturedThroughSourceRevision:
                    lastCapturedPage?.sourceRevision
                    ?? (
                        lastCapturedPage?.sourceState.outcome === 'same_revision'
                            ? manifest.capturedSource.revision
                            : null
                    ),
            });
        },

        async appendPageGroup(appendInput) {
            const operationId = readNonemptyString(appendInput.operationId, 'operationId');
            const page = createPageGroup(appendInput);
            const serializedBytes = new TextEncoder().encode(serializePageGroup(page)).byteLength;
            const contentSha256 = createHash('sha256')
                .update(JSON.stringify(page), 'utf8')
                .digest('hex');
            const replayOrder = appendInput.replayOrder ?? page.captureIndex;
            if (!Number.isSafeInteger(replayOrder)) {
                throw new ExternalSessionStagingError(
                    'external_session_staging_invalid_input',
                    'External session staging replayOrder must be a safe integer',
                );
            }
            return await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                assertOperationLifecycleAcceptsPage(manifest);
                if (manifest.captureState !== 'capturing') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_complete',
                        'External session staging capture is already complete',
                    );
                }
                const sourceState = classifyExternalSessionStagingSourceRead(
                    manifest.capturedSource,
                    appendInput.sourceRead,
                );
                if (
                    sourceState.outcome !== 'same_revision'
                    && sourceState.outcome !== 'appended_after_boundary'
                ) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'source_state_not_storable' as const,
                        sourceState,
                    });
                }
                const sourceRevision = appendInput.sourceRead.availability === 'reachable'
                    ? readNonemptyString(appendInput.sourceRead.revision, 'sourceRead.revision')
                    : undefined;

                // Capture indexes are dense and only the tail is ever appended,
                // so the retried page is the row at its own index. Reading that
                // one row is what replaces scanning every prior reservation.
                const existing = await readGroupRow(
                    paths.operationDirectory,
                    page.captureIndex,
                );
                const commitReservedRow = async (
                    reservation: StagingPageReservation,
                    summary: StagingGroupSummary,
                ): Promise<void> => {
                    await atomicWrite(
                        resolvePageGroupPath(paths.operationDirectory, page.captureIndex),
                        page,
                    );
                    const committed = Object.freeze({
                        ...reservation,
                        state: 'committed' as const,
                    });
                    await atomicWrite(
                        resolveGroupRowPath(paths.operationDirectory, page.captureIndex),
                        committed,
                    );
                    await atomicWrite(paths.manifestPath, Object.freeze({
                        ...manifest,
                        summary: summaryWithRowTransition(summary, reservation, committed),
                    }));
                };
                if (existing && page.captureIndex < manifest.summary.groupCount) {
                    assertMatchingReservedGroup(
                        existing,
                        page,
                        serializedBytes,
                        contentSha256,
                        sourceState,
                        sourceRevision,
                        replayOrder,
                    );
                    if (existing.state === 'committed') {
                        // The row is published before the header that folds it,
                        // so losing that header write leaves this page durable
                        // while the header still lists it pending and refuses
                        // to complete the capture. The pending entry names the
                        // fold that was lost, so the resumed capture that lands
                        // here republishes exactly it.
                        if (manifest.summary.pendingGroupIds.includes(existing.groupId)) {
                            await atomicWrite(paths.manifestPath, Object.freeze({
                                ...manifest,
                                summary: summaryWithRowTransition(
                                    manifest.summary,
                                    Object.freeze({ ...existing, state: 'reserved' as const }),
                                    existing,
                                ),
                            }));
                        }
                        return Object.freeze({
                            status: 'already_stored' as const,
                            sourceState,
                        });
                    }
                    await commitReservedRow(existing, manifest.summary);
                    return Object.freeze({ status: 'stored' as const, sourceState });
                }
                if (page.captureIndex !== manifest.summary.groupCount) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_order',
                        'External session staging pages must be captured newest-first without gaps',
                    );
                }

                const operationTotals = sumReservations([manifest]);
                if (operationTotals.itemCount + page.items.length > limits.perOperation.maxItems) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'per_operation_item_capacity' as const,
                    });
                }
                if (operationTotals.serializedBytes + serializedBytes > limits.perOperation.maxBytes) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'per_operation_byte_capacity' as const,
                    });
                }
                const aggregateTotals = sumReservations(await readAllHeaders(paths.rootDirectory));
                if (aggregateTotals.itemCount + page.items.length > limits.aggregate.maxItems) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'aggregate_item_capacity' as const,
                    });
                }
                if (aggregateTotals.serializedBytes + serializedBytes > limits.aggregate.maxBytes) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'aggregate_byte_capacity' as const,
                    });
                }

                const reservation: StagingPageReservation = Object.freeze({
                    captureIndex: page.captureIndex,
                    replayOrder,
                    groupId: page.groupId,
                    itemCount: page.items.length,
                    serializedBytes,
                    contentSha256,
                    sourceState,
                    sourceRevision,
                    state: 'reserved',
                });
                // The row is the fact and the summary is its fold, so the row is
                // published first: a crash between the two leaves an unadmitted
                // row that the retry at this index reconciles against, exactly
                // as the reserved manifest row used to.
                await atomicWrite(
                    resolveGroupRowPath(paths.operationDirectory, page.captureIndex),
                    reservation,
                );
                const reservedSummary = summaryWithRowTransition(
                    manifest.summary,
                    null,
                    reservation,
                );
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    summary: reservedSummary,
                }));
                await commitReservedRow(reservation, reservedSummary);
                return Object.freeze({ status: 'stored' as const, sourceState });
            });
        },

        async readReplayState(operationIdInput) {
            const operationId = readNonemptyString(operationIdInput, 'operationId');
            return await withCapacityLock(operationId, async (paths) => {
                const header = await readHeader(paths.manifestPath);
                if (!header || header.operationId !== operationId) {
                    return projectReplayState(header, operationId);
                }
                return projectReplayState(
                    await repairHeaderSummaryFromGroupRows(paths, header, atomicWrite),
                    operationId,
                );
            });
        },

        async *streamReplayGroups(operationIdInput) {
            const operationId = readNonemptyString(operationIdInput, 'operationId');
            const paths = await resolveStagingPaths(operationId);
            const manifest = await readHeader(paths.manifestPath);
            const state = projectReplayState(manifest, operationId);
            if (state.status === 'missing') {
                throw new ExternalSessionStagingError(
                    'external_session_staging_not_found',
                    'External session staging operation was not begun',
                );
            }
            if (state.status === 'capture_incomplete' || state.status === 'incomplete') {
                throw new ExternalSessionStagingError(
                    'external_session_staging_incomplete',
                    'External session staging is not ready for replay',
                );
            }
            const readyManifest = manifest as StagingHeader;
            const groups = await readAllGroupRows(
                paths.operationDirectory,
                readyManifest.summary,
            );
            for (const reservation of groups
                .filter((group) => group.state === 'committed')
                .sort((left, right) => right.replayOrder - left.replayOrder)) {
                const page = await readPageGroup(
                    resolvePageGroupPath(paths.operationDirectory, reservation.captureIndex),
                );
                const serializedBytes = new TextEncoder().encode(serializePageGroup(page)).byteLength;
                const contentSha256 = createHash('sha256')
                    .update(JSON.stringify(page), 'utf8')
                    .digest('hex');
                assertMatchingReservedGroup(
                    reservation,
                    page,
                    serializedBytes,
                    contentSha256,
                    reservation.sourceState,
                    reservation.sourceRevision,
                    reservation.replayOrder,
                );
                const preparedItems = reservation.preparedReplay
                    ? await (async () => {
                        const prepared = await readPreparedReplayGroup(
                            resolvePreparedReplayGroupPath(
                                paths.operationDirectory,
                                reservation.captureIndex,
                            ),
                        );
                        const preparedSerializedBytes = new TextEncoder().encode(
                            serializePreparedReplayGroup(prepared),
                        ).byteLength;
                        const preparedContentSha256 = createHash('sha256')
                            .update(JSON.stringify(prepared), 'utf8')
                            .digest('hex');
                        assertMatchingPreparedReplayGroup(
                            reservation,
                            prepared,
                            preparedSerializedBytes,
                            preparedContentSha256,
                        );
                        return prepared.items;
                    })()
                    : undefined;
                yield Object.freeze({
                    captureIndex: page.captureIndex,
                    groupId: page.groupId,
                    sourceState: reservation.sourceState,
                    items: page.items,
                    ...(preparedItems === undefined ? {} : { preparedItems }),
                });
            }
        },

        async persistPreparedReplayGroup(persistInput) {
            const operationId = readNonemptyString(persistInput.operationId, 'operationId');
            const groupId = readNonemptyString(persistInput.groupId, 'groupId');
            return await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                assertOperationLifecycleAcceptsPage(manifest);
                if (manifest.captureState !== 'complete') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_incomplete',
                        'External session staging cannot retain prepared replay before capture completes',
                    );
                }
                const reservation = await readAddressedGroupRow(
                    paths.operationDirectory,
                    manifest.summary,
                    persistInput.captureIndex,
                    groupId,
                );
                if (!reservation || reservation.state !== 'committed') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_group_not_ready',
                        'External session staging replay group is not ready for prepared replay',
                    );
                }
                const page = await readPageGroup(
                    resolvePageGroupPath(paths.operationDirectory, reservation.captureIndex),
                );
                const pageSerializedBytes = new TextEncoder().encode(serializePageGroup(page)).byteLength;
                const pageContentSha256 = createHash('sha256')
                    .update(JSON.stringify(page), 'utf8')
                    .digest('hex');
                assertMatchingReservedGroup(
                    reservation,
                    page,
                    pageSerializedBytes,
                    pageContentSha256,
                    reservation.sourceState,
                    reservation.sourceRevision,
                    reservation.replayOrder,
                );
                const prepared = createPreparedReplayGroup({
                    captureIndex: reservation.captureIndex,
                    groupId,
                    items: persistInput.items,
                });
                if (prepared.items.length !== reservation.itemCount) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_prepared_replay_conflict',
                        'External session staging prepared replay item count does not match its page',
                    );
                }
                const serializedBytes = new TextEncoder().encode(
                    serializePreparedReplayGroup(prepared),
                ).byteLength;
                const contentSha256 = createHash('sha256')
                    .update(JSON.stringify(prepared), 'utf8')
                    .digest('hex');
                if (reservation.preparedReplay) {
                    const existing = await readPreparedReplayGroup(
                        resolvePreparedReplayGroupPath(
                            paths.operationDirectory,
                            reservation.captureIndex,
                        ),
                    );
                    const existingSerializedBytes = new TextEncoder().encode(
                        serializePreparedReplayGroup(existing),
                    ).byteLength;
                    const existingContentSha256 = createHash('sha256')
                        .update(JSON.stringify(existing), 'utf8')
                        .digest('hex');
                    assertMatchingPreparedReplayGroup(
                        reservation,
                        existing,
                        existingSerializedBytes,
                        existingContentSha256,
                    );
                    if (
                        existingSerializedBytes !== serializedBytes
                        || existingContentSha256 !== contentSha256
                    ) {
                        throw new ExternalSessionStagingError(
                            'external_session_staging_prepared_replay_conflict',
                            'External session staging prepared replay conflicts with its existing receipt',
                        );
                    }
                    return Object.freeze({ status: 'already_stored' as const });
                }

                const operationTotals = sumReservations([manifest]);
                if (operationTotals.serializedBytes + serializedBytes > limits.perOperation.maxBytes) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'per_operation_byte_capacity' as const,
                    });
                }
                const aggregateTotals = sumReservations(await readAllHeaders(paths.rootDirectory));
                if (aggregateTotals.serializedBytes + serializedBytes > limits.aggregate.maxBytes) {
                    return Object.freeze({
                        status: 'refused' as const,
                        reason: 'aggregate_byte_capacity' as const,
                    });
                }

                await atomicWrite(
                    resolvePreparedReplayGroupPath(paths.operationDirectory, reservation.captureIndex),
                    prepared,
                );
                const retained = Object.freeze({
                    ...reservation,
                    preparedReplay: Object.freeze({ serializedBytes, contentSha256 }),
                });
                await atomicWrite(
                    resolveGroupRowPath(paths.operationDirectory, reservation.captureIndex),
                    retained,
                );
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    summary: summaryWithRowTransition(
                        manifest.summary,
                        reservation,
                        retained,
                    ),
                }));
                return Object.freeze({ status: 'stored' as const });
            });
        },

        async clearPreparedReplayGroup(clearInput) {
            const operationId = readNonemptyString(clearInput.operationId, 'operationId');
            const groupId = readNonemptyString(clearInput.groupId, 'groupId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return;
                const reservation = await readAddressedGroupRow(
                    paths.operationDirectory,
                    manifest.summary,
                    clearInput.captureIndex,
                    groupId,
                );
                if (!reservation?.preparedReplay) return;
                const {
                    preparedReplay: _preparedReplay,
                    ...withoutPreparedReplay
                } = reservation;
                const cleared = Object.freeze(withoutPreparedReplay);
                await atomicWrite(
                    resolveGroupRowPath(paths.operationDirectory, reservation.captureIndex),
                    cleared,
                );
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    summary: summaryWithRowTransition(
                        manifest.summary,
                        reservation,
                        cleared,
                    ),
                }));
                await rm(
                    resolvePreparedReplayGroupPath(paths.operationDirectory, reservation.captureIndex),
                    { force: true },
                );
            });
        },

        async *streamAllGroupsForTerminalCleanup(operationIdInput) {
            const operationId = readNonemptyString(operationIdInput, 'operationId');
            const paths = await resolveStagingPaths(operationId);
            const manifest = await readHeader(paths.manifestPath);
            const state = projectReplayState(manifest, operationId);
            if (state.status !== 'discard_required' || !manifest) {
                throw new ExternalSessionStagingError(
                    'external_session_staging_not_discard_ready',
                    'External session staging is not ready for terminal cleanup',
                );
            }
            const groups = await readAllGroupRows(
                paths.operationDirectory,
                manifest.summary,
            );
            for (const reservation of groups
                .filter((group) => group.state === 'committed' || group.state === 'acknowledged')
                .sort((left, right) => right.replayOrder - left.replayOrder)) {
                const page = await readPageGroup(
                    resolvePageGroupPath(paths.operationDirectory, reservation.captureIndex),
                );
                const serializedBytes = new TextEncoder().encode(serializePageGroup(page)).byteLength;
                const contentSha256 = createHash('sha256')
                    .update(JSON.stringify(page), 'utf8')
                    .digest('hex');
                assertMatchingReservedGroup(
                    reservation,
                    page,
                    serializedBytes,
                    contentSha256,
                    reservation.sourceState,
                    reservation.sourceRevision,
                    reservation.replayOrder,
                );
                yield Object.freeze({
                    captureIndex: page.captureIndex,
                    groupId: page.groupId,
                    sourceState: reservation.sourceState,
                    items: page.items,
                });
            }
        },

        async recordCreatedWorkspaceMedia(recordInput) {
            const operationId = readNonemptyString(recordInput.operationId, 'operationId');
            const media = recordInput.media.map(normalizeOwnedWorkspaceMediaPath);
            if (media.length === 0) return;
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                const existingKeys = new Set(
                    manifest.createdWorkspaceMedia.map(ownedWorkspaceMediaPathKey),
                );
                const additions = media.filter((entry) => {
                    const key = ownedWorkspaceMediaPathKey(entry);
                    if (existingKeys.has(key)) return false;
                    existingKeys.add(key);
                    return true;
                });
                if (additions.length === 0) return;
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    createdWorkspaceMedia: Object.freeze([
                        ...manifest.createdWorkspaceMedia,
                        ...additions,
                    ]),
                }));
            });
        },

        async transferDiscardedWorkspaceMediaOwnership(transferInput) {
            const operationId = readNonemptyString(transferInput.operationId, 'operationId');
            const media = transferInput.media.map(normalizeOwnedWorkspaceMediaPath);
            if (media.length === 0) return;
            await withCapacityLock(operationId, async (paths) => {
                const current = await readHeader(paths.manifestPath);
                if (!current || current.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                if (current.lifecycle.state !== 'active') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_active',
                        'External session staging can receive media ownership only while active',
                    );
                }

                const manifests = await readAllHeaders(paths.rootDirectory);
                const requestedByKey = new Map(
                    media.map((entry) => [ownedWorkspaceMediaPathKey(entry), entry]),
                );
                const transferableKeys = new Set<string>();
                for (const key of requestedByKey.keys()) {
                    const foreignOwners = manifests.filter((manifest) => (
                        manifest.operationId !== operationId
                        && manifest.createdWorkspaceMedia.some(
                            (entry) => ownedWorkspaceMediaPathKey(entry) === key,
                        )
                    ));
                    if (
                        foreignOwners.length > 0
                        && foreignOwners.every(
                            (manifest) => manifest.lifecycle.state === 'discard_required',
                        )
                    ) {
                        transferableKeys.add(key);
                    }
                }
                if (transferableKeys.size === 0) return;

                const existingKeys = new Set(
                    current.createdWorkspaceMedia.map(ownedWorkspaceMediaPathKey),
                );
                const additions = [...transferableKeys]
                    .filter((key) => !existingKeys.has(key))
                    .map((key) => requestedByKey.get(key)!);
                if (additions.length > 0) {
                    await atomicWrite(paths.manifestPath, Object.freeze({
                        ...current,
                        createdWorkspaceMedia: Object.freeze([
                            ...current.createdWorkspaceMedia,
                            ...additions,
                        ]),
                    }));
                }

                // Publish successor authority before removing discarded predecessors. If a
                // crash leaves duplicates, cleanup discharges one duplicate without unlinking.
                for (const manifest of manifests) {
                    if (
                        manifest.operationId === operationId
                        || manifest.lifecycle.state !== 'discard_required'
                    ) {
                        continue;
                    }
                    const nextMedia = manifest.createdWorkspaceMedia.filter(
                        (entry) => !transferableKeys.has(ownedWorkspaceMediaPathKey(entry)),
                    );
                    if (nextMedia.length === manifest.createdWorkspaceMedia.length) continue;
                    const ownerPaths = stagingPathsInRoot(
                        paths.rootDirectory,
                        manifest.operationId,
                    );
                    await atomicWrite(ownerPaths.manifestPath, Object.freeze({
                        ...manifest,
                        createdWorkspaceMedia: Object.freeze(nextMedia),
                    }));
                }
            });
        },

        async readCreatedWorkspaceMediaForCleanup(readInput) {
            const operationId = readNonemptyString(readInput.operationId, 'operationId');
            const requested = readInput.media?.map(normalizeOwnedWorkspaceMediaPath);
            return await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return Object.freeze([]);
                const requestedKeys = requested
                    ? new Set(requested.map(ownedWorkspaceMediaPathKey))
                    : null;
                const manifests = await readAllHeaders(paths.rootDirectory);
                const duplicateKeys = new Set<string>();
                const eligible = manifest.createdWorkspaceMedia.filter((entry) => {
                    const key = ownedWorkspaceMediaPathKey(entry);
                    if (requestedKeys !== null && !requestedKeys.has(key)) return false;
                    const duplicate = manifests.some((candidate) => (
                        candidate.operationId !== operationId
                        && candidate.createdWorkspaceMedia.some(
                            (candidateEntry) => ownedWorkspaceMediaPathKey(candidateEntry) === key,
                        )
                    ));
                    if (duplicate) duplicateKeys.add(key);
                    return !duplicate;
                });
                if (duplicateKeys.size > 0) {
                    await atomicWrite(paths.manifestPath, Object.freeze({
                        ...manifest,
                        createdWorkspaceMedia: Object.freeze(
                            manifest.createdWorkspaceMedia.filter(
                                (entry) => !duplicateKeys.has(ownedWorkspaceMediaPathKey(entry)),
                            ),
                        ),
                    }));
                }
                return Object.freeze(eligible);
            });
        },

        async acknowledgeCreatedWorkspaceMediaCleanup(acknowledgeInput) {
            const operationId = readNonemptyString(acknowledgeInput.operationId, 'operationId');
            const acknowledgedKeys = new Set(
                acknowledgeInput.media
                    .map(normalizeOwnedWorkspaceMediaPath)
                    .map(ownedWorkspaceMediaPathKey),
            );
            if (acknowledgedKeys.size === 0) return;
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return;
                const nextMedia = manifest.createdWorkspaceMedia.filter(
                    (entry) => !acknowledgedKeys.has(ownedWorkspaceMediaPathKey(entry)),
                );
                if (nextMedia.length === manifest.createdWorkspaceMedia.length) return;
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    createdWorkspaceMedia: Object.freeze(nextMedia),
                }));
            });
        },

        async completeCapture(completeInput) {
            const operationId = readNonemptyString(completeInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                assertOperationLifecycleAcceptsPage(manifest);
                if (manifest.captureState === 'complete') return;
                if (manifest.summary.pendingGroupIds.length > 0) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_incomplete',
                        'External session staging has an incomplete page reservation',
                    );
                }
                const finalPage = manifest.summary.groupCount === 0
                    ? null
                    : await readGroupRow(
                        paths.operationDirectory,
                        manifest.summary.groupCount - 1,
                    );
                if (
                    !finalPage
                    || finalPage.sourceState.eof !== true
                    || (
                        finalPage.sourceState.outcome !== 'same_revision'
                        && finalPage.sourceState.outcome !== 'appended_after_boundary'
                    )
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_source_not_at_eof',
                        'External session staging capture can complete only at confirmed source EOF',
                    );
                }
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    captureState: 'complete' as const,
                }));
            });
        },

        async reopenAcknowledgedCapture(reopenInput) {
            const operationId = readNonemptyString(reopenInput.operationId, 'operationId');
            return await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                assertOperationLifecycleAcceptsPage(manifest);
                if (
                    manifest.captureState !== 'complete'
                    || manifest.summary.acknowledgedGroupCount
                        !== manifest.summary.groupCount
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_not_extendable',
                        'External session staging can extend only a fully acknowledged capture',
                    );
                }
                // Extension is once per catch-up round, not per page, so reading
                // the rows to find the oldest replay order costs nothing per page.
                const groups = await readAllGroupRows(
                    paths.operationDirectory,
                    manifest.summary,
                );
                const nextReplayOrder = groups.length === 0
                    ? 0
                    : Math.min(...groups.map((group) => group.replayOrder)) - 1;
                if (!Number.isSafeInteger(nextReplayOrder)) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_replay_order_exhausted',
                        'External session staging replay order cannot be extended safely',
                    );
                }
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    captureState: 'capturing' as const,
                }));
                return Object.freeze({
                    nextCaptureIndex: manifest.summary.groupCount,
                    nextReplayOrder,
                });
            });
        },

        async resetUnpublishedCapture(resetInput) {
            const operationId = readNonemptyString(resetInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return;
                if (manifest.summary.acknowledgedGroupCount > 0) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_published_capture_reset_forbidden',
                        'External session staging cannot reset a capture with acknowledged rows',
                    );
                }
                await rm(paths.operationDirectory, { recursive: true, force: true });
            });
        },

        async rollbackUnacknowledgedCaptureExtension(rollbackInput) {
            const operationId = readNonemptyString(rollbackInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return;
                if (manifest.captureState === 'complete') {
                    await removeUnadmittedGroupRowMetadata(
                        paths.operationDirectory,
                        manifest.summary.groupCount,
                    );
                    return;
                }
                // Rolling back an extension is a recovery path, not a per-page
                // one, so it reads the rows and recomputes the retained fold
                // through the same summary owner an append maintains.
                const groups = await readAllGroupRows(
                    paths.operationDirectory,
                    manifest.summary,
                );
                const firstUnacknowledgedIndex = groups.findIndex(
                    (group) => group.state !== 'acknowledged',
                );
                const acknowledgedPrefixLength = firstUnacknowledgedIndex < 0
                    ? groups.length
                    : firstUnacknowledgedIndex;
                if (
                    acknowledgedPrefixLength === 0
                    || groups
                        .slice(0, acknowledgedPrefixLength)
                        .some((group) => group.state !== 'acknowledged')
                    || groups
                        .slice(acknowledgedPrefixLength)
                        .some((group) => group.state === 'acknowledged')
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_extension_not_recoverable',
                        'External session staging cannot roll back a non-tail capture extension',
                    );
                }
                const retained = groups.slice(0, acknowledgedPrefixLength);
                // Keep the old header charging every tail payload until both
                // large payload shapes are gone. A crash before the atomic
                // header write can therefore overcharge briefly, but it can
                // never leave an uncounted private payload behind.
                for (const group of groups.slice(acknowledgedPrefixLength)) {
                    await rm(
                        resolvePageGroupPath(paths.operationDirectory, group.captureIndex),
                        { force: true },
                    );
                    await rm(
                        resolvePreparedReplayGroupPath(paths.operationDirectory, group.captureIndex),
                        { force: true },
                    );
                }
                const retainedSummary = summarizeGroupRows(retained);
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    captureState: 'complete' as const,
                    summary: retainedSummary,
                }));
                await removeUnadmittedGroupRowMetadata(
                    paths.operationDirectory,
                    retainedSummary.groupCount,
                );
            });
        },

        async resumeOperation(resumeInput) {
            const operationId = readNonemptyString(resumeInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                if (manifest.lifecycle.state === 'discard_required') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_discard_required',
                        'External session staging requires discard',
                    );
                }
                if (manifest.lifecycle.state === 'active') return;
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    lifecycle: Object.freeze({ state: 'active' as const }),
                }));
            });
        },

        async acknowledgeReplayGroup(acknowledgeInput) {
            const operationId = readNonemptyString(acknowledgeInput.operationId, 'operationId');
            const groupId = readNonemptyString(acknowledgeInput.groupId, 'groupId');
            const acceptedThroughServerSeq = readNonnegativeSafeInteger(
                acknowledgeInput.acceptedThroughServerSeq,
                'acceptedThroughServerSeq',
            );
            await withCapacityLock(operationId, async (paths) => {
                const storedManifest = await readHeader(paths.manifestPath);
                if (!storedManifest || storedManifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                const manifest = await repairHeaderSummaryFromGroupRows(
                    paths,
                    storedManifest,
                    atomicWrite,
                );
                if (manifest.captureState !== 'complete') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_incomplete',
                        'External session staging cannot acknowledge replay before capture completes',
                    );
                }
                const group = await readAddressedGroupRow(
                    paths.operationDirectory,
                    manifest.summary,
                    acknowledgeInput.captureIndex,
                    groupId,
                );
                if (!group || group.state === 'reserved') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_group_not_ready',
                        'External session staging replay group is not ready',
                    );
                }
                if (group.state === 'acknowledged') {
                    if (group.acceptedThroughServerSeq !== acceptedThroughServerSeq) {
                        throw new ExternalSessionStagingError(
                            'external_session_staging_ack_conflict',
                            'External session staging acknowledgment conflicts with its checkpoint',
                        );
                    }
                    return;
                }
                const priorAcceptedThroughServerSeq =
                    manifest.summary.acceptedThroughServerSeq;
                if (
                    priorAcceptedThroughServerSeq !== null
                    && acceptedThroughServerSeq < priorAcceptedThroughServerSeq
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_ack_regressed',
                        'External session staging acknowledgment regressed the server checkpoint',
                    );
                }
                const acknowledged = Object.freeze({
                    ...group,
                    state: 'acknowledged' as const,
                    acceptedThroughServerSeq,
                });
                await atomicWrite(
                    resolveGroupRowPath(paths.operationDirectory, group.captureIndex),
                    acknowledged,
                );
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    summary: summaryWithRowTransition(
                        manifest.summary,
                        group,
                        acknowledged,
                    ),
                }));
            });
        },

        async cleanupTerminalOperation(completeInput) {
            const operationId = readNonemptyString(completeInput.operationId, 'operationId');
            return await withCapacityLock(operationId, async (paths) => {
                const storedManifest = await readHeader(paths.manifestPath);
                if (!storedManifest || storedManifest.operationId !== operationId) {
                    return Object.freeze({ status: 'missing' as const });
                }
                const manifest = await repairHeaderSummaryFromGroupRows(
                    paths,
                    storedManifest,
                    atomicWrite,
                );
                if (
                    manifest.lifecycle.state !== 'discard_required'
                    && (
                        manifest.captureState !== 'complete'
                        || manifest.summary.acknowledgedGroupCount
                            !== manifest.summary.groupCount
                    )
                ) {
                    return Object.freeze({ status: 'not_ready' as const });
                }
                if (
                    manifest.lifecycle.state === 'discard_required'
                    && manifest.createdWorkspaceMedia.length > 0
                ) {
                    return Object.freeze({ status: 'not_ready' as const });
                }
                if (
                    manifest.lifecycle.state !== 'discard_required'
                    && manifest.createdWorkspaceMedia.length > 0
                ) {
                    const publishedKeys = new Set(
                        manifest.createdWorkspaceMedia.map(ownedWorkspaceMediaPathKey),
                    );
                    const manifests = await readAllHeaders(paths.rootDirectory);
                    for (const candidate of manifests) {
                        if (candidate.operationId === operationId) continue;
                        const nextMedia = candidate.createdWorkspaceMedia.filter(
                            (entry) => !publishedKeys.has(ownedWorkspaceMediaPathKey(entry)),
                        );
                        if (nextMedia.length === candidate.createdWorkspaceMedia.length) continue;
                        const candidatePaths = stagingPathsInRoot(
                            paths.rootDirectory,
                            candidate.operationId,
                        );
                        await atomicWrite(candidatePaths.manifestPath, Object.freeze({
                            ...candidate,
                            createdWorkspaceMedia: Object.freeze(nextMedia),
                        }));
                    }
                }
                await rm(paths.operationDirectory, { recursive: true, force: true });
                stagingPaths.release(operationId);
                return Object.freeze({ status: 'completed' as const });
            });
        },

        async pauseOperation(pauseInput) {
            const operationId = readNonemptyString(pauseInput.operationId, 'operationId');
            const expiresAtMs = readNonnegativeSafeInteger(pauseInput.expiresAtMs, 'expiresAtMs');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                if (manifest.lifecycle.state === 'discard_required') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_discard_required',
                        'External session staging already requires discard',
                    );
                }
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    lifecycle: Object.freeze({ state: 'paused' as const, expiresAtMs }),
                }));
            });
        },

        async markExpiredPausedWorkDiscardRequired(markInput) {
            const operationId = readNonemptyString(markInput.operationId, 'operationId');
            const nowMs = readNonnegativeSafeInteger(markInput.nowMs, 'nowMs');
            return await withCapacityLock(operationId, async (paths) => {
                const manifest = await readHeader(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                if (manifest.lifecycle.state === 'active') {
                    return Object.freeze({ status: 'active' as const });
                }
                if (manifest.lifecycle.state === 'discard_required') {
                    return Object.freeze({ status: 'discard_required' as const });
                }
                if (nowMs < manifest.lifecycle.expiresAtMs) {
                    return Object.freeze({
                        status: 'paused' as const,
                        expiresAtMs: manifest.lifecycle.expiresAtMs,
                    });
                }
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    lifecycle: Object.freeze({ state: 'discard_required' as const }),
                }));
                return Object.freeze({ status: 'discard_required' as const });
            });
        },
    });
}
