import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';

/**
 * `session.prompt_preview.get` / session RPC `session.promptPreview.get.v1`. The session's live
 * runner computes it from the same plan it launches the provider with; no client rebuilds it.
 */
export const SessionPromptPreviewV1RequestSchema = lazySchema(() => z.object({}).passthrough());
export type SessionPromptPreviewV1Request = z.infer<typeof SessionPromptPreviewV1RequestSchema>;

export const SessionPromptPreviewV1BlockSchema = lazySchema(() => z.object({
    id: z.string().min(1),
    scope: z.string().min(1),
    chars: z.number().int().nonnegative(),
}).passthrough());
export type SessionPromptPreviewV1Block = z.infer<typeof SessionPromptPreviewV1BlockSchema>;

export const SessionPromptPreviewV1ResponseSchema = lazySchema(() => z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    /** The rendered prompt text that applies to the next provider launch. */
    text: z.string(),
    blocks: z.array(SessionPromptPreviewV1BlockSchema),
    /** `retained`: a resumed or reset provider launch rebuilds from retained metadata without account settings. */
    launchForm: z.enum(['fresh', 'retained']),
    /** Provider-specific delivery facts, for example a second rendering appended at a Claude remote launch. */
    providerNotes: z.array(z.string()),
}).passthrough());
export type SessionPromptPreviewV1Response = z.infer<typeof SessionPromptPreviewV1ResponseSchema>;
