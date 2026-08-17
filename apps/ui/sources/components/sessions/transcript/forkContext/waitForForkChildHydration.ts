import type { Metadata } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

const DEFAULT_FORK_HYDRATION_TIMEOUT_MS = 2500;
const DEFAULT_FORK_HYDRATION_POLL_INTERVAL_MS = 50;

export const FORK_CHILD_NOT_HYDRATED_ERROR =
    'Fork child session is not available locally as a child of this session';

/**
 * Has the row for `childSessionId` hydrated as a fork child OF THIS parent?
 *
 * The child id arrives from the fork RPC, so the store row it names is the only
 * local evidence, and `forkV1.v` alone does not identify it: every fork child
 * carries that. Comparing the recorded parent is what separates this fork's
 * child from a stale or unrelated one, and it is the difference between
 * navigating the reader into their new fork and into somebody else's Session.
 */
function isHydratedForkChildOfParent(
    metadata: Metadata | null | undefined,
    parentSessionId: string,
): boolean {
    if (!metadata || typeof metadata !== 'object') return false;
    const fork = (metadata as Record<string, unknown>).forkV1;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork)) return false;
    const forkRecord = fork as Record<string, unknown>;
    return forkRecord.v === 1 && forkRecord.parentSessionId === parentSessionId;
}

function hasHydratedForkChild(sessionId: string, parentSessionId: string): boolean {
    const session = storage.getState().sessions[sessionId];
    return isHydratedForkChildOfParent(session?.metadata as Metadata | null | undefined, parentSessionId);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves once the child row is present AND proves this parent; rejects
 * otherwise. Rejecting rather than reporting is deliberate: the one caller
 * navigates next, and an unproven child is exactly what must not be navigated
 * to. Its existing failure handling already keeps the fork flow on screen.
 */
export async function waitForForkChildHydration(params: Readonly<{
    childSessionId: string;
    parentSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
}>): Promise<void> {
    await sync.ensureSessionVisibleForMessageRoute(params.childSessionId, { forceRefresh: true });

    if (hasHydratedForkChild(params.childSessionId, params.parentSessionId)) return;

    const timeoutMs = params.timeoutMs ?? DEFAULT_FORK_HYDRATION_TIMEOUT_MS;
    const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_FORK_HYDRATION_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await delay(pollIntervalMs);
        if (hasHydratedForkChild(params.childSessionId, params.parentSessionId)) return;
    }

    throw new Error(FORK_CHILD_NOT_HYDRATED_ERROR);
}
