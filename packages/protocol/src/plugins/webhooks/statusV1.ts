import { z } from 'zod';

import type { AutomationEventAdmitItemResultV1 } from '../../automations/automationEventV1.js';
import { AutomationIdV1Schema } from '../../automations/automationIdV1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import {
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointReadinessV1Schema,
  PluginWebhookPublicUrlV1Schema,
} from './endpointV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const TimestampSchema = z.number().int().nonnegative().safe();
const RevisionSchema = z.number().int().positive().safe();
const CountSchema = z.number().int().nonnegative();
const DeliveryIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);

export const PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_TOTAL_COUNT_V1 = 10_000;
export const PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_ENTRIES_V1 = 100;
export const PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1 = 16 * 1024;
export const PLUGIN_WEBHOOK_ACCOUNT_STATUS_MAX_CANONICAL_JSON_BYTES_V1 = 4 * 1024 * 1024;

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(createCanonicalJsonSigningInput(value)).byteLength;
}

export const PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1 = '/v1/plugins/webhooks/status/read';
export const PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1 = '/v1/plugins/webhooks/deliveries/replay';
export const PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1 = '/v1/plugins/webhooks/deliveries/discard';

export const PluginWebhookAccountStatusRequestV1Schema = z.object({
  endpointCursor: PluginWebhookEndpointIdV1Schema.optional(),
  pageSize: z.number().int().min(1).max(100).default(50),
  deadLetterPageSize: z.number().int().min(0).max(100).default(50),
}).strict();

export const PluginWebhookEndpointStatusV1Schema = z.object({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: RevisionSchema,
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  routing: z.enum(['accountEndpoint', 'providerInstallation']),
  readiness: PluginWebhookEndpointReadinessV1Schema,
  targetStatus: z.enum(['current', 'unavailable']),
  publicUrl: PluginWebhookPublicUrlV1Schema,
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
  queue: z.object({
    queued: CountSchema,
    retrying: CountSchema,
    claimed: CountSchema,
    deadLetter: CountSchema,
    oldestPendingAtMs: TimestampSchema.nullable(),
  }).strict(),
  pendingTargetTransfer: z.object({
    previousTargetMaterialization: PluginMachineMaterializationRefV1Schema,
    eligibleDeliveryCount: CountSchema,
  }).strict().optional(),
  credentialRotation: z.object({
    previousCredentialVersionId: z.string().trim().min(1).max(128),
    previousAcceptUntilMs: TimestampSchema,
  }).strict().optional(),
}).strict();

const PluginWebhookAutomationAdmissionUnresolvedStatusV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('refreshDefinition'),
    reason: z.enum(['definitionStale', 'observationTargetChanged']),
  }).strict(),
  z.object({
    kind: z.literal('blocked'),
    reason: z.enum(['capacity', 'temporarilyUnavailable', 'occurrenceConflict']),
  }).strict(),
]);

type CanonicalUnresolvedAutomationAdmissionStatus = AutomationEventAdmitItemResultV1 extends infer Result
  ? Result extends { kind?: 'refreshDefinition' | 'blocked' }
    ? Omit<Result, 'checkpointSafe'>
    : never
  : never;
type WebhookUnresolvedAutomationAdmissionStatus = z.infer<
  typeof PluginWebhookAutomationAdmissionUnresolvedStatusV1Schema
>;
type Assert<T extends true> = T;

// Kept type-only to avoid a runtime cycle through automationEventV1 → deliveryV1.
type _WebhookAdmissionDiagnosticStatusAcceptsAutomationStatus = Assert<
  [CanonicalUnresolvedAutomationAdmissionStatus] extends [WebhookUnresolvedAutomationAdmissionStatus]
    ? true
    : false
>;
type _WebhookAdmissionDiagnosticStatusHasNoExtraValues = Assert<
  [WebhookUnresolvedAutomationAdmissionStatus] extends [CanonicalUnresolvedAutomationAdmissionStatus]
    ? true
    : false
>;

const PluginWebhookAutomationAdmissionUnresolvedEntryV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  status: PluginWebhookAutomationAdmissionUnresolvedStatusV1Schema,
}).strict();

/**
 * Host-derived diagnostic retained only with an exhausted Webhook delivery.
 * It is deliberately not part of the plugin-authored Action result contract.
 */
export const PluginWebhookAutomationAdmissionUnresolvedV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('automationAdmissionUnresolved'),
  totalCount: z.number().int().min(1).max(PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_TOTAL_COUNT_V1),
  entries: z.array(PluginWebhookAutomationAdmissionUnresolvedEntryV1Schema)
    .min(1)
    .max(PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_ENTRIES_V1),
  omittedCount: z.number().int().nonnegative().max(PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_TOTAL_COUNT_V1),
}).strict().superRefine((value, context) => {
  const expectedOmittedCount = value.totalCount - value.entries.length;
  if (expectedOmittedCount < 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalCount'],
      message: 'Unresolved Automation totalCount must include every retained entry',
    });
  }
  if (value.omittedCount !== expectedOmittedCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['omittedCount'],
      message: 'Unresolved Automation omittedCount must equal totalCount minus retained entries',
    });
  }
  for (let index = 1; index < value.entries.length; index += 1) {
    const previous = value.entries[index - 1]!.automationId;
    const current = value.entries[index]!.automationId;
    if (previous >= current) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'automationId'],
        message: 'Unresolved Automation entries must be unique and sorted by exact Automation ID',
      });
    }
  }
  if (canonicalJsonByteLength(value) > PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unresolved Automation summary exceeds the V1 canonical JSON byte limit',
    });
  }
});

export const PluginWebhookDeadLetterStatusV1Schema = z.object({
  deliveryId: DeliveryIdSchema,
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: z.number().int().nonnegative().safe(),
  deliveryIdentityDigestPrefix: z.string().regex(/^[a-f0-9]{12}$/u),
  errorCode: z.string().regex(/^[a-z0-9._-]{1,64}$/u).nullable(),
  attemptCount: z.number().int().nonnegative().max(12),
  replayCount: z.number().int().nonnegative().max(10),
  receivedAtMs: TimestampSchema,
  deadLetteredAtMs: TimestampSchema,
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  automationAdmissionUnresolved: PluginWebhookAutomationAdmissionUnresolvedV1Schema.nullable(),
}).strict();

export const PluginWebhookAccountStatusResultV1Schema = z.object({
  endpoints: z.array(PluginWebhookEndpointStatusV1Schema).max(100),
  nextEndpointCursor: PluginWebhookEndpointIdV1Schema.nullable(),
  deadLetters: z.array(PluginWebhookDeadLetterStatusV1Schema).max(100),
}).strict().superRefine((value, context) => {
  if (canonicalJsonByteLength(value) > PLUGIN_WEBHOOK_ACCOUNT_STATUS_MAX_CANONICAL_JSON_BYTES_V1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Plugin webhook Account status exceeds the V1 canonical JSON byte limit',
    });
  }
});

export const PluginWebhookDeliveryReplayInputV1Schema = z.object({
  deliveryId: DeliveryIdSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict();
export const PluginWebhookDeliveryReplayResultV1Schema = z.union([
  z.object({ kind: z.literal('requeued'), revision: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.enum(['revisionConflict', 'unavailable', 'replayLimit']) }).strict(),
]);

export const PluginWebhookDeliveryDiscardInputV1Schema = PluginWebhookDeliveryReplayInputV1Schema;
export const PluginWebhookDeliveryDiscardResultV1Schema = z.union([
  z.object({ kind: z.literal('discarded'), revision: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.enum(['revisionConflict', 'unavailable']) }).strict(),
]);

export type PluginWebhookAccountStatusRequestV1 = z.infer<typeof PluginWebhookAccountStatusRequestV1Schema>;
export type PluginWebhookAccountStatusResultV1 = z.infer<typeof PluginWebhookAccountStatusResultV1Schema>;
export type PluginWebhookAutomationAdmissionUnresolvedV1 = z.infer<
  typeof PluginWebhookAutomationAdmissionUnresolvedV1Schema
>;
export type PluginWebhookDeliveryReplayInputV1 = z.infer<typeof PluginWebhookDeliveryReplayInputV1Schema>;
export type PluginWebhookDeliveryReplayResultV1 = z.infer<typeof PluginWebhookDeliveryReplayResultV1Schema>;
export type PluginWebhookDeliveryDiscardInputV1 = z.infer<typeof PluginWebhookDeliveryDiscardInputV1Schema>;
export type PluginWebhookDeliveryDiscardResultV1 = z.infer<typeof PluginWebhookDeliveryDiscardResultV1Schema>;
