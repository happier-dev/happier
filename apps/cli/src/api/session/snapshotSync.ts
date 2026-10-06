import type { AgentState, Metadata } from '../types';
import type { StoredCredentials } from '@/persistence';
import { decodeBase64, decrypt } from '../encryption';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { isDeepStrictEqual } from 'node:util';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { AccountEncryptionCurrentnessResponse, V2SessionByIdResponse } from '@happier-dev/protocol';
import {
    readSessionMetadataLayoutVersion,
    tryReadApiSessionMetadataForLayout,
} from '@/session/metadata/sessionMetadataLayout';
import {
    readSessionMetadataEnvelopeTupleSnapshot,
    readSessionMetadataSharedEditorTupleSnapshot,
    type SessionMetadataEnvelopeTupleSnapshot,
    type SessionMetadataSharedEditorSnapshot,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import { readKnownPendingQueueState, readPendingExecutionRunIds, type KnownPendingQueueState } from './pendingQueueState';
import type { SessionSnapshotRefreshReason } from './sessionSnapshotRefreshReason';
import {
    readLatestTurnStatusSnapshot,
    type LatestTurnStatusSnapshot,
} from './sessionTurnStatusSnapshot';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { TranscriptOpenedAgentStateV1Schema, TranscriptOpenedSharedMetadataV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { TranscriptOpenedAgentStateV1, TranscriptOpenedSharedMetadataV1 } from '@happier-dev/protocol';

export type OpenedSessionStateVersions = Readonly<{ agentStateVersion: number; sharedMetadataVersion: number }>;
export type OpenedSessionStateSnapshot = Readonly<{
    agentState: TranscriptOpenedAgentStateV1 | null;
    sharedMetadata: TranscriptOpenedSharedMetadataV1 | null;
}>;

/** Follow's opened read projection consumes the same layout-aware snapshot owner. */
export async function fetchOpenedSessionStateFromServer(
    opts: Parameters<typeof fetchSessionSnapshotUpdateFromServer>[0],
): Promise<OpenedSessionStateSnapshot> {
    const update = await fetchSessionSnapshotUpdateFromServer(opts);
    const state = opts.metadataAuthority === 'shared_editor' ? null : update.metadataTuple
        ? { version: update.metadataTuple.agentStateVersion, value: update.metadataTuple.value.agentState }
        : update.agentState
            ? { version: update.agentState.agentStateVersion, value: update.agentState.agentState }
            : null;
    const tuple = update.metadataTuple ?? update.sharedMetadataTuple;
    const shared = tuple
        ? { version: tuple.metadataVersion, value: tuple.value.sharedMetadata }
        : update.metadata
            ? { version: update.metadata.metadataVersion, value: projectSessionSharedMetadataV1({ metadata: update.metadata.metadata }) }
            : null;
    return {
        agentState: state && state.version > opts.currentAgentStateVersion ? TranscriptOpenedAgentStateV1Schema.parse(state) : null,
        sharedMetadata: shared && shared.version > opts.currentMetadataVersion ? TranscriptOpenedSharedMetadataV1Schema.parse(shared) : null,
    };
}

export function shouldSyncSessionSnapshotOnConnect(opts: { metadataVersion: number; agentStateVersion: number }): boolean {
    return opts.metadataVersion < 0 || opts.agentStateVersion < 0;
}

type RawSessionSnapshot = Awaited<ReturnType<typeof fetchSessionByIdCompat>>;

const rawSessionSnapshotInFlight = new Map<string, Promise<RawSessionSnapshot>>();

function rawSessionSnapshotInFlightKey(opts: { token: string; sessionId: string; reason?: SessionSnapshotRefreshReason }): string {
    return `${opts.token}\u0000${opts.sessionId}\u0000${opts.reason ?? 'legacy-compat-proof'}`;
}

async function fetchRawSessionSnapshotOnce(opts: { token: string; sessionId: string; reason?: SessionSnapshotRefreshReason }): Promise<RawSessionSnapshot> {
    const key = rawSessionSnapshotInFlightKey(opts);
    const existing = rawSessionSnapshotInFlight.get(key);
    if (existing) {
        return await existing;
    }

    const promise = fetchSessionByIdCompat({ token: opts.token, sessionId: opts.sessionId, reason: opts.reason });
    rawSessionSnapshotInFlight.set(key, promise);
    try {
        return await promise;
    } finally {
        if (rawSessionSnapshotInFlight.get(key) === promise) {
            rawSessionSnapshotInFlight.delete(key);
        }
    }
}

export async function fetchSessionSnapshotUpdateFromServer(opts: {
    token: string;
    sessionId: string;
    credentials?: StoredCredentials | null;
    /**
     * Owner is the default. A `shared_editor` client holds no Account content
     * key, so it reads the layout-1 shared projection instead of the owner
     * tuple and never receives owner metadata or full Agent state.
     */
    metadataAuthority?: 'owner' | 'shared_editor';
    /**
     * Owner Account currentness. A shared editor supplies null: it must not
     * read Account-scoped encryption state with its Session runtime token.
     */
    accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse | null;
    currentMetadataLayoutVersion?: number;
    currentMetadataVersion: number;
    currentAgentStateVersion: number;
    currentMetadata?: Metadata | null;
    currentAgentState?: AgentState | null;
    reason?: SessionSnapshotRefreshReason;
} & SessionStoredContentCryptoContext): Promise<{
    organization?: Pick<V2SessionByIdResponse['session'], 'reportsTo' | 'origin'>;
    metadataLayoutVersion?: number;
    metadataTuple?: SessionMetadataEnvelopeTupleSnapshot;
    sharedMetadataTuple?: SessionMetadataSharedEditorSnapshot;
    metadata?: { metadata: Metadata | null; metadataVersion: number };
    agentState?: { agentState: AgentState | null; agentStateVersion: number };
    pendingQueueState?: KnownPendingQueueState;
    pendingExecutionRunIds?: readonly string[];
    latestTurnStatus?: LatestTurnStatusSnapshot;
    latestTurnStatusObservedAt?: number;
}> {
    const raw = await fetchRawSessionSnapshotOnce({ token: opts.token, sessionId: opts.sessionId, reason: opts.reason });
    if (!raw) return {};

    const sessionEncryptionMode: 'e2ee' | 'plain' =
        (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

    const out: {
        organization?: Pick<V2SessionByIdResponse['session'], 'reportsTo' | 'origin'>;
        metadataLayoutVersion?: number;
        metadataTuple?: SessionMetadataEnvelopeTupleSnapshot;
        sharedMetadataTuple?: SessionMetadataSharedEditorSnapshot;
        metadata?: { metadata: Metadata | null; metadataVersion: number };
        agentState?: { agentState: AgentState | null; agentStateVersion: number };
        pendingQueueState?: KnownPendingQueueState;
        pendingExecutionRunIds?: readonly string[];
        latestTurnStatus?: LatestTurnStatusSnapshot;
        latestTurnStatusObservedAt?: number;
    } = {};
    out.organization = {
        ...(raw.reportsTo ? { reportsTo: raw.reportsTo } : {}),
        ...(raw.origin ? { origin: raw.origin } : {}),
    };

    const pendingQueueState = readKnownPendingQueueState(raw);
    if (pendingQueueState) {
        out.pendingQueueState = pendingQueueState;
    }
    const pendingExecutionRunIds = readPendingExecutionRunIds(raw);
    if (pendingExecutionRunIds) {
        out.pendingExecutionRunIds = pendingExecutionRunIds;
    }

    const latestTurnStatus = readLatestTurnStatusSnapshot((raw as { latestTurnStatus?: unknown } | null)?.latestTurnStatus);
    if (latestTurnStatus !== undefined) {
        out.latestTurnStatus = latestTurnStatus;
        const observedAt = (raw as { latestTurnStatusObservedAt?: unknown }).latestTurnStatusObservedAt;
        if (typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt >= 0) {
            out.latestTurnStatusObservedAt = Math.trunc(observedAt);
        }
    }

    const nextMetadataLayoutVersion = readSessionMetadataLayoutVersion(raw.metadataLayoutVersion);
    const currentMetadataLayoutVersion = readSessionMetadataLayoutVersion(opts.currentMetadataLayoutVersion);
    if (currentMetadataLayoutVersion < 0) {
        return out;
    }
    if (
        nextMetadataLayoutVersion !== 0
        && nextMetadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
    ) {
        return out;
    }
    const metadataLayoutComparison =
        nextMetadataLayoutVersion - currentMetadataLayoutVersion;
    if (metadataLayoutComparison < 0) {
        return out;
    }

    if (nextMetadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
        if (opts.metadataAuthority === 'shared_editor') {
            out.metadataLayoutVersion = SESSION_METADATA_LAYOUT_VERSION_V1;
            out.sharedMetadataTuple = readSessionMetadataSharedEditorTupleSnapshot({
                rawSession: raw,
                ...(opts.mode === 'plain'
                    ? { mode: 'plain' as const, ctx: null }
                    : { mode: 'e2ee' as const, ctx: opts.ctx }),
            });
            return out;
        }
        if (
            !opts.credentials
            || opts.credentials.token !== opts.token
            || !opts.accountEncryptionCurrentness
        ) {
            throw Object.assign(
                new Error('Owner session credentials are unavailable'),
                {
                    code: 'metadata_privacy_upgrade_required',
                    retryable: false,
                },
            );
        }
        out.metadataLayoutVersion = SESSION_METADATA_LAYOUT_VERSION_V1;
        out.metadataTuple = readSessionMetadataEnvelopeTupleSnapshot({
            credentials: opts.credentials,
            rawSession: raw,
            accountEncryptionCurrentness: opts.accountEncryptionCurrentness,
        });
        return out;
    }

    // Sync metadata if it is newer than our local view.
    const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : null;
    const rawMetadata = typeof raw.metadata === 'string' ? raw.metadata : null;
    if (
        rawMetadata
        && nextMetadataVersion !== null
        && (
            metadataLayoutComparison > 0
            || nextMetadataVersion >= opts.currentMetadataVersion
        )
    ) {
        const nextMetadata: Metadata | null | undefined = (() => {
            if (sessionEncryptionMode === 'plain') {
                const parsed = tryParseJsonRecord(rawMetadata);
                if (!parsed) return undefined;
                return tryReadApiSessionMetadataForLayout(
                    parsed,
                    nextMetadataLayoutVersion,
                );
            }
            if (opts.mode !== 'e2ee') return undefined;
            try {
                const decrypted = decrypt(
                    opts.ctx.encryptionKey,
                    opts.ctx.encryptionVariant,
                    decodeBase64(rawMetadata),
                );
                return tryReadApiSessionMetadataForLayout(
                    decrypted,
                    nextMetadataLayoutVersion,
                );
            } catch {
                return undefined;
            }
        })();
        if (
            nextMetadata !== undefined &&
            (
                metadataLayoutComparison > 0 ||
                opts.currentMetadataVersion < 0 ||
                nextMetadataVersion > opts.currentMetadataVersion ||
                !isDeepStrictEqual(nextMetadata, opts.currentMetadata ?? null)
            )
        ) {
            out.metadata = { metadata: nextMetadata, metadataVersion: nextMetadataVersion };
            out.metadataLayoutVersion = nextMetadataLayoutVersion;
        }
    }

    // Sync agent state if it is newer than our local view.
    const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
    const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
    if (
        nextAgentStateVersion !== null
        && (
            metadataLayoutComparison > 0
            || nextAgentStateVersion >= opts.currentAgentStateVersion
        )
    ) {
        const nextAgentState: AgentState | null | undefined = (() => {
            if (!rawAgentState) return null;
            if (sessionEncryptionMode === 'plain') {
                const parsed = tryParseJsonRecord(rawAgentState);
                return parsed ? (parsed as unknown as AgentState) : undefined;
            }
            if (opts.mode !== 'e2ee') return undefined;
            try {
                return decrypt(
                    opts.ctx.encryptionKey,
                    opts.ctx.encryptionVariant,
                    decodeBase64(rawAgentState),
                ) as AgentState;
            } catch {
                return undefined;
            }
        })();
        if (
            nextAgentState !== undefined &&
            (
                metadataLayoutComparison > 0 ||
                opts.currentAgentStateVersion < 0 ||
                nextAgentStateVersion > opts.currentAgentStateVersion ||
                !isDeepStrictEqual(nextAgentState, opts.currentAgentState ?? null)
            )
        ) {
            out.agentState = { agentState: nextAgentState, agentStateVersion: nextAgentStateVersion };
        }
    }

    return out;
}
