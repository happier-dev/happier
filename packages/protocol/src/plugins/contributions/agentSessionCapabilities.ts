import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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
const PluginAgentGoalSetCapabilityV2Schema = lazyZodSchema(() => z.strictObject({
  fields: z.array(z.enum(['objective', 'status', 'tokenBudget'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')),
  writableStatuses: z.optional(z.array(z.enum(['active', 'paused', 'complete'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.'))),
}));
const PluginAgentGoalControlModeV2Schema = lazyZodSchema(() => z.strictObject({
  get: z.optional(z.literal(true)), clear: z.optional(z.literal(true)), set: z.optional(PluginAgentGoalSetCapabilityV2Schema),
}).check(z.refine((value) => value.get || value.clear || value.set, 'At least one goal control capability is required.')));
const activity = <T extends z.ZodMiniType>(schema: T) => z.strictObject({ active: z.optional(schema), inactive: z.optional(schema) }).check(z.refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.'));
const PluginAgentGoalsV2Schema = lazyZodSchema(() => z.strictObject({
  active: z.optional(PluginAgentGoalControlModeV2Schema),
  inactive: z.optional(PluginAgentGoalControlModeV2Schema),
  source: z.string().check(z.trim(), z.minLength(1)),
}).check(z.refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.')));

export const PluginAgentSessionCompactionCapabilityV2Schema = lazyZodSchema(() => z.strictObject({
  events: z.literal(true),
  manual: z.optional(z.literal(true)),
  idle: z.optional(z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('host'),
      defaultEnabled: z.boolean(),
      defaultMinContextTokens: z.optional(z.number().check(z.int(), z.gte(0))),
    }),
    z.strictObject({
      mode: z.literal('native'),
      defaultEnabled: z.boolean(),
      defaultMinContextTokens: z.optional(z.number().check(z.int(), z.gte(0))),
      nativeHonorsMinimum: z.optional(z.literal(true)),
    }).check(z.refine((value) => value.defaultMinContextTokens === undefined || value.nativeHonorsMinimum === true,
      'A native minimum default requires nativeHonorsMinimum.')),
  ])),
}));
export type PluginAgentSessionCompactionCapabilityV2 = z.infer<typeof PluginAgentSessionCompactionCapabilityV2Schema>;
export type AgentSessionCompactionCapability = PluginAgentSessionCompactionCapabilityV2;
export type AgentSessionCompactionIdleCapability = NonNullable<AgentSessionCompactionCapability['idle']>;

export const PluginAgentSessionCapabilitiesV2Schema = lazyZodSchema(() => z.strictObject({
  open: z.array(z.enum(['create', 'resume', 'fork'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')),
  delivery: z.array(z.enum(['newTurn', 'steer', 'followUp'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')),
  cancel: z.boolean(), configuration: z.optional(z.boolean()),
  /** Native filesystem enforcement of configuration.workspaceWrites='deny'. Absence is unsupported. */
  workspaceWrites: z.optional(z.literal('deny')),
  compaction: z.optional(PluginAgentSessionCompactionCapabilityV2Schema),
  conversationRollback: z.optional(z.literal(true)),
  goals: z.optional(PluginAgentGoalsV2Schema),
  /** Publishes token usage to Happier's Session accounting. Omission is undeclared. */
  usageReporting: z.optional(z.literal(true)),
  catalog: z.optional(activity(z.array(z.enum(['vendorPlugins', 'skills'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')))),
  usageLimitRecovery: z.optional(activity(z.array(z.enum(['checkNow', 'consumeResetCredit'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')))),
  continuationVerification: z.optional(z.strictObject({ intents: z.array(z.enum(['resume', 'fork'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')), requirement: z.enum(['required', 'advisory']) })),
  workStateSources: z.optional(z.array(z.strictObject({ id: asProtocolZod(PluginContributionLocalIdSchema), itemKinds: z.array(z.enum(['goal', 'task', 'todo'])).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')) })).check(z.maxLength(32), z.refine((values) => new Set(values.map((value) => value.id)).size === values.length, 'Work-state source ids must be unique.'))),
  runtimeActivitySnapshots: z.optional(z.literal(true)),
  startupInstructions: z.optional(z.strictObject({
    versions: z.tuple([z.literal(1)]),
    /** Omission means native resume cannot be used to apply changed instructions. */
    revisionChanges: z.optional(z.literal('resume')),
  })),
  /** Additive host context for Session-primary Agents executing without a Happier Session. */
  executionRunContext: z.optional(z.strictObject({
    versions: z.tuple([z.literal(1)]),
  })),
}));
export type PluginAgentSessionCapabilitiesV2 = z.infer<typeof PluginAgentSessionCapabilitiesV2Schema>;
