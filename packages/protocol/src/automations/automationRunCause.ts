import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { WorkflowRunIdV1Schema } from '../workflows/workflowIdsV1.js';
import { AutomationRunLifecycleConfigurationSchema, type AutomationRunLifecycleSource } from './automationRunLifecycle.js';
import { AutomationActionRunEvidenceV1Schema, type AutomationActionRunEvidenceV1 } from './automationActionOccurrenceV1.js';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import {
  AutomationOccurrenceKeyV1Schema,
  type AutomationOccurrenceKeyV1,
  AutomationOccurredAtV1Schema,
  type AutomationOccurredAtV1,
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from './automationOccurrenceV1.js';
import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../plugins/contributionIdentity.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
  type AutomationTriggerId,
  type AutomationTriggerRevision,
} from './automationTriggerIdentity.js';
import {
  AutomationSessionLifecycleEventSchema,
  AutomationSessionLifecyclePolicySnapshotSchema,
  AutomationSessionLifecycleRequestKindSchema,
  type AutomationSessionLifecycleEvent,
  type AutomationSessionLifecyclePolicySnapshot,
  type AutomationSessionLifecycleRequestKind,
} from './automationSessionLifecycle.js';

export {
  AutomationTriggerIdSchema,
  AutomationTriggerKindSchema,
  AutomationTriggerRevisionSchema,
  type AutomationTriggerId,
  type AutomationTriggerKind,
  type AutomationTriggerRevision,
} from './automationTriggerIdentity.js';

const IDENTIFIER_SCHEMA = z.string().check(z.trim(), z.minLength(1), z.maxLength(191));

const AutomationScheduleRunCauseSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('trigger'),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.literal('schedule'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOccurredAtV1Schema,
  evidence: z.strictObject({
    scheduledFor: AutomationOccurredAtV1Schema,
  }),
}));

const AutomationPluginEventRunCauseSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('trigger'),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.literal('pluginEvent'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOccurredAtV1Schema,
  evidence: z.strictObject({
    eventRef: asProtocolZod(PluginContributionIdentityV1Schema),
    sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  }),
}));

// Read lazily: Workflow progress reaches this module while the occurrence owner is still
// initializing, so its schemas cannot be captured at module load.
const automationSessionLifecycleRunCauseShape = () => ({
  kind: z.literal('trigger'),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.literal('sessionLifecycle'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOccurredAtV1Schema,
}) as const;

const AutomationSessionLifecycleRunCauseSchema = lazyZodSchema(() => z.strictObject({
  ...automationSessionLifecycleRunCauseShape(),
  evidence: z.discriminatedUnion('event', [
    (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.strictObject({
      event: zMini.enum(AutomationSessionLifecycleEventSchema.options.filter((value): value is Exclude<(typeof AutomationSessionLifecycleEventSchema.options)[number], 'userActionRequired' | 'sessionStarted' | 'sessionArchived'> => !(['userActionRequired', 'sessionStarted', 'sessionArchived'] as readonly string[]).includes(value))),
      sourceSessionId: IDENTIFIER_SCHEMA,
      sourceTurnId: IDENTIFIER_SCHEMA,
      policy: AutomationSessionLifecyclePolicySnapshotSchema,
    })),
    z.strictObject({
      event: z.literal('sessionStarted'),
      sourceSessionId: IDENTIFIER_SCHEMA,
      policy: AutomationSessionLifecyclePolicySnapshotSchema,
    }),
    z.strictObject({
      event: z.literal('sessionArchived'),
      sourceSessionId: IDENTIFIER_SCHEMA,
      policy: AutomationSessionLifecyclePolicySnapshotSchema,
      originRunId: zMini.optional(WorkflowRunIdV1Schema),
    }),
    z.object({
      event: z.literal('userActionRequired'),
      sourceSessionId: IDENTIFIER_SCHEMA,
      sourceTurnId: IDENTIFIER_SCHEMA,
      requestId: IDENTIFIER_SCHEMA,
      requestKind: AutomationSessionLifecycleRequestKindSchema,
      policy: AutomationSessionLifecyclePolicySnapshotSchema,
    }),
  ]),
}));

const AutomationManualRunCauseSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('manual'),
  invokedAt: AutomationOccurredAtV1Schema,
}));

const AutomationRunLifecycleRunCauseSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('trigger'), triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema, triggerKind: z.literal('runLifecycle'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema, occurredAt: AutomationOccurredAtV1Schema,
  evidence: (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(AutomationRunLifecycleConfigurationSchema, {
    sourceRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
    originRunId: z.optional(IDENTIFIER_SCHEMA),
  })),
}));

const AutomationConversationRunCauseSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('conversation'),
  triggerId: zMini.optional(AutomationTriggerIdSchema),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOccurredAtV1Schema,
}));

const AutomationActionRunCauseSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('trigger'), triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema, triggerKind: z.literal('action'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema, occurredAt: AutomationOccurredAtV1Schema,
  evidence: AutomationActionRunEvidenceV1Schema,
}));

/**
 * Immutable, bounded Run provenance. This is the sole current cause owner;
 * private payload bytes remain in the existing trigger-evidence envelope.
 *
 * Declared structurally instead of `z.infer` so downstream declaration-only
 * consumers (the public SDK projection re-exports this union through the
 * narrow `./automations/run-cause` leaf) never carry a validator-bearing
 * declaration. The `satisfies` lockstep below fails compilation if the parser
 * and this declaration drift on any field, bound, or literal.
 */
export type AutomationRunCause = Readonly<
  | { kind: 'trigger'; triggerId: AutomationTriggerId; triggerRevision: AutomationTriggerRevision;
    triggerKind: 'action'; occurrenceKey: AutomationOccurrenceKeyV1; occurredAt: AutomationOccurredAtV1;
    evidence: AutomationActionRunEvidenceV1 }
  | {
    kind: 'trigger';
    triggerId: AutomationTriggerId;
    triggerRevision: AutomationTriggerRevision;
    triggerKind: 'schedule';
    occurrenceKey: AutomationOccurrenceKeyV1;
    occurredAt: AutomationOccurredAtV1;
    evidence: Readonly<{ scheduledFor: AutomationOccurredAtV1 }>;
  }
  | {
    kind: 'trigger';
    triggerId: AutomationTriggerId;
    triggerRevision: AutomationTriggerRevision;
    triggerKind: 'pluginEvent';
    occurrenceKey: AutomationOccurrenceKeyV1;
    occurredAt: AutomationOccurredAtV1;
    evidence: Readonly<{
      eventRef: PluginContributionIdentityV1;
      sourceSelectorId: AutomationSourceSelectorIdV1;
    }>;
  }
  | {
    kind: 'trigger';
    triggerId: AutomationTriggerId;
    triggerRevision: AutomationTriggerRevision;
    triggerKind: 'sessionLifecycle';
    occurrenceKey: AutomationOccurrenceKeyV1;
    occurredAt: AutomationOccurredAtV1;
    evidence: Readonly<{
      event: Exclude<AutomationSessionLifecycleEvent, 'userActionRequired' | 'sessionStarted' | 'sessionArchived'>;
      sourceSessionId: string;
      sourceTurnId: string;
      policy: AutomationSessionLifecyclePolicySnapshot;
    }> | Readonly<{
      event: 'sessionStarted';
      sourceSessionId: string;
      policy: AutomationSessionLifecyclePolicySnapshot;
    }> | Readonly<{
      event: 'sessionArchived';
      sourceSessionId: string;
      policy: AutomationSessionLifecyclePolicySnapshot;
      originRunId?: string;
    }> | Readonly<{
      event: 'userActionRequired';
      sourceSessionId: string;
      sourceTurnId: string;
      requestId: string;
      requestKind: AutomationSessionLifecycleRequestKind;
      policy: AutomationSessionLifecyclePolicySnapshot;
    }>;
  }
  | { kind: 'trigger'; triggerId: AutomationTriggerId; triggerRevision: AutomationTriggerRevision;
    triggerKind: 'runLifecycle'; occurrenceKey: AutomationOccurrenceKeyV1; occurredAt: AutomationOccurredAtV1;
    evidence: Readonly<{ source: AutomationRunLifecycleSource; condition: 'terminal' | 'needs_attention'; sourceRevision: number; originRunId?: string }> }
  | { kind: 'manual'; invokedAt: AutomationOccurredAtV1 }
  | {
    kind: 'conversation';
    triggerId?: AutomationTriggerId;
    occurrenceKey: AutomationOccurrenceKeyV1;
    occurredAt: AutomationOccurredAtV1;
  }
>;

/**
 * The single declaration-neutral projection of `AutomationRunCause`. Public SDK
 * surfaces alias this name, so it is spelled without Protocol's identity brands
 * and without naming any Protocol-private type: a published author declaration
 * must close over author-visible names only.
 *
 * The two spellings cannot drift. `automationRunCause.contract.test-d.ts` derives the
 * brand-free projection of the canonical union mechanically and asserts mutual
 * assignability with this declaration, so any added, removed, or retyped field
 * fails there.
 */
export type AutomationRunCauseDeclarationV1 = Readonly<
  | { kind: 'trigger'; triggerId: string; triggerRevision: number;
    triggerKind: 'action'; occurrenceKey: string; occurredAt: number;
    evidence: Readonly<{ actionId: string; requestId: string; phase: 'before' | 'after';
      status?: 'succeeded' | 'failed'; errorCode?: string; machineId?: string; originRunId?: string }> }
  | {
    kind: 'trigger';
    triggerId: string;
    triggerRevision: number;
    triggerKind: 'schedule';
    occurrenceKey: string;
    occurredAt: number;
    evidence: Readonly<{ scheduledFor: number }>;
  }
  | {
    kind: 'trigger';
    triggerId: string;
    triggerRevision: number;
    triggerKind: 'pluginEvent';
    occurrenceKey: string;
    occurredAt: number;
    evidence: Readonly<{
      eventRef: Readonly<{ pluginId: string; localId: string }>;
      sourceSelectorId: string;
    }>;
  }
  | {
    kind: 'trigger';
    triggerId: string;
    triggerRevision: number;
    triggerKind: 'sessionLifecycle';
    occurrenceKey: string;
    occurredAt: number;
    evidence: Readonly<{
      event: 'parentTurnCompleted' | 'parentTurnFailed' | 'parentTurnCancelled';
      sourceSessionId: string;
      sourceTurnId: string;
      policy:
        | Readonly<{ kind: 'currentTurn' }>
        | Readonly<{ kind: 'firstMatch' }>
        | Readonly<{ kind: 'nextMatches'; count: number }>
        | Readonly<{ kind: 'everyMatch' }>;
    }> | Readonly<{
      event: 'userActionRequired';
      sourceSessionId: string;
      sourceTurnId: string;
      requestId: string;
      requestKind: 'permission' | 'user_action';
      policy:
        | Readonly<{ kind: 'currentTurn' }>
        | Readonly<{ kind: 'firstMatch' }>
        | Readonly<{ kind: 'nextMatches'; count: number }>
        | Readonly<{ kind: 'everyMatch' }>;
    }> | Readonly<{
      event: 'sessionStarted';
      sourceSessionId: string;
      policy:
        | Readonly<{ kind: 'currentTurn' }>
        | Readonly<{ kind: 'firstMatch' }>
        | Readonly<{ kind: 'nextMatches'; count: number }>
        | Readonly<{ kind: 'everyMatch' }>;
    }> | Readonly<{
      event: 'sessionArchived';
      originRunId?: string;
      sourceSessionId: string;
      policy:
        | Readonly<{ kind: 'currentTurn' }>
        | Readonly<{ kind: 'firstMatch' }>
        | Readonly<{ kind: 'nextMatches'; count: number }>
        | Readonly<{ kind: 'everyMatch' }>;
    }>;
  }
  | { kind: 'trigger'; triggerId: string; triggerRevision: number;
    triggerKind: 'runLifecycle'; occurrenceKey: string; occurredAt: number;
    evidence: Readonly<{ source: Readonly<{ kind: 'workflow_run'; runId: string }>
      | Readonly<{ kind: 'execution_run'; machineId: string; runId: string; sessionId?: string }>;
      condition: 'terminal' | 'needs_attention'; sourceRevision: number; originRunId?: string }> }
  | { kind: 'manual'; invokedAt: number }
  | {
    kind: 'conversation';
    triggerId?: string;
    occurrenceKey: string;
    occurredAt: number;
  }
>;

export const AutomationRunCauseSchema = z.union([
  AutomationActionRunCauseSchema,
  AutomationScheduleRunCauseSchema,
  AutomationPluginEventRunCauseSchema,
  AutomationSessionLifecycleRunCauseSchema,
  AutomationRunLifecycleRunCauseSchema,
  AutomationManualRunCauseSchema,
  AutomationConversationRunCauseSchema,
]) satisfies z.ZodMiniType<AutomationRunCause>;
