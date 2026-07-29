import { writeForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

import { waitForForkChildHydration } from './waitForForkChildHydration';

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

function writeRestoredDraft(childSessionId: string, restoredDraftText: string): void {
    try {
        storage.getState().updateSessionDraft(childSessionId, restoredDraftText);
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
    if (restoredDraftText) {
        writeRestoredDraft(params.childSessionId, restoredDraftText);
    }

    await waitForForkChildHydration({
        childSessionId: params.childSessionId,
        parentSessionId: params.parentSessionId,
        serverId,
    });
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
