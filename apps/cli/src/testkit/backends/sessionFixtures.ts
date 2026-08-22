import { EventEmitter } from 'node:events';

import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState, Metadata, PermissionMode, Session } from '@/api/types';
import type { V2SessionListResponse, V2SessionRecord } from '@happier-dev/protocol';

import { createTestMetadata } from './sessionMetadata';

type RecordLike = Record<string, unknown>;
export type SessionRecordFixture = V2SessionRecord;
export type SessionListResponseFixture = V2SessionListResponse;
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
        async enqueueAgentMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        async enqueueUserTextMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        updateMetadata() {},
        async fetchRecentTranscriptTextItemsForAcpImport() {
            return [];
        },
        getMetadataSnapshot() {
            return metadata;
        },
    } as unknown as ApiSessionClient;
}

export function createMutableApiSessionClientFixture<TMetadata extends Record<string, unknown> = Metadata>(options?: {
    sessionId?: string;
    metadata?: TMetadata | null;
    metadataPermissionMode?: PermissionMode;
    agentState?: AgentState;
    overrides?: Partial<ApiSessionClient>;
}): MutableApiSessionClientFixture<TMetadata> {
    const sessionId = options?.sessionId ?? 'test-session-id';
    let metadata = options?.metadata
        ?? ((options?.metadataPermissionMode
            ? createTestMetadata({ permissionMode: options.metadataPermissionMode })
            : null) as TMetadata | null);
    let agentState = options?.agentState ?? {};
    const events = new EventEmitter();
    const rpcHandlerManager = createRpcHandlerManager({
        scopePrefix: sessionId,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => {},
    });

    const fixture = {
        sessionId,
        rpcHandlerManager,
        keepAlive() {},
        async enqueueAgentMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        async enqueueUserTextMessageCommitted() {
            return { persisted: true, delivered: false };
        },
        updateMetadata(updater: (current: TMetadata | null) => TMetadata | null) {
            metadata = updater(metadata);
            events.emit('metadata-updated');
        },
        updateAgentState(updater: (current: AgentState) => AgentState) {
            agentState = updater(agentState);
        },
        async fetchRecentTranscriptTextItemsForAcpImport() {
            return [];
        },
        async fetchLatestUserPermissionIntentFromTranscript() {
            return null;
        },
        async popPendingMessage() {
            return false;
        },
        shouldAttemptPendingMaterialization() {
            return true;
        },
        async waitForMetadataUpdate() {
            return false;
        },
        async refreshSessionSnapshotFromServerBestEffort() {},
        observeProviderInputSettlement() {},
        confirmUserMessageLocallyConsumed() {},
        getMetadataSnapshot() {
            return metadata;
        },
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
