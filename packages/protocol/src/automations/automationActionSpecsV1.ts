import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { ACTION_ID_FAMILIES_V1 } from '../actions/actionIds.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import { PluginWebhookEndpointIdV1Schema } from '../plugins/webhooks/endpointV1.js';

import {
  AutomationHostIdentifierV1Schema as HostIdentifierV1Schema,
  AutomationIdV1Schema,
} from './automationIdV1.js';
import {
  AutomationEventAdmitUnresolvedStatusV1Schema,
  AutomationEventBlockedStatusV1Schema,
  AutomationEventRefreshDefinitionStatusV1Schema,
  type AutomationEventAdmitUnresolvedStatusV1,
} from './automationEventAdmitStatusV1.js';
import { AutomationAccountCurrentnessWitnessV1Schema } from './automationAccountCurrentnessV1.js';
import {
  AutomationQualifiedPluginContributionRefV1Schema,
  AutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import {
  AutomationEventPositiveSafeIntegerV1Schema as POSITIVE_SAFE_INTEGER_SCHEMA,
} from './automationColumnBoundsV1.js';
import {
  AutomationEventPayloadV1Schema,
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
  AutomationEventSourceOrOccurrenceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';
import {
  AutomationConversationAdmitInputV1Schema,
  AutomationConversationAdmitResultV1Schema,
  AutomationConversationScopedTriggerRefV1Schema,
  AutomationNonnegativeSafeIntegerV1Schema as NONNEGATIVE_SAFE_INTEGER_SCHEMA,
} from './automationResultDeliveryV1.js';

/** One page of Event-source definitions cannot exceed this bounded Action contract. */
export const MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE = 500;
export { MAX_AUTOMATION_EVENT_FILTER_CLAUSES, MAX_AUTOMATION_EVENT_FILTER_IN_VALUES, MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS } from './automationEventFilterV1.js';

export const OPAQUE_CURSOR_SCHEMA = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/u);
import { AutomationEventFilterV1Schema } from './automationEventFilterV1.js';
export { AutomationEventFilterV1Schema, AutomationJsonPointerV1Schema } from './automationEventFilterV1.js';
export type { AutomationEventFilterV1, AutomationEventFilterClauseV1, AutomationJsonScalarV1, AutomationJsonPointerV1 } from './automationEventFilterV1.js';
import { UNSIGNED_DECIMAL_BIGINT_SCHEMA, AutomationEventSourceStatusStateV1Schema, AutomationEventSourceStatusCodeV1Schema, AutomationEventSourceCatalogStatusStateV1Schema } from './automationEventSourceStatusV1.js';
export { UNSIGNED_DECIMAL_BIGINT_SCHEMA, AutomationEventSourceStatusStateV1Schema, AutomationEventSourceStatusCodeV1Schema, AutomationEventSourceCatalogStatusStateV1Schema } from './automationEventSourceStatusV1.js';
export type { AutomationEventSourceStatusStateV1, AutomationEventSourceStatusCodeV1, AutomationEventSourceCatalogStatusStateV1 } from './automationEventSourceStatusV1.js';

export const AutomationEventSourceObservationTransportV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('checkpointedPull'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('socket'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('durablePush'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    endpointMaterializationRef: PluginMachineMaterializationRefV1Schema,
    observationStartsAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  }).strict(),
]));
export type AutomationEventSourceObservationTransportV1 = z.infer<
  typeof AutomationEventSourceObservationTransportV1Schema
>;

export const AutomationEventSourceDefinitionV1Schema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: POSITIVE_SAFE_INTEGER_SCHEMA,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  observationTransport: AutomationEventSourceObservationTransportV1Schema,
  filter: AutomationEventFilterV1Schema.nullable(),
  maximumObservationAgeMs: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
}).strict());
export type AutomationEventSourceDefinitionV1 = z.infer<typeof AutomationEventSourceDefinitionV1Schema>;

export const AutomationEventSourcesListTransportV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkpointedPull') }).strict(),
  z.object({ kind: z.literal('socket') }).strict(),
  z.object({ kind: z.literal('durablePush') }).strict(),
]));
export type AutomationEventSourcesListTransportV1 = z.infer<
  typeof AutomationEventSourcesListTransportV1Schema
>;

export const AutomationEventSourceCatalogScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkpointedPull') }).strict(),
  z.object({ kind: z.literal('socket') }).strict(),
  z.object({ kind: z.literal('durablePush'), webhookEndpointId: PluginWebhookEndpointIdV1Schema }).strict(),
]));
export type AutomationEventSourceCatalogScopeV1 = z.infer<
  typeof AutomationEventSourceCatalogScopeV1Schema
>;

const AUTOMATION_EVENT_DURABLE_PUSH_CATALOG_SCOPE_KEY_PREFIX = 'durablePush:';

/**
 * Canonical durable key for one catalog reconciliation scope. The scope union
 * above is the only place a scope kind is introduced, so every catalog-status
 * reporter keys its row through this projection instead of restating the
 * transport vocabulary.
 */
export function automationEventSourceCatalogScopeKeyV1(
  scope: AutomationEventSourceCatalogScopeV1,
): string {
  return scope.kind === 'durablePush'
    ? `${AUTOMATION_EVENT_DURABLE_PUSH_CATALOG_SCOPE_KEY_PREFIX}${scope.webhookEndpointId}`
    : scope.kind;
}

/**
 * A stored scope key is valid exactly when it names one canonical scope, so
 * the key grammar is read back through the same union rather than restated.
 */
export const AutomationEventSourceCatalogScopeKeyV1Schema = lazyZodSchema(() => z.string().superRefine((value, context) => {
  const durablePushEndpointId = value.startsWith(AUTOMATION_EVENT_DURABLE_PUSH_CATALOG_SCOPE_KEY_PREFIX)
    ? value.slice(AUTOMATION_EVENT_DURABLE_PUSH_CATALOG_SCOPE_KEY_PREFIX.length)
    : null;
  const scope = AutomationEventSourceCatalogScopeV1Schema.safeParse(
    durablePushEndpointId === null
      ? { kind: value }
      : { kind: 'durablePush', webhookEndpointId: durablePushEndpointId },
  );
  if (!scope.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown Automation source catalog scope' });
  }
}));
export type AutomationEventSourceCatalogScopeKeyV1 = z.infer<
  typeof AutomationEventSourceCatalogScopeKeyV1Schema
>;

/**
 * A checkpoint owner presents this durable identity to the catalog owner after
 * it has completed a source scan. The catalog owner alone decides whether the
 * checkpoint is now retired; the provider keeps its incumbent row-level CAS.
 */
export const AutomationEventCheckpointRetirementCandidateV1Schema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: POSITIVE_SAFE_INTEGER_SCHEMA,
}).strict());
export type AutomationEventCheckpointRetirementCandidateV1 = z.infer<
  typeof AutomationEventCheckpointRetirementCandidateV1Schema
>;

function checkpointRetirementCandidateKey(value: AutomationEventCheckpointRetirementCandidateV1): string {
  return createCanonicalJsonSigningInput(value);
}

function addDuplicateCheckpointRetirementCandidateIssues(
  values: readonly AutomationEventCheckpointRetirementCandidateV1[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = checkpointRetirementCandidateKey(value);
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: 'Checkpoint retirement candidates must be unique',
      });
      return;
    }
    seen.add(key);
  });
}

export const AutomationEventCheckpointRetirementsV1Schema = lazyZodSchema(() => z.array(
  AutomationEventCheckpointRetirementCandidateV1Schema,
)
  .max(MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE)
  .superRefine(addDuplicateCheckpointRetirementCandidateIssues));
export type AutomationEventCheckpointRetirementsV1 = z.infer<
  typeof AutomationEventCheckpointRetirementsV1Schema
>;

export const AutomationEventSourcesListInputV1Schema = lazyZodSchema(() => z.object({
  transport: AutomationEventSourcesListTransportV1Schema,
  pageSize: z.number().int().min(1).max(MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE).default(
    MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
  ),
  cursor: OPAQUE_CURSOR_SCHEMA.optional(),
  knownRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA.optional(),
  checkpointRetirementCandidates: z.array(AutomationEventCheckpointRetirementCandidateV1Schema)
    .min(1)
    .max(MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE)
    .superRefine(addDuplicateCheckpointRetirementCandidateIssues)
    .optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor !== undefined && value.knownRevision !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['knownRevision'],
      message: 'knownRevision is valid only on the first source-list page',
    });
  }
  if (value.checkpointRetirementCandidates === undefined) return;
  if (value.transport.kind !== 'checkpointedPull') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checkpointRetirementCandidates'],
      message: 'Checkpoint retirement classification is valid only for checkpointed pulls',
    });
  }
  if (value.knownRevision === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['knownRevision'],
      message: 'Checkpoint retirement classification requires a known catalog revision',
    });
  }
  if (value.cursor !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cursor'],
      message: 'Checkpoint retirement classification requires a complete no-cursor catalog read',
    });
  }
}));
export type AutomationEventSourcesListInputV1 = z.infer<typeof AutomationEventSourcesListInputV1Schema>;

export const AutomationEventSourcesListResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    revision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
    definitions: z.array(AutomationEventSourceDefinitionV1Schema)
      .max(MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE),
    nextCursor: OPAQUE_CURSOR_SCHEMA.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('unchanged'),
    revision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
    checkpointRetirements: AutomationEventCheckpointRetirementsV1Schema.optional(),
  }).strict(),
  z.object({ kind: z.literal('cursorStale'), currentRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA }).strict(),
]));
export type AutomationEventSourcesListResultV1 = z.infer<typeof AutomationEventSourcesListResultV1Schema>;

/**
 * One source-list page makes traversal progress when it either terminates the
 * scan or carries at least one definition before its continuation cursor.
 * Keeping this semantic check beside the canonical result contract prevents
 * host and SDK readers from accepting different malformed pagination shapes.
 */
export function isAutomationEventSourcesListPageProgressingV1(
  result: Readonly<
    | {
        kind: 'page';
        definitions: readonly unknown[];
        nextCursor: string | null;
      }
    | { kind: 'unchanged' | 'cursorStale' }
  >,
): boolean {
  return result.kind !== 'page'
    || result.nextCursor === null
    || result.definitions.length > 0;
}

export const AutomationEventAdmitDefinitionSelectorV1Schema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
}).strict());
export type AutomationEventAdmitDefinitionSelectorV1 = z.infer<
  typeof AutomationEventAdmitDefinitionSelectorV1Schema
>;

const AutomationEventAdmitInputFieldsV1 = {
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  occurrenceId: AutomationEventSourceOrOccurrenceIdV1Schema,
  occurredAt: AutomationOccurredAtV1Schema,
  observationReceivedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  payload: asProtocolZod(AutomationEventPayloadV1Schema),
} as const;

export const AutomationEventAdmitInputV1Schema = lazyZodSchema(() => z.object({
  ...AutomationEventAdmitInputFieldsV1,
  definitions: z.array(AutomationEventAdmitDefinitionSelectorV1Schema)
    .min(1),
}).strict());
export type AutomationEventAdmitInputV1 = z.infer<typeof AutomationEventAdmitInputV1Schema>;

/**
 * Private E2-to-server sibling of the public Action input. One HTTP request
 * contains a complete contiguous subset, never a cursor or partial body.
 * Every definition stays individually bounded; the request body itself is
 * bounded by the owning server transport limit, not by a Protocol count.
 */
export const AutomationEventAdmitHttpInputV1Schema = lazyZodSchema(() => z.object({
  ...AutomationEventAdmitInputFieldsV1,
  definitions: z.array(AutomationEventAdmitDefinitionSelectorV1Schema)
    .min(1),
}).strict());
export type AutomationEventAdmitHttpInputV1 = z.infer<typeof AutomationEventAdmitHttpInputV1Schema>;

export {
  AutomationEventAdmitUnresolvedStatusV1Schema,
  type AutomationEventAdmitUnresolvedStatusV1,
};

export const AutomationEventAdmitItemResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('admitted'), runId: asProtocolZod(HostIdentifierV1Schema), checkpointSafe: z.literal(true) }).strict(),
  z.object({ kind: z.literal('rejoined'), runId: asProtocolZod(HostIdentifierV1Schema), checkpointSafe: z.literal(true) }).strict(),
  z.object({
    kind: z.literal('skipped'),
    reason: z.enum(['filtered', 'beforeObservationStart', 'outsideFreshness', 'definitionRetired', 'occurrenceRejected']),
    checkpointSafe: z.literal(true),
  }).strict(),
  AutomationEventRefreshDefinitionStatusV1Schema.extend({
    checkpointSafe: z.literal(false),
  }),
  AutomationEventBlockedStatusV1Schema.extend({
    checkpointSafe: z.literal(false),
  }),
]));
export type AutomationEventAdmitItemResultV1 = z.infer<typeof AutomationEventAdmitItemResultV1Schema>;

export const AutomationEventAdmitResultV1Schema = lazyZodSchema(() => z.object({
  results: z.array(AutomationEventAdmitItemResultV1Schema),
}).strict());
export type AutomationEventAdmitResultV1 = z.infer<typeof AutomationEventAdmitResultV1Schema>;

/** The server-owned continuation of one bounded private admission request. */
export const AutomationEventAdmitContinuationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('stopped'),
    reason: z.enum(['accountCurrentnessMoved', 'accountUnavailable']),
  }).strict(),
]));
export type AutomationEventAdmitContinuationV1 = z.infer<
  typeof AutomationEventAdmitContinuationV1Schema
>;

/** Private response sibling for exactly one complete HTTP admission request. */
export const AutomationEventAdmitHttpResultV1Schema = lazyZodSchema(() => z.object({
  results: z.array(AutomationEventAdmitItemResultV1Schema),
  continuation: AutomationEventAdmitContinuationV1Schema,
}).strict());
export type AutomationEventAdmitHttpResultV1 = z.infer<typeof AutomationEventAdmitHttpResultV1Schema>;

/**
 * A conversation binding is an additional invocation source for an Automation
 * the Account already owns, never a replacement for its automatic trigger set
 * or Run Now operation. Verification therefore asks only whether the caller is
 * naming a current target, and several bindings may name the same one.
 */
export const AutomationConversationTargetVerifyInputV1Schema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  scopedTrigger: AutomationConversationScopedTriggerRefV1Schema.optional(),
  /**
   * A final-result author asks the Automation owner to validate that
   * capability against the current target; ordinary delivery omits it.
   */
  resultDelivery: z.literal('finalResult').optional(),
}).strict());
export type AutomationConversationTargetVerifyInputV1 = z.infer<
  typeof AutomationConversationTargetVerifyInputV1Schema
>;

export const AutomationConversationTargetVerifyResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verified') }).strict(),
  z.object({
    kind: z.literal('notVerified'),
    reason: z.enum([
      'notFound',
      'resultDeliveryUnsupported',
      'scopedTriggerIdentityMismatch',
    ]),
  }).strict(),
]));
export type AutomationConversationTargetVerifyResultV1 = z.infer<
  typeof AutomationConversationTargetVerifyResultV1Schema
>;

export const AutomationConversationTargetsListInputV1Schema = lazyZodSchema(() => z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: asProtocolZod(AutomationIdV1Schema).nullable().optional(),
}).strict());
export type AutomationConversationTargetsListInputV1 = z.infer<typeof AutomationConversationTargetsListInputV1Schema>;

/**
 * Binding an Automation to a conversation delegates unattended execution to an
 * external sender, so selection and the final binding confirmation need the
 * Automation's nonsecret execution consequences, not only its name. These are
 * Account-owned columns; no prompt, recipe, secret, or template content is
 * projected, and nothing here is readable only in plain mode.
 */
export const AutomationConversationTargetExecutionV1Schema = lazyZodSchema(() => z.object({
  targetType: z.enum(['new_session', 'existing_session', 'execution_run']).nullable(),
  enabled: z.boolean(),
}).strict());
export type AutomationConversationTargetExecutionV1 = z.infer<
  typeof AutomationConversationTargetExecutionV1Schema
>;

export const AutomationConversationTargetsListItemV1Schema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  label: z.string().min(1).max(256),
  execution: AutomationConversationTargetExecutionV1Schema,
}).strict());
export type AutomationConversationTargetsListItemV1 = z.infer<typeof AutomationConversationTargetsListItemV1Schema>;

export const AutomationConversationTargetsListResultV1Schema = lazyZodSchema(() => z.object({
  items: z.array(AutomationConversationTargetsListItemV1Schema).max(100),
  nextCursor: asProtocolZod(AutomationIdV1Schema).nullable(),
}).strict());
export type AutomationConversationTargetsListResultV1 = z.infer<typeof AutomationConversationTargetsListResultV1Schema>;



function compareUnsignedDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export const AutomationEventSourceStatusReportV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('source'),
    automationId: asProtocolZod(AutomationIdV1Schema),
    triggerId: AutomationTriggerIdSchema,
    triggerRevision: AutomationTriggerRevisionSchema,
    eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
    sourceSelectorId: AutomationSourceSelectorIdV1Schema,
    state: AutomationEventSourceStatusStateV1Schema,
    code: AutomationEventSourceStatusCodeV1Schema,
    // Connection-health projections do not own occurrence history. Omitting
    // these fields preserves the current-revision timestamps, while an
    // occurrence report still supplies the exact nullable values it owns.
    lastObservedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable().optional(),
    lastDispositionAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable().optional(),
    nextRetryAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
    observedDelta: NONNEGATIVE_SAFE_INTEGER_SCHEMA.max(100),
    admittedDelta: NONNEGATIVE_SAFE_INTEGER_SCHEMA.max(100),
    skippedDelta: NONNEGATIVE_SAFE_INTEGER_SCHEMA.max(100),
  }).strict().superRefine((value, context) => {
    if (value.state === 'attention' && value.code === 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: 'Attention source status requires a non-none code',
      });
    }
  }),
  z.object({
    kind: z.literal('catalogReconciliation'),
    scope: AutomationEventSourceCatalogScopeV1Schema,
    observedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
    adoptedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA.nullable(),
    state: AutomationEventSourceCatalogStatusStateV1Schema,
    scanStartedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
    nextRetryAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  }).strict().superRefine((value, context) => {
    if (value.state === 'current') {
      if (value.adoptedRevision !== value.observedRevision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['adoptedRevision'],
          message: 'Current catalog status requires the observed revision to be adopted',
        });
      }
      return;
    }
    if (value.adoptedRevision !== null
      && compareUnsignedDecimalStrings(value.adoptedRevision, value.observedRevision) >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adoptedRevision'],
        message: 'Reconciling catalog status requires an older adopted revision',
      });
    }
  }),
]));
export type AutomationEventSourceStatusReportV1 = z.infer<
  typeof AutomationEventSourceStatusReportV1Schema
>;

export const AutomationEventSourceStatusReportResultV1Schema = lazyZodSchema(() => z.object({}).strict());
export type AutomationEventSourceStatusReportResultV1 = z.infer<
  typeof AutomationEventSourceStatusReportResultV1Schema
>;

export const AUTOMATION_EVENT_ACTION_IDS_V1 = ACTION_ID_FAMILIES_V1.automation_events;
export const AutomationEventActionIdV1Schema = lazyZodSchema(() => z.enum(AUTOMATION_EVENT_ACTION_IDS_V1));
export type AutomationEventActionIdV1 = z.infer<typeof AutomationEventActionIdV1Schema>;

export const AutomationEventActionInputSchemasV1 = Object.freeze({
  'automation.event.sources.list': AutomationEventSourcesListInputV1Schema,
  'automation.event.admit': AutomationEventAdmitInputV1Schema,
  'automation.event.source.status.report': AutomationEventSourceStatusReportV1Schema,
} as const satisfies Readonly<Record<AutomationEventActionIdV1, z.ZodTypeAny>>);

export const AutomationEventActionOutputSchemasV1 = Object.freeze({
  'automation.event.sources.list': AutomationEventSourcesListResultV1Schema,
  'automation.event.admit': AutomationEventAdmitResultV1Schema,
  'automation.event.source.status.report': AutomationEventSourceStatusReportResultV1Schema,
} as const satisfies Readonly<Record<AutomationEventActionIdV1, z.ZodTypeAny>>);

export const AUTOMATION_CONVERSATION_ACTION_IDS_V1 = ACTION_ID_FAMILIES_V1.automation_conversation;
export const AutomationConversationActionIdV1Schema = lazyZodSchema(() => z.enum(AUTOMATION_CONVERSATION_ACTION_IDS_V1));
export type AutomationConversationActionIdV1 = z.infer<typeof AutomationConversationActionIdV1Schema>;

export const AutomationConversationActionInputSchemasV1 = Object.freeze({
  'automation.conversation.targets.list': AutomationConversationTargetsListInputV1Schema,
  'automation.conversation.target.verify': AutomationConversationTargetVerifyInputV1Schema,
  'automation.conversation.admit': AutomationConversationAdmitInputV1Schema,
} as const satisfies Readonly<Record<AutomationConversationActionIdV1, z.ZodTypeAny>>);

export const AutomationConversationActionOutputSchemasV1 = Object.freeze({
  'automation.conversation.targets.list': AutomationConversationTargetsListResultV1Schema,
  'automation.conversation.target.verify': AutomationConversationTargetVerifyResultV1Schema,
  'automation.conversation.admit': AutomationConversationAdmitResultV1Schema,
} as const satisfies Readonly<Record<AutomationConversationActionIdV1, z.ZodTypeAny>>);
