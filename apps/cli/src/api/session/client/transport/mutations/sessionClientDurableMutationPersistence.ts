import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { getSessionStateFieldDescriptor } from '@happier-dev/agents';
import { hasSessionStateFieldMetadataBinding } from '@happier-dev/agents/session/state/metadataWriters';
import {
    SessionMessageRoleSchema,
    SessionRunnerRuntimeStateV1Schema,
    SessionStateAcpConfigOptionValueSchema,
    SessionStateAcpSessionModeValueSchema,
    SessionStateFieldDeliveryClassSchema,
    SessionStateFieldIdSchema,
    SessionStateModelValueSchema,
    SessionStatePermissionModeValueSchema,
    SessionStateProviderSessionIdValueSchema,
    SessionStateRuntimeDescriptorValueSchema,
    SessionStateTitleValueSchema,
    SessionStateUsageLimitRecoveryValueSchema,
    SessionStateWorkStateValueSchema,
    SessionStoredMessageContentSchema,
    SessionTurnMutationV1Schema,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';
import { SessionRuntimeActivityProjectionV1Schema } from '@happier-dev/protocol/sessions';

import type {
    QueuedSessionClientDurableMutation,
    RegisteredSessionStateFieldMutationV1,
    SessionClientDurableMutationDependency,
    SessionClientDurableMutationPause,
    SessionEndMutationV1,
    TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';
import { resolveTranscriptMessageAppendMutationId } from './sessionClientDurableMutationTypes';
import {
    isAuthoritativeSessionClientDurableMutation,
    isAuthoritativeSessionClientDurableMutationKind,
} from './sessionClientDurableMutationDurabilityPolicy';

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
    queuedMutation?: QueuedSessionClientDurableMutation;
    recoveryAttemptedAt?: number;
}>;

type SessionClientDurableMutationDeadLetterFileV1 = Readonly<{
    v: 1;
    entries: readonly SessionClientDurableMutationDeadLetterEntry[];
}>;

const DEFAULT_DEAD_LETTER_MAX_ENTRIES = 1_000;
const MAX_DEAD_LETTER_MAX_ENTRIES = 10_000;
const DEFAULT_REFERENCED_PREREQUISITE_MAX_ENTRIES = 10_000;
const MAX_REFERENCED_PREREQUISITE_MAX_ENTRIES = 50_000;

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

function readBoundedIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function resolveDeadLetterMaxEntries(): number {
    return Math.min(
        MAX_DEAD_LETTER_MAX_ENTRIES,
        Math.max(
            1,
            readBoundedIntEnv(
                'HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES',
                DEFAULT_DEAD_LETTER_MAX_ENTRIES,
            ),
        ),
    );
}

export function resolveSessionClientDurableMutationReferencedPrerequisiteMaxEntries(): number {
    return Math.min(
        MAX_REFERENCED_PREREQUISITE_MAX_ENTRIES,
        Math.max(
            1,
            readBoundedIntEnv(
                'HAPPIER_SESSION_MUTATION_OUTBOX_REFERENCED_PREREQUISITE_MAX_ENTRIES',
                DEFAULT_REFERENCED_PREREQUISITE_MAX_ENTRIES,
            ),
        ),
    );
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

function addDependencyMutationIds(
    value: unknown,
    add: (mutationId: string) => void,
): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
        if (!isRecord(item) || typeof item.mutationId !== 'string' || item.mutationId.trim().length === 0) continue;
        add(item.mutationId);
    }
}

async function loadReferencedPrerequisiteMutationIds(
    sessionId: string,
): Promise<Readonly<{ mutationIds: ReadonlySet<string>; overflowCount: number }>> {
    const maxEntries = resolveSessionClientDurableMutationReferencedPrerequisiteMaxEntries();
    const mutationIds = new Set<string>();
    let overflowCount = 0;
    const add = (mutationId: string): void => {
        if (mutationIds.has(mutationId)) return;
        if (mutationIds.size >= maxEntries) {
            overflowCount += 1;
            return;
        }
        mutationIds.add(mutationId);
    };
    try {
        const parsed = JSON.parse(await readFile(resolveSessionClientDurableMutationOutboxPath(sessionId), 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.mutations)) {
            return { mutationIds, overflowCount };
        }
        for (const rawMutation of parsed.mutations) {
            if (!isRecord(rawMutation)) continue;
            addDependencyMutationIds(rawMutation.dependsOn, add);
            if (isRecord(rawMutation.payload)) {
                addDependencyMutationIds(rawMutation.payload.dependsOn, add);
            }
        }
    } catch {
        return { mutationIds, overflowCount };
    }
    return { mutationIds, overflowCount };
}

function retainDeadLettersForQueuedPrerequisites(params: Readonly<{
    entries: readonly SessionClientDurableMutationDeadLetterEntry[];
    referencedPrerequisiteMutationIds: ReadonlySet<string>;
    ordinaryCap: number;
    referencedOverflowCount: number;
}>): Readonly<{
    entries: readonly SessionClientDurableMutationDeadLetterEntry[];
    cappedDeadLetterCount: number;
    referencedRetainedEntryCount: number;
    prunedEntryCount: number;
    referencedPrerequisiteOverflowCount: number;
}> {
    const isReferenced = (entry: SessionClientDurableMutationDeadLetterEntry): boolean => (
        typeof entry.mutationId === 'string'
        && params.referencedPrerequisiteMutationIds.has(entry.mutationId)
    );
    const unreferencedEntries = params.entries.filter((entry) => !isReferenced(entry));
    const retainedUnreferencedEntries = new Set(unreferencedEntries.slice(-params.ordinaryCap));
    const retainedEntries = params.entries.filter((entry) => (
        isReferenced(entry) || retainedUnreferencedEntries.has(entry)
    ));
    const referencedRetainedEntryCount = retainedEntries.filter(isReferenced).length;
    return {
        entries: retainedEntries,
        cappedDeadLetterCount: Math.max(0, unreferencedEntries.length - retainedUnreferencedEntries.size),
        referencedRetainedEntryCount,
        prunedEntryCount: Math.max(0, params.entries.length - retainedEntries.length),
        referencedPrerequisiteOverflowCount: params.referencedOverflowCount,
    };
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
    queuedMutation?: QueuedSessionClientDurableMutation;
    recoveryAttemptedAt?: number;
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
        ...(params.queuedMutation ? { queuedMutation: params.queuedMutation } : {}),
        ...(typeof params.recoveryAttemptedAt === 'number'
            ? { recoveryAttemptedAt: params.recoveryAttemptedAt }
            : {}),
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
    if (fieldId === 'identity.runtimeDescriptor') {
        const parsed = SessionStateRuntimeDescriptorValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'identity.providerSessionId') {
        return parseProviderSessionIdWriteValue(value);
    }
    if (fieldId === 'intent.model') {
        const parsed = SessionStateModelValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'intent.permissionMode') {
        const parsed = SessionStatePermissionModeValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'intent.acpSessionMode') {
        const parsed = SessionStateAcpSessionModeValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'intent.acpConfigOption') {
        const parsed = SessionStateAcpConfigOptionValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'display.title') {
        return parseDisplayTitleWriteValue(value);
    }
    if (fieldId === 'runtime.workState') {
        const parsed = SessionStateWorkStateValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'runtime.activity') {
        const parsed = SessionRuntimeActivityProjectionV1Schema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'runtime.usageLimitRecovery') {
        const parsed = SessionStateUsageLimitRecoveryValueSchema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (fieldId === 'runtime.sessionRunner') {
        const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    }
    if (hasSessionStateFieldMetadataBinding(fieldId)) {
        return { ok: true, value };
    }
    return { ok: false };
}

function parseProviderSessionIdWriteValue(
    value: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
    const parsedValue = SessionStateProviderSessionIdValueSchema.safeParse(value);
    if (parsedValue.success) return { ok: true, value: parsedValue.data };
    if (!isRecord(value)) return { ok: false };

    const metadataKey = typeof value.metadataKey === 'string' && value.metadataKey.trim().length > 0
        ? value.metadataKey.trim()
        : null;
    if (!metadataKey) return { ok: false };
    if (value.value !== null && !SessionStateProviderSessionIdValueSchema.safeParse(value.value).success) {
        return { ok: false };
    }
    return {
        ok: true,
        value: {
            metadataKey,
            value: value.value,
        },
    };
}

function parseDisplayTitleWriteValue(
    value: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
    const parsedTitle = SessionStateTitleValueSchema.safeParse(value);
    if (parsedTitle.success) return { ok: true, value: parsedTitle.data };
    if (!isRecord(value)) return { ok: false };

    const title = SessionStateTitleValueSchema.safeParse(value.title);
    if (!title.success) return { ok: false };

    const parsed: {
        title: string;
        updatedAt?: number;
        staleBehavior?: 'drop' | 'bump-if-value-changed';
        preserveExistingValue?: boolean;
    } = {
        title: title.data,
    };
    if (value.updatedAt !== undefined) {
        if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return { ok: false };
        parsed.updatedAt = value.updatedAt;
    }
    if (value.staleBehavior !== undefined) {
        if (value.staleBehavior !== 'drop' && value.staleBehavior !== 'bump-if-value-changed') return { ok: false };
        parsed.staleBehavior = value.staleBehavior;
    }
    if (value.preserveExistingValue !== undefined) {
        if (typeof value.preserveExistingValue !== 'boolean') return { ok: false };
        parsed.preserveExistingValue = value.preserveExistingValue;
    }
    return { ok: true, value: parsed };
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
            const deadLetters = [createDeadLetterEntry({
                sessionId,
                kind: 'outbox_file',
                reason: 'invalid_outbox_file',
                payload: parsed,
            })];
            await saveSessionClientDurableMutationOutbox(sessionId, []);
            await appendSessionClientDurableMutationDeadLetters(sessionId, deadLetters);
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
            await saveSessionClientDurableMutationOutbox(sessionId, mutations);
            await appendSessionClientDurableMutationDeadLetters(sessionId, deadLetters);
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

async function unlinkIfExists(filePath: string): Promise<void> {
    await unlink(filePath).catch((error) => {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') throw error;
    });
}

export async function saveSessionClientDurableMutationOutbox(
    sessionId: string,
    mutations: readonly QueuedSessionClientDurableMutation[],
): Promise<void> {
    const filePath = resolveSessionClientDurableMutationOutboxPath(sessionId);
    if (mutations.length === 0) {
        await unlinkIfExists(filePath);
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

function readLegacyAuthoritativeDeadLetterMutation(
    entry: SessionClientDurableMutationDeadLetterEntry,
    sessionId: string,
): QueuedSessionClientDurableMutation | null {
    const summary = entry.payloadSummary;
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

    if (entry.kind === 'session_end') {
        return {
            kind: 'session_end',
            mutationId,
            payload: {
                v: 1,
                sessionId: recoveredSessionId,
                mutationId,
                source: 'session_end',
                observedAt: createdAt,
            },
            createdAt,
            attempts,
            nextAttemptAt: 0,
        };
    }
    if (
        entry.kind !== 'session_turn_mutation'
        || !['complete', 'fail', 'cancel', 'end_session'].includes(String(summary.action ?? ''))
    ) {
        return null;
    }
    return {
        kind: 'session_turn_mutation',
        mutationId,
        payload: {
            v: 1,
            sessionId: recoveredSessionId,
            mutationId,
            action: 'end_session',
            observedAt: createdAt,
        },
        createdAt,
        attempts,
        nextAttemptAt: 0,
    };
}

function readRecoverableAuthoritativeDeadLetterMutation(
    entry: SessionClientDurableMutationDeadLetterEntry,
    sessionId: string,
): QueuedSessionClientDurableMutation | null {
    if (!isAuthoritativeSessionClientDurableMutationKind(entry.kind)) return null;
    if (typeof entry.recoveryAttemptedAt === 'number') return null;
    const record = entry as unknown as Record<string, unknown>;
    const rawMutation = record.queuedMutation ?? record.mutation ?? (
        record.payload
            ? {
                kind: entry.kind,
                mutationId: entry.mutationId,
                payload: record.payload,
                createdAt: entry.createdAt,
                attempts: entry.attempts,
                nextAttemptAt: 0,
            }
            : null
    );
    if (rawMutation) {
        const parsed = parseQueuedSessionClientDurableMutation(rawMutation, sessionId);
        const mutation = parsed.mutations[0];
        if (mutation && isAuthoritativeSessionClientDurableMutation(mutation)) {
            return { ...mutation, nextAttemptAt: 0 } as QueuedSessionClientDurableMutation;
        }
    }
    return readLegacyAuthoritativeDeadLetterMutation(entry, sessionId);
}

export async function recoverAuthoritativeSessionClientDurableMutationDeadLetters(
    sessionId: string,
    limit = 100,
): Promise<QueuedSessionClientDurableMutation[]> {
    const filePath = resolveSessionClientDurableMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    if (existing.length === 0) return [];
    const recovered: QueuedSessionClientDurableMutation[] = [];
    const recoveryAttemptedAt = Date.now();
    let changed = false;
    const updated = existing.map((entry) => {
        if (recovered.length >= limit) return entry;
        const mutation = readRecoverableAuthoritativeDeadLetterMutation(entry, sessionId);
        if (!mutation) return entry;
        recovered.push(mutation);
        changed = true;
        return { ...entry, recoveryAttemptedAt };
    });
    if (changed) {
        await writeJsonAtomic(filePath, { v: 1, entries: updated });
    }
    return recovered;
}

export async function loadSessionClientDurableMutationDeadLetters(
    sessionId: string,
): Promise<SessionClientDurableMutationDeadLetterEntry[]> {
    const entries = await loadDeadLetterFile(resolveSessionClientDurableMutationDeadLetterPath(sessionId));
    const referencedPrerequisites = await loadReferencedPrerequisiteMutationIds(sessionId);
    const retained = retainDeadLettersForQueuedPrerequisites({
        entries,
        referencedPrerequisiteMutationIds: referencedPrerequisites.mutationIds,
        ordinaryCap: resolveDeadLetterMaxEntries(),
        referencedOverflowCount: referencedPrerequisites.overflowCount,
    });
    return [...retained.entries];
}

export async function appendSessionClientDurableMutationDeadLetters(
    sessionId: string,
    entries: readonly SessionClientDurableMutationDeadLetterEntry[],
): Promise<Readonly<{
    cappedDeadLetterCount: number;
    referencedRetainedEntryCount: number;
    prunedEntryCount: number;
    referencedPrerequisiteOverflowCount: number;
}>> {
    if (entries.length === 0) {
        return {
            cappedDeadLetterCount: 0,
            referencedRetainedEntryCount: 0,
            prunedEntryCount: 0,
            referencedPrerequisiteOverflowCount: 0,
        };
    }
    const filePath = resolveSessionClientDurableMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    const maxEntries = resolveDeadLetterMaxEntries();
    const referencedPrerequisites = await loadReferencedPrerequisiteMutationIds(sessionId);
    const retained = retainDeadLettersForQueuedPrerequisites({
        entries: [...existing, ...entries],
        referencedPrerequisiteMutationIds: referencedPrerequisites.mutationIds,
        ordinaryCap: maxEntries,
        referencedOverflowCount: referencedPrerequisites.overflowCount,
    });
    await writeJsonAtomic(filePath, {
        v: 1,
        entries: retained.entries,
    } satisfies SessionClientDurableMutationDeadLetterFileV1);
    return {
        cappedDeadLetterCount: retained.cappedDeadLetterCount,
        referencedRetainedEntryCount: retained.referencedRetainedEntryCount,
        prunedEntryCount: retained.prunedEntryCount,
        referencedPrerequisiteOverflowCount: retained.referencedPrerequisiteOverflowCount,
    };
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
        ...(isAuthoritativeSessionClientDurableMutation(params.mutation)
            ? { queuedMutation: params.mutation }
            : {}),
    });
}
