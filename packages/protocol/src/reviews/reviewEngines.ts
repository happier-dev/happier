import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ExecutionRunRetentionPolicySchema } from '../execution/runs/runPrimitives.js';
import { MachineAgentExecutionStateV1Schema } from '../capabilities/machineAgentInventory.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';

export const ReviewEngineCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  structuredNarration: z.boolean(),
  sessionTranscript: z.optional(z.boolean()),
}));
export type ReviewEngineCapabilities = z.infer<typeof ReviewEngineCapabilitiesSchema>;

export const ReviewEngineScopeSchema = lazyZodSchema(() => z.enum(['worktree', 'paths', 'repository']));
export type ReviewEngineScope = z.infer<typeof ReviewEngineScopeSchema>;

/** Daemon Review inventory; the optional launch model is a read-only projection. */
export const ReviewEngineListItemSchema = lazyZodSchema(() => z.strictObject({
  engineId: z.string(),
  value: z.optional(z.string()),
  label: z.string(),
  enabled: z.boolean(),
  backendId: z.optional(z.string()),
  capabilities: ReviewEngineCapabilitiesSchema,
  retentionPolicy: z.optional(ExecutionRunRetentionPolicySchema),
  available: z.optional(z.boolean()),
  unavailableCode: z.optional(z.string()),
  readiness: z.optional(MachineAgentExecutionStateV1Schema),
  reviewScopes: z.optional(z.array(ReviewEngineScopeSchema)),
  profileId: z.optional(z.string()),
  profileSourceCustody: z.optional(PluginSourceCustodyV1Schema),
  description: z.optional(z.string()),
  /** Concrete Account-configured launch model; absent for the Agent's own default. */
  launchModelId: z.optional(z.string()),
}));
export type ReviewEngineListItem = z.infer<typeof ReviewEngineListItemSchema>;
export const ReviewEngineProfileSelectionSchema = lazyZodSchema(() => z.strictObject({
  engineId: ReviewEngineListItemSchema.shape.engineId,
  profileId: z.nonoptional(ReviewEngineListItemSchema.shape.profileId),
  profileSourceCustody: ReviewEngineListItemSchema.shape.profileSourceCustody,
}));
export type ReviewEngineProfileSelection = z.infer<typeof ReviewEngineProfileSelectionSchema>;

export const ReviewEngineInventorySchema = lazyZodSchema(() => z.object({
  items: z.array(ReviewEngineListItemSchema),
  selectionItems: z.optional(z.array(ReviewEngineListItemSchema)),
}));
export type ReviewEngineInventory = z.infer<typeof ReviewEngineInventorySchema>;

export type ReviewNarratorEngineOption = Readonly<{
  value: string;
  enabled?: boolean;
  disabled?: boolean;
  retentionPolicy?: z.infer<typeof ExecutionRunRetentionPolicySchema>;
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
    && engine.retentionPolicy !== 'ephemeral'
    && engine.capabilities?.structuredNarration === true);
  return {
    requiresSeparateNarrator: selected.length > 1 || (selected.length === 1 && !capable(selected[0]!)),
    defaultNarratorEngineId: selected.find(capable) ?? null,
  };
}
