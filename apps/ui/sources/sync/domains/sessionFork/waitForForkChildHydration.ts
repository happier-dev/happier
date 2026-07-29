import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { requireLocalSessionVisibleForRoute } from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

const DEFAULT_FORK_HYDRATION_TIMEOUT_MS = 2500;
const DEFAULT_FORK_HYDRATION_POLL_INTERVAL_MS = 50;

function hasExpectedForkV1Metadata(
    metadata: Metadata | null | undefined,
    parentSessionId: string,
): boolean {
    if (!metadata || typeof metadata !== 'object') return false;
    const fork = (metadata as Record<string, unknown>).forkV1;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork)) return false;
    const forkRecord = fork as Record<string, unknown>;
    return forkRecord.v === 1 && forkRecord.parentSessionId === parentSessionId;
}

function readStoredSession(sessionId: string): Session | null {
    return storage.getState().sessions[sessionId] ?? null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForForkChildHydration(params: Readonly<{
    childSessionId: string;
    parentSessionId: string;
    serverId?: string | null;
    timeoutMs?: number;
    pollIntervalMs?: number;
}>): Promise<void> {
    await requireLocalSessionVisibleForRoute({
        sessionId: params.childSessionId,
        serverId: params.serverId,
        getStoredSession: readStoredSession,
        ensureSessionVisibleForMessageRoute: sync.ensureSessionVisibleForMessageRoute,
    });

    const initialSession = readStoredSession(params.childSessionId);
    if (hasExpectedForkV1Metadata(
        initialSession ? readSessionOwnerMetadataView(initialSession) : null,
        params.parentSessionId,
    )) {
        return;
    }

    const timeoutMs = params.timeoutMs ?? DEFAULT_FORK_HYDRATION_TIMEOUT_MS;
    const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_FORK_HYDRATION_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await delay(pollIntervalMs);
        const storedSession = readStoredSession(params.childSessionId);
        if (hasExpectedForkV1Metadata(
            storedSession ? readSessionOwnerMetadataView(storedSession) : null,
            params.parentSessionId,
        )) {
            return;
        }
    }

    throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
}
