import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { AutomationIdV1Schema } from './automationIdV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationQualifiedPluginContributionRefV1Schema, AutomationSourceSelectorIdV1Schema } from './automationEventDeclarationV1.js';
import { AutomationNonnegativeSafeIntegerV1Schema as NONNEGATIVE_SAFE_INTEGER_SCHEMA } from './automationResultDeliveryV1.js';

const MAX_SIGNED_BIGINT_DECIMAL = '9223372036854775807';
export const UNSIGNED_DECIMAL_BIGINT_SCHEMA = z.string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .max(MAX_SIGNED_BIGINT_DECIMAL.length)
  .refine((value) => (
    value.length < MAX_SIGNED_BIGINT_DECIMAL.length || value <= MAX_SIGNED_BIGINT_DECIMAL
  ));

export const AutomationEventSourceStatusStateV1Schema = lazyZodSchema(() => z.enum([
  'uninitialized',
  'baselined',
  'observing',
  'backingOff',
  'attention',
]));
export type AutomationEventSourceStatusStateV1 = z.infer<typeof AutomationEventSourceStatusStateV1Schema>;

export const AutomationEventSourceStatusCodeV1Schema = lazyZodSchema(() => z.enum([
  'none',
  'credentialMissing',
  'credentialRevoked',
  'rateLimited',
  'historyGap',
  'capacityBlocked',
  'definitionStale',
  'sourceContractIncompatible',
  'admissionUnavailable',
]));
export type AutomationEventSourceStatusCodeV1 = z.infer<
  typeof AutomationEventSourceStatusCodeV1Schema
>;

export const AutomationEventSourceCatalogStatusStateV1Schema = lazyZodSchema(() => z.enum([
  'current',
  'reconciling',
  'reconciliationLate',
]));
export type AutomationEventSourceCatalogStatusStateV1 = z.infer<
  typeof AutomationEventSourceCatalogStatusStateV1Schema
>;

export const AutomationEventSourceStatusV1Schema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  reporterMaterializationRef: PluginMachineMaterializationRefV1Schema,
  reporterSourceCustody: PluginSourceCustodyV1Schema,
  state: AutomationEventSourceStatusStateV1Schema,
  code: AutomationEventSourceStatusCodeV1Schema.exclude(['none']).nullable(),
  lastObservedAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  lastDispositionAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  nextRetryAt: NONNEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
  observedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  admittedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  skippedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  revision: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
}).strict());
export type AutomationEventSourceStatusV1 = z.infer<typeof AutomationEventSourceStatusV1Schema>;
