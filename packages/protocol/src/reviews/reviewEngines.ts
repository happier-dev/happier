import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ReviewEngineCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  structuredNarration: z.boolean(),
}));
export type ReviewEngineCapabilities = z.infer<typeof ReviewEngineCapabilitiesSchema>;

/** Daemon Review inventory; the optional launch model is a read-only projection. */
export const ReviewEngineListItemSchema = lazyZodSchema(() => z.strictObject({
  engineId: z.string(),
  value: z.optional(z.string()),
  label: z.string(),
  enabled: z.boolean(),
  backendId: z.optional(z.string()),
  capabilities: ReviewEngineCapabilitiesSchema,
  description: z.optional(z.string()),
  /** Concrete Account-configured launch model; absent for the Agent's own default. */
  launchModelId: z.optional(z.string()),
}));
export type ReviewEngineListItem = z.infer<typeof ReviewEngineListItemSchema>;

export type ReviewNarratorEngineOption = Readonly<{
  value: string;
  enabled?: boolean;
  disabled?: boolean;
  capabilities?: Readonly<{ structuredNarration?: boolean }>;
}>;

/** Pure selection policy shared by review admission and presentation. */
export function resolveReviewNarratorPolicy(params: Readonly<{
  selectedEngineIds: readonly string[];
  engines: readonly ReviewNarratorEngineOption[];
}>): Readonly<{ requiresSeparateNarrator: boolean; defaultNarratorEngineId: string | null }> {
  const selected = [...new Set(params.selectedEngineIds)];
  const capable = (id: string) => params.engines.some((engine) => engine.value === id
    && engine.enabled !== false && engine.disabled !== true
    && engine.capabilities?.structuredNarration === true);
  return {
    requiresSeparateNarrator: selected.length > 1 || (selected.length === 1 && !capable(selected[0]!)),
    defaultNarratorEngineId: selected.find(capable) ?? null,
  };
}
