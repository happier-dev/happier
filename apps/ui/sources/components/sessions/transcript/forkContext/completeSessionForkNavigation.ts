import { writeForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { requireLocalSessionVisibleForRoute } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';

type ForkNavigationOptions = Readonly<{ serverId?: string }>;

export type CompleteSessionForkNavigationParams = Readonly<{
    childSessionId: string;
    parentSessionId: string;
    serverId?: string | null;
    navigate: (childSessionId: string, options?: ForkNavigationOptions) => void | Promise<void>;
    restoredDraftText?: string | null;
    sourceMessageId?: string | null;
    writeForkInitialPrompt?: boolean;
}>;

function normalizeServerId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeRestoredDraftText(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isExpectedForkChild(session: Session, parentSessionId: string): boolean {
    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object') return false;
    const fork = (metadata as Record<string, unknown>).forkV1;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork)) return false;
    const forkRecord = fork as Record<string, unknown>;
    return forkRecord.v === 1 && forkRecord.parentSessionId === parentSessionId;
}

function writeRestoredDraft(childSessionId: string, restoredDraftText: string): void {
    try {
        storage.getState().updateSessionDraft(childSessionId, restoredDraftText);
    } catch {
        // Draft restore is best-effort; fork navigation should not fail because local draft persistence failed.
    }
}

async function writeForkInitialPromptMetadata(params: Readonly<{
    childSessionId: string;
    restoredDraftText: string;
    sourceMessageId?: string | null;
    serverId?: string | null;
}>): Promise<void> {
    const serverId = normalizeServerId(params.serverId);
    await sync.patchSessionMetadataWithRetry(
        params.childSessionId,
        (metadata) =>
            writeForkInitialPromptV1({
                metadata: metadata as Metadata,
                text: params.restoredDraftText,
                createdAtMs: Date.now(),
                sourceMessageId: params.sourceMessageId,
            }),
        serverId ? { serverId } : undefined,
    );
}

export async function completeSessionForkNavigation(params: CompleteSessionForkNavigationParams): Promise<void> {
    const restoredDraftText = normalizeRestoredDraftText(params.restoredDraftText);
    const serverId = normalizeServerId(params.serverId);
    await requireLocalSessionVisibleForRoute({
        sessionId: params.childSessionId,
        serverId,
        getStoredSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
        ensureSessionVisibleForMessageRoute: sync.ensureSessionVisibleForMessageRoute,
        isLocalSessionReady: (session) => isExpectedForkChild(session, params.parentSessionId),
    });
    // The draft is locally targeted state. Do not write it until the canonical
    // route owner has proved this row is the expected fork child.
    if (restoredDraftText) writeRestoredDraft(params.childSessionId, restoredDraftText);
    await params.navigate(params.childSessionId, serverId ? { serverId } : undefined);

    if (restoredDraftText && params.writeForkInitialPrompt === true) {
        await writeForkInitialPromptMetadata({
            childSessionId: params.childSessionId,
            restoredDraftText,
            sourceMessageId: params.sourceMessageId,
            serverId,
        });
    }
}
