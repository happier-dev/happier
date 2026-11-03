import { EventEmitter } from 'node:events';
import { configuration } from '@/configuration';
import { registerPluginCatalogSignal } from '@/api/session/client/registerPluginCatalogSignal';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { V2SessionListRowSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryResponseV1Schema, SessionRuntimeManagedSubtreeSnapshotRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema,
    type SessionReadBatchResponseV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState, Metadata, PermissionMode, Session } from '@/api/types';
import type {
    AccountEncryptionCurrentnessResponse,
    SessionCurrentProjectionRecordV1,
    V2SessionRecord,
} from '@happier-dev/protocol';

import { createTestMetadata } from './sessionMetadata';
import { UNKNOWN_PENDING_QUEUE_STATE } from '@/api/session/pendingQueueState';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';

type RecordLike = Record<string, unknown>;
export type SessionRecordFixture = V2SessionRecord;
/** The CLI full-document facade, rather than the compact HTTP wire response. */
export type SessionListResponseFixture = Readonly<{
    sessions: SessionRecordFixture[];
    nextCursor: string | null;
    hasNext: boolean;
}>;
export type AccountEncryptionCurrentnessFixture = AccountEncryptionCurrentnessResponse;
export type CurrentSessionProjectionRecordFixture = SessionCurrentProjectionRecordV1;
export type PlainSessionFixture = Extract<Session, { encryptionMode: 'plain' }>;
export type MutableApiSessionClientFixture<TMetadata extends Record<string, unknown> = Metadata> = ApiSessionClient & {
    updateMetadata: (updater: (current: TMetadata | null) => TMetadata | null) => void;
    getMetadataSnapshot: () => TMetadata | null;
    __setMetadata: (next: TMetadata | null) => void;
    __getMetadata: () => TMetadata | null;
    __getAgentState: () => AgentState;
};

export function createMockSession(overrides: RecordLike = {}) {
    const base = {
        id: 'test-session-id',
        seq: 0,
        encryptionMode: 'e2ee' as const,
        metadata: createTestMetadata(),
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
    };

    const metadataOverride = overrides.metadata;
    if (metadataOverride && typeof metadataOverride === 'object' && !Array.isArray(metadataOverride)) {
        return {
            ...base,
            ...overrides,
            metadata: {
                ...base.metadata,
                ...metadataOverride,
            },
        };
    }

    return { ...base, ...overrides };
}

export function createPlainSessionFixture(
    overrides: Partial<PlainSessionFixture> & Pick<PlainSessionFixture, 'id'> = { id: 'test-session-id' },
): PlainSessionFixture {
    const { id, ...rest } = overrides;

    return {
        id,
        seq: 0,
        encryptionMode: 'plain',
        metadata: createTestMetadata(),
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        ...rest,
    };
}

export function createSessionClientWithMetadata(opts?: {
    initialMetadata?: Metadata;
    onSendAgentMessageCommitted?: (body: ACPMessageData) => void;
}): {
    session: AcpRuntimeSessionClient;
    metadataUpdates: Metadata[];
    committed: ACPMessageData[];
    getMetadata: () => Metadata;
} {
    let metadata = opts?.initialMetadata ?? createTestMetadata();
    const metadataUpdates: Metadata[] = [];
    const committed: ACPMessageData[] = [];
    const session: AcpRuntimeSessionClient = {
        sessionId: 'test-session-id',
        keepAlive: () => {},
        enqueueAgentMessageCommitted: async (_provider, body, _opts) => {
            committed.push(body);
            opts?.onSendAgentMessageCommitted?.(body);
            return { persisted: true, delivered: false };
        },
        enqueueUserTextMessageCommitted: async (_text, _opts) => ({ persisted: true, delivered: false }),
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: (handler) => {
            metadata = handler(metadata);
            metadataUpdates.push(metadata);
        },
    };
    return { session, metadataUpdates, committed, getMetadata: () => metadata };
}

export function createBasicSessionClient(): AcpRuntimeSessionClient {
    return createBasicSessionClientWithOverrides();
}

export function createBasicSessionClientWithOverrides(
    overrides: Partial<AcpRuntimeSessionClient> = {},
): AcpRuntimeSessionClient {
    return {
        sessionId: 'test-session-id',
        keepAlive: () => {},
        enqueueAgentMessageCommitted: async (_provider, _body, _opts) => ({ persisted: true, delivered: false }),
        enqueueUserTextMessageCommitted: async (_text, _opts) => ({ persisted: true, delivered: false }),
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: (_handler) => {},
        ...overrides,
    };
}

export function createApiSessionClientFixture(options?: {
    metadata?: Metadata | null;
    metadataPermissionMode?: PermissionMode;
}): ApiSessionClient {
    const metadata = options?.metadata
        ?? (options?.metadataPermissionMode
            ? createTestMetadata({ permissionMode: options.metadataPermissionMode })
            : null);

    return {
        keepAlive() {},
        prepareForClose() {},
        retireUndispatchedProviderInput() {},
        markPendingProviderInputDispatched() {},
        async enqueueAgentMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        async enqueueSessionEventCommitted() {
            return { persisted: true, delivered: false };
        },
        async enqueueUserTextMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        updateMetadata() {},
        async fetchRecentTranscriptTextItemsForAcpImport() {
            return [];
        },
        async fetchEarliestCommittedUserMessageLocalId() {
            return null;
        },
        getMetadataSnapshot() {
            return metadata;
        },
    } as unknown as ApiSessionClient;
}

export function createMutableApiSessionClientFixture<TMetadata extends Record<string, unknown> = Metadata>(options?: {
    sessionId?: string;
    serverBinding?: ReturnType<ApiSessionClient['getServerBinding']>;
    metadata?: TMetadata | null;
    metadataPermissionMode?: PermissionMode;
    agentState?: AgentState;
    overrides?: Omit<Partial<ApiSessionClient>, 'updateMetadata'> & {
        updateMetadata?: (updater: (current: TMetadata | null) => TMetadata | null) => void;
    };
}): MutableApiSessionClientFixture<TMetadata> {
    const sessionId = options?.sessionId ?? 'test-session-id';
    // Mirror the ApiSessionClient transport boundary's immutable construction
    // binding; later ambient configuration cannot move this Session's Home.
    const serverBinding = Object.freeze({
        ...(options?.serverBinding ?? { serverId: configuration.activeServerId, serverUrl: configuration.serverUrl }),
    });
    let metadata = options?.metadata
        ?? ((options?.metadataPermissionMode
            ? createTestMetadata({ permissionMode: options.metadataPermissionMode })
            : null) as TMetadata | null);
    let agentState = options?.agentState ?? {};
    const events = new EventEmitter();
    let closed = false;
    let mcpRequestAuth: ReturnType<ApiSessionClient['getMcpRequestAuthPort']>;
    const rpcHandlerManager = createRpcHandlerManager({
        scopePrefix: sessionId,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => {},
    });

    const fixture = {
        sessionId,
        getServerBinding: () => serverBinding,
        getServerFeaturesSnapshot: () => null,
        getServerIdentityId: () => readServerIdentityIdFromFeaturesSnapshot(options?.overrides?.getServerFeaturesSnapshot?.()),
        bindMcpRequestAuthPort(port: Parameters<ApiSessionClient['bindMcpRequestAuthPort']>[0]) {
            mcpRequestAuth = port;
        },
        getMcpRequestAuthPort: () => mcpRequestAuth,
        rpcHandlerManager,
        subscribeDaemonPluginCatalogChanges: registerPluginCatalogSignal({ rpcHandlerManager, events }),
        getEphemeralStreamConnectionEpoch: () => 0,
        // Offline Session boundary: hints reach the real registered local RPC
        // handler. Live Sessions require the authenticated relay's ack.
        isDaemonPluginCatalogSignalReady: () => true,
        keepAlive() {},
        async enqueueAgentMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        async enqueueUserTextMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        async updateMetadata(updater: (current: TMetadata | null) => TMetadata | null) {
            metadata = updater(metadata);
            events.emit('metadata-updated');
        },
        hasOwnerMetadataAuthority: () => true,
        async updateMetadataAsCurrentPublisher(updater: (current: TMetadata | null) => TMetadata | null) {
            // This generic transport fixture uses the caller's metadata view;
            // production enforces publisher currentness at the Home boundary.
            fixture.updateMetadata(updater);
        },
        updateAgentState(updater: (current: AgentState) => AgentState) {
            agentState = updater(agentState);
        },
        async updateAgentStateRequestSettlement(updater: (current: AgentState) => AgentState) {
            agentState = updater(agentState);
        },
        async fetchRecentTranscriptTextItemsForAcpImport() {
            return [];
        },
        async fetchLatestUserPermissionIntentFromTranscript() {
            return null;
        },
        async fetchEarliestCommittedUserMessageLocalId() {
            return null;
        },
        async popPendingMessage() {
            return false;
        },
        getPendingQueueState() {
            return UNKNOWN_PENDING_QUEUE_STATE;
        },
        async reconcilePendingQueueState() {
            return false;
        },
        shouldAttemptPendingMaterialization() {
            return true;
        },
        waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
            if (closed || abortSignal?.aborted) return Promise.resolve(false);
            // Mirror the real Session interaction port's offline lifecycle:
            // metadata wakes the reader; caller abort or local close releases it.
            return new Promise((resolve) => {
                const settle = (updated: boolean) => {
                    events.off('metadata-updated', onUpdate);
                    events.off('local-closed', onClosed);
                    abortSignal?.removeEventListener('abort', onClosed);
                    resolve(updated);
                };
                const onUpdate = () => settle(true);
                const onClosed = () => settle(false);
                events.on('metadata-updated', onUpdate);
                events.on('local-closed', onClosed);
                abortSignal?.addEventListener('abort', onClosed, { once: true });
            });
        },
        async refreshSessionSnapshotFromServerBestEffort() {},
        async refreshSessionSnapshotFromServerRequired() {},
        async disposeExecutionRuns() {},
        observeProviderInputSettlement() {},
        markPendingProviderInputDispatched() {},
        confirmUserMessageLocallyConsumed() {},
        getMetadataSnapshot() {
            return metadata;
        },
        getAgentStateSnapshot() {
            return agentState;
        },
        async close() {
            closed = true;
            events.emit('local-closed');
        },
        prepareForClose() {},
        retireUndispatchedProviderInput() {},
        on(event: string, listener: (...args: unknown[]) => void) {
            return events.on(event, listener);
        },
        off(event: string, listener: (...args: unknown[]) => void) {
            return events.off(event, listener);
        },
        __setMetadata(next: TMetadata | null) {
            metadata = next;
        },
        __getMetadata() {
            return metadata;
        },
        __getAgentState() {
            return agentState;
        },
        ...options?.overrides,
    };

    return fixture as unknown as MutableApiSessionClientFixture<TMetadata>;
}

export function createSessionRecordFixture(
    overrides: Partial<SessionRecordFixture> & Pick<SessionRecordFixture, 'id'>,
): SessionRecordFixture {
    const { id, ...rest } = overrides;

    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadata: 'metadata',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        ...rest,
    };
}

export function createCurrentSessionProjectionRecordFixture(
    overrides: Partial<CurrentSessionProjectionRecordFixture>
        & Pick<CurrentSessionProjectionRecordFixture, 'id' | 'effectiveAccess'>,
): CurrentSessionProjectionRecordFixture {
    return {
        ...createSessionRecordFixture(overrides),
        responsibleAccountId: null,
        responsibleAccount: null,
        ...overrides,
    };
}

/** Authenticated current-owner Session detail returned by notification HTTP fixtures. */
export function createSessionNotificationContextFixture(sessionId: string): CurrentSessionProjectionRecordFixture {
    return createCurrentSessionProjectionRecordFixture({
        id: sessionId,
        share: null,
        effectiveAccess: {
            v: 1,
            level: 'owner',
            sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
        },
        viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' },
            relevance: { relevant: true, reasons: ['owned_by_me'] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
        },
    });
}

/** Runtime subtree recipients use the listing owner's view grant, never Account-owner facts. */
export function createSessionRuntimeManagedSubtreeRecordFixture(
    overrides: Partial<SessionRecordFixture> & Pick<SessionRecordFixture, 'id'>,
): CurrentSessionProjectionRecordFixture {
    return SessionRuntimeManagedSubtreeSnapshotRecordV1Schema.parse(createCurrentSessionProjectionRecordFixture({
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        agentState: null,
        effectiveAccess: { v: 1, level: 'view', sources: [], capabilities: projectSessionAccessCapabilitiesV1({
            owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }],
        }) },
        ...overrides,
    }));
}

/**
 * The `/v1/account/encryption/currentness` boundary response.
 *
 * Typed against the Protocol schema the CLI actually parses, so a required field added by the
 * Account-encryption owner fails this fixture at compile time instead of turning every test that
 * hand-rolled the object literal red at runtime.
 */
export function createAccountEncryptionCurrentnessFixture(
    overrides: Partial<AccountEncryptionCurrentnessFixture> = {},
): AccountEncryptionCurrentnessFixture {
    const mode = overrides.mode ?? 'plain';

    return {
        mode,
        version: 0,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 0,
        // A plain Account holds no client Account data-encryption material at all, so its
        // recipient envelope is unavailable for that reason rather than through a failure.
        recipientEnvelopeReadiness: mode === 'plain'
            ? { status: 'unavailable', reason: 'plain_account' }
            : { status: 'available' },
        ...overrides,
    };
}

export function createSessionListResponseFixture(
    rows: Array<SessionRecordFixture>,
    options: {
        nextCursor?: string | null;
        hasNext?: boolean;
    } = {},
): SessionListResponseFixture {
    return {
        sessions: rows,
        nextCursor: options.nextCursor ?? null,
        hasNext: options.hasNext ?? false,
    };
}

/** Compact HTTP wire row; full consumer-facade fixtures remain separate above. */
export function createCompactSessionListRowFixture(session: SessionRecordFixture) {
    const { metadata: _metadata, ownerMetadata: _ownerMetadata, agentState: _agentState, ...facts } = session;
    const shared = readSessionAccessProjectionRoleV1(session) !== 'owner';
    return V2SessionListRowSchema.parse({ ...facts, metadataLayoutVersion: shared ? 1 : session.metadataLayoutVersion ?? 0,
        agentStateVersion: session.agentStateVersion ?? 0, documents: 'omitted',
        metadataAudience: shared ? 'shared' : 'owner', agentStateDocument: shared ? 'redacted' : 'omitted' });
}

export function createCompactSessionListQueryResponseFixture(params: Readonly<{
    sessions: readonly SessionRecordFixture[];
    nextCursor: string | null;
    hasNext: boolean;
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
    metadataUpgradeRequiredCount?: number;
}>) {
    return SessionListQueryResponseV1Schema.parse({ ...params,
        sessions: params.sessions.map(createCompactSessionListRowFixture) });
}

export type SessionReadBatchDetailFailureFixture = Exclude<
    NonNullable<SessionReadBatchResponseV1['results'][number]['detail']>, { status: 200 }>;

/** Session-parts HTTP boundary; every supplied document passes its real wire schema. */
export function createSessionReadBatchResponseFixture(params: Readonly<{
    request: unknown;
    sessions: readonly SessionRecordFixture[];
    failures?: ReadonlyMap<string, SessionReadBatchDetailFailureFixture>;
    turns?: ReadonlyMap<string, NonNullable<SessionReadBatchResponseV1['results'][number]['turns']>>;
    messages?: ReadonlyMap<string, NonNullable<SessionReadBatchResponseV1['results'][number]['messages']>>;
}>) {
    const demand = SessionReadBatchRequestV1Schema.parse(params.request);
    const byId = new Map(params.sessions.map(session => [session.id, session]));
    return SessionReadBatchResponseV1Schema.parse({ results: demand.sessionIds.map(sessionId => {
        const session = byId.get(sessionId);
        const detail = params.failures?.get(sessionId)
            ?? (session ? { status: 200, body: { session } }
                : { status: 404, body: { error: 'Session not found' } });
        const includeParts = !demand.includeSnapshot || detail.status === 200;
        const turns = includeParts && demand.includeSnapshot && demand.includeTurns !== false ? params.turns?.get(sessionId) : undefined;
        const messages = includeParts && demand.includeMessages ? params.messages?.get(sessionId) : undefined;
        if (includeParts && demand.includeSnapshot && demand.includeTurns !== false && !turns
            || includeParts && demand.includeMessages && !messages) {
            throw new Error('Session batch fixture is missing a demanded part');
        }
        return { sessionId, ...(demand.includeSnapshot ? { detail } : {}),
            ...(turns ? { turns } : {}), ...(messages ? { messages } : {}) };
    }) });
}
