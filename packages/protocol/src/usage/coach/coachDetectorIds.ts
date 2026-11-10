import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** One finite check vocabulary, shared by evaluation and Account preferences. */
export const USAGE_COACH_DETECTOR_IDS = [
    'duplicated_instructions', 'model_misfit', 'idle_recaching', 'approval_friction',
    'mcp_overhead', 'repeated_file_reads', 'compaction_storms', 'anomalous_looping_usage',
    'cache_busting_prompt_changes', 'outside_usage', 'context_bloat',
    'cache_economics', 'effort_audit', 'subagent_fanout',
] as const;
export const UsageCoachDetectorIdSchema = lazyZodSchema(() => z.enum(USAGE_COACH_DETECTOR_IDS));
export type UsageCoachDetectorId = z.infer<typeof UsageCoachDetectorIdSchema>;
