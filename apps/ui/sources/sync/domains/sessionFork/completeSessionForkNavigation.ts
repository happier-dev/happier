import { writeForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { sync } from '@/sync/sync';
import { requireLocalSessionVisibleForRoute } from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';

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
    const metadata = readSessionOwnerMetadataView(session);
    if (!metadata || typeof metadata !== 'object') return false;
    const fork = (metadata as Record<string, unknown>).forkV1;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork)) return false;
    const forkRecord = fork as Record<string, unknown>;
    return forkRecord.v === 1 && forkRecord.parentSessionId === parentSessionId;
}

function writeRestoredDraft(childSessionId: string, restoredDraftText: string, serverId?: string | null): void {
    try {
        const activeScope = getActiveServerAccountScope();
        if (!activeScope) return;
        writeExistingSessionDraft({
            scope: {
                serverId: normalizeServerId(serverId) ?? activeScope.serverId,
                accountId: activeScope.accountId,
            },
            sessionId: childSessionId,
            patch: { text: restoredDraftText },
            materializationIntent: 'seeded',
        });
    } catch {
        // The composer draft is local-only and must not make an otherwise valid fork unusable.
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

export async function completeSessionForkNavigation(
    params: CompleteSessionForkNavigationParams,
): Promise<void> {
    const restoredDraftText = normalizeRestoredDraftText(params.restoredDraftText);
    const serverId = normalizeServerId(params.serverId);
    await requireLocalSessionVisibleForRoute({
        sessionId: params.childSessionId,
        serverId,
        getStoredSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
        ensureSessionVisibleForMessageRoute: sync.ensureSessionVisibleForMessageRoute,
        isLocalSessionReady: (session) => isExpectedForkChild(session, params.parentSessionId),
    });
    // A wrong or still-unhydrated child must never receive the parent's draft.
    // Keep this immediately before navigation, after the canonical route owner
    // proved the expected child and without a fork-specific polling loop.
    if (restoredDraftText) writeRestoredDraft(params.childSessionId, restoredDraftText, params.serverId);
    await params.navigate(
        params.childSessionId,
        serverId ? { serverId } : undefined,
    );

    if (restoredDraftText && params.writeForkInitialPrompt === true) {
        await writeForkInitialPromptMetadata({
            childSessionId: params.childSessionId,
            restoredDraftText,
            sourceMessageId: params.sourceMessageId,
            serverId,
        });
    }
}
