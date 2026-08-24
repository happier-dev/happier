import {
    canonicalSessionDraftAddressV1,
    isMeaningfulSessionDraftRecipientValueV1,
    SessionDraftAddressV1Schema,
    type SessionDraftAddressV1,
    type SessionDraftDocumentV1,
    type SessionDraftExpectedRevisionV1,
    type SessionDraftListResponseV1,
    type SessionDraftMutateRequestV1,
    type SessionDraftMutateResponseV1,
    type SessionDraftReadResponseV1,
    type SessionDraftRecordV1,
    type SessionDraftStoredContentEnvelopeV1,
    type StrictJsonValue,
    type SyncedSessionAuthoringValueV1,
} from '@happier-dev/protocol';

import { randomUUID as platformRandomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';

export type SessionDraftRepositoryScope = ServerAccountScope;
export type SessionDraftStatus = 'clean' | 'pending' | 'offline' | 'conflict' | 'error';
export type SessionDraftMaterializationIntent = 'passiveHydration' | 'userEdit' | 'seeded' | 'launchInterrupted';

type DraftFieldPathV1 =
    | Readonly<{ kind: 'composer'; field: 'text' | 'mentions' | 'attachments' }>
    | Readonly<{ kind: 'authoring'; fieldId: keyof SyncedSessionAuthoringValueV1 }>
    | Readonly<{ kind: 'routing'; field: 'recipient' | 'agentContinuation' | 'executionRunDelivery' }>
    | Readonly<{ kind: 'extension'; pluginId: string; fieldId: string }>;

type DraftFieldMutationV1 = Readonly<{
    path: DraftFieldPathV1;
    mutationId: string;
    intent: 'edit' | 'clearCaptured';
    baseMutationId: string | null;
    field: Readonly<{ mutationId: string; value: StrictJsonValue }> | null;
}>;

export type SessionDraftCurrentness = Readonly<{
    address: SessionDraftAddressV1;
    mutationIds: Readonly<Record<string, string>>;
}>;

export type SessionDraftLaunchCurrentnessCapture = Readonly<{
    userAttemptId: string;
    currentness: SessionDraftCurrentness;
}>;

export type SessionDraftLocalSupplement = Readonly<{
    /** Local action-operation correlation; never sealed or sent to the server. */
    launchUserAttemptId?: string;
    /** Local-only launch CAS token. It is paired to one user attempt and never sealed or uploaded. */
    launchCurrentnessCapture?: SessionDraftLaunchCurrentnessCapture;
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
    address: SessionDraftAddressV1;
    document: SessionDraftDocumentV1;
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
        executionRunDelivery?: StrictJsonValue;
    }>;
}>;

export type NewSessionDraftPatch = Readonly<{
    text?: string;
    mentions?: readonly StrictJsonValue[];
    attachments?: readonly StrictJsonValue[];
    authoring?: Partial<SyncedSessionAuthoringValueV1>;
}>;

export type SessionDraftFlushResult =
    | Readonly<{ status: 'clean' | 'local-only' | 'pending' }>
    | Readonly<{ status: 'conflict' | 'offline' | 'error' }>;

export type ExistingSessionDraftProjection = Readonly<{
    text: string;
    preview: string;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    updatedAt: number;
}>;

export type NewSessionDraftProjection = Readonly<{
    draftId: string;
    document: SessionDraftDocumentV1;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    createdAt: number;
    updatedAt: number;
    localSupplement: SessionDraftLocalSupplement;
}>;

export type SessionDraftRepositoryStorage = Readonly<{
    getString(key: string): string | undefined;
    set(key: string, value: string): unknown;
    delete(key: string): unknown;
}>;

export type SessionDraftRepositoryTransport = Readonly<{
    read(address: SessionDraftAddressV1): Promise<SessionDraftReadResponseV1>;
    list(request: Readonly<{ after?: string; limit?: number }>): Promise<SessionDraftListResponseV1>;
    mutate(request: SessionDraftMutateRequestV1): Promise<SessionDraftMutateResponseV1>;
}>;

export type SessionDraftRepositoryCipher = Readonly<{
    seal(address: SessionDraftAddressV1, document: SessionDraftDocumentV1): Promise<SessionDraftStoredContentEnvelopeV1>;
    open(address: SessionDraftAddressV1, content: SessionDraftStoredContentEnvelopeV1): Promise<SessionDraftDocumentV1 | null>;
}>;

type PersistedReplica = {
    address: SessionDraftAddressV1;
    baseRevision: SessionDraftExpectedRevisionV1;
    baseRawDocument: SessionDraftDocumentV1 | null;
    localRawDocument: SessionDraftDocumentV1 | null;
    pendingFieldMutations: DraftFieldMutationV1[];
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    createdAt: number;
    updatedAt: number;
    materialized: boolean;
    deleteWhenEmpty: boolean;
    localSupplement: SessionDraftLocalSupplement;
};

type ScopeState = {
    loaded: boolean;
    replicas: Map<string, PersistedReplica>;
    ordinaryEntryDraftId: string | null;
};
type Listener = () => void;
type ScopeMutationBatch = {
    originalReplicas: Map<string, PersistedReplica>;
    originalOrdinaryEntryDraftId: string | null;
    changedAddresses: Map<string, SessionDraftAddressV1>;
};

type RepositoryOptions = Readonly<{
    storage: SessionDraftRepositoryStorage;
    transport?: SessionDraftRepositoryTransport;
    cipher: SessionDraftRepositoryCipher;
    syncEnabled: boolean;
    randomUUID?: () => string;
    now?: () => number;
}>;

const STORAGE_PREFIX = 'session-drafts-repository-v1';

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function cloneDocument(document: SessionDraftDocumentV1): SessionDraftDocumentV1 {
    return JSON.parse(JSON.stringify(document)) as SessionDraftDocumentV1;
}

function pathKey(path: DraftFieldPathV1): string {
    if (path.kind === 'composer') return `composer.${path.field}`;
    if (path.kind === 'routing') return `target.routing.${path.field}`;
    if (path.kind === 'authoring') return `target.authoring.${path.fieldId}`;
    return `extensions.${path.pluginId}.${path.fieldId}`;
}

function getField(document: SessionDraftDocumentV1 | null, path: DraftFieldPathV1): { mutationId: string; value: StrictJsonValue } | null {
    if (!document) return null;
    if (path.kind === 'composer') return document.composer[path.field];
    if (path.kind === 'routing') {
        return document.target.kind === 'session' ? document.target.routing[path.field] : null;
    }
    if (path.kind === 'authoring') {
        return document.target.kind === 'newSession' ? document.target.authoring[path.fieldId] ?? null : null;
    }
    return document.extensions[path.pluginId]?.[path.fieldId] ?? null;
}

function setField(
    document: SessionDraftDocumentV1,
    path: DraftFieldPathV1,
    field: { mutationId: string; value: StrictJsonValue } | null,
): SessionDraftDocumentV1 {
    const next = cloneDocument(document);
    if (path.kind === 'composer') {
        if (field) Object.assign(next.composer[path.field], field);
        return next;
    }
    if (path.kind === 'routing') {
        if (next.target.kind === 'session' && field) Object.assign(next.target.routing[path.field], field);
        return next;
    }
    if (path.kind === 'authoring') {
        if (next.target.kind !== 'newSession') return next;
        if (field) {
            next.target.authoring[path.fieldId] = field;
        } else {
            delete next.target.authoring[path.fieldId];
        }
        return next;
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

function listFieldPaths(document: SessionDraftDocumentV1): DraftFieldPathV1[] {
    const paths: DraftFieldPathV1[] = [
        { kind: 'composer', field: 'text' },
        { kind: 'composer', field: 'mentions' },
        { kind: 'composer', field: 'attachments' },
    ];
    if (document.target.kind === 'session') {
        paths.push(
            { kind: 'routing', field: 'recipient' },
            { kind: 'routing', field: 'agentContinuation' },
            { kind: 'routing', field: 'executionRunDelivery' },
        );
    } else {
        for (const fieldId of Object.keys(document.target.authoring) as Array<keyof SyncedSessionAuthoringValueV1>) {
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

function hasMeaningfulContent(document: SessionDraftDocumentV1): boolean {
    if (document.composer.text.value.trim().length > 0) return true;
    if (isNonEmptyArray(document.composer.mentions.value) || isNonEmptyArray(document.composer.attachments.value)) return true;
    if (Object.keys(document.extensions).some((pluginId) => Object.keys(document.extensions[pluginId] ?? {}).length > 0)) return true;
    if (document.target.kind === 'newSession') return Object.keys(document.target.authoring).length > 0;
    return isMeaningfulSessionDraftRecipientValueV1(document.target.routing.recipient.value)
        || document.target.routing.agentContinuation.value !== null
        || document.target.routing.executionRunDelivery.value !== null;
}

function createEmptyDocument(address: SessionDraftAddressV1, randomUUID: () => string): SessionDraftDocumentV1 {
    const field = <T extends StrictJsonValue>(value: T) => ({ mutationId: randomUUID(), value });
    return {
        v: 1,
        composer: { text: field(''), mentions: field([]), attachments: field([]) },
        target: address.kind === 'session'
            ? { kind: 'session', routing: {
                recipient: field(null),
                agentContinuation: field(null),
                executionRunDelivery: field(null),
            } }
            : { kind: 'newSession', authoring: {} },
        extensions: {},
    };
}

function addressesEqual(left: SessionDraftAddressV1, right: SessionDraftAddressV1): boolean {
    return canonicalSessionDraftAddressV1(left) === canonicalSessionDraftAddressV1(right);
}

function normalizeLocalSupplement(value: unknown, expectedAddress: SessionDraftAddressV1): SessionDraftLocalSupplement {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const candidate = value as Readonly<Record<string, unknown>>;
    const launchUserAttemptId = typeof candidate.launchUserAttemptId === 'string'
        ? candidate.launchUserAttemptId.trim()
        : '';
    const normalized: {
        launchUserAttemptId?: string;
        launchCurrentnessCapture?: SessionDraftLaunchCurrentnessCapture;
        legacyNewSessionDraftV1?: true;
        legacyExistingSessionDraftV1?: true;
    } = {};
    if (launchUserAttemptId) normalized.launchUserAttemptId = launchUserAttemptId;
    if (candidate.legacyNewSessionDraftV1 === true) normalized.legacyNewSessionDraftV1 = true;
    if (candidate.legacyExistingSessionDraftV1 === true) normalized.legacyExistingSessionDraftV1 = true;

    const capture = candidate.launchCurrentnessCapture;
    if (launchUserAttemptId && capture && typeof capture === 'object' && !Array.isArray(capture)) {
        const captureCandidate = capture as Readonly<Record<string, unknown>>;
        const capturedAttemptId = typeof captureCandidate.userAttemptId === 'string'
            ? captureCandidate.userAttemptId.trim()
            : '';
        const currentnessCandidate = captureCandidate.currentness;
        if (capturedAttemptId === launchUserAttemptId && currentnessCandidate && typeof currentnessCandidate === 'object' && !Array.isArray(currentnessCandidate)) {
            const currentness = currentnessCandidate as Readonly<Record<string, unknown>>;
            const parsedAddress = SessionDraftAddressV1Schema.safeParse(currentness.address);
            const mutationIdsCandidate = currentness.mutationIds;
            if (
                parsedAddress.success
                && addressesEqual(parsedAddress.data, expectedAddress)
                && mutationIdsCandidate
                && typeof mutationIdsCandidate === 'object'
                && !Array.isArray(mutationIdsCandidate)
                && Object.values(mutationIdsCandidate).every((mutationId) => typeof mutationId === 'string' && mutationId.length > 0)
            ) {
                normalized.launchCurrentnessCapture = {
                    userAttemptId: capturedAttemptId,
                    currentness: {
                        address: parsedAddress.data,
                        mutationIds: { ...(mutationIdsCandidate as Readonly<Record<string, string>>) },
                    },
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

function normalizeNewSessionDraftId(value: unknown): string | null {
    const parsed = SessionDraftAddressV1Schema.safeParse({ kind: 'newSession', draftId: value });
    return parsed.success && parsed.data.kind === 'newSession' ? parsed.data.draftId : null;
}

export class SessionDraftRepository {
    private readonly scopeStates = new Map<string, ScopeState>();
    private readonly listeners = new Map<string, Set<Listener>>();
    private readonly listListeners = new Map<string, Set<Listener>>();
    private readonly flushInFlight = new Map<string, Promise<SessionDraftFlushResult>>();
    private readonly mutationBatches = new Map<string, ScopeMutationBatch>();
    private readonly snapshotCache = new WeakMap<PersistedReplica, SessionDraftSnapshot>();
    private readonly existingProjectionCache = new WeakMap<PersistedReplica, ExistingSessionDraftProjection | null>();
    private readonly newListProjectionCache = new Map<string, readonly NewSessionDraftProjection[]>();
    private transport?: SessionDraftRepositoryTransport;
    private cipher: SessionDraftRepositoryCipher;
    private syncEnabled: boolean;
    private readonly storage: SessionDraftRepositoryStorage;
    private readonly randomUUID: () => string;
    private readonly now: () => number;

    constructor(options: RepositoryOptions) {
        this.storage = options.storage;
        this.transport = options.transport;
        this.cipher = options.cipher;
        this.syncEnabled = options.syncEnabled;
        this.randomUUID = options.randomUUID ?? platformRandomUUID;
        this.now = options.now ?? Date.now;
    }

    configure(options: Readonly<{
        transport?: SessionDraftRepositoryTransport;
        cipher?: SessionDraftRepositoryCipher;
        syncEnabled: boolean;
    }>): void {
        this.transport = options.transport;
        if (options.cipher) this.cipher = options.cipher;
        this.syncEnabled = options.syncEnabled;
    }

    private scopeKey(scope: SessionDraftRepositoryScope): string {
        return serverAccountScopeKeySuffix(scope);
    }

    private storageKey(scope: SessionDraftRepositoryScope): string {
        return `${STORAGE_PREFIX}:${this.scopeKey(scope)}`;
    }

    private replicaListenerKey(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): string {
        return `${this.scopeKey(scope)}:${canonicalSessionDraftAddressV1(address)}`;
    }

    private getScopeState(scope: SessionDraftRepositoryScope): ScopeState {
        const scopeKey = this.scopeKey(scope);
        const cached = this.scopeStates.get(scopeKey);
        if (cached) return cached;
        const state: ScopeState = { loaded: true, replicas: new Map(), ordinaryEntryDraftId: null };
        const raw = this.storage.getString(this.storageKey(scope));
        if (raw) {
            try {
                const parsed = JSON.parse(raw) as { v?: unknown; replicas?: unknown; ordinaryEntryDraftId?: unknown };
                if (parsed.v === 1 && parsed.replicas && typeof parsed.replicas === 'object' && !Array.isArray(parsed.replicas)) {
                    state.ordinaryEntryDraftId = normalizeNewSessionDraftId(parsed.ordinaryEntryDraftId);
                    for (const [key, replica] of Object.entries(parsed.replicas)) {
                        if (isPersistedReplica(replica)) {
                            state.replicas.set(key, {
                                ...replica,
                                pendingFieldMutations: replica.pendingFieldMutations.map((mutation) => ({
                                    ...mutation,
                                    mutationId: typeof mutation.mutationId === 'string'
                                        ? mutation.mutationId
                                        : mutation.field?.mutationId ?? this.randomUUID(),
                                    intent: mutation.intent === 'clearCaptured' ? 'clearCaptured' : 'edit',
                                })),
                                deleteWhenEmpty: replica.deleteWhenEmpty === true,
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
        const replicas = Object.fromEntries(state.replicas.entries());
        this.storage.set(this.storageKey(scope), JSON.stringify({
            v: 1,
            replicas,
            ...(state.ordinaryEntryDraftId ? { ordinaryEntryDraftId: state.ordinaryEntryDraftId } : {}),
        }));
    }

    private notify(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): void {
        const listenerKey = this.replicaListenerKey(scope, address);
        for (const listener of this.listeners.get(listenerKey) ?? []) listener();
        for (const listener of this.listListeners.get(this.scopeKey(scope)) ?? []) listener();
    }

    private notifyBatch(scope: SessionDraftRepositoryScope, addresses: Iterable<SessionDraftAddressV1>): void {
        for (const address of addresses) {
            const listenerKey = this.replicaListenerKey(scope, address);
            for (const listener of this.listeners.get(listenerKey) ?? []) listener();
        }
        for (const listener of this.listListeners.get(this.scopeKey(scope)) ?? []) listener();
    }

    private recordMutation(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): boolean {
        const batch = this.mutationBatches.get(this.scopeKey(scope));
        if (!batch) return false;
        batch.changedAddresses.set(canonicalSessionDraftAddressV1(address), address);
        return true;
    }

    private withAtomicScopeMutation<T>(scope: SessionDraftRepositoryScope, mutate: () => T): T {
        const scopeKey = this.scopeKey(scope);
        if (this.mutationBatches.has(scopeKey)) return mutate();
        const state = this.getScopeState(scope);
        const batch: ScopeMutationBatch = {
            originalReplicas: new Map(state.replicas),
            originalOrdinaryEntryDraftId: state.ordinaryEntryDraftId,
            changedAddresses: new Map(),
        };
        this.mutationBatches.set(scopeKey, batch);
        try {
            const result = mutate();
            this.persist(scope);
            this.mutationBatches.delete(scopeKey);
            if (batch.changedAddresses.size > 0) this.notifyBatch(scope, batch.changedAddresses.values());
            return result;
        } catch (error) {
            state.replicas = batch.originalReplicas;
            state.ordinaryEntryDraftId = batch.originalOrdinaryEntryDraftId;
            this.newListProjectionCache.delete(scopeKey);
            this.mutationBatches.delete(scopeKey);
            throw error;
        }
    }

    private writeReplica(scope: SessionDraftRepositoryScope, replica: PersistedReplica): void {
        this.getScopeState(scope).replicas.set(canonicalSessionDraftAddressV1(replica.address), replica);
        this.newListProjectionCache.delete(this.scopeKey(scope));
        if (this.recordMutation(scope, replica.address)) return;
        this.persist(scope);
        this.notify(scope, replica.address);
    }

    private deleteReplica(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): void {
        const state = this.getScopeState(scope);
        const deleted = state.replicas.delete(canonicalSessionDraftAddressV1(address));
        const clearedOrdinaryEntryPointer = address.kind === 'newSession'
            && state.ordinaryEntryDraftId === address.draftId;
        if (clearedOrdinaryEntryPointer) state.ordinaryEntryDraftId = null;
        if (!deleted && !clearedOrdinaryEntryPointer) return;
        this.newListProjectionCache.delete(this.scopeKey(scope));
        if (deleted && this.recordMutation(scope, address)) return;
        this.persist(scope);
        if (deleted) this.notify(scope, address);
    }

    private readReplica(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): PersistedReplica | null {
        return this.getScopeState(scope).replicas.get(canonicalSessionDraftAddressV1(address)) ?? null;
    }

    readOrdinaryEntryDraftId(scope: SessionDraftRepositoryScope): string | null {
        return this.getScopeState(scope).ordinaryEntryDraftId;
    }

    setOrdinaryEntryDraftId(scope: SessionDraftRepositoryScope, draftId: string): boolean {
        const normalizedDraftId = normalizeNewSessionDraftId(draftId);
        if (!normalizedDraftId) return false;
        const state = this.getScopeState(scope);
        const replica = this.readReplica(scope, { kind: 'newSession', draftId: normalizedDraftId });
        if (!replica?.localRawDocument || !replica.materialized) return false;
        if (state.ordinaryEntryDraftId === normalizedDraftId) return true;
        state.ordinaryEntryDraftId = normalizedDraftId;
        this.persist(scope);
        return true;
    }

    clearOrdinaryEntryDraftIdExact(scope: SessionDraftRepositoryScope, draftId: string): boolean {
        const normalizedDraftId = normalizeNewSessionDraftId(draftId);
        const state = this.getScopeState(scope);
        if (!normalizedDraftId || state.ordinaryEntryDraftId !== normalizedDraftId) return false;
        state.ordinaryEntryDraftId = null;
        this.persist(scope);
        return true;
    }

    getSessionDraftSnapshot(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): SessionDraftSnapshot | null {
        const replica = this.readReplica(scope, address);
        if (!replica?.localRawDocument) return null;
        const cached = this.snapshotCache.get(replica);
        if (cached) return cached;
        const snapshot: SessionDraftSnapshot = {
            address: replica.address,
            document: replica.localRawDocument,
            status: replica.status,
            conflict: replica.conflict,
            createdAt: replica.createdAt,
            updatedAt: replica.updatedAt,
            materialized: replica.materialized,
            localSupplement: replica.localSupplement,
        };
        this.snapshotCache.set(replica, snapshot);
        return snapshot;
    }

    subscribeSessionDraft(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1, listener: Listener): () => void {
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
        address: SessionDraftAddressV1,
        writes: ReadonlyArray<Readonly<{ path: DraftFieldPathV1; value: StrictJsonValue }>>,
        materializationIntent: SessionDraftMaterializationIntent,
    ): void {
        const existing = this.readReplica(scope, address);
        let document = existing?.localRawDocument ?? createEmptyDocument(address, this.randomUUID);
        let pending = [...(existing?.pendingFieldMutations ?? [])];
        let changed = false;
        for (const write of writes) {
            const previous = getField(document, write.path);
            if (previous && areJsonValuesEqual(previous.value, write.value)) continue;
            const priorPending = pending.find((mutation) => pathKey(mutation.path) === pathKey(write.path));
            const field = { mutationId: this.randomUUID(), value: write.value };
            document = setField(document, write.path, field);
            pending = pending.filter((mutation) => pathKey(mutation.path) !== pathKey(write.path));
            pending.push({
                path: write.path,
                mutationId: field.mutationId,
                intent: 'edit',
                baseMutationId: priorPending?.baseMutationId ?? getField(existing?.baseRawDocument ?? null, write.path)?.mutationId ?? null,
                field,
            });
            changed = true;
        }
        // An already-materialized document with identical semantic fields is a true no-op.
        // In particular, repository-to-composer adoption can notify the prompt store, whose
        // autosave subscriber may project the same value back here. Rewriting status/timestamps
        // for that echo creates a repository/React feedback wave without any user intent.
        // Explicit seeded/launch-interrupted materialization still works when no replica exists.
        if (!changed && (existing || materializationIntent === 'passiveHydration')) return;
        const now = this.now();
        const materialized = existing?.materialized === true
            || materializationIntent === 'seeded'
            || materializationIntent === 'launchInterrupted'
            || (materializationIntent === 'userEdit' && (changed || hasMeaningfulContent(document)));
        if (!materialized && address.kind === 'newSession') return;
        const meaningfulContent = hasMeaningfulContent(document);
        this.writeReplica(scope, {
            address,
            baseRevision: existing?.baseRevision ?? 'absent',
            baseRawDocument: existing?.baseRawDocument ?? null,
            localRawDocument: document,
            pendingFieldMutations: pending,
            status: this.syncEnabled ? 'pending' : 'clean',
            conflict: existing?.conflict ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            materialized: address.kind === 'session' ? meaningfulContent : materialized,
            deleteWhenEmpty: changed && meaningfulContent ? false : existing?.deleteWhenEmpty ?? false,
            localSupplement: existing?.localSupplement ?? {},
        });
    }

    writeSessionDraftLocalSupplement(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV1;
        patch: Readonly<{
            launchUserAttemptId?: string | null;
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
            nextSupplement.launchUserAttemptId = params.patch.launchUserAttemptId;
            if (nextSupplement.launchCurrentnessCapture?.userAttemptId !== params.patch.launchUserAttemptId) {
                delete nextSupplement.launchCurrentnessCapture;
            }
        }
        if (params.patch.legacyNewSessionDraftV1 === null) delete nextSupplement.legacyNewSessionDraftV1;
        else if (params.patch.legacyNewSessionDraftV1 === true) nextSupplement.legacyNewSessionDraftV1 = true;
        if (params.patch.legacyExistingSessionDraftV1 === null) delete nextSupplement.legacyExistingSessionDraftV1;
        else if (params.patch.legacyExistingSessionDraftV1 === true) nextSupplement.legacyExistingSessionDraftV1 = true;
        this.writeReplica(params.scope, { ...existing, localSupplement: nextSupplement });
    }

    writeExistingSessionDraft(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        sessionId: string;
        patch: ExistingSessionDraftPatch;
        materializationIntent?: SessionDraftMaterializationIntent;
    }>): void {
        const writes: Array<{ path: DraftFieldPathV1; value: StrictJsonValue }> = [];
        if (params.patch.text !== undefined) writes.push({ path: { kind: 'composer', field: 'text' }, value: params.patch.text });
        if (params.patch.mentions !== undefined) writes.push({ path: { kind: 'composer', field: 'mentions' }, value: params.patch.mentions });
        if (params.patch.attachments !== undefined) writes.push({ path: { kind: 'composer', field: 'attachments' }, value: params.patch.attachments });
        if (params.patch.routing?.recipient !== undefined) writes.push({ path: { kind: 'routing', field: 'recipient' }, value: params.patch.routing.recipient });
        if (params.patch.routing?.agentContinuation !== undefined) writes.push({ path: { kind: 'routing', field: 'agentContinuation' }, value: params.patch.routing.agentContinuation });
        if (params.patch.routing?.executionRunDelivery !== undefined) writes.push({ path: { kind: 'routing', field: 'executionRunDelivery' }, value: params.patch.routing.executionRunDelivery });
        this.applyWrites(params.scope, { kind: 'session', sessionId: params.sessionId }, writes, params.materializationIntent ?? 'userEdit');
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
            if (value !== undefined) writes.push({ path: { kind: 'authoring', fieldId: fieldId as keyof SyncedSessionAuthoringValueV1 }, value: value as StrictJsonValue });
        }
        this.applyWrites(params.scope, { kind: 'newSession', draftId: params.draftId }, writes, params.materializationIntent);
    }

    captureSessionDraftCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV1;
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
        address: SessionDraftAddressV1;
        userAttemptId: string;
    }>): SessionDraftCurrentness | null {
        const userAttemptId = params.userAttemptId.trim();
        const replica = this.readReplica(params.scope, params.address);
        if (!userAttemptId || !replica?.localRawDocument) return null;
        const currentness = this.captureSessionDraftCurrentness(params);
        this.writeReplica(params.scope, {
            ...replica,
            localSupplement: {
                ...replica.localSupplement,
                launchUserAttemptId: userAttemptId,
                launchCurrentnessCapture: { userAttemptId, currentness },
            },
        });
        return currentness;
    }

    readSessionDraftLaunchCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV1;
        userAttemptId: string;
    }>): SessionDraftCurrentness | null {
        const supplement = this.readReplica(params.scope, params.address)?.localSupplement;
        const capture = supplement?.launchCurrentnessCapture;
        return capture
            && supplement?.launchUserAttemptId === params.userAttemptId.trim()
            && capture.userAttemptId === params.userAttemptId.trim()
            && addressesEqual(capture.currentness.address, params.address)
            ? capture.currentness
            : null;
    }

    clearSessionDraftLaunchCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV1;
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

    async clearSessionDraftCurrentness(params: Readonly<{
        scope: SessionDraftRepositoryScope;
        address: SessionDraftAddressV1;
        currentness: SessionDraftCurrentness;
    }>): Promise<boolean> {
        if (!addressesEqual(params.address, params.currentness.address)) return false;
        if (params.address.kind === 'newSession') {
            this.clearOrdinaryEntryDraftIdExact(params.scope, params.address.draftId);
        }
        const replica = this.readReplica(params.scope, params.address);
        if (!replica?.localRawDocument) return false;
        let document = replica.localRawDocument;
        let pending = [...replica.pendingFieldMutations];
        let changed = false;
        for (const path of listFieldPaths(document)) {
            const key = pathKey(path);
            const capturedMutationId = params.currentness.mutationIds[key];
            const current = getField(document, path);
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
        const meaningfulContent = hasMeaningfulContent(document);
        this.writeReplica(params.scope, {
            ...replica,
            localRawDocument: document,
            pendingFieldMutations: pending,
            updatedAt: this.now(),
            status: this.syncEnabled ? 'pending' : 'clean',
            conflict: null,
            materialized: params.address.kind === 'newSession' ? meaningfulContent : meaningfulContent,
            deleteWhenEmpty: !meaningfulContent,
        });
        await this.flushSessionDraft({ scope: params.scope, address: params.address });
        return true;
    }

    async deleteSessionDraft(params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV1 }>): Promise<void> {
        const replica = this.readReplica(params.scope, params.address);
        if (!replica) return;
        if (!this.syncEnabled || !this.transport) {
            this.deleteReplica(params.scope, params.address);
            return;
        }
        const result = await this.transport.mutate({
            address: params.address,
            expectedRevision: replica.baseRevision,
            content: null,
        });
        if (result.status === 'updated') {
            this.deleteReplica(params.scope, params.address);
        } else {
            await this.materializeExact(params.scope, params.address);
        }
    }

    flushSessionDraft(params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV1 }>): Promise<SessionDraftFlushResult> {
        const key = this.replicaListenerKey(params.scope, params.address);
        const existing = this.flushInFlight.get(key);
        if (existing) return existing;
        const promise = this.flushLoop(params).finally(() => this.flushInFlight.delete(key));
        this.flushInFlight.set(key, promise);
        return promise;
    }

    private async flushLoop(params: Readonly<{ scope: SessionDraftRepositoryScope; address: SessionDraftAddressV1 }>): Promise<SessionDraftFlushResult> {
        if (!this.syncEnabled || !this.transport) {
            const replica = this.readReplica(params.scope, params.address);
            if (replica?.deleteWhenEmpty) this.deleteReplica(params.scope, params.address);
            else if (replica) this.writeReplica(params.scope, { ...replica, status: 'clean' });
            return { status: 'local-only' };
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const replica = this.readReplica(params.scope, params.address);
            if (!replica?.localRawDocument && !replica?.deleteWhenEmpty) return { status: 'clean' };
            if (replica.conflict) return { status: 'conflict' };
            const submittedDocument = replica.localRawDocument ? cloneDocument(replica.localRawDocument) : null;
            const submittedMutations = [...replica.pendingFieldMutations];
            const shouldTombstone = replica.deleteWhenEmpty
                || (submittedDocument !== null && !hasMeaningfulContent(submittedDocument) && params.address.kind === 'session');
            let content: SessionDraftStoredContentEnvelopeV1 | null;
            try {
                content = shouldTombstone ? null : await this.cipher.seal(params.address, submittedDocument!);
            } catch {
                this.writeReplica(params.scope, { ...replica, status: 'error' });
                return { status: 'error' };
            }
            let response: SessionDraftMutateResponseV1;
            try {
                response = await this.transport.mutate({
                    address: params.address,
                    expectedRevision: replica.baseRevision,
                    content,
                });
            } catch {
                this.writeReplica(params.scope, { ...replica, status: 'offline' });
                return { status: 'offline' };
            }
            if (response.status === 'updated') {
                if (response.record.content === null) {
                    this.deleteReplica(params.scope, params.address);
                    return { status: 'clean' };
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
            const rebased = await this.rebaseConflict(params.scope, params.address, replica, response.current);
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
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV1,
        replica: PersistedReplica,
        current: SessionDraftRecordV1 | Readonly<{ status: 'absent' }>,
    ): Promise<'rebased' | 'conflict' | 'error'> {
        const remoteRecord = 'status' in current ? null : current;
        const remoteDocument = remoteRecord?.content ? await this.cipher.open(address, remoteRecord.content) : null;
        if (remoteRecord?.content && !remoteDocument) {
            this.writeReplica(scope, { ...replica, status: 'error' });
            return 'error';
        }
        return this.rebaseConflictWithDocument(scope, address, replica, remoteRecord, remoteDocument);
    }

    private rebaseConflictWithDocument(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV1,
        replica: PersistedReplica,
        remoteRecord: SessionDraftRecordV1 | null,
        remoteDocument: SessionDraftDocumentV1 | null,
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
            if (areJsonValuesEqual(remoteField?.value ?? null, mutation.field?.value ?? null)) {
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
        const meaningfulContent = hasMeaningfulContent(localDocument);
        this.writeReplica(scope, {
            ...replica,
            baseRevision: remoteRecord?.revision ?? 'absent',
            baseRawDocument: remoteDocument,
            localRawDocument: localDocument,
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
        address: SessionDraftAddressV1;
        fieldId: string;
        action: 'useSynced' | 'keepDevice';
    }>): Promise<void> {
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
            this.deleteReplica(params.scope, params.address);
            return;
        }
        this.writeReplica(params.scope, {
            ...replica,
            localRawDocument: document,
            pendingFieldMutations: pending,
            conflict: remainingConflicts.length > 0 ? { fields: remainingConflicts } : null,
            status: remainingConflicts.length > 0 ? 'conflict' : pending.length > 0 ? 'pending' : 'clean',
            updatedAt: this.now(),
        });
        if (remainingConflicts.length === 0 && pending.length > 0) await this.flushSessionDraft({ scope: params.scope, address: params.address });
    }

    async materializeExact(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): Promise<void> {
        if (!this.syncEnabled || !this.transport) return;
        const activeFlush = this.flushInFlight.get(this.replicaListenerKey(scope, address));
        if (activeFlush) await activeFlush;
        let response: SessionDraftReadResponseV1;
        try {
            response = await this.transport.read(address);
        } catch (error) {
            const replica = this.readReplica(scope, address);
            if (replica) this.writeReplica(scope, { ...replica, status: 'offline' });
            throw error;
        }
        let remoteDocument: SessionDraftDocumentV1 | null = null;
        if (response.status === 'present') {
            try {
                remoteDocument = await this.openRequiredDocument(response.record);
            } catch (error) {
                const replica = this.readReplica(scope, address);
                if (replica) this.writeReplica(scope, { ...replica, status: 'error' });
                throw error;
            }
        }
        const shouldFlush = this.reconcileStagedRead(scope, address, response, remoteDocument);
        if (shouldFlush) await this.flushSessionDraft({ scope, address });
    }

    private async openRequiredDocument(record: SessionDraftRecordV1): Promise<SessionDraftDocumentV1> {
        if (!record.content) throw new Error(`Session draft ${canonicalSessionDraftAddressV1(record.address)} has no active content`);
        const document = await this.cipher.open(record.address, record.content);
        if (!document) throw new Error(`Unable to open session draft ${canonicalSessionDraftAddressV1(record.address)}`);
        return document;
    }

    private reconcileStagedRead(
        scope: SessionDraftRepositoryScope,
        address: SessionDraftAddressV1,
        response: SessionDraftReadResponseV1,
        remoteDocument: SessionDraftDocumentV1 | null,
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
            if (local.pendingFieldMutations.length === 0 || !local.localRawDocument || !hasMeaningfulContent(local.localRawDocument)) {
                this.deleteReplica(scope, address);
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
                this.deleteReplica(scope, address);
            } else {
                this.rebaseConflictWithDocument(scope, address, local, response.record, null);
            }
            return false;
        }
        if (!remoteDocument) {
            if (local) this.writeReplica(scope, { ...local, status: 'error' });
            throw new Error(`Unable to open session draft ${canonicalSessionDraftAddressV1(address)}`);
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
        record: SessionDraftRecordV1,
        document: SessionDraftDocumentV1,
        localSupplement: SessionDraftLocalSupplement = {},
    ): void {
        this.writeReplica(scope, {
            address: record.address,
            baseRevision: record.revision,
            baseRawDocument: document,
            localRawDocument: document,
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
        if (!this.syncEnabled || !this.transport) return;
        const staged = new Map<string, Readonly<{
            address: SessionDraftAddressV1;
            response: SessionDraftReadResponseV1;
            document: SessionDraftDocumentV1 | null;
        }>>();
        let after: string | undefined;
        do {
            const response = await this.transport.list({ ...(after ? { after } : {}), limit: 100 });
            for (const record of response.items) {
                const document = await this.openRequiredDocument(record);
                staged.set(canonicalSessionDraftAddressV1(record.address), {
                    address: record.address,
                    response: { status: 'present', record },
                    document,
                });
            }
            after = response.nextAfter;
        } while (after);
        const localAddressesMissingFromActiveList = [...this.getScopeState(scope).replicas.values()]
            .map((replica) => replica.address)
            .filter((address) => !staged.has(canonicalSessionDraftAddressV1(address)));
        for (const address of localAddressesMissingFromActiveList) {
            const response = await this.transport.read(address);
            const document = response.status === 'present' ? await this.openRequiredDocument(response.record) : null;
            staged.set(canonicalSessionDraftAddressV1(address), { address, response, document });
        }
        const addressesToFlush: SessionDraftAddressV1[] = [];
        const addressesToRematerialize: SessionDraftAddressV1[] = [];
        this.withAtomicScopeMutation(scope, () => {
            for (const { address, response, document } of staged.values()) {
                if (this.flushInFlight.has(this.replicaListenerKey(scope, address))) {
                    addressesToRematerialize.push(address);
                    continue;
                }
                if (this.reconcileStagedRead(scope, address, response, document)) addressesToFlush.push(address);
            }
        });
        for (const address of addressesToFlush) await this.flushSessionDraft({ scope, address });
        for (const address of addressesToRematerialize) await this.materializeExact(scope, address);
    }

    getExistingSessionDraftProjection(scope: SessionDraftRepositoryScope, sessionId: string): ExistingSessionDraftProjection | null {
        const address = { kind: 'session', sessionId } as const;
        const replica = this.readReplica(scope, address);
        if (!replica?.localRawDocument || !replica.materialized) return null;
        const cached = this.existingProjectionCache.get(replica);
        if (cached !== undefined) return cached;
        const projection: ExistingSessionDraftProjection = {
            text: replica.localRawDocument.composer.text.value,
            preview: normalizePreview(replica.localRawDocument.composer.text.value),
            status: replica.status,
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
            .filter((replica): replica is PersistedReplica & { localRawDocument: SessionDraftDocumentV1 } => (
                replica.address.kind === 'newSession' && replica.materialized && replica.localRawDocument?.target.kind === 'newSession'
            ))
            .map((replica) => ({
                draftId: (replica.address as Extract<SessionDraftAddressV1, { kind: 'newSession' }>).draftId,
                document: replica.localRawDocument,
                status: replica.status,
                conflict: replica.conflict,
                createdAt: replica.createdAt,
                updatedAt: replica.updatedAt,
                localSupplement: replica.localSupplement,
            }))
            .sort((left, right) => right.updatedAt - left.updatedAt || left.draftId.localeCompare(right.draftId));
        this.newListProjectionCache.set(scopeKey, projection);
        return projection;
    }

    isSessionDraftRemoteAcknowledged(scope: SessionDraftRepositoryScope, address: SessionDraftAddressV1): boolean {
        const replica = this.readReplica(scope, address);
        return Boolean(
            replica
            && typeof replica.baseRevision === 'number'
            && replica.pendingFieldMutations.length === 0
            && replica.conflict === null,
        );
    }

    listNewSessionDraftEncryptionMigrationCandidates(scope: SessionDraftRepositoryScope): readonly Readonly<{
        address: Extract<SessionDraftAddressV1, { kind: 'newSession' }>;
        baseRevision: number;
        document: SessionDraftDocumentV1;
    }>[] {
        return [...this.getScopeState(scope).replicas.values()]
            .filter((replica): replica is PersistedReplica & {
                address: Extract<SessionDraftAddressV1, { kind: 'newSession' }>;
                baseRevision: number;
                baseRawDocument: SessionDraftDocumentV1;
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
        records: readonly SessionDraftRecordV1[],
    ): Promise<void> {
        const candidates = this.listNewSessionDraftEncryptionMigrationCandidates(scope);
        const candidateKeys = new Set(candidates.map((candidate) => canonicalSessionDraftAddressV1(candidate.address)));
        const candidateRevisionByKey = new Map(candidates.map((candidate) => [
            canonicalSessionDraftAddressV1(candidate.address),
            candidate.baseRevision,
        ]));
        const recordKeys = new Set(records.map((record) => canonicalSessionDraftAddressV1(record.address)));
        if (
            records.length !== candidates.length
            || recordKeys.size !== records.length
            || candidateKeys.size !== recordKeys.size
            || [...candidateKeys].some((key) => !recordKeys.has(key))
        ) {
            throw new Error('Session draft encryption migration response did not cover the exact candidate set');
        }
        const openedRecords: Array<Readonly<{ record: SessionDraftRecordV1; document: SessionDraftDocumentV1 }>> = [];
        for (const record of records) {
            if (record.address.kind !== 'newSession' || record.content === null) {
                throw new Error('Session draft encryption migration returned an invalid record');
            }
            const document = await this.cipher.open(record.address, record.content);
            if (!document) throw new Error(`Unable to open migrated session draft ${canonicalSessionDraftAddressV1(record.address)}`);
            openedRecords.push({ record, document });
        }
        this.withAtomicScopeMutation(scope, () => {
            for (const { record, document } of openedRecords) {
                const replica = this.readReplica(scope, record.address);
                if (
                    !replica
                    || replica.address.kind !== 'newSession'
                    || replica.baseRevision !== candidateRevisionByKey.get(canonicalSessionDraftAddressV1(record.address))
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
    storage: getPersistenceStorage(),
    cipher: unavailableCipher,
    syncEnabled: false,
});

export function configureSessionDraftRepository(options: Readonly<{
    transport?: SessionDraftRepositoryTransport;
    cipher?: SessionDraftRepositoryCipher;
    syncEnabled: boolean;
}>): void {
    singleton.configure(options);
}

export const getSessionDraftSnapshot = singleton.getSessionDraftSnapshot.bind(singleton);
export const readOrdinaryEntryDraftId = singleton.readOrdinaryEntryDraftId.bind(singleton);
export const setOrdinaryEntryDraftId = singleton.setOrdinaryEntryDraftId.bind(singleton);
export const clearOrdinaryEntryDraftIdExact = singleton.clearOrdinaryEntryDraftIdExact.bind(singleton);
export const subscribeSessionDraft = singleton.subscribeSessionDraft.bind(singleton);
export const subscribeSessionDraftList = singleton.subscribeSessionDraftList.bind(singleton);
export const writeExistingSessionDraft = singleton.writeExistingSessionDraft.bind(singleton);
export const writeNewSessionDraft = singleton.writeNewSessionDraft.bind(singleton);
export const writeSessionDraftLocalSupplement = singleton.writeSessionDraftLocalSupplement.bind(singleton);
export const captureSessionDraftCurrentness = singleton.captureSessionDraftCurrentness.bind(singleton);
export const captureSessionDraftLaunchCurrentness = singleton.captureSessionDraftLaunchCurrentness.bind(singleton);
export const readSessionDraftLaunchCurrentness = singleton.readSessionDraftLaunchCurrentness.bind(singleton);
export const clearSessionDraftLaunchCurrentness = singleton.clearSessionDraftLaunchCurrentness.bind(singleton);
export const clearSessionDraftCurrentness = singleton.clearSessionDraftCurrentness.bind(singleton);
export const deleteSessionDraft = singleton.deleteSessionDraft.bind(singleton);
export const flushSessionDraft = singleton.flushSessionDraft.bind(singleton);
export const resolveSessionDraftConflict = singleton.resolveSessionDraftConflict.bind(singleton);
export const materializeExactSessionDraft = singleton.materializeExact.bind(singleton);
export const ensureSessionDraftRepositoryHydrated = singleton.ensureSessionDraftRepositoryHydrated.bind(singleton);
export const getExistingSessionDraftProjection = singleton.getExistingSessionDraftProjection.bind(singleton);
export const listNewSessionDraftProjections = singleton.listNewSessionDraftProjections.bind(singleton);
export const isSessionDraftRemoteAcknowledged = singleton.isSessionDraftRemoteAcknowledged.bind(singleton);
export const listNewSessionDraftEncryptionMigrationCandidates = singleton.listNewSessionDraftEncryptionMigrationCandidates.bind(singleton);
export const acknowledgeNewSessionDraftEncryptionMigration = singleton.acknowledgeNewSessionDraftEncryptionMigration.bind(singleton);
