import { readRecord, hasOwn } from '../inputs/inputRecords.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ExecutionRunRetentionPolicySchema } from '../execution/runs/runPrimitives.js';
import { MachineAgentExecutionStateV1Schema } from '../capabilities/machineAgentInventory.js';
import type { ReviewStartInput, ReviewReviewerSelectionV1 } from './reviewStart.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { ExecutionRunProfileDescriptorSchema } from '../plugins/contributions/executionRunProfiles.js';
import { PluginAgentRunnerV1Schema, PluginAgentRunnerSelectionV1Schema } from '../plugins/contributions/agentContributionV2.js';

export const ReviewEngineCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  structuredNarration: z.boolean(),
  sessionTranscript: z.optional(z.boolean()),
}));
export type ReviewEngineCapabilities = z.infer<typeof ReviewEngineCapabilitiesSchema>;

export const ReviewEngineScopeSchema = lazyZodSchema(() => z.enum(['worktree', 'paths', 'repository']));
export type ReviewEngineScope = z.infer<typeof ReviewEngineScopeSchema>;
export const REVIEW_ENGINE_SCOPE_UNSUPPORTED = 'review_scope_unsupported' as const;

export function reviewScopeForInput(input: unknown): ReviewEngineScope {
  const record = readRecord(input);
  if (record.scope === 'repository') return 'repository';
  return hasOwn(record, 'selectedPaths') || hasOwn(record, 'selectedFiles') ? 'paths' : 'worktree';
}

/** Daemon Review inventory; the optional launch model is a read-only projection. */
export const ReviewEngineListItemSchema = lazyZodSchema(() => z.strictObject({
  engineId: z.string(),
  value: z.optional(z.string()),
  label: z.string(),
  enabled: z.boolean(),
  backendId: z.optional(z.string()),
  runnerAgents: z.optional(z.array(PluginAgentRunnerV1Schema)),
  runnerSelection: z.optional(PluginAgentRunnerSelectionV1Schema),
  capabilities: ReviewEngineCapabilitiesSchema,
  retentionPolicy: z.optional(ExecutionRunRetentionPolicySchema),
  available: z.optional(z.boolean()),
  unavailableCode: z.optional(z.string()),
  readiness: z.optional(MachineAgentExecutionStateV1Schema),
  reviewScopes: z.optional(z.array(ReviewEngineScopeSchema)),
  profileId: z.optional(z.string()),
  profileSourceCustody: z.optional(PluginSourceCustodyV1Schema),
  /** Optional acknowledgement for this start; the engine decides whether it is required at admission. */
  costConsent: z.optional(z.strictObject({
    optionKey: z.string(),
    title: z.string(),
    description: z.optional(z.string()),
  })),
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
  executionRunProfiles: z.optional(z.array(ExecutionRunProfileDescriptorSchema)),
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

/** Refresh only the selected paid options; retained consent never admits another paid launch. */
export function refreshReviewNewRoundCostConsentV1(input: ReviewStartInput,
  selection: ReviewEngineInventory | ReviewEngineListItem, costConsent?: boolean): ReviewStartInput {
  const engines = { ...input.engines };
  const confirmed: Record<string, boolean> = {};
  const refreshItem = (item: ReviewEngineListItem, reviewerEngineId?: string) => {
    if (!item.costConsent) return;
    const key = item.costConsent.optionKey;
    confirmed[key] = costConsent === true;
    for (const engineId of new Set([item.engineId, item.value, reviewerEngineId])) {
      if (engineId && (engineId === reviewerEngineId || Object.hasOwn(engines, engineId))) {
        engines[engineId] = { ...engines[engineId], [key]: costConsent === true };
      }
    }
  };
  // A native Run supplies its actual selected profile, independently of the retained roster.
  if (!('items' in selection)) refreshItem(selection);
  const refresh = (candidate: ReviewReviewerSelectionV1): ReviewReviewerSelectionV1 => {
    if (candidate.kind !== 'engine') return candidate;
    const profileId = candidate.profileId ?? input.profileId;
    const items = 'items' in selection
      ? profileId ? selection.selectionItems ?? selection.items : selection.items : [selection];
    const item = items.find(item => (item.engineId === candidate.engineId || item.value === candidate.engineId)
      && (!('items' in selection) || !profileId || item.profileId === profileId));
    if (!item?.costConsent) return candidate;
    refreshItem(item, candidate.engineId);
    // Preserve the reviewer's admitted JSON intersection; a spread widens opaque native option fields.
    return Object.assign({}, candidate, { options: { ...candidate.options, [item.costConsent.optionKey]: costConsent === true } });
  };
  const reviewers = input.reviewers.map(refresh);
  const steps = input.steps?.map(step => ({ ...step, reviewers: step.reviewers.map(refresh) }));
  return { ...input, ...confirmed, engines, reviewers, ...(steps ? { steps } : {}) };
}
