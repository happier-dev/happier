import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { readSessionInputPromptUserTextV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

import { normalizeRawMessages, type NormalizedMessage, type RawMessageNormalizationInput } from "@happier-dev/session-core/raw";

export function normalizeExternalSessionTranscriptMessages(
    items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
    sourceIdentity?: Readonly<{ agentId: string; remoteSessionId: string }>,
): NormalizedMessage[] {
    const displayUserTextById = new Map<string, string>();
    const mediaById = new Map<string, readonly unknown[]>();
    // Place untimed native rows beside their ordered neighbours without inventing
    // a producer timestamp. A wholly untimed page uses the display epoch.
    let displayCreatedAt = items.find(item => item.createdAtMs !== undefined)?.createdAtMs ?? 0;
    return normalizeRawMessages(items.map((item): RawMessageNormalizationInput => {
        displayCreatedAt = item.createdAtMs ?? displayCreatedAt;
        const id = sourceIdentity
            ? makeExternalSessionHistoricalImportLocalId({
                ...sourceIdentity,
                directItemId: item.id,
            })
            : item.id;
        if (typeof item.displayUserText === 'string') displayUserTextById.set(id, item.displayUserText);
        const media = item.raw.media;
        if (Array.isArray(media) && media.length > 0) mediaById.set(id, media);
        return {
            id,
            localId: typeof item.localId === 'string' ? item.localId : null,
            sidechainId: item.sidechainId ?? undefined,
            createdAt: displayCreatedAt,
            // The projection classifies every row it emits; forwarding that role is what lets
            // normalization drop content-less event rows here exactly as it does for synced sessions.
            messageRole: item.messageRole ?? undefined,
            raw: item.raw,
        };
    })).map(message => {
        const media = mediaById.get(message.id);
        // Source-only bytes stay in this transient projection, never in the
        // durable session_media.v1 envelope or a second media store. The
        // ordinary reducer carries metadata to preview/linked transcript rows.
        if (media) message = { ...message, meta: { ...message.meta, externalSessionMedia: media } };
        if (message.role !== 'user') return message;
        const text = displayUserTextById.get(message.id) ?? readSessionInputPromptUserTextV1(message.content.text);
        // Native records and import/send paths retain the original bytes. Only
        // the shared UI projection (preview, linked transcript and Find) changes.
        return text === message.content.text ? message : { ...message, content: { ...message.content, text } };
    });
}
