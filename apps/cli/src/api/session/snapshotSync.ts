import type { AgentState, Metadata } from '../types';
import { decodeBase64, decrypt } from '../encryption';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { isDeepStrictEqual } from 'node:util';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
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
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    currentMetadataVersion: number;
    currentAgentStateVersion: number;
    currentMetadata?: Metadata | null;
    currentAgentState?: AgentState | null;
    reason?: SessionSnapshotRefreshReason;
}): Promise<{
    metadata?: { metadata: Metadata; metadataVersion: number };
    agentState?: { agentState: AgentState | null; agentStateVersion: number };
    pendingQueueState?: KnownPendingQueueState;
    latestTurnStatus?: LatestTurnStatusSnapshot;
}> {
    const raw = await fetchRawSessionSnapshotOnce({ token: opts.token, sessionId: opts.sessionId, reason: opts.reason });
    if (!raw) return {};

    const sessionEncryptionMode: 'e2ee' | 'plain' =
        (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

    const out: {
        metadata?: { metadata: Metadata; metadataVersion: number };
        agentState?: { agentState: AgentState | null; agentStateVersion: number };
        pendingQueueState?: KnownPendingQueueState;
        latestTurnStatus?: LatestTurnStatusSnapshot;
    } = {};

    const pendingQueueState = readKnownPendingQueueState(raw);
    if (pendingQueueState) {
        out.pendingQueueState = pendingQueueState;
    }

    const latestTurnStatus = readLatestTurnStatusSnapshot((raw as { latestTurnStatus?: unknown } | null)?.latestTurnStatus);
    if (latestTurnStatus !== undefined) {
        out.latestTurnStatus = latestTurnStatus;
    }

    // Sync metadata if it is newer than our local view.
    const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : null;
    const rawMetadata = typeof raw.metadata === 'string' ? raw.metadata : null;
    if (rawMetadata && nextMetadataVersion !== null && nextMetadataVersion >= opts.currentMetadataVersion) {
        const nextMetadata: Metadata | null = (() => {
            if (sessionEncryptionMode === 'plain') {
                return tryParseJsonRecord(rawMetadata) as unknown as Metadata | null;
            }
            try {
                return decrypt(opts.encryptionKey, opts.encryptionVariant, decodeBase64(rawMetadata)) as Metadata;
            } catch {
                return null;
            }
        })();
        if (
            nextMetadata &&
            (
                opts.currentMetadataVersion < 0 ||
                nextMetadataVersion > opts.currentMetadataVersion ||
                !isDeepStrictEqual(nextMetadata, opts.currentMetadata ?? null)
            )
        ) {
            out.metadata = { metadata: nextMetadata, metadataVersion: nextMetadataVersion };
        }
    }

    // Sync agent state if it is newer than our local view.
    const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
    const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
    if (nextAgentStateVersion !== null && nextAgentStateVersion >= opts.currentAgentStateVersion) {
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
