import { z } from 'zod';
import { canonicalSessionDraftAddressV2, NewSessionDraftDocumentV2Schema, SessionDraftAddressV2Schema, type SessionDraftAddressV2, type SessionDraftDocumentV2, type SessionDraftListResponseV2, type SessionDraftListRequestV2, type SessionDraftMutateRequestV2, type SessionDraftMutateResponseV2, type SessionDraftReadResponseV2, type SessionDraftRecordV2, type SessionDraftStoredContentEnvelopeV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { pluginJsonValuesEqual as areJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { SessionDraftDocumentV1Schema, isMeaningfulSessionDraftRecipientValueV1, type SessionDraftDocumentV1, type SessionDraftExpectedRevisionV1, type StrictJsonValue } from '@happier-dev/protocol/drafts/sessionDrafts';
import { SessionDiscussionSelectionSourceV1Schema, type SessionDiscussionSelectionSourceV1 } from '@happier-dev/protocol/sessions/discussions/content';
import { SYNCED_SESSION_AUTHORING_FIELD_IDS_V2, SyncedSessionAuthoringValueV2Schema, type SyncedSessionAuthoringValueV2 } from '@happier-dev/protocol/sessions/authoring/index';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

import { randomUUID as platformRandomUUID } from '@/platform/randomUUID';
import { log } from '@/log';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftPersistenceStorage } from './sessionDraftPersistenceStorage';
import { isSessionDraftContextUnavailableError } from './sessionDraftCipherError';
import { isSessionDraftEpochUnavailableError } from './sessionDraftEpochError';
import type { NewSessionDraftLocalState } from './newSessionDraftLocalState';
import { getSessionDraftDocumentField as getField, type DraftFieldPathV1 } from './sessionDraftDocumentFields';
import { parseSerializedSessionDraftScope, serializeSessionDraftReplica } from './sessionDraftSerializedScope';
import { clearNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';

export type SessionDraftRepositoryScope = ServerAccountScope;
type NewSessionDraftDocument = SessionDraftDocumentV2 & {
    target: Extract<SessionDraftDocumentV2['target'], { kind: 'newSession' }>;
};
/**
 * `unsupported` is the Home answering that it cannot serve this draft address
 * at all (V2 epoch unavailable). The draft is retained locally exactly like
 * `offline`, but the cause is permanent for this Home, so it carries its own
 * truthful copy instead of the generic sync error.
 */
export type SessionDraftStatus = 'clean' | 'pending' | 'offline' | 'conflict' | 'error' | 'unsupported';
export type SessionDraftMaterializationIntent = 'passiveHydration' | 'userEdit' | 'seeded' | 'launchInterrupted';

type DraftFieldMutationV1 = Readonly<{
    path: DraftFieldPathV1;
    mutationId: string;
    intent: 'edit' | 'clearCaptured';
    baseMutationId: string | null;
    field: Readonly<{ mutationId: string; value: StrictJsonValue }> | null;
}>;

export type SessionDraftLaunchCurrentnessCapture = Readonly<{
    userAttemptId: string;
    currentness: SessionDraftCurrentness;
    /**
     * Spawn configuration timestamp first submitted under this attempt. Reusing
     * the attempt id after a reload must replay the identical Action input.
     */
    configurationUpdatedAtMs?: number;
}>;

export type SessionDiscussionDraftMutationAttempt = Readonly<
    | {
        kind: 'create';
        creationLocalId: string;
        messageLocalId: string;
        currentness: SessionDraftCurrentness;
    }
    | {
        kind: 'post';
        discussionId: string;
        localId: string;
        currentness: SessionDraftCurrentness;
    }
>;
export type SessionDiscussionDraftMutationAttemptInput =
    | Omit<Extract<SessionDiscussionDraftMutationAttempt, { kind: 'create' }>, 'currentness'>
    | Omit<Extract<SessionDiscussionDraftMutationAttempt, { kind: 'post' }>, 'currentness'>;

export type SessionDraftLocalSupplement = Readonly<{
    /** Local action-operation correlation; never sealed or sent to the server. */
    launchUserAttemptId?: string;
    /** Local-only launch CAS token paired to one attempt; never sealed or uploaded. */
    launchCurrentnessCapture?: SessionDraftLaunchCurrentnessCapture;
    /** Crash-stable Discussion retry identity. The synchronized draft owns content. */
    discussionMutationAttempt?: SessionDiscussionDraftMutationAttempt;
    /** Device-local New Session state that must not become part of the synchronized document. */
    newSessionLocalState?: NewSessionDraftLocalState;
    /** Crash-stable identity for the retired singleton new-session draft adapter. */
    legacyNewSessionDraftV1?: true;
    /** Captured legacy existing-session text/value owners exactly once. */
    legacyExistingSessionDraftV1?: true;
}>;

export type SessionDraftConflictField = Readonly<{
    fieldId: string;
    path: DraftFieldPathV1;
    mine: StrictJsonValue | null;
    synced: StrictJsonValue | null;
}>;

export type SessionDraftConflict = Readonly<{
    fields: readonly SessionDraftConflictField[];
}>;

export type SessionDraftSnapshot = Readonly<{
    address: SessionDraftAddressV2;
    document: SessionDraftDocumentV2;
    /** One local atomic document revision shared by mounted and unmounted adapters. */
    revision: number;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    createdAt: number;
    updatedAt: number;
    materialized: boolean;
    localSupplement: SessionDraftLocalSupplement;
}>;

export type ExistingSessionDraftPatch = Readonly<{
    text?: string;
    mentions?: readonly StrictJsonValue[];
    attachments?: readonly StrictJsonValue[];
    routing?: Readonly<{
        recipient?: StrictJsonValue;
        agentContinuation?: StrictJsonValue;
        executionRunRequestedAction?: StrictJsonValue;
    }>;
    sessionDiscussionSelectionSourceV1?: Omit<SessionDiscussionSelectionSourceV1, 'draftCorrelationId'> | null;
    /** The session Git pane's commit message; `null` clears it. */
    scmCommitMessageV1?: string | null;
    /** The session's new pull request form (sidebar or Details); `null` clears it. */
    scmPullRequestV1?: SessionScmPullRequestDraftV1 | null;
}>;

/** A new pull request being written for this session's branch (Git lab PR / PRD). */
export type SessionScmPullRequestDraftV1 = Readonly<{
    title: string;
    body: string;
    draft: boolean;
    /** The branch it merges into; `null` means the provider's default. */
    base: string | null;
}>;

export type SessionScmDraft = Readonly<{
    commitMessage: string;
    pullRequest: SessionScmPullRequestDraftV1 | null;
}>;

const SESSION_SCM_COMMIT_MESSAGE_DRAFT_PATH = Object.freeze({
    kind: 'extension' as const,
    pluginId: 'happier',
    fieldId: 'scmCommitMessageV1',
});
const SESSION_SCM_PULL_REQUEST_DRAFT_PATH = Object.freeze({
    kind: 'extension' as const,
    pluginId: 'happier',
    fieldId: 'scmPullRequestV1',
});
/** Git pane drafts ride on the Session draft but are not a message draft (no session-list mark, kept on send). */
const SESSION_SCM_DRAFT_FIELD_KEYS: ReadonlySet<string> = new Set([
    'extensions.happier.scmCommitMessageV1',
    'extensions.happier.scmPullRequestV1',
]);

const SessionScmPullRequestDraftV1Schema = z.object({
    title: z.string(),
    body: z.string(),
    draft: z.boolean(),
    base: z.string().nullable(),
}).strict();

const EMPTY_SESSION_SCM_DRAFT: SessionScmDraft = Object.freeze({ commitMessage: '', pullRequest: null });

export function readSessionScmDraftFromDraft(document: SessionDraftDocumentV2 | null | undefined): SessionScmDraft {
    const commitMessage = getField(document ?? null, SESSION_SCM_COMMIT_MESSAGE_DRAFT_PATH)?.value;
    const pullRequest = SessionScmPullRequestDraftV1Schema.safeParse(getField(document ?? null, SESSION_SCM_PULL_REQUEST_DRAFT_PATH)?.value);
    if (typeof commitMessage !== 'string' && !pullRequest.success) return EMPTY_SESSION_SCM_DRAFT;
    return {
        commitMessage: typeof commitMessage === 'string' ? commitMessage : '',
        pullRequest: pullRequest.success ? pullRequest.data : null,
    };
}

const SESSION_DISCUSSION_SELECTION_SOURCE_DRAFT_PATH = Object.freeze({
    kind: 'extension' as const,
    pluginId: 'happier',
    fieldId: 'sessionDiscussionSelectionSourceV1',
});

export function readSessionDiscussionSelectionSourceFromDraft(
    document: SessionDraftDocumentV2 | null | undefined,
): Omit<SessionDiscussionSelectionSourceV1, 'draftCorrelationId'> | null {
    const field = getField(document ?? null, SESSION_DISCUSSION_SELECTION_SOURCE_DRAFT_PATH);
    const parsed = SessionDiscussionSelectionSourceV1Schema
        .omit({ draftCorrelationId: true })
        .safeParse(field?.value);
    return parsed.success ? parsed.data : null;
}

export type DiscussionSessionDraftPatch = Readonly<{
    text?: string;
    mentions?: readonly StrictJsonValue[];
    /** New-discussion only; renaming an existing discussion is an Action. */
    title?: string;
}>;

export type NewSessionDraftPatch = Readonly<{
    text?: string;
    mentions?: readonly StrictJsonValue[];
    attachments?: readonly StrictJsonValue[];
    authoring?: Partial<SyncedSessionAuthoringValueV2>;
}>;

export type SessionDraftCurrentness = Readonly<{
    address: SessionDraftAddressV2;
    mutationIds: Readonly<Record<string, string>>;
}>;

export function areSessionDraftCurrentnessCapturesEqual(
    left: SessionDraftCurrentness | null,
    right: SessionDraftCurrentness | null,
): boolean {
    if (!left || !right) return left === right;
    if (canonicalSessionDraftAddressV2(left.address) !== canonicalSessionDraftAddressV2(right.address)) return false;
    const leftEntries = Object.entries(left.mutationIds);
    return leftEntries.length === Object.keys(right.mutationIds).length
        && leftEntries.every(([fieldId, mutationId]) => right.mutationIds[fieldId] === mutationId);
}

export type SessionDraftFlushResult =
    | Readonly<{ status: 'clean' | 'local-only' | 'pending' }>
    | Readonly<{ status: 'conflict' | 'offline' | 'error'; code?: 'session_draft_epoch_unavailable' }>;

export type NewSessionDraftScopeMoveResult = Readonly<{
    status: 'moved' | 'already_moved' | 'source_changed' | 'source_unavailable' | 'target_conflict';
}>;

export type SessionDraftRepositoryScopedRuntime = Readonly<{
    transport: SessionDraftRepositoryTransport;
    cipher: SessionDraftRepositoryCipher;
}>;

export type ExistingSessionDraftProjection = Readonly<{
    /** The draft holds a message (or its routing), not only the Git pane's drafts: the session list marks it. */
    listed: boolean;
    text: string;
    preview: string;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    updatedAt: number;
}>;

/**
 * Whether a kept New Session draft belongs in the user's draft list: it holds
 * authored content, or a launch attempt is still in custody for it. A kept
 * configuration-only draft (an explicit seed, or one whose text was cleared)
 * stays openable by its route but is not listed.
 */
export function isNewSessionDraftListed(draft: Pick<NewSessionDraftProjection, 'document' | 'localSupplement'>): boolean {
    return hasMeaningfulContent(draft.document)
        || (draft.localSupplement.launchUserAttemptId?.trim().length ?? 0) > 0;
}

export type NewSessionDraftProjection = Readonly<{
    draftId: string;
    document: SessionDraftDocumentV2;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    createdAt: number;
    updatedAt: number;
    localSupplement: SessionDraftLocalSupplement;
}>;

export type SessionDraftRepositoryStorage = Readonly<{
    prepare?(): Promise<void>;
    flush?(): Promise<void>;
    getString(key: string): string | undefined;
    set(key: string, value: string): unknown;
    delete(key: string): unknown;
}>;

export type SessionDraftRepositoryTransport = Readonly<{
    read(address: SessionDraftAddressV2): Promise<SessionDraftReadResponseV2>;
    list(request: SessionDraftListRequestV2): Promise<SessionDraftListResponseV2>;
    mutate(request: SessionDraftMutateRequestV2): Promise<SessionDraftMutateResponseV2>;
}>;

export type SessionDraftRepositoryCipher = Readonly<{
    seal(address: SessionDraftAddressV2, document: SessionDraftDocumentV2): Promise<SessionDraftStoredContentEnvelopeV2>;
    open(address: SessionDraftAddressV2, content: SessionDraftStoredContentEnvelopeV2): Promise<SessionDraftDocumentV2 | null>;
}>;

type PersistedReplica = {
    address: SessionDraftAddressV2;
    baseRevision: SessionDraftExpectedRevisionV1;
    baseRawDocument: SessionDraftDocumentV2 | null;
    localRawDocument: SessionDraftDocumentV2 | null;
    documentRevision?: number;
    pendingFieldMutations: DraftFieldMutationV1[];
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    createdAt: number;
    updatedAt: number;
    materialized: boolean;
    deleteWhenEmpty: boolean;
    localSupplement: SessionDraftLocalSupplement;
};

type ScopeState = { loaded: boolean; replicas: Map<string, PersistedReplica>; persistenceError?: boolean; envelopeFields?: Readonly<Record<string, unknown>> };
type Listener = () => void;
type ScopeMutationBatch = {
    originalReplicas: Map<string, PersistedReplica>;
    changedAddresses: Map<string, SessionDraftAddressV2>;
    removedDrafts: Map<string, Readonly<{
        address: SessionDraftAddressV2;
        document: SessionDraftDocumentV2;
        replica: PersistedReplica;
    }>>;
};

type RepositoryOptions = Readonly<{
    storage: SessionDraftRepositoryStorage;
    scope?: SessionDraftRepositoryScope;
    transport?: SessionDraftRepositoryTransport;
    cipher: SessionDraftRepositoryCipher;
    syncEnabled: boolean;
    onDraftRemoved?: (event: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        document: SessionDraftDocumentV2;
    }>) => Promise<void> | void;
    randomUUID?: () => string;
    now?: () => number;
}>;

type RepositoryRuntime = Readonly<{
    epoch: number;
    scopeKey: string | null;
    transport?: SessionDraftRepositoryTransport;
    cipher: SessionDraftRepositoryCipher;
    syncEnabled: boolean;
    onDraftRemoved?: RepositoryOptions['onDraftRemoved'];
}>;

type SyncRepositoryRuntime = RepositoryRuntime & Readonly<{
    transport: SessionDraftRepositoryTransport;
    syncEnabled: true;
}>;

const STORAGE_PREFIX = 'session-drafts-repository-v1';

function isIntrinsicDraftFieldDefault(path: DraftFieldPathV1, value: StrictJsonValue): boolean {
    if (path.kind === 'composer' && path.field === 'text') {
        return typeof value === 'string' && value.trim().length === 0;
    }
    if (path.kind === 'title') return typeof value === 'string' && value.trim().length === 0;
    if (path.kind === 'composer') return Array.isArray(value) && value.length === 0;
    if (path.kind === 'routing') return value === null;
    return false;
}

function areDraftFieldsSemanticallyEqual(
    path: DraftFieldPathV1,
    left: Readonly<{ value: StrictJsonValue }> | null,
    right: Readonly<{ value: StrictJsonValue }> | null,
): boolean {
    if (left && right) return areJsonValuesEqual(left.value, right.value);
    if (!left && !right) return true;
    const present = left ?? right;
    return present !== null && isIntrinsicDraftFieldDefault(path, present.value);
}

function cloneDocument(document: SessionDraftDocumentV2): SessionDraftDocumentV2 {
    return JSON.parse(JSON.stringify(document)) as SessionDraftDocumentV2;
}

function pathKey(path: DraftFieldPathV1): string {
    if (path.kind === 'composer') return `composer.${path.field}`;
    if (path.kind === 'routing') return `target.routing.${path.field}`;
    if (path.kind === 'title') return 'title';
    if (path.kind === 'authoring') return `target.authoring.${path.fieldId}`;
    return `extensions.${path.pluginId}.${path.fieldId}`;
}

function setField(
    document: SessionDraftDocumentV2,
    path: DraftFieldPathV1,
    field: { mutationId: string; value: StrictJsonValue } | null,
): SessionDraftDocumentV2 {
    let next = cloneDocument(document);
    if (path.kind === 'composer') {
        if (field) Object.assign(next.composer[path.field], field);
        return next;
    }
    if (path.kind === 'title') {
        if (!isDiscussionDocument(next)) return next;
        if (field) next.title = { mutationId: field.mutationId, value: String(field.value) };
        else delete next.title;
        return next;
    }
    if (isDiscussionDocument(next)) return next;
    if (path.kind === 'routing') {
        if (next.target.kind === 'session' && field) Object.assign(next.target.routing[path.field], field);
        return next;
    }
    if (path.kind === 'authoring') {
        if (next.target.kind !== 'newSession') return next;
        const authoring: Record<string, unknown> = { ...next.target.authoring };
        if (field) authoring[path.fieldId] = field;
        else delete authoring[path.fieldId];
        const candidate = { ...next, target: { ...next.target, authoring } };
        const retainedV1 = SessionDraftDocumentV1Schema.safeParse(candidate);
        if (retainedV1.success) return retainedV1.data;
        // A genuine successor write upgrades the document once at this owner.
        // Retain only fields the current catalog understands; predecessor-only
        // selections have already been projected into their canonical fields by
        // the current New Session adapter and must not remain a second authority.
        const currentAuthoring: Record<string, unknown> = {};
        for (const fieldId of SYNCED_SESSION_AUTHORING_FIELD_IDS_V2) {
            const candidateField = authoring[fieldId];
            if (!candidateField || typeof candidateField !== 'object' || Array.isArray(candidateField)) continue;
            const value = Reflect.get(candidateField, 'value');
            if (SyncedSessionAuthoringValueV2Schema.shape[fieldId].safeParse(value).success) {
                currentAuthoring[fieldId] = candidateField;
            }
        }
        if (field && !Object.prototype.hasOwnProperty.call(currentAuthoring, path.fieldId)) return next;
        const upgradedV2 = NewSessionDraftDocumentV2Schema.safeParse({
            ...candidate,
            v: 2,
            target: { ...candidate.target, authoring: currentAuthoring },
        });
        return upgradedV2.success ? upgradedV2.data : next;
    }
    const pluginFields = next.extensions[path.pluginId] ?? {};
    if (field) {
        next.extensions[path.pluginId] = { ...pluginFields, [path.fieldId]: field };
    } else {
        const remaining = { ...pluginFields };
        delete remaining[path.fieldId];
        if (Object.keys(remaining).length === 0) delete next.extensions[path.pluginId];
        else next.extensions[path.pluginId] = remaining;
    }
    return next;
}

function isDiscussionDocument(document: SessionDraftDocumentV2): document is Extract<SessionDraftDocumentV2, { title?: unknown }> {
    return document.target.kind === 'discussion' || document.target.kind === 'newDiscussion';
}

function listFieldPaths(document: SessionDraftDocumentV2): DraftFieldPathV1[] {
    const paths: DraftFieldPathV1[] = [
        { kind: 'composer', field: 'text' },
        { kind: 'composer', field: 'mentions' },
        { kind: 'composer', field: 'attachments' },
    ];
    if (isDiscussionDocument(document)) {
        if (document.title) paths.push({ kind: 'title' });
        return paths;
    }
    if (document.target.kind === 'session') {
        paths.push(
            { kind: 'routing', field: 'recipient' },
            { kind: 'routing', field: 'agentContinuation' },
            { kind: 'routing', field: 'executionRunDelivery' },
        );
    } else {
        for (const fieldId of Object.keys(document.target.authoring) as Array<keyof SyncedSessionAuthoringValueV2>) {
            paths.push({ kind: 'authoring', fieldId });
        }
    }
    for (const [pluginId, fields] of Object.entries(document.extensions)) {
        for (const fieldId of Object.keys(fields)) paths.push({ kind: 'extension', pluginId, fieldId });
    }
    return paths;
}

function isNonEmptyArray(value: StrictJsonValue): boolean {
    return Array.isArray(value) && value.length > 0;
}

/**
 * New Session authoring the user would expect to keep on its own. Everything
 * else in `authoring` (Machine, folder, Agent, model, permission, ...) is
 * configuration the composer resolves and autosaves as soon as it opens, so a
 * draft carrying only that is not a draft: it is neither kept nor listed.
 */
function hasNewSessionAuthoredContent(authoring: NewSessionDraftDocument['target']['authoring']): boolean {
    const record = authoring as Readonly<Record<string, { value?: unknown } | undefined>>;
    // A Runner package already exists for this draft; losing the reference would strand it.
    if (record.temporaryComputerActivationRef?.value != null) return true;
    // An Automation definition is authored content, not a resolved default.
    return record.automation?.value != null;
}

/**
 * The one "does this draft hold something the user wrote" decision, used both to
 * keep/sync a draft and to list it. A Run address seeds its own manual recipient
 * so the sealed payload matches the address. That structural selection is not
 * authored content, so an otherwise empty Run draft still deletes when empty.
 */
function hasMeaningfulContent(
    document: SessionDraftDocumentV2,
    address?: SessionDraftAddressV2,
    options?: Readonly<{ excludeScmDrafts?: boolean }>,
): boolean {
    if (document.composer.text.value.trim().length > 0) return true;
    if (isNonEmptyArray(document.composer.mentions.value) || isNonEmptyArray(document.composer.attachments.value)) return true;
    if (isDiscussionDocument(document)) return (document.title?.value.trim().length ?? 0) > 0;
    const counted = (pluginId: string, fieldId: string) => !(options?.excludeScmDrafts && SESSION_SCM_DRAFT_FIELD_KEYS.has(`extensions.${pluginId}.${fieldId}`));
    if (Object.keys(document.extensions).some((pluginId) => Object.keys(document.extensions[pluginId] ?? {}).some((fieldId) => counted(pluginId, fieldId)))) return true;
    if (document.target.kind === 'newSession') return hasNewSessionAuthoredContent(document.target.authoring);
    const recipientIsStructural = address?.kind === 'run'
        && areJsonValuesEqual(document.target.routing.recipient.value, runRecipientValue(address.runId));
    return (!recipientIsStructural && isMeaningfulSessionDraftRecipientValueV1(document.target.routing.recipient.value))
        || document.target.routing.agentContinuation.value !== null
        || document.target.routing.executionRunDelivery.value !== null;
}

function runRecipientValue(runId: string): StrictJsonValue {
    return { mode: 'manual', recipient: { kind: 'execution_run', runId } };
}

function createEmptyDocument(address: SessionDraftAddressV2, randomUUID: () => string): SessionDraftDocumentV2 {
    const field = <T extends StrictJsonValue>(value: T) => ({ mutationId: randomUUID(), value });
    if (address.kind === 'discussion' || address.kind === 'newDiscussion') {
        return {
            v: 2,
            target: { kind: address.kind },
            composer: { text: field(''), mentions: field([]), attachments: field([]) },
        };
    }
    return {
        v: 1,
        composer: { text: field(''), mentions: field([]), attachments: field([]) },
        target: address.kind === 'newSession'
            ? { kind: 'newSession', authoring: {} }
            : { kind: 'session', routing: {
                // A Run draft binds its own run as the manual recipient; the
                // shared V2 payload parser requires that exact correspondence.
                recipient: field(address.kind === 'run' ? runRecipientValue(address.runId) : null),
                agentContinuation: field(null),
                executionRunDelivery: field(null),
            } },
        extensions: {},
    };
}

function addressesEqual(left: SessionDraftAddressV2, right: SessionDraftAddressV2): boolean {
    return canonicalSessionDraftAddressV2(left) === canonicalSessionDraftAddressV2(right);
}

function normalizeLocalSupplement(value: unknown, expectedAddress: SessionDraftAddressV2): SessionDraftLocalSupplement {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const candidate = value as Readonly<Record<string, unknown>>;
    const launchUserAttemptId = typeof candidate.launchUserAttemptId === 'string'
        ? candidate.launchUserAttemptId.trim()
        : '';
    const normalized: {
        launchUserAttemptId?: string;
        launchCurrentnessCapture?: SessionDraftLaunchCurrentnessCapture;
        discussionMutationAttempt?: SessionDiscussionDraftMutationAttempt;
        newSessionLocalState?: NewSessionDraftLocalState;
        legacyNewSessionDraftV1?: true;
        legacyExistingSessionDraftV1?: true;
    } = {};
    if (launchUserAttemptId) normalized.launchUserAttemptId = launchUserAttemptId;
    if (candidate.legacyNewSessionDraftV1 === true) normalized.legacyNewSessionDraftV1 = true;
    if (candidate.legacyExistingSessionDraftV1 === true) normalized.legacyExistingSessionDraftV1 = true;
    const parsedNewSessionLocalState = StrictJsonValueSchema.safeParse(candidate.newSessionLocalState);
    if (
        expectedAddress.kind === 'newSession'
        && parsedNewSessionLocalState.success
        && parsedNewSessionLocalState.data
        && typeof parsedNewSessionLocalState.data === 'object'
        && !Array.isArray(parsedNewSessionLocalState.data)
    ) {
        normalized.newSessionLocalState = parsedNewSessionLocalState.data as unknown as NewSessionDraftLocalState;
    }
    const capture = candidate.launchCurrentnessCapture;
    if (launchUserAttemptId && capture && typeof capture === 'object' && !Array.isArray(capture)) {
        const captureCandidate = capture as Readonly<Record<string, unknown>>;
        const capturedAttemptId = typeof captureCandidate.userAttemptId === 'string' ? captureCandidate.userAttemptId.trim() : '';
        const currentnessCandidate = captureCandidate.currentness;
        if (capturedAttemptId === launchUserAttemptId && currentnessCandidate && typeof currentnessCandidate === 'object' && !Array.isArray(currentnessCandidate)) {
            const currentness = currentnessCandidate as Readonly<Record<string, unknown>>;
            const parsedAddress = SessionDraftAddressV2Schema.safeParse(currentness.address);
            const mutationIds = currentness.mutationIds;
            if (
                parsedAddress.success
                && addressesEqual(parsedAddress.data, expectedAddress)
                && mutationIds && typeof mutationIds === 'object' && !Array.isArray(mutationIds)
                && Object.values(mutationIds).every((id) => typeof id === 'string' && id.length > 0)
            ) {
                const configurationUpdatedAtMs = captureCandidate.configurationUpdatedAtMs;
                normalized.launchCurrentnessCapture = {
                    userAttemptId: capturedAttemptId,
                    currentness: { address: parsedAddress.data, mutationIds: { ...(mutationIds as Readonly<Record<string, string>>) } },
                    ...(typeof configurationUpdatedAtMs === 'number' && Number.isFinite(configurationUpdatedAtMs) && configurationUpdatedAtMs >= 0
                        ? { configurationUpdatedAtMs }
                        : {}),
                };
            }
        }
    }
    const attempt = candidate.discussionMutationAttempt;
    if ((expectedAddress.kind === 'discussion' || expectedAddress.kind === 'newDiscussion')
        && attempt && typeof attempt === 'object' && !Array.isArray(attempt)) {
        const value = attempt as Readonly<Record<string, unknown>>;
        const kind = value.kind;
        const currentnessValue = value.currentness;
        if (currentnessValue && typeof currentnessValue === 'object' && !Array.isArray(currentnessValue)) {
            const currentnessCandidate = currentnessValue as Readonly<Record<string, unknown>>;
            const parsedAddress = SessionDraftAddressV2Schema.safeParse(currentnessCandidate.address);
            const mutationIds = currentnessCandidate.mutationIds;
            const currentness = parsedAddress.success
                && addressesEqual(parsedAddress.data, expectedAddress)
                && mutationIds && typeof mutationIds === 'object' && !Array.isArray(mutationIds)
                && Object.values(mutationIds).every((id) => typeof id === 'string' && id.length > 0)
                ? { address: parsedAddress.data, mutationIds: { ...(mutationIds as Readonly<Record<string, string>>) } }
                : null;
            if (currentness && kind === 'create'
                && expectedAddress.kind === 'newDiscussion'
                && typeof value.creationLocalId === 'string' && value.creationLocalId.trim()
                && typeof value.messageLocalId === 'string' && value.messageLocalId.trim()) {
                normalized.discussionMutationAttempt = {
                    kind,
                    creationLocalId: value.creationLocalId.trim(),
                    messageLocalId: value.messageLocalId.trim(),
                    currentness,
                };
            } else if (currentness && kind === 'post'
                && expectedAddress.kind === 'discussion'
                && typeof value.discussionId === 'string' && value.discussionId.trim() === expectedAddress.discussionId
                && typeof value.localId === 'string' && value.localId.trim()) {
                normalized.discussionMutationAttempt = {
                    kind,
                    discussionId: expectedAddress.discussionId,
                    localId: value.localId.trim(),
                    currentness,
                };
            }
        }
    }
    return normalized;
}

function normalizePreview(text: string): string {
    return text.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ') ?? '';
}

function isPersistedReplica(value: unknown): value is PersistedReplica {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<PersistedReplica>;
    return Boolean(candidate.address && candidate.localRawDocument && Array.isArray(candidate.pendingFieldMutations));
}

export class SessionDraftRepository {
    // Replicas are replaced on writes; unchanged documents need no repeat JSON traversal.
    private readonly serializedReplicas = new WeakMap<PersistedReplica, string>();
    private readonly scopeStates = new Map<string, ScopeState>();
    private readonly listeners = new Map<string, Set<Listener>>();
    private readonly listListeners = new Map<string, Set<Listener>>();
    private readonly flushInFlight = new Map<string, Promise<SessionDraftFlushResult>>();
    private readonly draftRemovalCleanups = new Map<string, Promise<void>>();
    private readonly mutationBatches = new Map<string, ScopeMutationBatch>();
    private readonly snapshotCache = new WeakMap<PersistedReplica, SessionDraftSnapshot>();
    private readonly existingProjectionCache = new WeakMap<PersistedReplica, ExistingSessionDraftProjection | null>();
    private readonly newListProjectionCache = new Map<string, readonly NewSessionDraftProjection[]>();
    /**
     * The last projection of each new-session draft replica. A replica is replaced on every write,
     * so an unchanged replica with an unchanged status keeps its projection object across list
     * rebuilds: every draft row renders from these objects, and a rebuild caused by one draft (or by
     * a repository notification that changed nothing) must not hand every other row a new one.
     */
    private readonly newProjectionCache = new WeakMap<PersistedReplica, NewSessionDraftProjection>();
    /** The last list per scope, reused when a rebuild yields the same projections in the same order. */
    private readonly lastNewListProjection = new Map<string, readonly NewSessionDraftProjection[]>();
    private runtime: RepositoryRuntime;
    private readonly storage: SessionDraftRepositoryStorage;
    private readonly randomUUID: () => string;
    private readonly now: () => number;

    constructor(options: RepositoryOptions) {
        this.storage = options.storage;
        this.runtime = {
            epoch: 0,
            scopeKey: options.scope ? serverAccountScopeKeySuffix(options.scope) : null,
            transport: options.transport,
            cipher: options.cipher,
            syncEnabled: options.syncEnabled,
            onDraftRemoved: options.onDraftRemoved,
        };
        this.randomUUID = options.randomUUID ?? platformRandomUUID;
        this.now = options.now ?? Date.now;
    }

    configure(options: Readonly<{
        scope?: SessionDraftRepositoryScope;
        transport?: SessionDraftRepositoryTransport;
        cipher?: SessionDraftRepositoryCipher;
        syncEnabled: boolean;
        onDraftRemoved?: RepositoryOptions['onDraftRemoved'];
    }>): void {
        this.runtime = {
            epoch: this.runtime.epoch + 1,
            scopeKey: options.scope ? serverAccountScopeKeySuffix(options.scope) : null,
            transport: options.transport,
            cipher: options.cipher ?? this.runtime.cipher,
            syncEnabled: options.syncEnabled,
            onDraftRemoved: options.onDraftRemoved,
        };
    }

    private syncRuntime(scope: SessionDraftRepositoryScope): SyncRepositoryRuntime | null {
        const runtime = this.runtime;
        if (!runtime.syncEnabled || !runtime.transport) return null;
        if (runtime.scopeKey !== null && runtime.scopeKey !== this.scopeKey(scope)) return null;
        return runtime as SyncRepositoryRuntime;
    }

    private isCurrentRuntime(runtime: RepositoryRuntime): boolean {
        return runtime.epoch === this.runtime.epoch;
    }

    private isSyncEnabledForScope(scope: SessionDraftRepositoryScope): boolean {
        return this.syncRuntime(scope) !== null;
    }

    resetForTests(): void {
        this.scopeStates.clear();
        this.listeners.clear();
        this.listListeners.clear();
        this.flushInFlight.clear();
        this.mutationBatches.clear();
        this.draftRemovalCleanups.clear();
        this.newListProjectionCache.clear();
        this.lastNewListProjection.clear();
    }

    private scopeKey(scope: SessionDraftRepositoryScope): string {
        return serverAccountScopeKeySuffix(scope);
    }

    private storageKey(scope: SessionDraftRepositoryScope): string {
        return `${STORAGE_PREFIX}:${this.scopeKey(scope)}`;
    }

    private replicaListenerKey(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): string {
        return `${this.scopeKey(scope)}:${canonicalSessionDraftAddressV2(address)}`;
    }

    private getScopeState(scope: SessionDraftRepositoryScope): ScopeState {
        const scopeKey = this.scopeKey(scope);
        const cached = this.scopeStates.get(scopeKey);
        if (cached) return cached;
        const state: ScopeState = { loaded: true, replicas: new Map() };
        const raw = this.storage.getString(this.storageKey(scope));
        if (raw) {
            try {
                const parsed = parseSerializedSessionDraftScope(raw);
                if (parsed) {
                    const { v: _version, replicas: _replicas, ...envelopeFields } = parsed;
                    state.envelopeFields = envelopeFields;
                    for (const [key, replica] of Object.entries(parsed.replicas)) {
                        if (isPersistedReplica(replica)) {
                            state.replicas.set(key, {
                                ...replica,
                                // V2 omits only exact duplicates; v1 remains readable for existing installs.
                                baseRawDocument: parsed.v === 2 && !Object.prototype.hasOwnProperty.call(replica, 'baseRawDocument')
                                    ? replica.localRawDocument
                                    : replica.baseRawDocument,
                                pendingFieldMutations: replica.pendingFieldMutations.map((mutation) => ({
                                    ...mutation,
                                    field: parsed.v === 2 && !Object.prototype.hasOwnProperty.call(mutation, 'field')
                                        ? getField(replica.localRawDocument, mutation.path)
                                        : mutation.field,
                                    mutationId: typeof mutation.mutationId === 'string'
                                        ? mutation.mutationId
                                        : mutation.field?.mutationId ?? this.randomUUID(),
                                    intent: mutation.intent === 'clearCaptured' ? 'clearCaptured' : 'edit',
                                })),
                                deleteWhenEmpty: replica.deleteWhenEmpty === true,
                                documentRevision: typeof replica.documentRevision === 'number'
                                    && Number.isSafeInteger(replica.documentRevision)
                                    && replica.documentRevision >= 0
                                    ? replica.documentRevision
                                    : 0,
                                localSupplement: normalizeLocalSupplement(replica.localSupplement, replica.address),
                            });
                        }
                    }
                }
            } catch {
                // Preserve the unreadable bytes. A later compatible build may recover them.
            }
        }
        this.scopeStates.set(scopeKey, state);
        return state;
    }

    private persist(scope: SessionDraftRepositoryScope): void {
        const state = this.getScopeState(scope);
        const entries: string[] = [];
        for (const [key, replica] of state.replicas) {
            let serialized = this.serializedReplicas.get(replica);
            if (serialized === undefined) {
                serialized = serializeSessionDraftReplica(replica);
                this.serializedReplicas.set(replica, serialized);
            }
            entries.push(`${JSON.stringify(key)}:${serialized}`);
        }
        const envelope = JSON.stringify({ ...state.envelopeFields, v: 2 });
        this.storage.set(this.storageKey(scope), `${envelope.slice(0, -1)},"replicas":{${entries.join(',')}}}`);
        if (this.storage.flush) {
            // The storage boundary coalesces writes; failures remain visible until a durable retry.
            void Promise.resolve().then(() => this.flushStorage(scope)).catch(() => {});
        }
    }

    private setPersistenceError(scope: SessionDraftRepositoryScope, failed: boolean): void {
        const scopeKey = this.scopeKey(scope);
        const state = this.scopeStates.get(scopeKey);
        if (!state || Boolean(state.persistenceError) === failed) return;
        state.persistenceError = failed;
        this.newListProjectionCache.delete(scopeKey);
        this.notifyBatch(scope, [...state.replicas.values()].map((replica) => replica.address));
    }

    private async flushStorage(scope: SessionDraftRepositoryScope): Promise<void> {
        try {
            await this.storage.flush?.();
            this.setPersistenceError(scope, false);
        } catch (error) {
            this.setPersistenceError(scope, true);
            throw error;
        }
    }

    private projectedStatus(scope: SessionDraftRepositoryScope, replica: PersistedReplica): SessionDraftStatus {
        return this.getScopeState(scope).persistenceError ? 'error' : replica.status;
    }

    private notify(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): void {
        const listenerKey = this.replicaListenerKey(scope, address);
        for (const listener of this.listeners.get(listenerKey) ?? []) listener();
        for (const listener of this.listListeners.get(this.scopeKey(scope)) ?? []) listener();
    }

    private notifyBatch(scope: SessionDraftRepositoryScope, addresses: Iterable<SessionDraftAddressV2>): void {
        for (const address of addresses) {
            const listenerKey = this.replicaListenerKey(scope, address);
            for (const listener of this.listeners.get(listenerKey) ?? []) listener();
        }
        for (const listener of this.listListeners.get(this.scopeKey(scope)) ?? []) listener();
    }

    private recordMutation(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): boolean {
        const batch = this.mutationBatches.get(this.scopeKey(scope));
        if (!batch) return false;
        batch.changedAddresses.set(canonicalSessionDraftAddressV2(address), address);
        return true;
    }

    private publishDraftRemoved(
        scope: SessionDraftRepositoryScope,
        removed: Readonly<{
            address: SessionDraftAddressV2;
            document: SessionDraftDocumentV2;
            replica: PersistedReplica;
        }>,
    ): void {
        const cleanup = this.runtime.onDraftRemoved;
        const key = this.replicaListenerKey(scope, removed.address);
        if (this.draftRemovalCleanups.has(key)) return;
        const pending = Promise.resolve().then(async () => {
            await cleanup?.({ scope, address: removed.address, document: removed.document });
            if (removed.address.kind === 'newSession') {
                clearNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(removed.address.draftId));
            }
        }).catch((error) => {
            // The remote tombstone is already authoritative. Restore only the
            // local retry surface, and never overwrite a newer local draft.
            const state = this.getScopeState(scope);
            const replicaKey = canonicalSessionDraftAddressV2(removed.address);
            if (!state.replicas.has(replicaKey)) {
                state.replicas.set(replicaKey, { ...removed.replica, status: 'error' });
                this.newListProjectionCache.delete(this.scopeKey(scope));
                this.persist(scope);
                this.notify(scope, removed.address);
            }
            throw error;
        });
        this.draftRemovalCleanups.set(key, pending);
        // Callers at authoritative async boundaries await this exact promise.
        // The rejection observer only prevents a transient unhandled rejection
        // while an atomic batch finishes publishing its local state.
        void pending.catch(() => undefined);
    }

    private async awaitDraftRemovalCleanup(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
    ): Promise<void> {
        const key = this.replicaListenerKey(scope, address);
        const pending = this.draftRemovalCleanups.get(key);
        if (!pending) return;
        try {
            await pending;
        } finally {
            if (this.draftRemovalCleanups.get(key) === pending) {
                this.draftRemovalCleanups.delete(key);
            }
        }
    }

    private withAtomicScopeMutation<T>(scope: SessionDraftRepositoryScope, mutate: () => T): T {
        const scopeKey = this.scopeKey(scope);
        if (this.mutationBatches.has(scopeKey)) return mutate();
        const state = this.getScopeState(scope);
        const batch: ScopeMutationBatch = {
            originalReplicas: new Map(state.replicas),
            changedAddresses: new Map(),
            removedDrafts: new Map(),
        };
        this.mutationBatches.set(scopeKey, batch);
        try {
            const result = mutate();
            this.persist(scope);
            this.mutationBatches.delete(scopeKey);
            if (batch.changedAddresses.size > 0) this.notifyBatch(scope, batch.changedAddresses.values());
            for (const [key, removed] of batch.removedDrafts) {
                if (!state.replicas.has(key)) this.publishDraftRemoved(scope, removed);
            }
            return result;
        } catch (error) {
            state.replicas = batch.originalReplicas;
            this.newListProjectionCache.delete(scopeKey);
            this.mutationBatches.delete(scopeKey);
            throw error;
        }
    }

    private writeReplica(scope: SessionDraftRepositoryScope, replica: PersistedReplica): void {
        this.getScopeState(scope).replicas.set(canonicalSessionDraftAddressV2(replica.address), replica);
        this.newListProjectionCache.delete(this.scopeKey(scope));
        if (this.recordMutation(scope, replica.address)) return;
        this.persist(scope);
        this.notify(scope, replica.address);
    }

    private writeLatestReplicaStatus(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
        status: 'offline' | 'error' | 'unsupported',
    ): void {
        const latest = this.readReplica(scope, address);
        if (latest) this.writeReplica(scope, { ...latest, status });
    }

    private deleteReplica(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
        options: Readonly<{ authoritativeRemoval?: boolean }> = {},
    ): void {
        const current = this.readReplica(scope, address);
        const deleted = this.getScopeState(scope).replicas.delete(canonicalSessionDraftAddressV2(address));
        if (!deleted) return;
        this.newListProjectionCache.delete(this.scopeKey(scope));
        if (this.recordMutation(scope, address)) {
            if (options.authoritativeRemoval && current?.localRawDocument) {
                this.mutationBatches.get(this.scopeKey(scope))?.removedDrafts.set(
                    canonicalSessionDraftAddressV2(address),
                    { address, document: current.localRawDocument, replica: current },
                );
            }
            return;
        }
        this.persist(scope);
        this.notify(scope, address);
        if (options.authoritativeRemoval && current?.localRawDocument) {
            this.publishDraftRemoved(scope, { address, document: current.localRawDocument, replica: current });
        }
    }

    private readReplica(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): PersistedReplica | null {
        return this.getScopeState(scope).replicas.get(canonicalSessionDraftAddressV2(address)) ?? null;
    }

    getSessionDraftSnapshot(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): SessionDraftSnapshot | null {
        const replica = this.readReplica(scope, address);
        if (!replica?.localRawDocument) return null;
        const cached = this.snapshotCache.get(replica);
        const status = this.projectedStatus(scope, replica);
        if (cached?.status === status) return cached;
        const snapshot: SessionDraftSnapshot = {
            address: replica.address,
            document: replica.localRawDocument,
            revision: replica.documentRevision ?? 0,
            status,
            conflict: replica.conflict,
            createdAt: replica.createdAt,
            updatedAt: replica.updatedAt,
            materialized: replica.materialized,
            localSupplement: replica.localSupplement,
        };
        this.snapshotCache.set(replica, snapshot);
        return snapshot;
    }

    subscribeSessionDraft(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2, listener: Listener): () => void {
        const key = this.replicaListenerKey(scope, address);
        const listeners = this.listeners.get(key) ?? new Set();
        listeners.add(listener);
        this.listeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listeners.delete(key);
        };
    }

    subscribeSessionDraftList(scope: SessionDraftRepositoryScope, listener: Listener): () => void {
        const key = this.scopeKey(scope);
        const listeners = this.listListeners.get(key) ?? new Set();
        listeners.add(listener);
        this.listListeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listListeners.delete(key);
        };
    }

    private applyWrites(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
        writes: ReadonlyArray<Readonly<{ path: DraftFieldPathV1; value: StrictJsonValue | undefined }>>,
        materializationIntent: SessionDraftMaterializationIntent,
    ): void {
        const existing = this.readReplica(scope, address);
        let document = existing?.localRawDocument ?? createEmptyDocument(address, this.randomUUID);
        let pending = [...(existing?.pendingFieldMutations ?? [])];
        let changed = false;
        for (const write of writes) {
            const previous = getField(document, write.path);
            if (write.value === undefined && !previous) continue;
            if (write.value !== undefined && previous && areJsonValuesEqual(previous.value, write.value)) continue;
            const priorPending = pending.find((mutation) => pathKey(mutation.path) === pathKey(write.path));
            const field = write.value === undefined
                ? null
                : { mutationId: this.randomUUID(), value: write.value };
            const nextDocument = setField(document, write.path, field);
            const appliedField = getField(nextDocument, write.path);
            const didApply = field
                ? appliedField?.mutationId === field.mutationId
                : appliedField === null;
            if (!didApply) continue;
            document = nextDocument;
            pending = pending.filter((mutation) => pathKey(mutation.path) !== pathKey(write.path));
            pending.push({
                path: write.path,
                mutationId: field?.mutationId ?? this.randomUUID(),
                intent: 'edit',
                baseMutationId: priorPending?.baseMutationId ?? getField(existing?.baseRawDocument ?? null, write.path)?.mutationId ?? null,
                field,
            });
            changed = true;
        }
        if (!changed && (existing || materializationIntent === 'passiveHydration')) return;
        const now = this.now();
        const materialized = existing?.materialized === true
            || materializationIntent === 'seeded'
            || materializationIntent === 'launchInterrupted'
            || (materializationIntent === 'userEdit' && (address.kind === 'newSession'
                // Opening the composer autosaves resolved configuration; only
                // authored content turns a New Session into a kept draft.
                ? hasMeaningfulContent(document, address)
                : changed || hasMeaningfulContent(document, address)));
        if (!materialized && address.kind === 'newSession') return;
        const meaningfulContent = hasMeaningfulContent(document, address);
        this.writeReplica(scope, {
            address,
            baseRevision: existing?.baseRevision ?? 'absent',
            baseRawDocument: existing?.baseRawDocument ?? null,
            localRawDocument: document,
            documentRevision: (existing?.documentRevision ?? 0) + (changed ? 1 : 0),
            pendingFieldMutations: pending,
            status: this.isSyncEnabledForScope(scope) ? 'pending' : 'clean',
            conflict: existing?.conflict ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            materialized: address.kind === 'newSession' ? materialized : meaningfulContent,
            deleteWhenEmpty: changed && meaningfulContent ? false : existing?.deleteWhenEmpty ?? false,
            localSupplement: existing?.localSupplement ?? {},
        });
    }

    writeSessionDraftLocalSupplement(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        patch: Readonly<{
            launchUserAttemptId?: string | null;
            discussionMutationAttempt?: SessionDiscussionDraftMutationAttempt | null;
            newSessionLocalState?: NewSessionDraftLocalState | null;
            legacyNewSessionDraftV1?: true | null;
            legacyExistingSessionDraftV1?: true | null;
        }>;
    }>): void {
        const existing = this.readReplica(params.scope, params.address);
        if (!existing) return;
        const nextSupplement = { ...existing.localSupplement };
        if (params.patch.launchUserAttemptId === null) {
            delete nextSupplement.launchUserAttemptId;
            delete nextSupplement.launchCurrentnessCapture;
        } else if (params.patch.launchUserAttemptId !== undefined) {
            const userAttemptId = params.patch.launchUserAttemptId.trim();
            if (!userAttemptId) {
                delete nextSupplement.launchUserAttemptId;
                delete nextSupplement.launchCurrentnessCapture;
            } else {
                nextSupplement.launchUserAttemptId = userAttemptId;
            }
            if (nextSupplement.launchCurrentnessCapture?.userAttemptId !== userAttemptId) {
                delete nextSupplement.launchCurrentnessCapture;
            }
        }
        if (params.patch.newSessionLocalState === null) delete nextSupplement.newSessionLocalState;
        else if (params.patch.newSessionLocalState !== undefined) nextSupplement.newSessionLocalState = params.patch.newSessionLocalState;
        if (params.patch.discussionMutationAttempt === null) delete nextSupplement.discussionMutationAttempt;
        else if (params.patch.discussionMutationAttempt !== undefined) {
            const attempt = params.patch.discussionMutationAttempt;
            if (!addressesEqual(attempt.currentness.address, params.address)) {
                throw new Error('Discussion mutation attempt must belong to its exact draft');
            }
            nextSupplement.discussionMutationAttempt = structuredClone(attempt);
        }
        if (params.patch.legacyNewSessionDraftV1 === null) delete nextSupplement.legacyNewSessionDraftV1;
        else if (params.patch.legacyNewSessionDraftV1 === true) nextSupplement.legacyNewSessionDraftV1 = true;
        if (params.patch.legacyExistingSessionDraftV1 === null) delete nextSupplement.legacyExistingSessionDraftV1;
        else if (params.patch.legacyExistingSessionDraftV1 === true) nextSupplement.legacyExistingSessionDraftV1 = true;
        this.writeReplica(params.scope, { ...existing, localSupplement: nextSupplement });
    }

    /**
     * One writer for the main Session composer draft and for an attached Run's
     * composer draft. The Run destination only selects the synchronized address;
     * the document shape, fields and conflict semantics are unchanged.
     */
    writeExistingSessionDraft(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        sessionId: string;
        runId?: string;
        patch: ExistingSessionDraftPatch;
        materializationIntent?: SessionDraftMaterializationIntent;
    }>): void {
        const writes: Array<{ path: DraftFieldPathV1; value: StrictJsonValue | undefined }> = [];
        if (params.patch.text !== undefined) writes.push({ path: { kind: 'composer', field: 'text' }, value: params.patch.text });
        if (params.patch.mentions !== undefined) writes.push({ path: { kind: 'composer', field: 'mentions' }, value: params.patch.mentions });
        if (params.patch.attachments !== undefined) writes.push({ path: { kind: 'composer', field: 'attachments' }, value: params.patch.attachments });
        if (params.patch.routing?.recipient !== undefined) writes.push({ path: { kind: 'routing', field: 'recipient' }, value: params.patch.routing.recipient });
        if (params.patch.routing?.agentContinuation !== undefined) writes.push({ path: { kind: 'routing', field: 'agentContinuation' }, value: params.patch.routing.agentContinuation });
        if (params.patch.routing?.executionRunRequestedAction !== undefined) {
            writes.push({
                // The released wire field stores the current canonical Pending
                // requested-action value; UI naming does not widen draft V1.
                path: { kind: 'routing', field: 'executionRunDelivery' },
                value: params.patch.routing.executionRunRequestedAction,
            });
        }
        if (params.patch.sessionDiscussionSelectionSourceV1 !== undefined) {
            writes.push({
                path: SESSION_DISCUSSION_SELECTION_SOURCE_DRAFT_PATH,
                value: params.patch.sessionDiscussionSelectionSourceV1 === null
                    ? undefined
                    : StrictJsonValueSchema.parse(params.patch.sessionDiscussionSelectionSourceV1),
            });
        }
        if (params.patch.scmCommitMessageV1 !== undefined) {
            writes.push({
                path: SESSION_SCM_COMMIT_MESSAGE_DRAFT_PATH,
                value: params.patch.scmCommitMessageV1 === null || params.patch.scmCommitMessageV1 === ''
                    ? undefined
                    : params.patch.scmCommitMessageV1,
            });
        }
        if (params.patch.scmPullRequestV1 !== undefined) {
            writes.push({
                path: SESSION_SCM_PULL_REQUEST_DRAFT_PATH,
                value: params.patch.scmPullRequestV1 === null
                    ? undefined
                    : StrictJsonValueSchema.parse(SessionScmPullRequestDraftV1Schema.parse(params.patch.scmPullRequestV1)),
            });
        }
        const address: SessionDraftAddressV2 = params.runId
            ? { kind: 'run', sessionId: params.sessionId, runId: params.runId }
            : { kind: 'session', sessionId: params.sessionId };
        this.applyWrites(params.scope, address, writes, params.materializationIntent ?? 'userEdit');
    }

    /** Human conversation drafts share this repository, cipher and lifecycle. */
    writeDiscussionSessionDraft(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: Extract<SessionDraftAddressV2, { kind: 'discussion' | 'newDiscussion' }>;
        patch: DiscussionSessionDraftPatch;
        materializationIntent?: SessionDraftMaterializationIntent;
    }>): void {
        const writes: Array<{ path: DraftFieldPathV1; value: StrictJsonValue }> = [];
        if (params.patch.text !== undefined) writes.push({ path: { kind: 'composer', field: 'text' }, value: params.patch.text });
        if (params.patch.mentions !== undefined) writes.push({ path: { kind: 'composer', field: 'mentions' }, value: params.patch.mentions });
        if (params.patch.title !== undefined) {
            if (params.address.kind !== 'newDiscussion') {
                throw new Error('Only a new-discussion draft carries a title field');
            }
            writes.push({ path: { kind: 'title' }, value: params.patch.title });
        }
        this.applyWrites(params.scope, params.address, writes, params.materializationIntent ?? 'userEdit');
    }

    writeNewSessionDraft(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        draftId: string;
        patch: NewSessionDraftPatch;
        materializationIntent: SessionDraftMaterializationIntent;
    }>): void {
        const writes: Array<{ path: DraftFieldPathV1; value: StrictJsonValue }> = [];
        if (params.patch.text !== undefined) writes.push({ path: { kind: 'composer', field: 'text' }, value: params.patch.text });
        if (params.patch.mentions !== undefined) writes.push({ path: { kind: 'composer', field: 'mentions' }, value: params.patch.mentions });
        if (params.patch.attachments !== undefined) writes.push({ path: { kind: 'composer', field: 'attachments' }, value: params.patch.attachments });
        for (const [fieldId, value] of Object.entries(params.patch.authoring ?? {})) {
            if (value !== undefined) writes.push({ path: { kind: 'authoring', fieldId: fieldId as keyof SyncedSessionAuthoringValueV2 }, value: value as StrictJsonValue });
        }
        this.applyWrites(params.scope, { kind: 'newSession', draftId: params.draftId }, writes, params.materializationIntent);
    }

    captureSessionDraftCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        fieldIds?: readonly string[];
    }>): SessionDraftCurrentness {
        const document = this.readReplica(params.scope, params.address)?.localRawDocument;
        const included = params.fieldIds ? new Set(params.fieldIds) : null;
        const mutationIds: Record<string, string> = {};
        if (document) {
            for (const path of listFieldPaths(document)) {
                const key = pathKey(path);
                if (included && !included.has(key)) continue;
                const field = getField(document, path);
                if (field) mutationIds[key] = field.mutationId;
            }
        }
        return { address: params.address, mutationIds };
    }

    captureSessionDraftLaunchCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        userAttemptId: string;
        /** Submission-time revisions, captured before asynchronous preparation. */
        currentness?: SessionDraftCurrentness;
        /** Kept only by the first capture of this attempt, like its revisions. */
        configurationUpdatedAtMs?: number;
    }>): SessionDraftCurrentness | null {
        const userAttemptId = params.userAttemptId.trim();
        const replica = this.readReplica(params.scope, params.address);
        if (!userAttemptId || !replica?.localRawDocument) return null;
        if (params.currentness && !addressesEqual(params.currentness.address, params.address)) return null;
        const existing = this.readSessionDraftLaunchCurrentness({ ...params, userAttemptId });
        if (existing) return existing;
        const currentness = structuredClone(params.currentness ?? this.captureSessionDraftCurrentness(params));
        this.writeReplica(params.scope, {
            ...replica,
            localSupplement: {
                ...replica.localSupplement,
                launchUserAttemptId: userAttemptId,
                launchCurrentnessCapture: {
                    userAttemptId,
                    currentness,
                    ...(params.configurationUpdatedAtMs !== undefined
                        ? { configurationUpdatedAtMs: params.configurationUpdatedAtMs }
                        : {}),
                },
            },
        });
        return currentness;
    }

    readSessionDraftLaunchCapture(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        userAttemptId: string;
    }>): SessionDraftLaunchCurrentnessCapture | null {
        const supplement = this.readReplica(params.scope, params.address)?.localSupplement;
        const capture = supplement?.launchCurrentnessCapture;
        return capture
            && supplement?.launchUserAttemptId === params.userAttemptId.trim()
            && capture.userAttemptId === params.userAttemptId.trim()
            && addressesEqual(capture.currentness.address, params.address)
            ? capture
            : null;
    }

    readSessionDraftLaunchCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        userAttemptId: string;
    }>): SessionDraftCurrentness | null {
        return this.readSessionDraftLaunchCapture(params)?.currentness ?? null;
    }

    clearSessionDraftLaunchCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        userAttemptId: string;
    }>): boolean {
        const replica = this.readReplica(params.scope, params.address);
        const capture = replica?.localSupplement.launchCurrentnessCapture;
        const userAttemptId = params.userAttemptId.trim();
        if (!replica || !capture || capture.userAttemptId !== userAttemptId || !addressesEqual(capture.currentness.address, params.address)) {
            return false;
        }
        const localSupplement = { ...replica.localSupplement };
        delete localSupplement.launchCurrentnessCapture;
        if (localSupplement.launchUserAttemptId === userAttemptId) delete localSupplement.launchUserAttemptId;
        this.writeReplica(params.scope, { ...replica, localSupplement });
        return true;
    }

    clearSessionDraftCurrentnessLocal(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        currentness: SessionDraftCurrentness;
        /** Absent clears every field the capture still owns; present narrows it. */
        fieldIds?: readonly string[];
        /**
         * Composer references are ranges into composer text. When captured text
         * is still current, clear the latest reference field with it so a
         * reference-only edit cannot survive against empty text.
         */
        clearComposerReferencesWithCurrentText?: boolean;
    }>): boolean {
        if (!addressesEqual(params.address, params.currentness.address)) return false;
        const replica = this.readReplica(params.scope, params.address);
        if (!replica?.localRawDocument) return false;
        const included = params.fieldIds ? new Set<string>(params.fieldIds) : null;
        let document = replica.localRawDocument;
        let pending = [...replica.pendingFieldMutations];
        let changed = false;
        const capturedTextMutationId = params.currentness.mutationIds['composer.text'];
        const currentTextMutationId = getField(document, { kind: 'composer', field: 'text' })?.mutationId;
        const acceptedComposerTextIsCurrent = params.clearComposerReferencesWithCurrentText === true
            && capturedTextMutationId !== undefined
            && currentTextMutationId === capturedTextMutationId;
        for (const path of listFieldPaths(document)) {
            const key = pathKey(path);
            if (included && !included.has(key)) continue;
            const current = getField(document, path);
            const capturedMutationId = acceptedComposerTextIsCurrent && key === 'composer.mentions'
                ? current?.mutationId
                : params.currentness.mutationIds[key];
            if (!capturedMutationId || current?.mutationId !== capturedMutationId) continue;
            const emptyValue: StrictJsonValue | undefined = path.kind === 'composer'
                ? path.field === 'text' ? '' : []
                : path.kind === 'routing' ? null : undefined;
            const nextField = emptyValue === undefined ? null : { mutationId: this.randomUUID(), value: emptyValue };
            document = setField(document, path, nextField);
            pending = pending.filter((mutation) => pathKey(mutation.path) !== key);
            pending.push({
                path,
                mutationId: nextField?.mutationId ?? this.randomUUID(),
                intent: 'clearCaptured',
                baseMutationId: getField(replica.baseRawDocument, path)?.mutationId ?? null,
                field: nextField,
            });
            changed = true;
        }
        if (!changed) return false;
        const meaningfulContent = hasMeaningfulContent(document, params.address);
        this.writeReplica(params.scope, {
            ...replica,
            localRawDocument: document,
            documentRevision: (replica.documentRevision ?? 0) + 1,
            pendingFieldMutations: pending,
            updatedAt: this.now(),
            status: this.isSyncEnabledForScope(params.scope) ? 'pending' : 'clean',
            conflict: null,
            materialized: meaningfulContent,
            deleteWhenEmpty: !meaningfulContent,
        });
        return true;
    }

    async clearSessionDraftCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        currentness: SessionDraftCurrentness;
        /** Absent clears every field the capture still owns; present narrows it. */
        fieldIds?: readonly string[];
        /** Clear the latest range-bound references when captured text remains current. */
        clearComposerReferencesWithCurrentText?: boolean;
    }>): Promise<boolean> {
        // Capturing currentness already requires readable storage. Keep the local
        // clear synchronous for handoff callers; flush below awaits durability.
        const changed = this.clearSessionDraftCurrentnessLocal(params);
        if (!changed) return false;
        await this.flushSessionDraft({ scope: params.scope, address: params.address });
        return true;
    }

    async deleteSessionDraft(params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV2 }>): Promise<boolean> {
        if (this.storage.prepare) await this.storage.prepare();
        const replica = this.readReplica(params.scope, params.address);
        if (!replica) return false;
        const runtime = this.syncRuntime(params.scope);
        if (!runtime) {
            if (this.runtime.syncEnabled) return false;
            this.deleteReplica(params.scope, params.address, { authoritativeRemoval: true });
            await this.awaitDraftRemovalCleanup(params.scope, params.address);
            if (this.storage.flush) await this.flushStorage(params.scope);
            return true;
        }
        return this.deleteSessionDraftWithScopedRuntime({
            ...params,
            runtime,
            isCurrent: () => this.isCurrentRuntime(runtime),
        });
    }

    /** Tombstones one exact scoped draft without changing the configured singleton runtime. */
    async deleteSessionDraftWithScopedRuntime(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        runtime: SessionDraftRepositoryScopedRuntime;
        isCurrent: () => boolean;
    }>): Promise<boolean> {
        if (this.storage.prepare) await this.storage.prepare();
        const replica = this.readReplica(params.scope, params.address);
        if (!replica || !params.isCurrent()) return false;
        let result: SessionDraftMutateResponseV2;
        try {
            result = await params.runtime.transport.mutate({
                address: params.address,
                expectedRevision: replica.baseRevision,
                content: null,
            });
        } catch (error) {
            if (!params.isCurrent()) return false;
            this.writeLatestReplicaStatus(params.scope, params.address, 'offline');
            throw error;
        }
        if (!params.isCurrent()) return false;
        if (result.status === 'updated') {
            this.deleteReplica(params.scope, params.address, { authoritativeRemoval: true });
        } else {
            await this.materializeExactWithScopedRuntime({
                scope: params.scope,
                address: params.address,
                runtime: params.runtime,
                isCurrent: params.isCurrent,
                flushRebasedLocalMutations: () => this.flushSessionDraftWithScopedRuntime(params).then(() => undefined),
            });
        }
        await this.awaitDraftRemovalCleanup(params.scope, params.address);
        if (!params.isCurrent()) return false;
        if (this.storage.flush) await this.flushStorage(params.scope);
        return result.status === 'updated';
    }

    /**
     * Transfers one New Session draft between Account scopes before a scoped
     * launch. The destination is committed first; the source is tombstoned only
     * by its exact revision. A retry may update only the destination replica
     * this repository previously adopted, so another Account's same-id draft
     * can never be overwritten by inference.
     */
    async moveNewSessionDraftToScope(params: Readonly<{
        sourceScope: SessionDraftRepositoryScope;
        targetScope: SessionDraftRepositoryScope;
        draftId: string;
        target: SessionDraftRepositoryScopedRuntime;
    }>): Promise<NewSessionDraftScopeMoveResult> {
        const address = SessionDraftAddressV2Schema.parse({ kind: 'newSession', draftId: params.draftId });
        if (this.scopeKey(params.sourceScope) === this.scopeKey(params.targetScope)) {
            return { status: 'already_moved' };
        }
        if (this.storage.prepare) await this.storage.prepare();
        const sourceRuntime = this.syncRuntime(params.sourceScope);
        if (!sourceRuntime) return { status: 'source_unavailable' };

        const sourceFlush = await this.flushSessionDraft({ scope: params.sourceScope, address });
        if (sourceFlush.status !== 'clean') return { status: 'source_unavailable' };
        if (!this.isCurrentRuntime(sourceRuntime)) return { status: 'source_unavailable' };

        const source = this.readReplica(params.sourceScope, address);
        const adoptedTarget = this.readReplica(params.targetScope, address);
        if (!source?.localRawDocument) {
            return adoptedTarget?.localRawDocument ? { status: 'already_moved' } : { status: 'source_unavailable' };
        }
        if (source.pendingFieldMutations.length > 0 || source.conflict) return { status: 'source_unavailable' };

        const targetRead = await params.target.transport.read(address);
        const targetRecord = targetRead.status === 'absent' ? null : targetRead.record;
        const targetDocument = targetRead.status === 'present'
            ? await this.openRequiredDocument(params.target, targetRead.record)
            : null;
        const targetIsOwnedRetry = Boolean(
            adoptedTarget
            && adoptedTarget.pendingFieldMutations.length === 0
            && !adoptedTarget.conflict
            && areJsonValuesEqual(adoptedTarget.baseRawDocument, targetDocument),
        );
        const targetAlreadyMatches = targetDocument !== null
            && areJsonValuesEqual(targetDocument, source.localRawDocument);
        if (targetDocument !== null && !targetAlreadyMatches && !targetIsOwnedRetry) {
            return { status: 'target_conflict' };
        }

        let committedTargetRecord = targetRecord;
        if (!targetAlreadyMatches) {
            const sealed = await params.target.cipher.seal(address, source.localRawDocument);
            const targetWrite = await params.target.transport.mutate({
                address,
                expectedRevision: targetRecord?.revision ?? 'absent',
                content: sealed,
            });
            if (targetWrite.status !== 'updated') return { status: 'target_conflict' };
            committedTargetRecord = targetWrite.record;
        }
        if (!committedTargetRecord || committedTargetRecord.content === null) return { status: 'target_conflict' };

        this.writeReplica(params.targetScope, {
            ...source,
            address,
            baseRevision: committedTargetRecord.revision,
            baseRawDocument: cloneDocument(source.localRawDocument),
            localRawDocument: cloneDocument(source.localRawDocument),
            pendingFieldMutations: [],
            status: 'clean',
            conflict: null,
            createdAt: committedTargetRecord.createdAt,
            updatedAt: committedTargetRecord.updatedAt,
            deleteWhenEmpty: false,
        });
        if (this.storage.flush) await this.flushStorage(params.targetScope);

        if (this.readReplica(params.sourceScope, address) !== source) {
            return { status: 'source_changed' };
        }
        const sourceDelete = await sourceRuntime.transport.mutate({
            address,
            expectedRevision: source.baseRevision,
            content: null,
        });
        if (!this.isCurrentRuntime(sourceRuntime)) return { status: 'source_unavailable' };
        if (sourceDelete.status !== 'updated') {
            await this.rebaseConflict(
                sourceRuntime,
                () => this.isCurrentRuntime(sourceRuntime),
                params.sourceScope,
                address,
                source,
                sourceDelete.current,
            );
            if (this.storage.flush) await this.flushStorage(params.sourceScope);
            return { status: 'source_changed' };
        }
        if (this.readReplica(params.sourceScope, address) !== source) {
            const latest = this.readReplica(params.sourceScope, address);
            if (latest) {
                this.writeReplica(params.sourceScope, {
                    ...latest,
                    baseRevision: sourceDelete.record.revision,
                    baseRawDocument: null,
                    pendingFieldMutations: latest.pendingFieldMutations.map((mutation) => ({
                        ...mutation,
                        baseMutationId: null,
                    })),
                    status: 'pending',
                    conflict: null,
                });
            }
            if (this.storage.flush) await this.flushStorage(params.sourceScope);
            return { status: 'source_changed' };
        }
        // The draft still exists under the target Account. Do not publish an
        // authoritative removal that would discard its local attachment custody.
        this.deleteReplica(params.sourceScope, address);
        if (this.storage.flush) await this.flushStorage(params.sourceScope);
        return { status: 'moved' };
    }

    /** Purges local decrypted presentation after authoritative access loss. */
    async purgeSessionDraftPresentation(params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV2 }>): Promise<void> {
        this.deleteReplica(params.scope, params.address);
        if (this.storage.flush) await this.flushStorage(params.scope);
    }

    flushSessionDraft(params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV2 }>): Promise<SessionDraftFlushResult> {
        const key = this.replicaListenerKey(params.scope, params.address);
        const existing = this.flushInFlight.get(key);
        if (existing) return existing;
        const promise = this.flushLoop(params).then(async (result) => {
            await this.awaitDraftRemovalCleanup(params.scope, params.address);
            if (this.storage.flush) await this.flushStorage(params.scope);
            return result;
        }).finally(() => this.flushInFlight.delete(key));
        this.flushInFlight.set(key, promise);
        return promise;
    }

    private flushSessionDraftWithScopedRuntime(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        runtime: SessionDraftRepositoryScopedRuntime;
        isCurrent: () => boolean;
    }>): Promise<SessionDraftFlushResult> {
        const key = this.replicaListenerKey(params.scope, params.address);
        const existing = this.flushInFlight.get(key);
        if (existing) return existing;
        const promise = this.flushLoop(params, { runtime: params.runtime, isCurrent: params.isCurrent }).then(async (result) => {
            await this.awaitDraftRemovalCleanup(params.scope, params.address);
            if (this.storage.flush) await this.flushStorage(params.scope);
            return result;
        }).finally(() => this.flushInFlight.delete(key));
        this.flushInFlight.set(key, promise);
        return promise;
    }

    private async flushLoop(
        params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV2 }>,
        scoped?: Readonly<{ runtime: SessionDraftRepositoryScopedRuntime; isCurrent: () => boolean }>,
    ): Promise<SessionDraftFlushResult> {
        if (this.storage.prepare) await this.storage.prepare();
        // Preserve the pending recovery document before sending or clearing it.
        if (this.storage.flush) await this.flushStorage(params.scope);
        const runtime = scoped?.runtime ?? this.syncRuntime(params.scope);
        if (!runtime) {
            if (this.runtime.syncEnabled) return { status: 'pending' };
            const replica = this.readReplica(params.scope, params.address);
            if (replica?.deleteWhenEmpty) this.deleteReplica(params.scope, params.address);
            else if (replica) this.writeReplica(params.scope, { ...replica, status: 'clean' });
            return { status: 'local-only' };
        }
        const isCurrent = scoped?.isCurrent ?? (() => this.isCurrentRuntime(runtime as SyncRepositoryRuntime));
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const replica = this.readReplica(params.scope, params.address);
            if (!replica?.localRawDocument && !replica?.deleteWhenEmpty) return { status: 'clean' };
            if (replica.conflict) return { status: 'conflict' };
            if (replica.status === 'clean' && replica.pendingFieldMutations.length === 0 && !replica.deleteWhenEmpty) {
                return { status: 'clean' };
            }
            const submittedDocument = replica.localRawDocument ? cloneDocument(replica.localRawDocument) : null;
            const submittedMutations = [...replica.pendingFieldMutations];
            const shouldTombstone = replica.deleteWhenEmpty
                || (submittedDocument !== null
                    && !hasMeaningfulContent(submittedDocument, params.address)
                    && params.address.kind !== 'newSession');
            let content: SessionDraftStoredContentEnvelopeV2 | null;
            try {
                content = shouldTombstone ? null : await runtime.cipher.seal(params.address, submittedDocument!);
            } catch {
                if (!isCurrent()) return { status: 'pending' };
                this.writeLatestReplicaStatus(params.scope, params.address, 'error');
                return { status: 'error' };
            }
            if (!isCurrent()) return { status: 'pending' };
            let response: SessionDraftMutateResponseV2;
            try {
                response = await runtime.transport.mutate({
                    address: params.address,
                    expectedRevision: replica.baseRevision,
                    content,
                });
            } catch (error) {
                if (!isCurrent()) return { status: 'pending' };
                if (isSessionDraftEpochUnavailableError(error)) {
                    this.writeLatestReplicaStatus(params.scope, params.address, 'unsupported');
                    return { status: 'error', code: 'session_draft_epoch_unavailable' };
                }
                this.writeLatestReplicaStatus(params.scope, params.address, 'offline');
                return { status: 'offline' };
            }
            if (!isCurrent()) return { status: 'pending' };
            if (response.status === 'updated') {
                if (response.record.content === null) {
                    const latest = this.readReplica(params.scope, params.address) ?? replica;
                    const acknowledged = new Map(submittedMutations.map((mutation) => [pathKey(mutation.path), mutation.mutationId]));
                    const remaining = latest.pendingFieldMutations
                        .filter((mutation) => acknowledged.get(pathKey(mutation.path)) !== mutation.mutationId)
                        .map((mutation) => acknowledged.has(pathKey(mutation.path))
                            ? { ...mutation, baseMutationId: null }
                            : mutation);
                    if (!latest.localRawDocument || !hasMeaningfulContent(latest.localRawDocument, params.address) || remaining.length === 0) {
                        this.deleteReplica(params.scope, params.address, { authoritativeRemoval: true });
                        return { status: 'clean' };
                    }
                    this.writeReplica(params.scope, {
                        ...latest,
                        baseRevision: response.record.revision,
                        baseRawDocument: null,
                        pendingFieldMutations: remaining,
                        status: 'pending',
                        conflict: null,
                        createdAt: response.record.createdAt,
                    });
                    continue;
                }
                const latest = this.readReplica(params.scope, params.address) ?? replica;
                const acknowledged = new Map(submittedMutations.map((mutation) => [pathKey(mutation.path), mutation.mutationId]));
                const remaining = latest.pendingFieldMutations
                    .filter((mutation) => acknowledged.get(pathKey(mutation.path)) !== mutation.mutationId)
                    .map((mutation) => acknowledged.has(pathKey(mutation.path))
                        ? {
                            ...mutation,
                            baseMutationId: getField(submittedDocument, mutation.path)?.mutationId ?? null,
                        }
                        : mutation);
                this.writeReplica(params.scope, {
                    ...latest,
                    baseRevision: response.record.revision,
                    baseRawDocument: submittedDocument,
                    pendingFieldMutations: remaining,
                    status: remaining.length > 0 ? 'pending' : 'clean',
                    conflict: null,
                    createdAt: response.record.createdAt,
                    updatedAt: remaining.length > 0 ? latest.updatedAt : response.record.updatedAt,
                });
                if (remaining.length === 0) return { status: 'clean' };
                continue;
            }
            const rebased = await this.rebaseConflict(runtime, isCurrent, params.scope, params.address, replica, response.current);
            if (rebased === 'stale') return { status: 'pending' };
            if (rebased === 'conflict') return { status: 'conflict' };
            if (rebased === 'error') return { status: 'error' };
            const latest = this.readReplica(params.scope, params.address);
            if (!latest?.pendingFieldMutations.length) return { status: 'clean' };
        }
        const replica = this.readReplica(params.scope, params.address);
        if (replica) this.writeReplica(params.scope, { ...replica, status: 'pending' });
        return { status: 'pending' };
    }

    private async rebaseConflict(
        runtime: Readonly<{ cipher: SessionDraftRepositoryCipher }>,
        isCurrent: () => boolean,
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
        replica: PersistedReplica,
        current: SessionDraftRecordV2 | Readonly<{ status: 'absent' }>,
    ): Promise<'rebased' | 'conflict' | 'error' | 'stale'> {
        const remoteRecord = 'status' in current ? null : current;
        const remoteDocument = remoteRecord?.content ? await runtime.cipher.open(address, remoteRecord.content) : null;
        if (!isCurrent()) return 'stale';
        const latestReplica = this.readReplica(scope, address) ?? replica;
        if (remoteRecord?.content && !remoteDocument) {
            this.writeReplica(scope, { ...latestReplica, status: 'error' });
            return 'error';
        }
        return this.rebaseConflictWithDocument(scope, address, latestReplica, remoteRecord, remoteDocument);
    }

    private rebaseConflictWithDocument(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
        replica: PersistedReplica,
        remoteRecord: SessionDraftRecordV2 | null,
        remoteDocument: SessionDraftDocumentV2 | null,
    ): 'rebased' | 'conflict' {
        let localDocument = remoteDocument ?? createEmptyDocument(address, this.randomUUID);
        const remaining: DraftFieldMutationV1[] = [];
        const conflicts: SessionDraftConflictField[] = [];
        for (const mutation of replica.pendingFieldMutations) {
            const remoteField = getField(remoteDocument, mutation.path);
            if (remoteField?.mutationId === mutation.baseMutationId || (!remoteField && mutation.baseMutationId === null)) {
                localDocument = setField(localDocument, mutation.path, mutation.field);
                remaining.push(mutation);
                continue;
            }
            if (mutation.intent === 'clearCaptured') {
                localDocument = setField(localDocument, mutation.path, remoteField);
                continue;
            }
            if (areDraftFieldsSemanticallyEqual(mutation.path, remoteField, mutation.field)) {
                localDocument = setField(localDocument, mutation.path, remoteField);
                continue;
            }
            localDocument = setField(localDocument, mutation.path, mutation.field);
            remaining.push(mutation);
            conflicts.push({
                fieldId: pathKey(mutation.path),
                path: mutation.path,
                mine: mutation.field?.value ?? null,
                synced: remoteField?.value ?? null,
            });
        }
        const meaningfulContent = hasMeaningfulContent(localDocument, address);
        if (remoteDocument === null && remaining.length === 0 && conflicts.length === 0 && !meaningfulContent) {
            this.deleteReplica(scope, address, { authoritativeRemoval: true });
            return 'rebased';
        }
        const documentChanged = !areJsonValuesEqual(replica.localRawDocument, localDocument);
        this.writeReplica(scope, {
            ...replica,
            baseRevision: remoteRecord?.revision ?? 'absent',
            baseRawDocument: remoteDocument,
            localRawDocument: localDocument,
            documentRevision: (replica.documentRevision ?? 0) + (documentChanged ? 1 : 0),
            pendingFieldMutations: remaining,
            status: conflicts.length > 0 ? 'conflict' : remaining.length > 0 ? 'pending' : 'clean',
            conflict: conflicts.length > 0 ? { fields: conflicts } : null,
            createdAt: remoteRecord?.createdAt ?? replica.createdAt,
            updatedAt: Math.max(remoteRecord?.updatedAt ?? 0, replica.updatedAt),
            materialized: address.kind === 'newSession' ? meaningfulContent || replica.materialized : meaningfulContent,
            deleteWhenEmpty: remaining.some((mutation) => mutation.intent === 'clearCaptured') && !meaningfulContent,
        });
        return conflicts.length > 0 ? 'conflict' : 'rebased';
    }

    async resolveSessionDraftConflict(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        fieldId: string;
        action: 'useSynced' | 'keepDevice';
    }>): Promise<void> {
        if (this.storage.prepare) await this.storage.prepare();
        const replica = this.readReplica(params.scope, params.address);
        const conflict = replica?.conflict;
        const conflictField = conflict?.fields.find((field) => field.fieldId === params.fieldId);
        if (!replica?.localRawDocument || !conflict || !conflictField) return;
        let document = replica.localRawDocument;
        const conflictedMutation = replica.pendingFieldMutations.find((mutation) => pathKey(mutation.path) === params.fieldId);
        let pending = replica.pendingFieldMutations.filter((mutation) => pathKey(mutation.path) !== params.fieldId);
        const remoteField = getField(replica.baseRawDocument, conflictField.path);
        if (params.action === 'useSynced') {
            document = setField(document, conflictField.path, remoteField);
        } else {
            const mine = getField(document, conflictField.path);
            if (mine || conflictedMutation?.field === null) {
                const nextField = mine ? { mutationId: this.randomUUID(), value: mine.value } : null;
                document = setField(document, conflictField.path, nextField);
                pending.push({
                    path: conflictField.path,
                    mutationId: nextField?.mutationId ?? this.randomUUID(),
                    intent: 'edit',
                    baseMutationId: remoteField?.mutationId ?? null,
                    field: nextField,
                });
            }
        }
        const remainingConflicts = conflict.fields.filter((field) => field.fieldId !== params.fieldId);
        if (
            params.action === 'useSynced'
            && remainingConflicts.length === 0
            && pending.length === 0
            && replica.baseRevision === 'absent'
            && replica.baseRawDocument === null
        ) {
            this.deleteReplica(params.scope, params.address, { authoritativeRemoval: true });
            await this.awaitDraftRemovalCleanup(params.scope, params.address);
            if (this.storage.flush) await this.flushStorage(params.scope);
            return;
        }
        this.writeReplica(params.scope, {
            ...replica,
            localRawDocument: document,
            documentRevision: (replica.documentRevision ?? 0) + 1,
            pendingFieldMutations: pending,
            conflict: remainingConflicts.length > 0 ? { fields: remainingConflicts } : null,
            status: remainingConflicts.length > 0 ? 'conflict' : pending.length > 0 ? 'pending' : 'clean',
            updatedAt: this.now(),
        });
        if (remainingConflicts.length === 0 && pending.length > 0) await this.flushSessionDraft({ scope: params.scope, address: params.address });
        if (this.storage.flush) await this.flushStorage(params.scope);
    }

    async materializeExact(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): Promise<void> {
        const runtime = this.syncRuntime(scope);
        if (!runtime) return;
        await this.materializeExactWithScopedRuntime({
            scope,
            address,
            runtime,
            isCurrent: () => this.isCurrentRuntime(runtime),
            flushRebasedLocalMutations: () => this.flushSessionDraft({ scope, address }).then(() => undefined),
        });
    }

    /** Uses an invocation-owned exact Home transport without reconfiguring the singleton runtime. */
    async materializeExactWithScopedRuntime(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV2;
        runtime: SessionDraftRepositoryScopedRuntime;
        isCurrent: () => boolean;
        flushRebasedLocalMutations?: () => Promise<void>;
    }>): Promise<void> {
        if (this.storage.prepare) await this.storage.prepare();
        const activeFlush = this.flushInFlight.get(this.replicaListenerKey(params.scope, params.address));
        if (activeFlush) await activeFlush;
        if (!params.isCurrent()) return;
        let response: SessionDraftReadResponseV2;
        try {
            response = await params.runtime.transport.read(params.address);
        } catch (error) {
            if (!params.isCurrent()) return;
            this.writeLatestReplicaStatus(params.scope, params.address, 'offline');
            throw error;
        }
        if (!params.isCurrent()) return;
        let remoteDocument: SessionDraftDocumentV2 | null = null;
        if (response.status === 'present') {
            try {
                remoteDocument = await this.openRequiredDocument(params.runtime, response.record);
            } catch (error) {
                if (!params.isCurrent()) return;
                if (isSessionDraftContextUnavailableError(error)) throw error;
                this.writeLatestReplicaStatus(params.scope, params.address, 'error');
                throw error;
            }
            if (!params.isCurrent()) return;
        }
        const shouldFlush = this.reconcileStagedRead(params.scope, params.address, response, remoteDocument);
        await this.awaitDraftRemovalCleanup(params.scope, params.address);
        if (shouldFlush) await params.flushRebasedLocalMutations?.();
        if (!params.isCurrent()) return;
        if (this.storage.flush) await this.flushStorage(params.scope);
    }

    private async openRequiredDocument(
        runtime: Readonly<{ cipher: SessionDraftRepositoryCipher }>,
        record: SessionDraftRecordV2,
    ): Promise<SessionDraftDocumentV2> {
        if (!record.content) throw new Error(`Session draft ${canonicalSessionDraftAddressV2(record.address)} has no active content`);
        const document = await runtime.cipher.open(record.address, record.content);
        if (!document) throw new Error(`Unable to open session draft ${canonicalSessionDraftAddressV2(record.address)}`);
        return document;
    }

    private reconcileStagedRead(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV2,
        response: SessionDraftReadResponseV2,
        remoteDocument: SessionDraftDocumentV2 | null,
    ): boolean {
        const local = this.readReplica(scope, address);
        if (
            local
            && local.baseRevision !== 'absent'
            && response.status !== 'absent'
            && response.record.revision < local.baseRevision
        ) {
            return false;
        }
        if (response.status === 'absent') {
            if (!local) return false;
            if (local.baseRevision === 'absent') {
                if (local.deleteWhenEmpty) this.deleteReplica(scope, address);
                return local.pendingFieldMutations.length > 0 && !local.deleteWhenEmpty;
            }
            if (local.pendingFieldMutations.length === 0 || !local.localRawDocument || !hasMeaningfulContent(local.localRawDocument, address)) {
                this.deleteReplica(scope, address, { authoritativeRemoval: true });
                return false;
            }
            const conflicts = local.pendingFieldMutations.map((mutation): SessionDraftConflictField => ({
                fieldId: pathKey(mutation.path),
                path: mutation.path,
                mine: mutation.field?.value ?? null,
                synced: null,
            }));
            this.writeReplica(scope, {
                ...local,
                baseRevision: 'absent',
                baseRawDocument: null,
                status: 'conflict',
                conflict: { fields: conflicts },
            });
            return false;
        }
        if (response.status === 'deleted') {
            if (!local?.pendingFieldMutations.length) {
                this.deleteReplica(scope, address, { authoritativeRemoval: true });
            } else {
                this.rebaseConflictWithDocument(scope, address, local, response.record, null);
            }
            return false;
        }
        if (!remoteDocument) {
            if (local) this.writeReplica(scope, { ...local, status: 'error' });
            throw new Error(`Unable to open session draft ${canonicalSessionDraftAddressV2(address)}`);
        }
        if (!local) {
            this.adoptRemote(scope, response.record, remoteDocument);
            return false;
        }
        if (local.pendingFieldMutations.length > 0) {
            this.rebaseConflictWithDocument(scope, address, local, response.record, remoteDocument);
            const rebased = this.readReplica(scope, address);
            return Boolean(rebased && !rebased.conflict && rebased.pendingFieldMutations.length > 0);
        }
        this.adoptRemote(scope, response.record, remoteDocument, local.localSupplement);
        return false;
    }

    private adoptRemote(
        scope: SessionDraftRepositoryScope,
        record: SessionDraftRecordV2,
        document: SessionDraftDocumentV2,
        localSupplement: SessionDraftLocalSupplement = {},
    ): void {
        const existing = this.readReplica(scope, record.address);
        // Reading back the revision this replica already holds (the sync feed can report the same
        // draft again) is not a change: keep the replica, so no list rebuilds and no subscriber is told.
        if (
            existing
            && existing.baseRevision === record.revision
            && existing.status === 'clean'
            && existing.conflict === null
            && existing.pendingFieldMutations.length === 0
            && existing.materialized
            && !existing.deleteWhenEmpty
            && existing.createdAt === record.createdAt
            && existing.updatedAt === record.updatedAt
            && areJsonValuesEqual(existing.localRawDocument, document)
            && areJsonValuesEqual(existing.baseRawDocument, document)
            && areJsonValuesEqual(existing.localSupplement as StrictJsonValue, localSupplement as StrictJsonValue)
        ) return;
        this.writeReplica(scope, {
            address: record.address,
            baseRevision: record.revision,
            baseRawDocument: document,
            localRawDocument: document,
            documentRevision: (existing?.documentRevision ?? 0)
                + (existing && areJsonValuesEqual(existing.localRawDocument, document) ? 0 : 1),
            pendingFieldMutations: [],
            status: 'clean',
            conflict: null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            materialized: true,
            deleteWhenEmpty: false,
            localSupplement,
        });
    }

    async ensureSessionDraftRepositoryHydrated(scope: SessionDraftRepositoryScope): Promise<void> {
        // Hydration is also the async-storage preparation boundary for local-only callers.
        if (this.storage.prepare) await this.storage.prepare();
        const runtime = this.syncRuntime(scope);
        if (!runtime) return;
        await this.ensureSessionDraftRepositoryHydratedWithScopedRuntime({
            scope,
            runtime,
            isCurrent: () => this.isCurrentRuntime(runtime),
        });
    }

    /** Hydrates one exact Account/Home collection without changing the configured singleton runtime. */
    async ensureSessionDraftRepositoryHydratedWithScopedRuntime(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        runtime: SessionDraftRepositoryScopedRuntime;
        isCurrent: () => boolean;
    }>): Promise<void> {
        if (this.storage.prepare) await this.storage.prepare();
        if (!params.isCurrent()) return;
        const { scope } = params;
        const staged = new Map<string, Readonly<{
            address: SessionDraftAddressV2;
            response: SessionDraftReadResponseV2;
            document: SessionDraftDocumentV2 | null;
        }>>();
        const listedAddresses = new Set<string>();
        let unavailableSessionContextCount = 0;
        let after: string | undefined;
        do {
            const response = await params.runtime.transport.list({ ...(after ? { after } : {}), limit: 100 });
            if (!params.isCurrent()) return;
            for (const record of response.items) {
                const addressKey = canonicalSessionDraftAddressV2(record.address);
                listedAddresses.add(addressKey);
                let document: SessionDraftDocumentV2;
                try {
                    document = await this.openRequiredDocument(params.runtime, record);
                } catch (error) {
                    if (!params.isCurrent()) return;
                    if (!isSessionDraftContextUnavailableError(error)) throw error;
                    unavailableSessionContextCount += 1;
                    continue;
                }
                if (!params.isCurrent()) return;
                staged.set(addressKey, {
                    address: record.address,
                    response: { status: 'present', record },
                    document,
                });
            }
            after = response.nextAfter;
        } while (after);
        const localAddressesMissingFromActiveList = [...this.getScopeState(scope).replicas.values()]
            .map((replica) => replica.address)
            .filter((address) => !listedAddresses.has(canonicalSessionDraftAddressV2(address)));
        for (const address of localAddressesMissingFromActiveList) {
            const response = await params.runtime.transport.read(address);
            if (!params.isCurrent()) return;
            let document: SessionDraftDocumentV2 | null = null;
            if (response.status === 'present') {
                try {
                    document = await this.openRequiredDocument(params.runtime, response.record);
                } catch (error) {
                    if (!params.isCurrent()) return;
                    if (!isSessionDraftContextUnavailableError(error)) throw error;
                    unavailableSessionContextCount += 1;
                    continue;
                }
            }
            if (!params.isCurrent()) return;
            staged.set(canonicalSessionDraftAddressV2(address), { address, response, document });
        }
        if (!params.isCurrent()) return;
        const addressesToFlush: SessionDraftAddressV2[] = [];
        const addressesToRematerialize: SessionDraftAddressV2[] = [];
        this.withAtomicScopeMutation(scope, () => {
            for (const { address, response, document } of staged.values()) {
                if (this.flushInFlight.has(this.replicaListenerKey(scope, address))) {
                    addressesToRematerialize.push(address);
                    continue;
                }
                if (this.reconcileStagedRead(scope, address, response, document)) addressesToFlush.push(address);
            }
        });
        for (const { address } of staged.values()) {
            await this.awaitDraftRemovalCleanup(scope, address);
        }
        for (const address of addressesToFlush) {
            if (!params.isCurrent()) return;
            await this.flushSessionDraftWithScopedRuntime({
                scope: params.scope,
                address,
                runtime: params.runtime,
                isCurrent: params.isCurrent,
            });
        }
        for (const address of addressesToRematerialize) {
            if (!params.isCurrent()) return;
            await this.materializeExactWithScopedRuntime({
                scope: params.scope,
                address,
                runtime: params.runtime,
                isCurrent: params.isCurrent,
                flushRebasedLocalMutations: () => this.flushSessionDraftWithScopedRuntime({
                    scope: params.scope,
                    address,
                    runtime: params.runtime,
                    isCurrent: params.isCurrent,
                }).then(() => undefined),
            });
        }
        if (!params.isCurrent()) return;
        if (this.storage.flush) await this.flushStorage(scope);
        if (unavailableSessionContextCount > 0) {
            log.log(
                `[session-drafts] Snapshot skipped reason=session_context_unavailable count=${unavailableSessionContextCount}`,
            );
        }
    }

    getExistingSessionDraftProjection(scope: SessionDraftRepositoryScope, sessionId: string): ExistingSessionDraftProjection | null {
        const address = { kind: 'session', sessionId } as const;
        const replica = this.readReplica(scope, address);
        if (!replica?.localRawDocument || !replica.materialized) return null;
        const cached = this.existingProjectionCache.get(replica);
        const status = this.projectedStatus(scope, replica);
        if (cached?.status === status) return cached;
        const projection: ExistingSessionDraftProjection = {
            listed: hasMeaningfulContent(replica.localRawDocument, address, { excludeScmDrafts: true }),
            text: replica.localRawDocument.composer.text.value,
            preview: normalizePreview(replica.localRawDocument.composer.text.value),
            status,
            conflict: replica.conflict,
            updatedAt: replica.updatedAt,
        };
        this.existingProjectionCache.set(replica, projection);
        return projection;
    }

    listNewSessionDraftProjections(scope: SessionDraftRepositoryScope): readonly NewSessionDraftProjection[] {
        const scopeKey = this.scopeKey(scope);
        const cached = this.newListProjectionCache.get(scopeKey);
        if (cached) return cached;
        const projection = [...this.getScopeState(scope).replicas.values()]
            .filter((replica): replica is PersistedReplica & { localRawDocument: NewSessionDraftDocument } => (
                replica.address.kind === 'newSession'
                && replica.materialized
                && replica.localRawDocument?.target.kind === 'newSession'
            ))
            .map((replica) => {
                const status = this.projectedStatus(scope, replica);
                const previous = this.newProjectionCache.get(replica);
                if (previous && previous.status === status) return previous;
                const next: NewSessionDraftProjection = {
                    draftId: (replica.address as Extract<SessionDraftAddressV2, { kind: 'newSession' }>).draftId,
                    document: replica.localRawDocument,
                    status,
                    conflict: replica.conflict,
                    createdAt: replica.createdAt,
                    updatedAt: replica.updatedAt,
                    localSupplement: replica.localSupplement,
                };
                this.newProjectionCache.set(replica, next);
                return next;
            })
            .sort((left, right) => right.updatedAt - left.updatedAt || left.draftId.localeCompare(right.draftId));
        const last = this.lastNewListProjection.get(scopeKey);
        const list = last && last.length === projection.length && last.every((draft, index) => draft === projection[index])
            ? last
            : projection;
        this.lastNewListProjection.set(scopeKey, list);
        this.newListProjectionCache.set(scopeKey, list);
        return list;
    }

    isSessionDraftRemoteAcknowledged(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV2): boolean {
        const replica = this.readReplica(scope, address);
        return Boolean(
            replica
            && typeof replica.baseRevision === 'number'
            && replica.pendingFieldMutations.length === 0
            && replica.conflict === null,
        );
    }

    listNewSessionDraftEncryptionMigrationCandidates(scope: SessionDraftRepositoryScope): readonly Readonly<{
        address: Extract<SessionDraftAddressV2, { kind: 'newSession' }>;
        baseRevision: number;
        document: SessionDraftDocumentV2;
    }>[] {
        return [...this.getScopeState(scope).replicas.values()]
            .filter((replica): replica is PersistedReplica & {
                address: Extract<SessionDraftAddressV2, { kind: 'newSession' }>;
                baseRevision: number;
                baseRawDocument: SessionDraftDocumentV2;
            } => (
                replica.address.kind === 'newSession'
                && replica.materialized
                && typeof replica.baseRevision === 'number'
                && replica.baseRawDocument !== null
            ))
            .map((replica) => ({
                address: replica.address,
                baseRevision: replica.baseRevision,
                document: cloneDocument(replica.baseRawDocument),
            }));
    }

    async acknowledgeNewSessionDraftEncryptionMigration(
        scope: SessionDraftRepositoryScope,
        records: readonly SessionDraftRecordV2[],
    ): Promise<void> {
        if (this.storage.prepare) await this.storage.prepare();
        const runtime = this.syncRuntime(scope);
        if (!runtime) throw new Error('Session draft repository scope is unavailable');
        const candidates = this.listNewSessionDraftEncryptionMigrationCandidates(scope);
        const candidateKeys = new Set(candidates.map((candidate) => canonicalSessionDraftAddressV2(candidate.address)));
        const candidateRevisionByKey = new Map(candidates.map((candidate) => [
            canonicalSessionDraftAddressV2(candidate.address),
            candidate.baseRevision,
        ]));
        const recordKeys = new Set(records.map((record) => canonicalSessionDraftAddressV2(record.address)));
        if (
            records.length !== candidates.length
            || recordKeys.size !== records.length
            || candidateKeys.size !== recordKeys.size
            || [...candidateKeys].some((key) => !recordKeys.has(key))
        ) {
            throw new Error('Session draft encryption migration response did not cover the exact candidate set');
        }
        const openedRecords: Array<Readonly<{ record: SessionDraftRecordV2; document: SessionDraftDocumentV2 }>> = [];
        for (const record of records) {
            if (record.address.kind !== 'newSession' || record.content === null) {
                throw new Error('Session draft encryption migration returned an invalid record');
            }
            const document = await runtime.cipher.open(record.address, record.content);
            if (!this.isCurrentRuntime(runtime)) {
                throw new Error('Session draft repository scope changed during encryption migration');
            }
            if (!document) throw new Error(`Unable to open migrated session draft ${canonicalSessionDraftAddressV2(record.address)}`);
            openedRecords.push({ record, document });
        }
        this.withAtomicScopeMutation(scope, () => {
            for (const { record, document } of openedRecords) {
                const replica = this.readReplica(scope, record.address);
                if (
                    !replica
                    || replica.address.kind !== 'newSession'
                    || replica.baseRevision !== candidateRevisionByKey.get(canonicalSessionDraftAddressV2(record.address))
                ) {
                    throw new Error('Session draft encryption migration candidate changed before acknowledgement');
                }
                this.writeReplica(scope, {
                    ...replica,
                    baseRevision: record.revision,
                    baseRawDocument: document,
                    createdAt: record.createdAt,
                    updatedAt: Math.max(replica.updatedAt, record.updatedAt),
                });
            }
        });
        if (this.storage.flush) await this.flushStorage(scope);
    }

}

export function createSessionDraftRepository(options: RepositoryOptions): SessionDraftRepository {
    return new SessionDraftRepository(options);
}

const unavailableCipher: SessionDraftRepositoryCipher = {
    seal: async () => { throw new Error('Session draft encryption is not configured'); },
    open: async () => null,
};

const singleton = createSessionDraftRepository({
    storage: getSessionDraftPersistenceStorage(),
    cipher: unavailableCipher,
    syncEnabled: false,
});

export function configureSessionDraftRepository(options: Readonly<{
    scope?: SessionDraftRepositoryScope;
    transport?: SessionDraftRepositoryTransport;
    cipher?: SessionDraftRepositoryCipher;
    syncEnabled: boolean;
    onDraftRemoved?: RepositoryOptions['onDraftRemoved'];
}>): void {
    singleton.configure(options);
}

export const getSessionDraftSnapshot = singleton.getSessionDraftSnapshot.bind(singleton);
export const subscribeSessionDraft = singleton.subscribeSessionDraft.bind(singleton);
export const subscribeSessionDraftList = singleton.subscribeSessionDraftList.bind(singleton);
export const writeExistingSessionDraft = singleton.writeExistingSessionDraft.bind(singleton);
export const writeDiscussionSessionDraft = singleton.writeDiscussionSessionDraft.bind(singleton);
export const writeNewSessionDraft = singleton.writeNewSessionDraft.bind(singleton);
export const writeSessionDraftLocalSupplement = singleton.writeSessionDraftLocalSupplement.bind(singleton);
export const captureSessionDraftCurrentness = singleton.captureSessionDraftCurrentness.bind(singleton);
export const captureSessionDraftLaunchCurrentness = singleton.captureSessionDraftLaunchCurrentness.bind(singleton);
export const readSessionDraftLaunchCapture = singleton.readSessionDraftLaunchCapture.bind(singleton);
export const readSessionDraftLaunchCurrentness = singleton.readSessionDraftLaunchCurrentness.bind(singleton);
export const clearSessionDraftLaunchCurrentness = singleton.clearSessionDraftLaunchCurrentness.bind(singleton);
export const clearSessionDraftCurrentnessLocal = singleton.clearSessionDraftCurrentnessLocal.bind(singleton);
export const clearSessionDraftCurrentness = singleton.clearSessionDraftCurrentness.bind(singleton);
export const deleteSessionDraft = singleton.deleteSessionDraft.bind(singleton);
export const deleteSessionDraftWithScopedRuntime = singleton.deleteSessionDraftWithScopedRuntime.bind(singleton);
export const moveNewSessionDraftToScope = singleton.moveNewSessionDraftToScope.bind(singleton);
export const purgeSessionDraftPresentation = singleton.purgeSessionDraftPresentation.bind(singleton);
export const flushSessionDraft = singleton.flushSessionDraft.bind(singleton);
export const resolveSessionDraftConflict = singleton.resolveSessionDraftConflict.bind(singleton);
export const materializeExactSessionDraft = singleton.materializeExact.bind(singleton);
export const materializeExactSessionDraftWithScopedRuntime = singleton.materializeExactWithScopedRuntime.bind(singleton);
export const ensureSessionDraftRepositoryHydrated = singleton.ensureSessionDraftRepositoryHydrated.bind(singleton);
export const ensureSessionDraftRepositoryHydratedWithScopedRuntime = singleton.ensureSessionDraftRepositoryHydratedWithScopedRuntime.bind(singleton);
export const getExistingSessionDraftProjection = singleton.getExistingSessionDraftProjection.bind(singleton);
export const listNewSessionDraftProjections = singleton.listNewSessionDraftProjections.bind(singleton);
export const isSessionDraftRemoteAcknowledged = singleton.isSessionDraftRemoteAcknowledged.bind(singleton);
export const listNewSessionDraftEncryptionMigrationCandidates = singleton.listNewSessionDraftEncryptionMigrationCandidates.bind(singleton);
export const acknowledgeNewSessionDraftEncryptionMigration = singleton.acknowledgeNewSessionDraftEncryptionMigration.bind(singleton);
export const resetSessionDraftRepositoryForTests = singleton.resetForTests.bind(singleton);
