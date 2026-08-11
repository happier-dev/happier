import type { ReactElement } from 'react';

import { findStructuredMessageRenderer } from '@/components/sessions/transcript/structured/structuredMessageRegistry';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

export type ExecutionRunStructuredMetaEnvelope = Readonly<{
    kind: string;
    payload: unknown;
}>;

/**
 * Render an execution run's structured outcome when the envelope came from the RUN REGISTRY
 * (`sessionExecutionRunGet(..., { includeStructured: true })`) rather than from a transcript
 * message's `meta.happier`.
 *
 * The kind → schema → card table is deliberately NOT restated here. This module used to carry its
 * own copy of the review/plan/delegate bindings alongside the transcript's
 * `STRUCTURED_MESSAGE_REGISTRY`, which meant one concept with two decision-makers: a card added or
 * corrected in the registry silently did not reach the run surfaces, and the two could disagree
 * about the same payload. The registry is the single owner; this function is only the
 * run-registry-shaped way in, for callers that hold an envelope and no message.
 */
export function renderExecutionRunStructuredMeta(params: Readonly<{
    meta: ExecutionRunStructuredMetaEnvelope;
    sessionId: string;
    interaction: TranscriptInteraction;
}>): ReactElement | null {
    const entry = findStructuredMessageRenderer(params.meta.kind);
    if (!entry) return null;

    const parsed = entry.schema.safeParse(params.meta.payload);
    if (!parsed.success) return null;

    return entry.render(parsed.data, {
        sessionId: params.sessionId,
        interaction: params.interaction,
    });
}
