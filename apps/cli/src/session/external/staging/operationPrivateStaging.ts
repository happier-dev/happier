import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic as writeJsonAtomicDefault } from '@/utils/fs/writeJsonAtomic';

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
    state: 'reserved' | 'committed' | 'acknowledged';
    acceptedThroughServerSeq?: number;
}>;

type StagingManifest = Readonly<{
    schemaVersion: 1;
    operationId: string;
    capturedSource: ExternalSessionStagingSourceCapture;
    captureState: 'capturing' | 'complete';
    lifecycle: StagingLifecycle;
    groups: readonly StagingPageReservation[];
}>;

type StagingPageGroup = Readonly<{
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
            captureState: StagingManifest['captureState'];
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

function resolveStagingPaths(activeServerDir: string, operationId: string): StagingPaths {
    const operationKey = createHash('sha256').update(operationId, 'utf8').digest('hex');
    const rootDirectory = resolve(activeServerDir, 'external-session-operation-staging');
    const operationDirectory = join(rootDirectory, operationKey);
    return Object.freeze({
        rootDirectory,
        operationDirectory,
        manifestPath: join(operationDirectory, 'manifest.json'),
        capacityLockPath: join(rootDirectory, '.capacity.lock'),
    });
}

function resolvePageGroupPath(operationDirectory: string, captureIndex: number): string {
    return join(operationDirectory, `page-${String(captureIndex).padStart(12, '0')}.json`);
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
        state: record.state,
        ...(record.state === 'acknowledged'
            ? { acceptedThroughServerSeq: record.acceptedThroughServerSeq as number }
            : {}),
    });
}

function parseManifest(value: unknown): StagingManifest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const lifecycle = parseLifecycle(record.lifecycle);
    if (
        record.schemaVersion !== 1
        || typeof record.operationId !== 'string'
        || !record.operationId.trim()
        || (record.captureState !== 'capturing' && record.captureState !== 'complete')
        || !Array.isArray(record.groups)
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
    const groups = record.groups.map(parseReservation);
    if (groups.some((group) => !group)) return null;
    const parsedGroups = groups as StagingPageReservation[];
    if (
        new Set(parsedGroups.map((group) => group.groupId)).size !== parsedGroups.length
        || new Set(parsedGroups.map((group) => group.captureIndex)).size !== parsedGroups.length
    ) {
        return null;
    }
    return Object.freeze({
        schemaVersion: 1,
        operationId: record.operationId,
        capturedSource,
        captureState: record.captureState,
        lifecycle,
        groups: Object.freeze(parsedGroups),
    });
}

async function readManifest(path: string): Promise<StagingManifest | null> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging manifest is malformed',
        );
    }
    const manifest = parseManifest(value);
    if (!manifest) {
        throw new ExternalSessionStagingError(
            'external_session_staging_corrupt',
            'External session staging manifest is invalid',
        );
    }
    return manifest;
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

function sumReservations(manifests: readonly StagingManifest[]): Readonly<{
    itemCount: number;
    serializedBytes: number;
}> {
    let itemCount = 0;
    let serializedBytes = 0;
    for (const manifest of manifests) {
        for (const group of manifest.groups) {
            itemCount += group.itemCount;
            serializedBytes += group.serializedBytes;
        }
    }
    return Object.freeze({ itemCount, serializedBytes });
}

function readAcceptedThroughServerSeq(manifest: StagingManifest): number | null {
    let acceptedThroughServerSeq: number | null = null;
    for (const group of manifest.groups) {
        const groupCheckpoint = group.acceptedThroughServerSeq;
        if (
            group.state === 'acknowledged'
            && group.itemCount > 0
            && groupCheckpoint !== undefined
            && (
                acceptedThroughServerSeq === null
                || groupCheckpoint > acceptedThroughServerSeq
            )
        ) {
            acceptedThroughServerSeq = groupCheckpoint;
        }
    }
    return acceptedThroughServerSeq;
}

function readAcknowledgedItemCount(manifest: StagingManifest): number {
    return manifest.groups.reduce(
        (total, group) => group.state === 'acknowledged'
            ? total + group.itemCount
            : total,
        0,
    );
}

function projectReplayState(
    manifest: StagingManifest | null,
    operationId: string,
): ExternalSessionStagingReplayState {
    if (!manifest || manifest.operationId !== operationId) {
        return Object.freeze({ status: 'missing' as const });
    }
    const acceptedThroughServerSeq = readAcceptedThroughServerSeq(manifest);
    const acknowledgedItemCount = readAcknowledgedItemCount(manifest);
    if (
        manifest.captureState !== 'complete'
        && manifest.lifecycle.state !== 'discard_required'
    ) {
        return Object.freeze({
            status: 'capture_incomplete' as const,
            lifecycle: manifest.lifecycle.state,
            acceptedThroughServerSeq,
            acknowledgedItemCount,
        });
    }
    const pendingGroupIds = manifest.groups
        .filter((group) => group.state === 'reserved')
        .map((group) => group.groupId);
    if (pendingGroupIds.length > 0) {
        return Object.freeze({
            status: 'incomplete' as const,
            lifecycle: manifest.lifecycle.state,
            pendingGroupIds: Object.freeze(pendingGroupIds),
            acceptedThroughServerSeq,
            acknowledgedItemCount,
        });
    }
    if (manifest.lifecycle.state === 'discard_required') {
        return Object.freeze({
            status: 'discard_required' as const,
            acceptedThroughServerSeq,
            acknowledgedItemCount,
        });
    }
    return Object.freeze({
        status: 'ready' as const,
        lifecycle: manifest.lifecycle.state,
        acceptedThroughServerSeq,
        acknowledgedItemCount,
    });
}

async function readAllManifests(rootDirectory: string): Promise<readonly StagingManifest[]> {
    let entries;
    try {
        entries = await readdir(rootDirectory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
        throw error;
    }
    const manifests: StagingManifest[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !OPERATION_DIRECTORY_PATTERN.test(entry.name)) continue;
        const manifest = await readManifest(join(rootDirectory, entry.name, 'manifest.json'));
        if (manifest) manifests.push(manifest);
    }
    return Object.freeze(manifests);
}

function assertOperationLifecycleAcceptsPage(manifest: StagingManifest): void {
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

    const withCapacityLock = async <T>(
        operationId: string,
        effect: (paths: StagingPaths) => Promise<T>,
    ): Promise<T> => {
        const paths = resolveStagingPaths(activeServerDir, operationId);
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
                const current = await readManifest(paths.manifestPath);
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
                const manifest: StagingManifest = Object.freeze({
                    schemaVersion: 1,
                    operationId,
                    capturedSource,
                    captureState: 'capturing',
                    lifecycle: Object.freeze({ state: 'active' }),
                    groups: Object.freeze([]),
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
            const paths = resolveStagingPaths(activeServerDir, operationId);
            const manifest = await readManifest(paths.manifestPath);
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
            const paths = resolveStagingPaths(activeServerDir, operationId);
            const manifest = await readManifest(paths.manifestPath);
            if (!manifest || manifest.operationId !== operationId) {
                return Object.freeze({ status: 'missing' as const });
            }
            const lastCapturedPage = manifest.groups.at(-1);
            return Object.freeze({
                status: 'ready' as const,
                captureState: manifest.captureState,
                sourcePagesRead: manifest.groups.length,
                stagedItemCount: manifest.groups.reduce(
                    (total, group) => total + group.itemCount,
                    0,
                ),
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
                const manifest = await readManifest(paths.manifestPath);
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

                const existing = manifest.groups.find((group) => (
                    group.groupId === page.groupId || group.captureIndex === page.captureIndex
                ));
                if (existing) {
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
                        return Object.freeze({
                            status: 'already_stored' as const,
                            sourceState,
                        });
                    }
                    await atomicWrite(
                        resolvePageGroupPath(paths.operationDirectory, page.captureIndex),
                        page,
                    );
                    const committedManifest: StagingManifest = Object.freeze({
                        ...manifest,
                        groups: Object.freeze(manifest.groups.map((group) => (
                            group.groupId === existing.groupId
                                ? Object.freeze({ ...group, state: 'committed' as const })
                                : group
                        ))),
                    });
                    await atomicWrite(paths.manifestPath, committedManifest);
                    return Object.freeze({ status: 'stored' as const, sourceState });
                }
                if (page.captureIndex !== manifest.groups.length) {
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
                const aggregateTotals = sumReservations(await readAllManifests(paths.rootDirectory));
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
                const reservedManifest: StagingManifest = Object.freeze({
                    ...manifest,
                    groups: Object.freeze([...manifest.groups, reservation]),
                });
                await atomicWrite(paths.manifestPath, reservedManifest);
                await atomicWrite(
                    resolvePageGroupPath(paths.operationDirectory, page.captureIndex),
                    page,
                );
                const committedManifest: StagingManifest = Object.freeze({
                    ...reservedManifest,
                    groups: Object.freeze(reservedManifest.groups.map((group) => (
                        group.groupId === reservation.groupId
                            ? Object.freeze({ ...group, state: 'committed' as const })
                            : group
                    ))),
                });
                await atomicWrite(paths.manifestPath, committedManifest);
                return Object.freeze({ status: 'stored' as const, sourceState });
            });
        },

        async readReplayState(operationIdInput) {
            const operationId = readNonemptyString(operationIdInput, 'operationId');
            const paths = resolveStagingPaths(activeServerDir, operationId);
            return projectReplayState(await readManifest(paths.manifestPath), operationId);
        },

        async *streamReplayGroups(operationIdInput) {
            const operationId = readNonemptyString(operationIdInput, 'operationId');
            const paths = resolveStagingPaths(activeServerDir, operationId);
            const manifest = await readManifest(paths.manifestPath);
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
            const readyManifest = manifest as StagingManifest;
            for (const reservation of readyManifest.groups
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
                yield Object.freeze({
                    captureIndex: page.captureIndex,
                    groupId: page.groupId,
                    sourceState: reservation.sourceState,
                    items: page.items,
                });
            }
        },

        async *streamAllGroupsForTerminalCleanup(operationIdInput) {
            const operationId = readNonemptyString(operationIdInput, 'operationId');
            const paths = resolveStagingPaths(activeServerDir, operationId);
            const manifest = await readManifest(paths.manifestPath);
            const state = projectReplayState(manifest, operationId);
            if (state.status !== 'discard_required' || !manifest) {
                throw new ExternalSessionStagingError(
                    'external_session_staging_not_discard_ready',
                    'External session staging is not ready for terminal cleanup',
                );
            }
            for (const reservation of manifest.groups
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

        async completeCapture(completeInput) {
            const operationId = readNonemptyString(completeInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readManifest(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                assertOperationLifecycleAcceptsPage(manifest);
                if (manifest.captureState === 'complete') return;
                if (manifest.groups.some((group) => group.state === 'reserved')) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_incomplete',
                        'External session staging has an incomplete page reservation',
                    );
                }
                const finalPage = manifest.groups.at(-1);
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
                const manifest = await readManifest(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                assertOperationLifecycleAcceptsPage(manifest);
                if (
                    manifest.captureState !== 'complete'
                    || manifest.groups.some((group) => group.state !== 'acknowledged')
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_not_extendable',
                        'External session staging can extend only a fully acknowledged capture',
                    );
                }
                const nextReplayOrder = manifest.groups.length === 0
                    ? 0
                    : Math.min(...manifest.groups.map((group) => group.replayOrder)) - 1;
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
                    nextCaptureIndex: manifest.groups.length,
                    nextReplayOrder,
                });
            });
        },

        async resetUnpublishedCapture(resetInput) {
            const operationId = readNonemptyString(resetInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readManifest(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return;
                if (manifest.groups.some((group) => group.state === 'acknowledged')) {
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
                const manifest = await readManifest(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) return;
                if (manifest.captureState === 'complete') return;
                const firstUnacknowledgedIndex = manifest.groups.findIndex(
                    (group) => group.state !== 'acknowledged',
                );
                const acknowledgedPrefixLength = firstUnacknowledgedIndex < 0
                    ? manifest.groups.length
                    : firstUnacknowledgedIndex;
                if (
                    acknowledgedPrefixLength === 0
                    || manifest.groups
                        .slice(0, acknowledgedPrefixLength)
                        .some((group) => group.state !== 'acknowledged')
                    || manifest.groups
                        .slice(acknowledgedPrefixLength)
                        .some((group) => group.state === 'acknowledged')
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_extension_not_recoverable',
                        'External session staging cannot roll back a non-tail capture extension',
                    );
                }
                for (const group of manifest.groups.slice(acknowledgedPrefixLength)) {
                    await rm(
                        resolvePageGroupPath(paths.operationDirectory, group.captureIndex),
                        { force: true },
                    );
                }
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    captureState: 'complete' as const,
                    groups: Object.freeze(manifest.groups.slice(0, acknowledgedPrefixLength)),
                }));
            });
        },

        async resumeOperation(resumeInput) {
            const operationId = readNonemptyString(resumeInput.operationId, 'operationId');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readManifest(paths.manifestPath);
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
                const manifest = await readManifest(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_not_found',
                        'External session staging operation was not begun',
                    );
                }
                if (manifest.captureState !== 'complete') {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_capture_incomplete',
                        'External session staging cannot acknowledge replay before capture completes',
                    );
                }
                const group = manifest.groups.find((candidate) => candidate.groupId === groupId);
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
                const priorAcceptedThroughServerSeq = readAcceptedThroughServerSeq(manifest);
                if (
                    priorAcceptedThroughServerSeq !== null
                    && acceptedThroughServerSeq < priorAcceptedThroughServerSeq
                ) {
                    throw new ExternalSessionStagingError(
                        'external_session_staging_ack_regressed',
                        'External session staging acknowledgment regressed the server checkpoint',
                    );
                }
                await atomicWrite(paths.manifestPath, Object.freeze({
                    ...manifest,
                    groups: Object.freeze(manifest.groups.map((candidate) => (
                        candidate.groupId === groupId
                            ? Object.freeze({
                                ...candidate,
                                state: 'acknowledged' as const,
                                acceptedThroughServerSeq,
                            })
                            : candidate
                    ))),
                }));
            });
        },

        async cleanupTerminalOperation(completeInput) {
            const operationId = readNonemptyString(completeInput.operationId, 'operationId');
            return await withCapacityLock(operationId, async (paths) => {
                const manifest = await readManifest(paths.manifestPath);
                if (!manifest || manifest.operationId !== operationId) {
                    return Object.freeze({ status: 'missing' as const });
                }
                if (
                    manifest.lifecycle.state !== 'discard_required'
                    && (
                        manifest.captureState !== 'complete'
                        || manifest.groups.some((group) => group.state !== 'acknowledged')
                    )
                ) {
                    return Object.freeze({ status: 'not_ready' as const });
                }
                await rm(paths.operationDirectory, { recursive: true, force: true });
                return Object.freeze({ status: 'completed' as const });
            });
        },

        async pauseOperation(pauseInput) {
            const operationId = readNonemptyString(pauseInput.operationId, 'operationId');
            const expiresAtMs = readNonnegativeSafeInteger(pauseInput.expiresAtMs, 'expiresAtMs');
            await withCapacityLock(operationId, async (paths) => {
                const manifest = await readManifest(paths.manifestPath);
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
                const manifest = await readManifest(paths.manifestPath);
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
