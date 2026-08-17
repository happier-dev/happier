import { writeForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

import { waitForForkChildHydration } from './waitForForkChildHydration';

export type CompleteSessionForkNavigationParams = Readonly<{
    childSessionId: string;
    parentSessionId: string;
    navigate: (childSessionId: string) => void | Promise<void>;
    restoredDraftText?: string | null;
    sourceMessageId?: string | null;
    writeForkInitialPrompt?: boolean;
}>;

function normalizeRestoredDraftText(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
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
}>): Promise<void> {
    await sync.patchSessionMetadataWithRetry(params.childSessionId, (metadata) =>
        writeForkInitialPromptV1({
            metadata: metadata as Metadata,
            text: params.restoredDraftText,
            createdAtMs: Date.now(),
            sourceMessageId: params.sourceMessageId,
        }),
    );
}

export async function completeSessionForkNavigation(params: CompleteSessionForkNavigationParams): Promise<void> {
    const restoredDraftText = normalizeRestoredDraftText(params.restoredDraftText);
    if (restoredDraftText) {
        writeRestoredDraft(params.childSessionId, restoredDraftText);
    }

    await waitForForkChildHydration({
        childSessionId: params.childSessionId,
        parentSessionId: params.parentSessionId,
    });
    await params.navigate(params.childSessionId);

    if (restoredDraftText && params.writeForkInitialPrompt === true) {
        await writeForkInitialPromptMetadata({
            childSessionId: params.childSessionId,
            restoredDraftText,
            sourceMessageId: params.sourceMessageId,
        });
    }
}
