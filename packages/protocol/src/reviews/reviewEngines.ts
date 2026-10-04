import { z } from 'zod';

export const ReviewEngineCapabilitiesSchema = z.object({
  structuredNarration: z.boolean(),
}).strict();
export type ReviewEngineCapabilities = z.infer<typeof ReviewEngineCapabilitiesSchema>;

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
