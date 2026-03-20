import type { SessionSubagent } from './types';
import { shouldIgnoreProviderSessionSubagentActivityPreviewText } from '@/sync/domains/session/providers/sessionProviderBehaviorRegistry';

type SidechainMessageLike = Readonly<{
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
