import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

/**
 * The one declared Agent Session capability set.
 *
 * It lives in this focused contribution module rather than inside the aggregate
 * V2 manifest so a small runtime contract — such as the Execution Run
 * interaction projection — can consume it without importing the whole plugin
 * contribution catalog. `v2.ts` re-exports this exact schema; there is no second
 * capability vocabulary.
 */
const PluginAgentGoalSetCapabilityV2Schema = lazyZodSchema(() => z.object({
  fields: z.array(z.enum(['objective', 'status', 'tokenBudget'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  writableStatuses: z.array(z.enum(['active', 'paused', 'complete'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.').optional(),
}).strict());
const PluginAgentGoalControlModeV2Schema = lazyZodSchema(() => z.object({
  get: z.literal(true).optional(), clear: z.literal(true).optional(), set: PluginAgentGoalSetCapabilityV2Schema.optional(),
}).strict().refine((value) => value.get || value.clear || value.set, 'At least one goal control capability is required.'));
const activity = <T extends z.ZodTypeAny>(schema: T) => z.object({ active: schema.optional(), inactive: schema.optional() }).strict()
  .refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.');
const PluginAgentGoalsV2Schema = lazyZodSchema(() => z.object({
  active: PluginAgentGoalControlModeV2Schema.optional(),
  inactive: PluginAgentGoalControlModeV2Schema.optional(),
  source: z.string().trim().min(1),
}).strict().refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.'));

export const PluginAgentSessionCapabilitiesV2Schema = lazyZodSchema(() => z.object({
  open: z.array(z.enum(['create', 'resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  delivery: z.array(z.enum(['newTurn', 'steer', 'followUp'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  cancel: z.boolean(), configuration: z.boolean().optional(),
  /** Native filesystem enforcement of configuration.workspaceWrites='deny'. Absence is unsupported. */
  workspaceWrites: z.literal('deny').optional(),
  compaction: z.object({ events: z.literal(true), manual: z.literal(true).optional() }).strict().optional(),
  conversationRollback: z.literal(true).optional(),
  goals: PluginAgentGoalsV2Schema.optional(),
  /** Publishes token usage to Happier's Session accounting. Omission is undeclared. */
  usageReporting: z.literal(true).optional(),
  catalog: activity(z.array(z.enum(['vendorPlugins', 'skills'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.')).optional(),
  usageLimitRecovery: activity(z.array(z.enum(['checkNow', 'consumeResetCredit'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.')).optional(),
  continuationVerification: z.object({ intents: z.array(z.enum(['resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'), requirement: z.enum(['required', 'advisory']) }).strict().optional(),
  workStateSources: z.array(z.object({ id: asProtocolZod(PluginContributionLocalIdSchema), itemKinds: z.array(z.enum(['goal', 'task', 'todo'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.') }).strict()).max(32).refine((values) => new Set(values.map((value) => value.id)).size === values.length, 'Work-state source ids must be unique.').optional(),
  runtimeActivitySnapshots: z.literal(true).optional(),
  startupInstructions: z.object({
    versions: z.tuple([z.literal(1)]),
    /** Omission means native resume cannot be used to apply changed instructions. */
    revisionChanges: z.literal('resume').optional(),
  }).strict().optional(),
  /** Additive host context for Session-primary Agents executing without a Happier Session. */
  executionRunContext: z.object({
    versions: z.tuple([z.literal(1)]),
  }).strict().optional(),
}).strict());
export type PluginAgentSessionCapabilitiesV2 = z.infer<typeof PluginAgentSessionCapabilitiesV2Schema>;
