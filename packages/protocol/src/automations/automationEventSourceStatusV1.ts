import { lazyZodSchema } from '../lazyZodSchema.js';
import { readActionErrorCodeV1 } from '../actions/actionErrorClassV1.js';
import { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { AutomationIdV1Schema } from './automationIdV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationQualifiedPluginContributionRefV1Schema, AutomationSourceSelectorIdV1Schema } from './automationEventDeclarationV1.js';
import { AutomationNonnegativeSafeIntegerV1Schema as NONNEGATIVE_SAFE_INTEGER_SCHEMA } from './automationResultDeliveryV1.js';

const MAX_SIGNED_BIGINT_DECIMAL = '9223372036854775807';
export const UNSIGNED_DECIMAL_BIGINT_SCHEMA = z.string().check(z.regex(/^(?:0|[1-9][0-9]*)$/u), z.maxLength(MAX_SIGNED_BIGINT_DECIMAL.length), z.refine((value) => (
    value.length < MAX_SIGNED_BIGINT_DECIMAL.length || value <= MAX_SIGNED_BIGINT_DECIMAL
  )));

export const AutomationEventSourceStatusStateV1Schema = lazyZodSchema(() => z.enum([
  'uninitialized',
  'baselined',
  'observing',
  'backingOff',
  'attention',
]));
export type AutomationEventSourceStatusStateV1 = z.infer<typeof AutomationEventSourceStatusStateV1Schema>;

const legacySourceStatusCodes = [
  'none',
  'credentialMissing',
  'credentialRevoked',
  'rateLimited',
  'historyGap',
  'capacityBlocked',
  'definitionStale',
  'sourceContractIncompatible',
  'admissionUnavailable',
] as const;
export const AutomationEventSourceStatusCodeV1Schema = lazyZodSchema(() => z.union([
  z.enum(legacySourceStatusCodes),
  z.string().check(z.refine(code => readActionErrorCodeV1({ code }) === code)),
]));
export type AutomationEventSourceStatusCodeV1 = z.infer<
  typeof AutomationEventSourceStatusCodeV1Schema
>;

export const AutomationEventSourceCatalogStatusStateV1Schema = lazyZodSchema(() => z.enum([
  'current',
  'reconciling',
]));
export type AutomationEventSourceCatalogStatusStateV1 = z.infer<
  typeof AutomationEventSourceCatalogStatusStateV1Schema
>;

export const AutomationEventSourceStatusExplanationV1Schema = lazyZodSchema(() => z.strictObject({
  reason: AutomationEventSourceStatusCodeV1Schema,
  requiredFact: z.literal('availableSourceObservationOrAdmission'),
  remedy: z.literal('restoreSourceRegistrationOrAdmission'),
  underlyingCause: z.optional(z.literal('notRecorded')),
}));
export type AutomationEventSourceStatusExplanationV1 = z.infer<typeof AutomationEventSourceStatusExplanationV1Schema>;

/** Explain retained status facts once, without inferring a lost provider cause. */
export function explainAutomationEventSourceStatusV1(
  code: AutomationEventSourceStatusCodeV1 | null,
): AutomationEventSourceStatusExplanationV1 | undefined {
  if (code === null || (code !== 'admissionUnavailable' && legacySourceStatusCodes.some(legacy => legacy === code))) return undefined;
  return {
    reason: code,
    requiredFact: 'availableSourceObservationOrAdmission',
    remedy: 'restoreSourceRegistrationOrAdmission',
    ...(code === 'admissionUnavailable' ? { underlyingCause: 'notRecorded' as const } : {}),
  };
}

export const AutomationEventSourceStatusV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  reporterMaterializationRef: PluginMachineMaterializationRefV1Schema,
  reporterSourceCustody: PluginSourceCustodyV1Schema,
  state: AutomationEventSourceStatusStateV1Schema,
  code: z.nullable(AutomationEventSourceStatusCodeV1Schema.check(z.refine(code => code !== 'none'))),
  explanation: z.optional(AutomationEventSourceStatusExplanationV1Schema),
  lastObservedAt: z.nullable(NONNEGATIVE_SAFE_INTEGER_SCHEMA),
  lastDispositionAt: z.nullable(NONNEGATIVE_SAFE_INTEGER_SCHEMA),
  nextRetryAt: z.nullable(NONNEGATIVE_SAFE_INTEGER_SCHEMA),
  observedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  admittedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  skippedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  revision: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
}));
export type AutomationEventSourceStatusV1 = z.infer<typeof AutomationEventSourceStatusV1Schema>;
