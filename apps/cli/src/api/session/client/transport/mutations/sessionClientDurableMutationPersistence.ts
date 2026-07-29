import { readFile, readdir, unlink } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
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
    SessionTranscriptObservationProvenanceV1Schema,
    ExactSessionTurnEndMutationV1Schema,
    SessionTurnMutationV1Schema,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';
import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol/sessions';

import type {
    QueuedSessionClientDurableMutation,
    PersistedTranscriptMessageAppendMutationV1,
    PersistedVoiceAgentTranscriptTurnMutationV1,
    RegisteredSessionStateFieldMutationV1,
    SessionClientDurableMutationDependency,
    SessionClientDurableMutationPause,
    SessionEndMutationV1,
} from './sessionClientDurableMutationTypes';
import {
    resolveRuntimeActivitySnapshotMutationId,
    resolveTranscriptMessageAppendMutationId,
    resolveVoiceAgentTranscriptTurnMutationId,
} from './sessionClientDurableMutationTypes';
import {
    isAuthoritativeSessionClientDurableMutation,
    isAuthoritativeSessionClientDurableMutationKind,
} from './sessionClientDurableMutationDurabilityPolicy';

type SessionClientDurableMutationOutboxFileV1 = Readonly<{
    v: 1;
    mutations: readonly QueuedSessionClientDurableMutation[];
}>;

export type SessionClientDurableMutationJournalCustody = 'runtime' | 'daemon';

export type SessionClientDurableMutationJournalPaths = Readonly<{
    queuePath: string;
    deadLetterPath: string;
}>;

export type SessionClientDurableMutationPersistenceContext = Readonly<{
    custody: SessionClientDurableMutationJournalCustody;
    sessionId: string;
    paths: SessionClientDurableMutationJournalPaths;
    parseQueuedMutation(value: unknown, expectedSessionId: string): ParseQueuedResult;
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

function encodeSessionIdForDurableMutationJournalFileName(sessionId: string): string {
    if (sessionId.length === 0) {
        throw new Error('Session id cannot be empty in a durable mutation journal filename');
    }
    try {
        let encoded = '';
        for (const character of sessionId) {
            encoded += /[A-Z.!'()*]/u.test(character)
                ? `%${character.charCodeAt(0).toString(16).toUpperCase()}`
                : encodeURIComponent(character);
        }
        return encoded;
    } catch {
        throw new Error('Session id cannot be encoded losslessly in a durable mutation journal filename');
    }
}

function decodeCanonicalSessionIdFromDurableMutationJournalFileName(encodedSessionId: string): string | null {
    if (encodedSessionId.length === 0) return null;
    try {
        const sessionId = decodeURIComponent(encodedSessionId);
        return encodeSessionIdForDurableMutationJournalFileName(sessionId) === encodedSessionId
            ? sessionId
            : null;
    } catch {
        return null;
    }
}

export function resolveSessionClientDurableMutationOutboxPath(sessionId: string): string {
    return resolveSessionClientDurableMutationJournalPaths({
        activeServerDir: configuration.activeServerDir,
        sessionId,
        custody: 'runtime',
    }).queuePath;
}

export function resolveSessionClientDurableMutationDeadLetterPath(sessionId: string): string {
    return resolveSessionClientDurableMutationJournalPaths({
        activeServerDir: configuration.activeServerDir,
        sessionId,
        custody: 'runtime',
    }).deadLetterPath;
}

export function resolveSessionClientDurableMutationJournalPaths(params: Readonly<{
    activeServerDir: string;
    sessionId: string;
    custody: SessionClientDurableMutationJournalCustody;
}>): SessionClientDurableMutationJournalPaths {
    const encodedSessionId = encodeSessionIdForDurableMutationJournalFileName(params.sessionId);
    const baseName = params.custody === 'daemon'
        ? `session-${encodedSessionId}.daemon`
        : `session-${encodedSessionId}`;
    return {
        queuePath: join(params.activeServerDir, 'session-mutations', `${baseName}.json`),
        deadLetterPath: join(params.activeServerDir, 'session-mutations', `${baseName}.dead-letter.json`),
    };
}

export async function discoverDaemonSessionClientDurableMutationJournalSessionIds(
    activeServerDir: string,
): Promise<string[]> {
    const journalDir = join(activeServerDir, 'session-mutations');
    let entries: Dirent<string>[];
    try {
        entries = await readdir(journalDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw error;
    }

    const prefix = 'session-';
    const suffixes = ['.daemon.dead-letter.json', '.daemon.json'] as const;
    const sessionIds = new Set<string>();
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const suffix = suffixes.find((candidate) => entry.name.endsWith(candidate));
        if (!suffix) continue;
        const encodedSessionId = entry.name.slice(prefix.length, -suffix.length);
        const sessionId = decodeCanonicalSessionIdFromDurableMutationJournalFileName(encodedSessionId);
        if (sessionId !== null) sessionIds.add(sessionId);
    }
    return [...sessionIds].sort();
}

export function createSessionClientDurableMutationPersistenceContext(params: Readonly<{
    activeServerDir: string;
    sessionId: string;
    custody: SessionClientDurableMutationJournalCustody;
    parseQueuedMutation(value: unknown, expectedSessionId: string): ParseQueuedResult;
}>): SessionClientDurableMutationPersistenceContext {
    return {
        custody: params.custody,
        sessionId: params.sessionId,
        paths: resolveSessionClientDurableMutationJournalPaths(params),
        parseQueuedMutation: params.parseQueuedMutation,
    };
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
    context?: SessionClientDurableMutationPersistenceContext,
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
        const parsed = JSON.parse(await readFile(
            context?.paths.queuePath ?? resolveSessionClientDurableMutationOutboxPath(sessionId),
            'utf8',
        )) as unknown;
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
        || value === 'voice_agent_transcript_turn'
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

function parseTranscriptMessageAppendPayload(value: unknown): PersistedTranscriptMessageAppendMutationV1 | null {
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
        || value.updatedAt < value.createdAt
        || (value.sidechainId !== undefined && value.sidechainId !== null && typeof value.sidechainId !== 'string')
        || (value.sessionEventType !== undefined && value.sessionEventType !== 'ready')
    ) {
        return null;
    }
    if (value.messageRole !== undefined && !SessionMessageRoleSchema.safeParse(value.messageRole).success) {
        return null;
    }
    if (
        value.provenance !== undefined
        && !SessionTranscriptObservationProvenanceV1Schema.safeParse(value.provenance).success
    ) {
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
    return value as unknown as PersistedTranscriptMessageAppendMutationV1;
}

function parseVoiceAgentTranscriptTurnPayload(value: unknown): PersistedVoiceAgentTranscriptTurnMutationV1 | null {
    if (!isRecord(value)) return null;
    const user = parseTranscriptMessageAppendPayload(value.user);
    const assistant = parseTranscriptMessageAppendPayload(value.assistant);
    if (
        value.v !== 1
        || value.source !== 'voice_agent_transcript_turn'
        || typeof value.sessionId !== 'string'
        || value.sessionId.trim().length === 0
        || typeof value.turnId !== 'string'
        || value.turnId.trim().length === 0
        || typeof value.mutationId !== 'string'
        || typeof value.observedAt !== 'number'
        || !Number.isFinite(value.observedAt)
        || value.observedAt < 0
        || !user
        || !assistant
        || user.sessionId !== value.sessionId
        || assistant.sessionId !== value.sessionId
        || user.messageRole !== 'user'
        || assistant.messageRole !== 'agent'
        || user.localId === assistant.localId
        || value.mutationId !== resolveVoiceAgentTranscriptTurnMutationId({
            sessionId: value.sessionId,
            turnId: value.turnId,
        })
    ) {
        return null;
    }
    return {
        v: 1,
        sessionId: value.sessionId,
        mutationId: value.mutationId,
        source: 'voice_agent_transcript_turn',
        turnId: value.turnId,
        user,
        assistant,
        observedAt: Math.trunc(value.observedAt),
    };
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
        const parsed = SessionRuntimeActivitySnapshotSchema.safeParse(value);
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

export type ParseQueuedResult = Readonly<{
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
    const hasAdmissionOrder = Object.prototype.hasOwnProperty.call(value, 'admissionOrder');
    const admissionOrder = typeof value.admissionOrder === 'number'
        && Number.isSafeInteger(value.admissionOrder)
        && value.admissionOrder > 0
        ? value.admissionOrder
        : null;
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

    if (value.kind === 'voice_agent_transcript_turn') {
        const payload = parseVoiceAgentTranscriptTurnPayload(value.payload);
        if (!payload || mutationId !== payload.mutationId) {
            return {
                mutations: [],
                deadLetters: [createDeadLetterEntry({
                    sessionId,
                    kind: 'voice_agent_transcript_turn',
                    reason: 'invalid_voice_agent_transcript_turn_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                })],
            };
        }
        return { mutations: [{
            kind: 'voice_agent_transcript_turn',
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
        if (hasAdmissionOrder && admissionOrder === null) {
            return {
                mutations: [],
                deadLetters: [createDeadLetterEntry({
                    sessionId,
                    kind: 'registered_session_state_field',
                    reason: 'invalid_registered_session_state_field_admission_order',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value,
                })],
            };
        }
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
        const canonicalMutationId = payload.fieldId === 'runtime.activity'
            ? resolveRuntimeActivitySnapshotMutationId(payload.sessionId)
            : payload.mutationId;
        const canonicalPayload = canonicalMutationId === payload.mutationId
            ? payload
            : { ...payload, mutationId: canonicalMutationId };
        return { mutations: [{
            kind: 'registered_session_state_field',
            mutationId: canonicalMutationId,
            payload: canonicalPayload,
            ...(admissionOrder !== null ? { admissionOrder } : {}),
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

/**
 * Parsed runtime-custody admission. Runtime custody owns ordinary turn work,
 * transcript work, voice transcript work, and non-daemon registered fields.
 * Terminal turn/session mutations and daemon usage recovery are quarantined.
 */
export function parseRuntimeSessionClientDurableMutation(
    value: unknown,
    expectedSessionId: string,
): ParseQueuedResult {
    const parsed = parseQueuedSessionClientDurableMutation(value, expectedSessionId);
    const mutation = parsed.mutations[0];
    if (!mutation) return parsed;
    const belongsToExpectedSession = mutation.payload.sessionId === expectedSessionId;
    const admitted = belongsToExpectedSession && (
        (mutation.kind === 'session_turn_mutation' && mutation.payload.action !== 'end_session')
        || mutation.kind === 'transcript_message_append'
        || mutation.kind === 'voice_agent_transcript_turn'
        || (
            mutation.kind === 'registered_session_state_field'
            && mutation.payload.source !== 'daemon'
            && mutation.payload.fieldId !== 'runtime.usageLimitRecovery'
        )
    );
    if (admitted) return parsed;

    const record = isRecord(value) ? value : null;
    return {
        mutations: [],
        deadLetters: [createDeadLetterEntry({
            sessionId: expectedSessionId,
            kind: mutation.kind,
            reason: 'invalid_runtime_custody_mutation',
            mutationId: typeof record?.mutationId === 'string' ? record.mutationId : mutation.mutationId,
            attempts: mutation.attempts,
            createdAt: mutation.createdAt,
            payload: record?.payload ?? value,
        })],
    };
}

/**
 * Parsed daemon-custody admission. This is deliberately narrower than the
 * runtime journal: daemon custody can contain only exact-turn settlement and
 * the registered usage-limit recovery field.
 */
export function parseDaemonSessionClientDurableMutation(
    value: unknown,
    expectedSessionId: string,
): ParseQueuedResult {
    const parsed = parseQueuedSessionClientDurableMutation(value, expectedSessionId);
    const mutation = parsed.mutations[0];
    if (!mutation) return parsed;
    const rawPayload = isRecord(value) && isRecord(value.payload) ? value.payload : null;
    const exactTurnEnd = ExactSessionTurnEndMutationV1Schema.safeParse(rawPayload);
    const admittedExactTurnEnd = mutation.kind === 'session_turn_mutation'
        && exactTurnEnd.success
        && exactTurnEnd.data.sessionId === expectedSessionId
        && mutation.mutationId === exactTurnEnd.data.mutationId
        && mutation.dependsOn === undefined
        && mutation.paused === undefined;
    const admittedUsageLimitRecovery = mutation.kind === 'registered_session_state_field'
        && mutation.payload.sessionId === expectedSessionId
        && mutation.payload.fieldId === 'runtime.usageLimitRecovery'
        && mutation.payload.source === 'daemon'
        && mutation.payload.deliveryClass === 'durable_required'
        && mutation.mutationId === mutation.payload.mutationId
        && mutation.dependsOn === undefined
        && mutation.paused === undefined;
    if (admittedExactTurnEnd || admittedUsageLimitRecovery) return parsed;

    const record = isRecord(value) ? value : null;
    return {
        mutations: [],
        deadLetters: [createDeadLetterEntry({
            sessionId: expectedSessionId,
            kind: mutation.kind,
            reason: 'invalid_daemon_custody_mutation',
            mutationId: typeof record?.mutationId === 'string' ? record.mutationId : mutation.mutationId,
            attempts: mutation.attempts,
            createdAt: mutation.createdAt,
            payload: record?.payload ?? value,
        })],
    };
}

export async function loadSessionClientDurableMutationOutbox(
    sessionId: string,
    context?: SessionClientDurableMutationPersistenceContext,
): Promise<QueuedSessionClientDurableMutation[]> {
    try {
        const parsed = JSON.parse(await readFile(
            context?.paths.queuePath ?? resolveSessionClientDurableMutationOutboxPath(sessionId),
            'utf8',
        )) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.mutations)) {
            const deadLetters = [createDeadLetterEntry({
                sessionId,
                kind: 'outbox_file',
                reason: 'invalid_outbox_file',
                payload: parsed,
            })];
            await saveSessionClientDurableMutationOutbox(sessionId, [], context);
            await appendSessionClientDurableMutationDeadLetters(sessionId, deadLetters, context);
            return [];
        }
        const mutations: QueuedSessionClientDurableMutation[] = [];
        const deadLetters: SessionClientDurableMutationDeadLetterEntry[] = [];
        for (const rawMutation of parsed.mutations) {
            const parsedMutation = context?.parseQueuedMutation(rawMutation, sessionId)
                ?? parseQueuedSessionClientDurableMutation(rawMutation, sessionId);
            mutations.push(...parsedMutation.mutations);
            deadLetters.push(...parsedMutation.deadLetters);
        }
        if (deadLetters.length > 0) {
            await saveSessionClientDurableMutationOutbox(sessionId, mutations, context);
            await appendSessionClientDurableMutationDeadLetters(sessionId, deadLetters, context);
        }
        return mutations;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') return [];
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
    context?: SessionClientDurableMutationPersistenceContext,
): Promise<void> {
    const filePath = context?.paths.queuePath ?? resolveSessionClientDurableMutationOutboxPath(sessionId);
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
    context?: SessionClientDurableMutationPersistenceContext,
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
        const parsed = context?.parseQueuedMutation(rawMutation, sessionId)
            ?? parseQueuedSessionClientDurableMutation(rawMutation, sessionId);
        const mutation = parsed.mutations[0];
        if (mutation && isAuthoritativeSessionClientDurableMutation(mutation)) {
            return { ...mutation, nextAttemptAt: 0 } as QueuedSessionClientDurableMutation;
        }
    }
    const legacy = readLegacyAuthoritativeDeadLetterMutation(entry, sessionId);
    if (!legacy || !context) return legacy;
    const readmitted = context.parseQueuedMutation(legacy, sessionId);
    const mutation = readmitted.mutations[0];
    return mutation && isAuthoritativeSessionClientDurableMutation(mutation) ? mutation : null;
}

export async function recoverAuthoritativeSessionClientDurableMutationDeadLetters(
    sessionId: string,
    limit = 100,
    context?: SessionClientDurableMutationPersistenceContext,
): Promise<QueuedSessionClientDurableMutation[]> {
    const filePath = context?.paths.deadLetterPath ?? resolveSessionClientDurableMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    if (existing.length === 0) return [];
    const recovered: QueuedSessionClientDurableMutation[] = [];
    for (const entry of existing) {
        if (recovered.length >= limit) break;
        const mutation = readRecoverableAuthoritativeDeadLetterMutation(entry, sessionId, context);
        if (!mutation) continue;
        recovered.push(mutation);
    }
    return recovered;
}

export async function markAuthoritativeSessionClientDurableMutationDeadLettersRecovered(
    sessionId: string,
    mutationIds: readonly string[],
    context?: SessionClientDurableMutationPersistenceContext,
): Promise<void> {
    if (mutationIds.length === 0) return;
    const filePath = context?.paths.deadLetterPath ?? resolveSessionClientDurableMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    if (existing.length === 0) return;
    const recoveredMutationIds = new Set(mutationIds);
    const recoveryAttemptedAt = Date.now();
    let changed = false;
    const updated = existing.map((entry) => {
        if (
            typeof entry.recoveryAttemptedAt === 'number'
            || !entry.mutationId
            || !recoveredMutationIds.has(entry.mutationId)
        ) {
            return entry;
        }
        const mutation = readRecoverableAuthoritativeDeadLetterMutation(entry, sessionId, context);
        if (!mutation) return entry;
        changed = true;
        return { ...entry, recoveryAttemptedAt };
    });
    if (changed) await writeJsonAtomic(filePath, { v: 1, entries: updated });
}

export async function loadSessionClientDurableMutationDeadLetters(
    sessionId: string,
    context?: SessionClientDurableMutationPersistenceContext,
): Promise<SessionClientDurableMutationDeadLetterEntry[]> {
    const entries = await loadDeadLetterFile(
        context?.paths.deadLetterPath ?? resolveSessionClientDurableMutationDeadLetterPath(sessionId),
    );
    const referencedPrerequisites = await loadReferencedPrerequisiteMutationIds(sessionId, context);
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
    context?: SessionClientDurableMutationPersistenceContext,
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
    const filePath = context?.paths.deadLetterPath ?? resolveSessionClientDurableMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    const maxEntries = resolveDeadLetterMaxEntries();
    const referencedPrerequisites = await loadReferencedPrerequisiteMutationIds(sessionId, context);
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
