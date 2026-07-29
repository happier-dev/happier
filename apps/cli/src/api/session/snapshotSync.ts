import type { AgentState, Metadata } from '../types';
import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt } from '../encryption';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { isDeepStrictEqual } from 'node:util';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol';
import {
    readSessionMetadataLayoutVersion,
    tryReadApiSessionMetadataForLayout,
} from '@/session/metadata/sessionMetadataLayout';
import {
    readSessionMetadataEnvelopeTupleSnapshot,
    type SessionMetadataEnvelopeTupleSnapshot,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';
import type { SessionSnapshotRefreshReason } from './sessionSnapshotRefreshReason';
import {
    readLatestTurnStatusSnapshot,
    type LatestTurnStatusSnapshot,
} from './sessionTurnStatusSnapshot';

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
    credentials?: Credentials | null;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    currentMetadataLayoutVersion?: number;
    currentMetadataVersion: number;
    currentAgentStateVersion: number;
    currentMetadata?: Metadata | null;
    currentAgentState?: AgentState | null;
    reason?: SessionSnapshotRefreshReason;
}): Promise<{
    metadataLayoutVersion?: number;
    metadataTuple?: SessionMetadataEnvelopeTupleSnapshot;
    metadata?: { metadata: Metadata | null; metadataVersion: number };
    agentState?: { agentState: AgentState | null; agentStateVersion: number };
    pendingQueueState?: KnownPendingQueueState;
    latestTurnStatus?: LatestTurnStatusSnapshot;
    latestTurnStatusObservedAt?: number;
}> {
    const raw = await fetchRawSessionSnapshotOnce({ token: opts.token, sessionId: opts.sessionId, reason: opts.reason });
    if (!raw) return {};

    const sessionEncryptionMode: 'e2ee' | 'plain' =
        (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

    const out: {
        metadataLayoutVersion?: number;
        metadataTuple?: SessionMetadataEnvelopeTupleSnapshot;
        metadata?: { metadata: Metadata | null; metadataVersion: number };
        agentState?: { agentState: AgentState | null; agentStateVersion: number };
        pendingQueueState?: KnownPendingQueueState;
        latestTurnStatus?: LatestTurnStatusSnapshot;
        latestTurnStatusObservedAt?: number;
    } = {};

    const pendingQueueState = readKnownPendingQueueState(raw);
    if (pendingQueueState) {
        out.pendingQueueState = pendingQueueState;
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
        if (!opts.credentials || opts.credentials.token !== opts.token) {
            throw Object.assign(
                new Error('Owner session metadata encryption material is unavailable'),
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
            try {
                const decrypted = decrypt(
                    opts.encryptionKey,
                    opts.encryptionVariant,
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
            try {
                return decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawAgentState)) as AgentState;
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
