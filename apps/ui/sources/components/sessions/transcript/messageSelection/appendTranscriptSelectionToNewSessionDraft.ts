import {
    seedNewSessionDraftV1,
    type NewSessionDraftSeedV1,
} from '@/components/sessions/new/newSessionDraftSeed';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type AppendTranscriptSelectionToNewSessionDraftInput = Readonly<{
    promptText: string;
    sourceServerId: string | null | undefined;
    scope?: ServerAccountScope | null;
    nowMs?: () => number;
    createDraftId?: () => string;
    writeDraft?: Parameters<typeof seedNewSessionDraftV1>[0]['writeDraft'];
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/** Creates one fresh exact repository draft for one transcript send-to flow. */
export function appendTranscriptSelectionToNewSessionDraft(
    input: AppendTranscriptSelectionToNewSessionDraftInput,
): string | null {
    const promptText = normalizeNonEmptyString(input.promptText);
    if (!promptText) return null;
    const sourceServerId = normalizeNonEmptyString(input.sourceServerId);
    const seed: NewSessionDraftSeedV1 = {
        prompt: { text: promptText, mode: 'replace' },
        ...(sourceServerId ? { placement: { serverId: sourceServerId } } : {}),
    };
    return seedNewSessionDraftV1({
        seed,
        scope: input.scope,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.createDraftId ? { createDraftId: input.createDraftId } : {}),
        ...(input.writeDraft ? { writeDraft: input.writeDraft } : {}),
    });
}
