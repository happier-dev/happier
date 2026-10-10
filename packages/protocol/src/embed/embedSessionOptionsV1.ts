import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { SessionOwnerMetadataV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';

/** The input consumed by the existing Session model/config-option readers, never a complete owner view. */
export const ComposerOptionsInputV1Schema = lazyZodSchema(() => SessionOwnerMetadataV1Schema.shape.runtime.unwrap().pick({
    sessionModelsV1: true,
    acpSessionModelsV1: true,
    modelSelectionIntentV1: true,
    modelOverrideV1: true,
    sessionConfigOptionOverridesV1: true,
    acpConfigOptionOverridesV1: true,
}).strict());

export type ComposerOptionsInputV1 = z.infer<typeof ComposerOptionsInputV1Schema>;

/** Select before parsing: unrelated owner metadata never enters the transported projection. */
export function projectComposerOptionsInputV1(metadata: unknown): ComposerOptionsInputV1 {
    const record = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(ComposerOptionsInputV1Schema.shape)) {
        if (record[key] !== undefined) projected[key] = record[key];
    }
    return ComposerOptionsInputV1Schema.parse(projected);
}

/** Closed V1 frame projection. Session binding is checked again after authenticated opening. */
export const EmbedSessionOptionsV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    sessionId: z.string().trim().min(1),
    owner: ComposerOptionsInputV1Schema,
}).strict());

export type EmbedSessionOptionsV1 = z.infer<typeof EmbedSessionOptionsV1Schema>;
