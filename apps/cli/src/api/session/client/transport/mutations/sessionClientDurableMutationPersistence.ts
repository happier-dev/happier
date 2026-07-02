import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { getSessionStateFieldDescriptor } from '@happier-dev/agents';
import {
    SessionMessageRoleSchema,
    SessionStateFieldDeliveryClassSchema,
    SessionStateFieldIdSchema,
    SessionStateUsageLimitRecoveryValueSchema,
    SessionStateWorkStateValueSchema,
    SessionStoredMessageContentSchema,
    SessionTurnMutationV1Schema,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';

import type {
    QueuedSessionClientDurableMutation,
    RegisteredSessionStateFieldMutationV1,
    SessionClientDurableMutationDependency,
    SessionClientDurableMutationPause,
    SessionEndMutationV1,
    TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';
import { resolveTranscriptMessageAppendMutationId } from './sessionClientDurableMutationTypes';

type SessionClientDurableMutationOutboxFileV1 = Readonly<{
    v: 1;
    mutations: readonly QueuedSessionClientDurableMutation[];
}>;

export type SessionClientDurableMutationDeadLetterEntry = Readonly<{
    v: 1;
    kind: QueuedSessionClientDurableMutation['kind'] | 'outbox_file' | 'unknown';
    sessionId: string;
    mutationId?: string;
    reason: string;
    attempts?: number;
    createdAt?: number;
    deadLetteredAt: number;
    diagnostic?: Record<string, unknown>;
    payloadSummary?: Record<string, unknown>;
}>;

type SessionClientDurableMutationDeadLetterFileV1 = Readonly<{
    v: 1;
    entries: readonly SessionClientDurableMutationDeadLetterEntry[];
}>;

function sanitizeSessionIdForFileName(sessionId: string): string {
    const sanitized = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return sanitized || 'unknown-session';
}

export function resolveSessionClientDurableMutationOutboxPath(sessionId: string): string {
    return join(
        configuration.activeServerDir,
        'session-mutations',
        `session-${sanitizeSessionIdForFileName(sessionId)}.json`,
    );
}

export function resolveSessionClientDurableMutationDeadLetterPath(sessionId: string): string {
    return join(
        configuration.activeServerDir,
        'session-mutations',
        `session-${sanitizeSessionIdForFileName(sessionId)}.dead-letter.json`,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizePayload(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    const summary: Record<string, unknown> = {
        keys: Object.keys(value).sort(),
    };
    for (const key of ['sessionId', 'mutationId', 'action', 'source', 'localId'] as const) {
        if (typeof value[key] === 'string') summary[key] = value[key];
    }
    return summary;
}

function createDeadLetterEntry(params: Readonly<{
    sessionId: string;
    kind: SessionClientDurableMutationDeadLetterEntry['kind'];
    reason: string;
    mutationId?: string;
    attempts?: number;
    createdAt?: number;
    diagnostic?: Record<string, unknown>;
    payload?: unknown;
}>): SessionClientDurableMutationDeadLetterEntry {
    return {
        v: 1,
        kind: params.kind,
        sessionId: params.sessionId,
        ...(params.mutationId ? { mutationId: params.mutationId } : {}),
        reason: params.reason,
        ...(typeof params.attempts === 'number' ? { attempts: params.attempts } : {}),
        ...(typeof params.createdAt === 'number' ? { createdAt: params.createdAt } : {}),
        deadLetteredAt: Date.now(),
        ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
        ...(params.payload !== undefined ? { payloadSummary: summarizePayload(params.payload) } : {}),
    };
}

function resolveQueuedMutationKind(value: unknown): SessionClientDurableMutationDeadLetterEntry['kind'] {
    if (
        value === 'session_turn_mutation'
        || value === 'session_end'
        || value === 'transcript_message_append'
        || value === 'registered_session_state_field'
    ) {
        return value;
    }
    return 'unknown';
}

function parseSessionEndPayload(value: unknown): SessionEndMutationV1 | null {
    if (!isRecord(value)) return null;
    if (
        value.v !== 1
        || value.source !== 'session_end'
        || typeof value.sessionId !== 'string'
        || typeof value.mutationId !== 'string'
        || typeof value.observedAt !== 'number'
    ) {
        return null;
    }
    return value as SessionEndMutationV1;
}

function parseSessionTurnMutationPayload(value: unknown): SessionTurnMutationV1 | null {
    const parsed = SessionTurnMutationV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function parseTranscriptMessageAppendPayload(value: unknown): TranscriptMessageAppendMutationV1 | null {
    if (!isRecord(value)) return null;
    if (
        value.v !== 1
        || value.source !== 'transcript_message_append'
        || typeof value.sessionId !== 'string'
        || typeof value.mutationId !== 'string'
        || typeof value.localId !== 'string'
        || value.localId.trim().length === 0
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
        localId: value.localId,
    })) {
        return null;
    }
    return value as unknown as TranscriptMessageAppendMutationV1;
}

function parseMutationDependencies(value: unknown): readonly SessionClientDurableMutationDependency[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const dependencies: SessionClientDurableMutationDependency[] = [];
    for (const item of value) {
        if (
            !isRecord(item)
            || typeof item.mutationId !== 'string'
            || item.mutationId.trim().length === 0
            || (
                item.relationship !== 'same_turn_prerequisite'
                && item.relationship !== 'session_lifecycle_prerequisite'
            )
        ) {
            return null;
        }
        dependencies.push({
            mutationId: item.mutationId,
            relationship: item.relationship,
        });
    }
    return dependencies;
}

function parseMutationPause(value: unknown): SessionClientDurableMutationPause | null | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return null;
    if (
        value.reason !== 'session_auth_recovery'
        && value.reason !== 'runtime_auth_recovery'
        && value.reason !== 'setup_recovery'
        && value.reason !== 'user_paused_recovery'
    ) {
        return null;
    }
    if (
        typeof value.pausedAt !== 'number'
        || !Number.isFinite(value.pausedAt)
        || value.pausedAt < 0
        || (value.resumeAtMs !== undefined && (
            typeof value.resumeAtMs !== 'number'
            || !Number.isFinite(value.resumeAtMs)
            || value.resumeAtMs < 0
        ))
    ) {
        return null;
    }
    const pause: SessionClientDurableMutationPause = {
        reason: value.reason,
        pausedAt: Math.trunc(value.pausedAt),
        ...(typeof value.resumeAtMs === 'number' ? { resumeAtMs: Math.trunc(value.resumeAtMs) } : {}),
    };
    return pause;
}

function parseRegisteredSessionStateFieldPayload(value: unknown): RegisteredSessionStateFieldMutationV1 | null {
    if (!isRecord(value)) return null;
    const fieldId = SessionStateFieldIdSchema.safeParse(value.fieldId);
    const deliveryClass = SessionStateFieldDeliveryClassSchema.safeParse(value.deliveryClass);
    const dependencies = parseMutationDependencies(value.dependsOn);
    if (
        value.v !== 1
        || typeof value.sessionId !== 'string'
        || value.sessionId.trim().length === 0
        || typeof value.mutationId !== 'string'
        || value.mutationId.trim().length === 0
        || !fieldId.success
        || !deliveryClass.success
        || (
            value.source !== 'runtime'
            && value.source !== 'ui'
            && value.source !== 'daemon'
            && value.source !== 'server_reconcile'
            && value.source !== 'compat'
        )
        || typeof value.observedAt !== 'number'
        || !Number.isFinite(value.observedAt)
        || value.observedAt < 0
        || dependencies === null
        || !isRecord(value.op)
    ) {
        return null;
    }
    if (getSessionStateFieldDescriptor(fieldId.data).deliveryClass !== deliveryClass.data) {
        return null;
    }

    let op: RegisteredSessionStateFieldMutationV1['op'] | null = null;
    if (value.op.kind === 'clear') {
        if (value.op.previousFingerprint !== undefined && typeof value.op.previousFingerprint !== 'string') {
            return null;
        }
        op = {
            kind: 'clear',
            ...(typeof value.op.previousFingerprint === 'string'
                ? { previousFingerprint: value.op.previousFingerprint }
                : {}),
        };
    } else if (value.op.kind === 'set') {
        if (value.op.valueFingerprint !== undefined && typeof value.op.valueFingerprint !== 'string') {
            return null;
        }
        const parsedValue = parseRegisteredSessionStateFieldValue(fieldId.data, value.op.value);
        if (!parsedValue.ok) return null;
        op = {
            kind: 'set',
            value: parsedValue.value,
            ...(typeof value.op.valueFingerprint === 'string'
                ? { valueFingerprint: value.op.valueFingerprint }
                : {}),
        };
    }
    if (!op) return null;

    return {
        v: 1,
        sessionId: value.sessionId,
        mutationId: value.mutationId,
        fieldId: fieldId.data,
        deliveryClass: deliveryClass.data,
        op,
        source: value.source,
        observedAt: Math.trunc(value.observedAt),
        ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
    };
}

function parseRegisteredSessionStateFieldValue(
    fieldId: RegisteredSessionStateFieldMutationV1['fieldId'],
    value: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
    if (fieldId === 'runtime.workState') {
        const parsed = SessionStateWorkStateValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'runtime.usageLimitRecovery') {
        const parsed = SessionStateUsageLimitRecoveryValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    return { ok: false };
}

type ParseQueuedResult = Readonly<{
    mutations: readonly QueuedSessionClientDurableMutation[];
    deadLetters: readonly SessionClientDurableMutationDeadLetterEntry[];
}>;

function parseQueuedSessionClientDurableMutation(value: unknown, sessionId: string): ParseQueuedResult {
    if (!isRecord(value)) {
        return {
            mutations: [],
            deadLetters: [createDeadLetterEntry({
                sessionId,
                kind: 'unknown',
                reason: 'invalid_queued_mutation_record',
                payload: value,
            })],
        };
    }
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? Math.trunc(value.createdAt) : Date.now();
    const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? Math.max(0, Math.trunc(value.attempts)) : 0;
    const nextAttemptAt = typeof value.nextAttemptAt === 'number' && Number.isFinite(value.nextAttemptAt) ? Math.max(0, Math.trunc(value.nextAttemptAt)) : 0;
    const mutationId = typeof value.mutationId === 'string' ? value.mutationId : undefined;
    const dependsOn = parseMutationDependencies(value.dependsOn);
    const paused = parseMutationPause(value.paused);
    if (dependsOn === null) {
        return {
            mutations: [],
            deadLetters: [createDeadLetterEntry({
                sessionId,
                kind: resolveQueuedMutationKind(value.kind),
                reason: 'invalid_mutation_dependencies',
                mutationId,
                attempts,
                createdAt,
                payload: value,
            })],
        };
    }
    if (paused === null) {
        return {
            mutations: [],
            deadLetters: [createDeadLetterEntry({
                sessionId,
                kind: resolveQueuedMutationKind(value.kind),
                reason: 'invalid_mutation_pause',
                mutationId,
                attempts,
                createdAt,
                payload: value,
            })],
        };
    }

    if (value.kind === 'session_end') {
        const payload = parseSessionEndPayload(value.payload);
        if (!payload) {
            return {
                mutations: [],
                deadLetters: [createDeadLetterEntry({
                    sessionId,
                    kind: 'session_end',
                    reason: 'invalid_session_end_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                })],
            };
        }
        return { mutations: [{
            kind: 'session_end',
            mutationId: payload.mutationId,
            payload,
            createdAt,
            attempts,
            nextAttemptAt,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            ...(paused ? { paused } : {}),
        }], deadLetters: [] };
    }

    if (value.kind === 'session_turn_mutation') {
        const payload = parseSessionTurnMutationPayload(value.payload);
        if (!payload) {
            return {
                mutations: [],
                deadLetters: [createDeadLetterEntry({
                    sessionId,
                    kind: 'session_turn_mutation',
                    reason: 'invalid_session_turn_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                })],
            };
        }
        return { mutations: [{
            kind: 'session_turn_mutation',
            mutationId: payload.mutationId,
            payload,
            createdAt,
            attempts,
            nextAttemptAt,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            ...(paused ? { paused } : {}),
        }], deadLetters: [] };
    }

    if (value.kind === 'transcript_message_append') {
        const payload = parseTranscriptMessageAppendPayload(value.payload);
        if (!payload || mutationId !== payload.mutationId) {
            return {
                mutations: [],
                deadLetters: [createDeadLetterEntry({
                    sessionId,
                    kind: 'transcript_message_append',
                    reason: 'invalid_transcript_message_append_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                })],
            };
        }
        return { mutations: [{
            kind: 'transcript_message_append',
            mutationId: payload.mutationId,
            payload,
            createdAt,
            attempts,
            nextAttemptAt,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            ...(paused ? { paused } : {}),
        }], deadLetters: [] };
    }

    if (value.kind === 'registered_session_state_field') {
        const payload = parseRegisteredSessionStateFieldPayload(value.payload);
        if (!payload || mutationId !== payload.mutationId) {
            return {
                mutations: [],
                deadLetters: [createDeadLetterEntry({
                    sessionId,
                    kind: 'registered_session_state_field',
                    reason: 'invalid_registered_session_state_field_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                })],
            };
        }
        return { mutations: [{
            kind: 'registered_session_state_field',
            mutationId: payload.mutationId,
            payload,
            createdAt,
            attempts,
            nextAttemptAt,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            ...(paused ? { paused } : {}),
        }], deadLetters: [] };
    }

    return {
        mutations: [],
        deadLetters: [createDeadLetterEntry({
            sessionId,
            kind: 'unknown',
            reason: 'unknown_queued_mutation_kind',
            mutationId,
            attempts,
            createdAt,
            payload: value,
        })],
    };
}

export async function loadSessionClientDurableMutationOutbox(sessionId: string): Promise<QueuedSessionClientDurableMutation[]> {
    try {
        const parsed = JSON.parse(await readFile(resolveSessionClientDurableMutationOutboxPath(sessionId), 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.mutations)) {
            await appendSessionClientDurableMutationDeadLetters(sessionId, [
                createDeadLetterEntry({
                    sessionId,
                    kind: 'outbox_file',
                    reason: 'invalid_outbox_file',
                    payload: parsed,
                }),
            ]);
            await saveSessionClientDurableMutationOutbox(sessionId, []);
            return [];
        }
        const mutations: QueuedSessionClientDurableMutation[] = [];
        const deadLetters: SessionClientDurableMutationDeadLetterEntry[] = [];
        for (const rawMutation of parsed.mutations) {
            const parsedMutation = parseQueuedSessionClientDurableMutation(rawMutation, sessionId);
            mutations.push(...parsedMutation.mutations);
            deadLetters.push(...parsedMutation.deadLetters);
        }
        if (deadLetters.length > 0) {
            await appendSessionClientDurableMutationDeadLetters(sessionId, deadLetters);
            await saveSessionClientDurableMutationOutbox(sessionId, mutations);
        }
        return mutations;
    } catch {
        return [];
    }
}

async function writeJsonAtomic(
    filePath: string,
    value: SessionClientDurableMutationOutboxFileV1 | SessionClientDurableMutationDeadLetterFileV1,
): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await writeFile(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') {
            await chmod(tmpPath, 0o600).catch(() => {});
        }
        try {
            await rename(tmpPath, filePath);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw error;
            await unlink(filePath).catch((unlinkError) => {
                const unlinkErr = unlinkError as NodeJS.ErrnoException;
                if (unlinkErr?.code !== 'ENOENT') throw unlinkError;
            });
            await rename(tmpPath, filePath);
        }
        if (process.platform !== 'win32') {
            await chmod(filePath, 0o600).catch(() => {});
        }
    } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
    }
}

export async function saveSessionClientDurableMutationOutbox(
    sessionId: string,
    mutations: readonly QueuedSessionClientDurableMutation[],
): Promise<void> {
    const filePath = resolveSessionClientDurableMutationOutboxPath(sessionId);
    if (mutations.length === 0) {
        await unlink(filePath).catch((error) => {
            const err = error as NodeJS.ErrnoException;
            if (err?.code !== 'ENOENT') throw error;
        });
        return;
    }
    await writeJsonAtomic(filePath, { v: 1, mutations });
}

async function loadDeadLetterFile(filePath: string): Promise<SessionClientDurableMutationDeadLetterEntry[]> {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.entries)) return [];
        return parsed.entries.filter((entry): entry is SessionClientDurableMutationDeadLetterEntry => (
            isRecord(entry) && entry.v === 1
        ));
    } catch {
        return [];
    }
}

export async function appendSessionClientDurableMutationDeadLetters(
    sessionId: string,
    entries: readonly SessionClientDurableMutationDeadLetterEntry[],
): Promise<void> {
    if (entries.length === 0) return;
    const filePath = resolveSessionClientDurableMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    await writeJsonAtomic(filePath, {
        v: 1,
        entries: [...existing, ...entries],
    } satisfies SessionClientDurableMutationDeadLetterFileV1);
}

export function createSessionClientDurableMutationDeadLetterEntry(params: Readonly<{
    sessionId: string;
    mutation: QueuedSessionClientDurableMutation;
    reason: string;
    diagnostic?: Record<string, unknown>;
}>): SessionClientDurableMutationDeadLetterEntry {
    return createDeadLetterEntry({
        sessionId: params.sessionId,
        kind: params.mutation.kind,
        reason: params.reason,
        mutationId: params.mutation.mutationId,
        attempts: params.mutation.attempts,
        createdAt: params.mutation.createdAt,
        diagnostic: params.diagnostic,
        payload: params.mutation.payload,
    });
}
