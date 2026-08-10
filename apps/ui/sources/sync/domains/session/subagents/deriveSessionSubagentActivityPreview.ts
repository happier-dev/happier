import type { SessionSubagent } from './types';
import { shouldIgnoreProviderSessionSubagentActivityPreviewText } from '@/sync/domains/session/providers/sessionProviderBehaviorRegistry';

type SidechainMessageLike = Readonly<{
    createdAt?: number | null;
    text?: string | null;
    tool?: Readonly<{
        name?: string | null;
        description?: string | null;
    }> | null;
}>;

type SidechainStateLike = Readonly<{
    sidechains?: ReadonlyMap<string, readonly SidechainMessageLike[]> | null;
}> | null;

function normalizePreviewText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

export function deriveSessionSubagentActivityPreview(params: Readonly<{
    subagent: SessionSubagent;
    reducerState: SidechainStateLike;
}>): string | null {
    const sidechainId = params.subagent.transcript.sidechainId?.trim();
    if (!sidechainId) return null;

    const sidechainMessages = params.reducerState?.sidechains?.get(sidechainId);
    if (!Array.isArray(sidechainMessages) || sidechainMessages.length === 0) return null;

    for (let index = sidechainMessages.length - 1; index >= 0; index -= 1) {
        const message = sidechainMessages[index];
        const textPreview = normalizePreviewText(message?.text);
        if (textPreview) {
            if (!shouldIgnoreProviderSessionSubagentActivityPreviewText({
                subagent: params.subagent,
                text: textPreview,
            })) {
                return textPreview;
            }
        }

        const descriptionPreview = normalizePreviewText(message?.tool?.description);
        if (descriptionPreview) return descriptionPreview;

        const toolName = normalizePreviewText(message?.tool?.name);
        if (toolName) return toolName;
    }

    return null;
}

/**
 * When this subagent was last observed doing something, or `null` when nothing has been observed.
 *
 * A *different question* from the preview above, which is why it is a second pass rather than a
 * second return value: the preview walks backwards for the newest line worth showing and may skip
 * several messages that carry no usable text, while "when did anything last arrive" counts every
 * message. A tool result with no description is not something to display, but it is certainly
 * evidence the agent is alive.
 *
 * `null` is load-bearing. It means "we have not observed this agent", which is the normal state for
 * a roster entry whose sidechain has not been hydrated — and the staleness rules make no claim from
 * it. Substituting the subagent's own `timestamps.updatedAtMs` here would look like a reasonable
 * fallback and would be wrong: for a live sidechain subagent that value is the launching tool
 * message's `createdAt` and never advances, so every healthy long-running agent would read as
 * silent.
 */
export function deriveSessionSubagentLastActivityAtMs(params: Readonly<{
    subagent: SessionSubagent;
    reducerState: SidechainStateLike;
}>): number | null {
    const sidechainId = params.subagent.transcript.sidechainId?.trim();
    if (!sidechainId) return null;

    const sidechainMessages = params.reducerState?.sidechains?.get(sidechainId);
    if (!Array.isArray(sidechainMessages) || sidechainMessages.length === 0) return null;

    // The maximum rather than the last element: arrival order and `createdAt` order are not the
    // same thing once a late-delivered message lands, and a timestamp that can go backwards would
    // make an agent flicker between quiet and fresh.
    let latest: number | null = null;
    for (const message of sidechainMessages) {
        const createdAt = message?.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
        if (latest == null || createdAt > latest) latest = createdAt;
    }
    return latest;
}
