import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
    SessionMessageRoleSchema,
    SessionRuntimeActivitySnapshotSchema,
    SessionStoredMessageContentSchema,
    SessionTurnMutationV1Schema,
    ExactSessionTurnEndMutationV1Schema,
} from '@happier-dev/protocol';

import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import type {
    QueuedSessionMutation,
    SessionTurnMutationV1,
    PersistedTranscriptMessageAppendMutationV1,
    RuntimeActivitySnapshotMutationV1,
} from './sessionMutationTypes';
import {
    resolveRuntimeActivitySnapshotMutationId,
    resolveTranscriptMessageAppendMutationId,
} from './sessionMutationTypes';
import { isAuthoritativeSessionMutation, isAuthoritativeSessionMutationKind } from './sessionMutationDurabilityPolicy';

type SessionMutationOutboxFileV1 = Readonly<{
    v: 1;
    mutations: readonly QueuedSessionMutation[];
}>;

export type SessionMutationDeadLetterEntry = Readonly<{
    v: 1;
    kind: QueuedSessionMutation['kind'] | 'outbox_file' | 'unknown';
    sessionId: string;
    mutationId?: string;
    reason: string;
    attempts?: number;
    createdAt?: number;
    deadLetteredAt: number;
    dependencyMutationId?: string;
    diagnostic?: Record<string, unknown>;
    payloadSummary?: Record<string, unknown>;
    /** Byte/content-preserving recovery custody; never used as a live mutation without re-admission. */
    recoveryPayload?: unknown;
    queuedMutation?: QueuedSessionMutation;
    recoveryAttemptedAt?: number;
}>;

const daemonQuarantineEvidenceFingerprints = new WeakMap<SessionMutationDeadLetterEntry, string>();

type SessionMutationDeadLetterFileV1 = Readonly<{
    v: 1;
    entries: readonly SessionMutationDeadLetterEntry[];
}>;

export type QueuedMutationParseResult =
    | Readonly<{ ok: true; mutation: QueuedSessionMutation }>
    | Readonly<{ ok: false; deadLetter: SessionMutationDeadLetterEntry }>;

export type SessionMutationJournalCustody = 'runtime' | 'daemon-terminal';

export type SessionMutationJournalPaths = Readonly<{
    queuePath: string;
    deadLetterPath: string;
}>;

export type SessionMutationJournalAdmission = (
    value: unknown,
    expectedSessionId: string,
) => QueuedMutationParseResult;

export type SessionMutationPersistenceContext = Readonly<{
    custody: SessionMutationJournalCustody;
    sessionId: string;
    paths: SessionMutationJournalPaths;
    parseQueuedMutation: SessionMutationJournalAdmission;
}>;

export function createSessionMutationPersistenceContext(params: Readonly<{
    activeServerDir: string;
    custody: SessionMutationJournalCustody;
    sessionId: string;
    parseQueuedMutation: SessionMutationJournalAdmission;
}>): SessionMutationPersistenceContext {
    return {
        custody: params.custody,
        sessionId: params.sessionId,
        paths: resolveSessionMutationJournalPaths(params),
        parseQueuedMutation: params.parseQueuedMutation,
    };
}

function sanitizeSessionIdForFileName(sessionId: string): string {
    const sanitized = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!sanitized || sanitized !== sessionId) {
        throw new Error('Session id cannot be represented losslessly in a mutation journal filename');
    }
    return sanitized;
}

export function resolveSessionMutationJournalPaths(params: Readonly<{
    activeServerDir: string;
    sessionId: string;
    custody: SessionMutationJournalCustody;
}>): SessionMutationJournalPaths {
    const safeSessionId = sanitizeSessionIdForFileName(params.sessionId);
    const baseName = params.custody === 'daemon-terminal'
        ? `session-${safeSessionId}.daemon-terminal`
        : `session-${safeSessionId}`;
    return {
        queuePath: join(params.activeServerDir, 'session-mutations', `${baseName}.json`),
        deadLetterPath: join(params.activeServerDir, 'session-mutations', `${baseName}.dead-letter.json`),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEvidenceValue(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (Array.isArray(value)) return value.map(normalizeEvidenceValue);
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, normalizeEvidenceValue(value[key])]),
        );
    }
    return String(value);
}

function createEvidenceFingerprint(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(normalizeEvidenceValue(value)))
        .digest('hex');
}

function summarizePayload(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    const summary: Record<string, unknown> = {
        keys: Object.keys(value).sort(),
    };
    for (const key of ['sessionId', 'mutationId', 'action', 'source', 'localId', 'turnId', 'provider', 'providerTurnId'] as const) {
        if (typeof value[key] === 'string') summary[key] = value[key];
    }
    return summary;
}

function summarizeZodIssues(error: { issues: readonly { code: string; path: readonly PropertyKey[] }[] }): Record<string, unknown> {
    return {
        issues: error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map(String).join('.'),
        })),
    };
}

function createDeadLetterEntry(params: Readonly<{
    sessionId: string;
    kind: SessionMutationDeadLetterEntry['kind'];
    reason: string;
    mutationId?: string;
    attempts?: number;
    createdAt?: number;
    dependencyMutationId?: string;
    diagnostic?: Record<string, unknown>;
    payload?: unknown;
    queuedMutation?: QueuedSessionMutation;
    recoveryAttemptedAt?: number;
}>): SessionMutationDeadLetterEntry {
    const entry: SessionMutationDeadLetterEntry = {
        v: 1,
        kind: params.kind,
        sessionId: params.sessionId,
        ...(params.mutationId ? { mutationId: params.mutationId } : {}),
        reason: params.reason,
        ...(typeof params.attempts === 'number' ? { attempts: params.attempts } : {}),
        ...(typeof params.createdAt === 'number' ? { createdAt: params.createdAt } : {}),
        deadLetteredAt: Date.now(),
        ...(params.dependencyMutationId ? { dependencyMutationId: params.dependencyMutationId } : {}),
        ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
        ...(params.payload !== undefined ? { payloadSummary: summarizePayload(params.payload) } : {}),
        ...(params.payload !== undefined ? { recoveryPayload: params.payload } : {}),
        ...(params.queuedMutation ? { queuedMutation: params.queuedMutation } : {}),
        ...(typeof params.recoveryAttemptedAt === 'number' ? { recoveryAttemptedAt: params.recoveryAttemptedAt } : {}),
    };
    if (params.payload !== undefined) {
        daemonQuarantineEvidenceFingerprints.set(entry, createEvidenceFingerprint(params.payload));
    }
    return entry;
}

function parseSessionTurnPayload(value: unknown): Readonly<{
    payload: SessionTurnMutationV1 | null;
    diagnostic?: Record<string, unknown>;
}> {
    const parsed = SessionTurnMutationV1Schema.safeParse(value);
    if (parsed.success) return { payload: parsed.data };
    return {
        payload: null,
        diagnostic: summarizeZodIssues(parsed.error),
    };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

function parseTranscriptMessageAppendPayload(value: unknown): PersistedTranscriptMessageAppendMutationV1 | null {
    if (!isRecord(value)) return null;
    const localId = readNonBlankOpaqueIdentifier(value.localId);
    const allowedKeys = new Set([
        'v',
        'source',
        'sessionId',
        'mutationId',
        'localId',
        'sidechainId',
        'messageRole',
        'content',
        'createdAt',
        'updatedAt',
        'provenance',
        'sessionEventType',
    ]);
    if (
        !hasOnlyKeys(value, allowedKeys)
        || value.v !== 1
        || value.source !== 'transcript_message_append'
        || typeof value.sessionId !== 'string'
        || typeof value.mutationId !== 'string'
        || localId === null
        || typeof value.createdAt !== 'number'
        || !Number.isFinite(value.createdAt)
        || value.createdAt < 0
        || typeof value.updatedAt !== 'number'
        || !Number.isFinite(value.updatedAt)
        || value.updatedAt < 0
        || (value.sidechainId !== undefined && value.sidechainId !== null && typeof value.sidechainId !== 'string')
        || (value.sessionEventType !== undefined && value.sessionEventType !== 'ready')
    ) {
        return null;
    }
    if (value.messageRole !== undefined && !SessionMessageRoleSchema.safeParse(value.messageRole).success) {
        return null;
    }
    if (typeof value.content !== 'string' && !SessionStoredMessageContentSchema.safeParse(value.content).success) {
        return null;
    }
    if (value.mutationId !== resolveTranscriptMessageAppendMutationId({
        sessionId: value.sessionId,
        localId,
    })) {
        return null;
    }
    return value as unknown as PersistedTranscriptMessageAppendMutationV1;
}

function parseRuntimeActivitySnapshotPayload(value: unknown): RuntimeActivitySnapshotMutationV1 | null {
    if (!isRecord(value)) return null;
    const allowedKeys = new Set(['v', 'source', 'sessionId', 'mutationId', 'snapshot']);
    if (
        !hasOnlyKeys(value, allowedKeys)
        || value.v !== 1
        || value.source !== 'runtime_activity_snapshot'
        || typeof value.sessionId !== 'string'
        || typeof value.mutationId !== 'string'
    ) {
        return null;
    }
    const snapshot = SessionRuntimeActivitySnapshotSchema.safeParse(value.snapshot);
    if (!snapshot.success) return null;
    return {
        v: 1,
        source: 'runtime_activity_snapshot',
        sessionId: value.sessionId,
        mutationId: value.mutationId,
        snapshot: snapshot.data,
    };
}

export function parseQueuedSessionMutation(value: unknown, sessionId: string): QueuedMutationParseResult {
    if (!isRecord(value)) {
        return {
            ok: false,
            deadLetter: createDeadLetterEntry({
                sessionId,
                kind: 'unknown',
                reason: 'invalid_queued_mutation_record',
                payload: value,
            }),
        };
    }
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? Math.trunc(value.createdAt) : Date.now();
    const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? Math.max(0, Math.trunc(value.attempts)) : 0;
    const nextAttemptAt = typeof value.nextAttemptAt === 'number' && Number.isFinite(value.nextAttemptAt) ? Math.max(0, Math.trunc(value.nextAttemptAt)) : 0;
    const intentOrder = typeof value.intentOrder === 'number'
        && Number.isSafeInteger(value.intentOrder)
        && value.intentOrder > 0
        ? value.intentOrder
        : null;
    const admissionOrder = typeof value.admissionOrder === 'number'
        && Number.isSafeInteger(value.admissionOrder)
        && value.admissionOrder > 0
        ? value.admissionOrder
        : null;
    const unknownGuardSegment = typeof value.unknownGuardSegment === 'number'
        && Number.isSafeInteger(value.unknownGuardSegment)
        && value.unknownGuardSegment >= 0
        ? value.unknownGuardSegment
        : null;
    const mutationId = typeof value.mutationId === 'string' ? value.mutationId : undefined;
    if (value.kind === 'session_turn') {
        const parsedPayload = parseSessionTurnPayload(value.payload);
        if (!parsedPayload.payload) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'session_turn',
                    reason: 'invalid_session_turn_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    diagnostic: parsedPayload.diagnostic,
                    payload: value.payload,
                }),
            };
        }
        if (
            parsedPayload.payload.action === 'end_session'
            && (typeof parsedPayload.payload.turnId !== 'string' || parsedPayload.payload.turnId.length === 0)
        ) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'session_turn',
                    reason: 'broad_session_end_requires_exact_turn',
                    mutationId: parsedPayload.payload.mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                }),
            };
        }
        return {
            ok: true,
            mutation: {
                kind: 'session_turn',
                mutationId: parsedPayload.payload.mutationId,
                payload: parsedPayload.payload,
                createdAt,
                attempts,
                nextAttemptAt,
            },
        };
    }
    if (value.kind === 'transcript_message_append') {
        const payload = parseTranscriptMessageAppendPayload(value.payload);
        if (!payload || mutationId !== payload.mutationId) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'transcript_message_append',
                    reason: 'invalid_transcript_message_append_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                }),
            };
        }
        return {
            ok: true,
            mutation: {
                kind: 'transcript_message_append',
                mutationId: payload.mutationId,
                payload,
                ...(intentOrder !== null ? { intentOrder } : {}),
                createdAt,
                attempts,
                nextAttemptAt,
            },
        };
    }
    if (value.kind === 'runtime_activity_snapshot') {
        const payload = parseRuntimeActivitySnapshotPayload(value.payload);
        const expectedMutationId = resolveRuntimeActivitySnapshotMutationId(sessionId);
        if (
            !payload
            || payload.sessionId !== sessionId
            || payload.mutationId !== expectedMutationId
            || mutationId !== expectedMutationId
            || admissionOrder === null
        ) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'runtime_activity_snapshot',
                    reason: 'invalid_runtime_activity_snapshot_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                }),
            };
        }
        return {
            ok: true,
            mutation: {
                kind: 'runtime_activity_snapshot',
                mutationId: expectedMutationId,
                payload,
                admissionOrder,
                createdAt,
                attempts,
                nextAttemptAt,
            },
        };
    }
    return {
        ok: false,
        deadLetter: createDeadLetterEntry({
            sessionId,
            kind: 'unknown',
            reason: 'unknown_queued_mutation_kind',
            mutationId,
            attempts,
            createdAt,
            payload: value,
        }),
    };
}

export function parseDaemonTerminalQueuedSessionMutation(
    value: unknown,
    expectedSessionId: string,
): QueuedMutationParseResult {
    const broad = parseQueuedSessionMutation(value, expectedSessionId);
    if (!broad.ok) return broad;
    const rawMutationId = isRecord(value) && typeof value.mutationId === 'string' ? value.mutationId : undefined;
    const exact = broad.mutation.kind === 'session_turn'
        ? ExactSessionTurnEndMutationV1Schema.safeParse(broad.mutation.payload)
        : null;
    if (
        !exact?.success
        || exact.data.sessionId !== expectedSessionId
        || rawMutationId !== exact.data.mutationId
        || broad.mutation.mutationId !== exact.data.mutationId
    ) {
        return {
            ok: false,
            deadLetter: createDeadLetterEntry({
                sessionId: expectedSessionId,
                kind: broad.mutation.kind,
                reason: 'invalid_daemon_terminal_mutation',
                mutationId: rawMutationId,
                attempts: broad.mutation.attempts,
                createdAt: broad.mutation.createdAt,
                payload: isRecord(value) ? value.payload : value,
            }),
        };
    }
    return broad;
}

export async function loadSessionMutationOutbox(
    context: SessionMutationPersistenceContext,
    onQuarantined?: (count: number) => void,
): Promise<QueuedSessionMutation[]> {
    const { sessionId } = context;
    const filePath = context.paths.queuePath;
    let fileContents: string | undefined;
    try {
        fileContents = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(fileContents) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.mutations)) {
            await appendSessionMutationQuarantine(context, [
                createDeadLetterEntry({
                    sessionId,
                    kind: 'outbox_file',
                    reason: 'invalid_outbox_file',
                    payload: parsed,
                }),
            ]);
            onQuarantined?.(1);
            return [];
        }
        const mutations: QueuedSessionMutation[] = [];
        const deadLetters: SessionMutationDeadLetterEntry[] = [];
        for (const rawMutation of parsed.mutations) {
            const parsedMutation = context.parseQueuedMutation(rawMutation, sessionId);
            if (parsedMutation.ok) {
                mutations.push(parsedMutation.mutation);
            } else {
                deadLetters.push(parsedMutation.deadLetter);
            }
        }
        if (deadLetters.length > 0) {
            await appendSessionMutationQuarantine(context, deadLetters);
            onQuarantined?.(deadLetters.length);
        }
        return mutations;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') {
            await appendSessionMutationQuarantine(context, [
                createDeadLetterEntry({
                    sessionId,
                    kind: 'outbox_file',
                    reason: 'invalid_outbox_json',
                    diagnostic: {
                        errorName: error instanceof Error ? error.name : 'unknown',
                    },
                    payload: fileContents,
                }),
            ]);
            onQuarantined?.(1);
        }
        return [];
    }
}

async function loadDeadLetterFile(filePath: string): Promise<SessionMutationDeadLetterEntry[]> {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.entries)) return [];
        return parsed.entries.filter((entry): entry is SessionMutationDeadLetterEntry => isRecord(entry) && entry.v === 1);
    } catch {
        return [];
    }
}

export async function appendSessionMutationDeadLetters(
    context: SessionMutationPersistenceContext,
    entries: readonly SessionMutationDeadLetterEntry[],
): Promise<void> {
    await appendSessionMutationDeadLettersWithPolicy(context, entries, false);
}

function stableDeadLetterIdentity(entry: SessionMutationDeadLetterEntry): string {
    const payloadSummaryEntries = entry.payloadSummary
        ? Object.entries(entry.payloadSummary).filter(([key]) => key !== 'fingerprint')
        : [];
    const payloadSummary = payloadSummaryEntries.length > 0
        ? Object.fromEntries(payloadSummaryEntries)
        : null;
    const evidenceFingerprint = daemonQuarantineEvidenceFingerprints.get(entry)
        ?? (typeof entry.payloadSummary?.fingerprint === 'string' ? entry.payloadSummary.fingerprint : null);
    return JSON.stringify(normalizeEvidenceValue({
        kind: entry.kind,
        sessionId: entry.sessionId,
        mutationId: entry.mutationId ?? null,
        reason: entry.reason,
        dependencyMutationId: entry.dependencyMutationId ?? null,
        diagnostic: entry.diagnostic ?? null,
        payloadSummary,
        evidenceFingerprint,
        queuedMutation: entry.queuedMutation ?? null,
    }));
}

function prepareDaemonQuarantineEntryForPersistence(
    entry: SessionMutationDeadLetterEntry,
): SessionMutationDeadLetterEntry {
    const evidenceFingerprint = daemonQuarantineEvidenceFingerprints.get(entry);
    if (!evidenceFingerprint) return entry;
    return {
        ...entry,
        payloadSummary: {
            ...(entry.payloadSummary ?? {}),
            fingerprint: evidenceFingerprint,
        },
    };
}

async function appendSessionMutationQuarantine(
    context: SessionMutationPersistenceContext,
    entries: readonly SessionMutationDeadLetterEntry[],
): Promise<void> {
    await appendSessionMutationDeadLettersWithPolicy(context, entries, context.custody === 'daemon-terminal');
}

async function appendSessionMutationDeadLettersWithPolicy(
    context: SessionMutationPersistenceContext,
    entries: readonly SessionMutationDeadLetterEntry[],
    dedupeStableDaemonQuarantine: boolean,
): Promise<void> {
    if (entries.length === 0) return;
    const filePath = context.paths.deadLetterPath;
    const existing = await loadDeadLetterFile(filePath);
    const boundedEntries = dedupeStableDaemonQuarantine
        ? entries.filter((entry, index) => {
            const key = stableDeadLetterIdentity(entry);
            const alreadyPersisted = existing.some((candidate) => stableDeadLetterIdentity(candidate) === key);
            if (alreadyPersisted) return false;
            return entries.findIndex((candidate) => stableDeadLetterIdentity(candidate) === key) === index;
        })
        : entries;
    if (boundedEntries.length === 0) return;
    await writeJsonAtomic(filePath, {
        v: 1,
        entries: [
            ...existing,
            ...boundedEntries.map((entry) => (
                dedupeStableDaemonQuarantine
                    ? prepareDaemonQuarantineEntryForPersistence(entry)
                    : entry
            )),
        ],
    } satisfies SessionMutationDeadLetterFileV1);
}

function readRecoverableQueuedMutation(
    entry: SessionMutationDeadLetterEntry,
    context: SessionMutationPersistenceContext,
): QueuedSessionMutation | null {
    if (!isAuthoritativeSessionMutationKind(entry.kind as QueuedSessionMutation['kind'])) return null;
    if (entry.reason === 'permanent_invalid_payload') return null;
    if (typeof entry.recoveryAttemptedAt === 'number') return null;
    const record = entry as unknown as Record<string, unknown>;
    const rawQueuedMutation = record.queuedMutation ?? record.mutation ?? (
        record.payload
            ? {
                kind: entry.kind,
                mutationId: entry.mutationId,
                payload: record.payload,
                createdAt: entry.createdAt,
                attempts: entry.attempts,
                nextAttemptAt: 0,
            }
            : readQueuedMutationFromPayloadSummary(entry, context.sessionId)
    );
    if (!rawQueuedMutation) return null;
    const parsed = context.parseQueuedMutation(rawQueuedMutation, context.sessionId);
    if (!parsed.ok || !isAuthoritativeSessionMutation(parsed.mutation)) return null;
    return {
        ...parsed.mutation,
        nextAttemptAt: 0,
    } as QueuedSessionMutation;
}

function readQueuedMutationFromPayloadSummary(
    entry: SessionMutationDeadLetterEntry,
    sessionId: string,
): QueuedSessionMutation | null {
    const summary = isRecord(entry.payloadSummary) ? entry.payloadSummary : null;
    if (!summary) return null;
    const recoveredSessionId = typeof summary.sessionId === 'string' && summary.sessionId.trim().length > 0
        ? summary.sessionId
        : sessionId;
    const mutationId = typeof entry.mutationId === 'string' && entry.mutationId.trim().length > 0
        ? entry.mutationId
        : typeof summary.mutationId === 'string' && summary.mutationId.trim().length > 0
            ? summary.mutationId
            : null;
    if (!mutationId) return null;
    const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
        ? entry.createdAt
        : entry.deadLetteredAt;
    const attempts = typeof entry.attempts === 'number' && Number.isFinite(entry.attempts)
        ? Math.max(0, Math.trunc(entry.attempts))
        : 0;

    if (entry.kind === 'session_turn') {
        if (typeof summary.action !== 'string' || summary.action.trim().length === 0) return null;
        const turnId = typeof summary.turnId === 'string' && summary.turnId.trim().length > 0
            ? summary.turnId
            : null;
        if (!turnId) return null;
        return {
            kind: 'session_turn',
            mutationId,
            payload: {
                v: 1,
                sessionId: recoveredSessionId,
                mutationId,
                action: summary.action,
                turnId,
                ...(typeof summary.provider === 'string' && summary.provider.trim().length > 0 ? { provider: summary.provider } : {}),
                ...(typeof summary.providerTurnId === 'string' && summary.providerTurnId.trim().length > 0 ? { providerTurnId: summary.providerTurnId } : {}),
                observedAt: createdAt,
            },
            createdAt,
            attempts,
            nextAttemptAt: 0,
        } as QueuedSessionMutation;
    }

    return null;
}

export async function recoverAuthoritativeSessionMutationDeadLetters(
    context: SessionMutationPersistenceContext,
    persistRecovered: (mutations: readonly QueuedSessionMutation[]) => Promise<void>,
    limit = 100,
): Promise<QueuedSessionMutation[]> {
    const { sessionId } = context;
    const filePath = context.paths.deadLetterPath;
    const existing = await loadDeadLetterFile(filePath);
    if (existing.length === 0) return [];

    const recovered: QueuedSessionMutation[] = [];
    const selectedEntries: SessionMutationDeadLetterEntry[] = [];
    for (const entry of existing) {
        if (recovered.length >= limit) break;
        const queuedMutation = readRecoverableQueuedMutation(entry, context);
        if (!queuedMutation) continue;
        recovered.push(queuedMutation);
        selectedEntries.push(entry);
    }

    if (recovered.length === 0) return [];

    await persistRecovered(recovered);

    const selectedIdentityCounts = new Map<string, number>();
    for (const entry of selectedEntries) {
        const identity = stableDeadLetterIdentity(entry);
        selectedIdentityCounts.set(identity, (selectedIdentityCounts.get(identity) ?? 0) + 1);
    }
    const now = Date.now();
    const current = await loadDeadLetterFile(filePath);
    const updated = current.map((entry) => {
        if (typeof entry.recoveryAttemptedAt === 'number') return entry;
        const identity = stableDeadLetterIdentity(entry);
        const remaining = selectedIdentityCounts.get(identity) ?? 0;
        if (remaining === 0) return entry;
        selectedIdentityCounts.set(identity, remaining - 1);
        return {
            ...entry,
            recoveryAttemptedAt: now,
        } satisfies SessionMutationDeadLetterEntry;
    });
    await writeJsonAtomic(filePath, {
        v: 1,
        entries: updated,
    } satisfies SessionMutationDeadLetterFileV1);
    return recovered;
}

export function createSessionMutationDeadLetterEntry(params: Readonly<{
    sessionId: string;
    mutation: QueuedSessionMutation;
    reason: string;
    dependencyMutationId?: string;
    diagnostic?: Record<string, unknown>;
}>): SessionMutationDeadLetterEntry {
    return createDeadLetterEntry({
        sessionId: params.sessionId,
        kind: params.mutation.kind,
        reason: params.reason,
        mutationId: params.mutation.mutationId,
        attempts: params.mutation.attempts,
        createdAt: params.mutation.createdAt,
        dependencyMutationId: params.dependencyMutationId,
        diagnostic: params.diagnostic,
        payload: params.mutation.payload,
        ...(isAuthoritativeSessionMutation(params.mutation) ? { queuedMutation: params.mutation } : {}),
    });
}

export async function saveSessionMutationOutbox(
    context: SessionMutationPersistenceContext,
    mutations: readonly QueuedSessionMutation[],
): Promise<void> {
    const filePath = context.paths.queuePath;
    if (mutations.length === 0) {
        await unlink(filePath).catch((error) => {
            const err = error as NodeJS.ErrnoException;
            if (err?.code !== 'ENOENT') throw error;
        });
        return;
    }
    await writeJsonAtomic(filePath, { v: 1, mutations } satisfies SessionMutationOutboxFileV1);
}
