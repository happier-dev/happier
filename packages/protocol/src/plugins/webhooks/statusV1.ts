import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { AutomationEventAdmitUnresolvedStatusV1Schema } from '../../automations/automationEventAdmitStatusV1.js';
import { AutomationIdV1Schema } from '../../automations/automationIdV1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import {
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointReadinessV1Schema,
  PluginWebhookPublicUrlV1Schema,
  PluginWebhookDeliveryIdV1Schema,
  PluginWebhookDeliveryDiscardInputV1Schema,
  PluginWebhookDeliveryDiscardResultV1Schema,
  PluginWebhookDeliveryReplayInputV1Schema,
  PluginWebhookDeliveryReplayResultV1Schema,
} from './endpointV1.js';
export {
  PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1,
  PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1,
  PluginWebhookDeliveryDiscardInputV1Schema,
  PluginWebhookDeliveryDiscardResultV1Schema,
  PluginWebhookDeliveryReplayInputV1Schema,
  PluginWebhookDeliveryReplayResultV1Schema,
} from './endpointV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const TimestampSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));
const RevisionSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.int()));
const CountSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_TOTAL_COUNT_V1 = 10_000;
export const PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_ENTRIES_V1 = 100;
export const PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1 = 16 * 1024;
export const PLUGIN_WEBHOOK_ACCOUNT_STATUS_MAX_CANONICAL_JSON_BYTES_V1 = 4 * 1024 * 1024;

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(createCanonicalJsonSigningInput(value)).byteLength;
}

export const PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1 = '/v1/plugins/webhooks/status/read';

export const PluginWebhookAccountStatusRequestV1Schema = lazyZodSchema(() => z.strictObject({
  endpointCursor: z.optional(PluginWebhookEndpointIdV1Schema),
  pageSize: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
  deadLetterPageSize: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(100)), 50),
}));

export const PluginWebhookEndpointStatusV1Schema = lazyZodSchema(() => z.strictObject({
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: RevisionSchema,
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  sourceInstanceId: z.string().check(z.regex(/^[A-Za-z0-9._:-]{1,128}$/u)),
  routing: z.enum(['accountEndpoint', 'providerInstallation']),
  readiness: PluginWebhookEndpointReadinessV1Schema,
  targetStatus: z.enum(['current', 'unavailable']),
  publicUrl: PluginWebhookPublicUrlV1Schema,
  createdAt: TimestampSchema,
  revokedAt: z.optional(TimestampSchema),
  queue: z.strictObject({
    queued: CountSchema,
    retrying: CountSchema,
    claimed: CountSchema,
    deadLetter: CountSchema,
    oldestPendingAtMs: z.nullable(TimestampSchema),
  }),
  /**
   * Movable rows frozen away from `targetMaterialization`, aggregated across
   * however many times this endpoint moved. There is no single predecessor to
   * name once the target has moved more than once, and `movePending` needs
   * none: it selects by difference from the current target.
   */
  pendingTargetTransfer: z.optional(z.strictObject({
    eligibleDeliveryCount: CountSchema,
  })),
  credentialRotation: z.optional(z.strictObject({
    previousCredentialVersionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    previousAcceptUntilMs: TimestampSchema,
  })),
}));

const PluginWebhookAutomationAdmissionUnresolvedEntryV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  status: AutomationEventAdmitUnresolvedStatusV1Schema,
}));

/**
 * Host-derived diagnostic retained only with an exhausted Webhook delivery.
 * It is deliberately not part of the plugin-authored Action result contract.
 */
export const PluginWebhookAutomationAdmissionUnresolvedV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('automationAdmissionUnresolved'),
  totalCount: z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_TOTAL_COUNT_V1)),
  entries: z.array(PluginWebhookAutomationAdmissionUnresolvedEntryV1Schema).check(z.minLength(1), z.maxLength(PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_ENTRIES_V1)),
  omittedCount: z.number().check(z.int(), z.nonnegative(), z.maximum(PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_TOTAL_COUNT_V1)),
}).check(z.superRefine((value, context) => {
  const expectedOmittedCount = value.totalCount - value.entries.length;
  if (expectedOmittedCount < 0) {
    context.addIssue({
      code: "custom",
      path: ['totalCount'],
      message: 'Unresolved Automation totalCount must include every retained entry',
    });
  }
  if (value.omittedCount !== expectedOmittedCount) {
    context.addIssue({
      code: "custom",
      path: ['omittedCount'],
      message: 'Unresolved Automation omittedCount must equal totalCount minus retained entries',
    });
  }
  for (let index = 1; index < value.entries.length; index += 1) {
    const previous = value.entries[index - 1]!.automationId;
    const current = value.entries[index]!.automationId;
    if (previous >= current) {
      context.addIssue({
        code: "custom",
        path: ['entries', index, 'automationId'],
        message: 'Unresolved Automation entries must be unique and sorted by exact Automation ID',
      });
    }
  }
  if (canonicalJsonByteLength(value) > PLUGIN_WEBHOOK_AUTOMATION_ADMISSION_UNRESOLVED_MAX_CANONICAL_JSON_BYTES_V1) {
    context.addIssue({
      code: "custom",
      message: 'Unresolved Automation summary exceeds the V1 canonical JSON byte limit',
    });
  }
})));

export const PluginWebhookDeadLetterStatusV1Schema = lazyZodSchema(() => z.strictObject({
  deliveryId: PluginWebhookDeliveryIdV1Schema,
  webhookEndpointId: PluginWebhookEndpointIdV1Schema,
  revision: z.number().check(z.int(), z.nonnegative(), z.int()),
  deliveryIdentityDigestPrefix: z.string().check(z.regex(/^[a-f0-9]{12}$/u)),
  errorCode: z.nullable(z.string().check(z.regex(/^[a-z0-9._-]{1,64}$/u))),
  attemptCount: z.number().check(z.int(), z.nonnegative(), z.maximum(12)),
  replayCount: z.number().check(z.int(), z.nonnegative(), z.maximum(10)),
  receivedAtMs: TimestampSchema,
  deadLetteredAtMs: TimestampSchema,
  targetMaterialization: PluginMachineMaterializationRefV1Schema,
  automationAdmissionUnresolved: z.nullable(PluginWebhookAutomationAdmissionUnresolvedV1Schema),
}));

export const PluginWebhookAccountStatusResultV1Schema = lazyZodSchema(() => z.strictObject({
  endpoints: z.array(PluginWebhookEndpointStatusV1Schema).check(z.maxLength(100)),
  nextEndpointCursor: z.nullable(PluginWebhookEndpointIdV1Schema),
  deadLetters: z.array(PluginWebhookDeadLetterStatusV1Schema).check(z.maxLength(100)),
}).check(z.superRefine((value, context) => {
  if (canonicalJsonByteLength(value) > PLUGIN_WEBHOOK_ACCOUNT_STATUS_MAX_CANONICAL_JSON_BYTES_V1) {
    context.addIssue({
      code: "custom",
      message: 'Plugin webhook Account status exceeds the V1 canonical JSON byte limit',
    });
  }
})));

export type PluginWebhookAccountStatusRequestV1 = z.infer<typeof PluginWebhookAccountStatusRequestV1Schema>;
export type PluginWebhookAccountStatusResultV1 = z.infer<typeof PluginWebhookAccountStatusResultV1Schema>;
export type PluginWebhookAutomationAdmissionUnresolvedV1 = z.infer<
  typeof PluginWebhookAutomationAdmissionUnresolvedV1Schema
>;
export type PluginWebhookDeliveryReplayInputV1 = z.infer<typeof PluginWebhookDeliveryReplayInputV1Schema>;
export type PluginWebhookDeliveryReplayResultV1 = z.infer<typeof PluginWebhookDeliveryReplayResultV1Schema>;
export type PluginWebhookDeliveryDiscardInputV1 = z.infer<typeof PluginWebhookDeliveryDiscardInputV1Schema>;
export type PluginWebhookDeliveryDiscardResultV1 = z.infer<typeof PluginWebhookDeliveryDiscardResultV1Schema>;
