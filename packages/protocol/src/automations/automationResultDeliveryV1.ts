import { z } from 'zod';

import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import {
  AutomationHostIdentifierV1JsonSchema as HOST_ID_JSON_SCHEMA,
  AutomationIdV1Schema,
} from './automationIdV1.js';
import {
  AutomationEventReplyContextV1Schema,
  AutomationEventSourceOrOccurrenceIdV1Schema,
  boundedAutomationEventJsonValueV1,
} from './automationEventJsonBoundsV1.js';
import { AutomationOriginOccurredAtV1Schema } from './automationOriginOccurredAtV1.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

export { AutomationIdV1Schema };
export type { AutomationIdV1 } from './automationIdV1.js';

export const MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES = 2 * 1024;
export const MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS = 86_400_000;
export const MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES = 256 * 1024;

const UTF8_ENCODER = new TextEncoder();

/** Shared bounded integer grammar for Automation source and result contracts. */
export const AutomationNonnegativeSafeIntegerV1Schema = z.number().int().nonnegative().safe();

export const AutomationRunResultV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('text'),
  text: z.string().superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Result text exceeds its UTF-8 byte limit' });
    }
  }),
}).strict();
export type AutomationRunResultV1 = z.infer<typeof AutomationRunResultV1Schema>;

/**
 * Immutable Automation facts carried from Conversation admission through the
 * daemon and into the Channels custody owner. Correspondence remains separate
 * so the server can route without opening the sealed source payload.
 */
export const AutomationResultDeliverySourceV1Schema = z.object({
  kind: z.literal('automationResult'),
  automationRunId: asProtocolZod(AutomationIdV1Schema),
  resultId: asProtocolZod(AutomationIdV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  templateVersion: AutomationNonnegativeSafeIntegerV1Schema,
  resultDelivery: z.literal('finalResult'),
}).strict();
export type AutomationResultDeliverySourceV1 = z.infer<typeof AutomationResultDeliverySourceV1Schema>;

/**
 * The one result Action accepted for a Conversation Automation handoff. The
 * server freezes this reference during admission; neither a Channel plugin nor
 * a daemon caller may substitute a different target Action at delivery time.
 */
export const AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1 = Object.freeze({
  pluginId: 'happier.channels',
  localId: 'automation/result-deliver-v1',
} as const);

export const AutomationResultDeliveryActionRefV1Schema = z.object({
  pluginId: z.literal(AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1.pluginId),
  localId: z.literal(AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1.localId),
}).strict();
export type AutomationResultDeliveryActionRefV1 = z.infer<
  typeof AutomationResultDeliveryActionRefV1Schema
>;

export const AutomationConversationResultDeliveryV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('finalResult'),
    actionRef: AutomationResultDeliveryActionRefV1Schema,
    opaqueContext: asProtocolZod(AutomationEventReplyContextV1Schema),
  }).strict(),
]);
export type AutomationConversationResultDeliveryV1 = z.infer<
  typeof AutomationConversationResultDeliveryV1Schema
>;

export const AutomationConversationAdmitInputV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  bindingId: asProtocolZod(AutomationIdV1Schema),
  templateVersion: AutomationNonnegativeSafeIntegerV1Schema,
  occurrenceId: AutomationEventSourceOrOccurrenceIdV1Schema,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  sender: asProtocolZod(boundedAutomationEventJsonValueV1(
    MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
  )),
  text: z.string().superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Conversation text exceeds its UTF-8 byte limit' });
    }
  }),
  resultDelivery: AutomationConversationResultDeliveryV1Schema,
}).strict();
export type AutomationConversationAdmitInputV1 = z.infer<typeof AutomationConversationAdmitInputV1Schema>;

export const AutomationConversationAdmitResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('admitted'), runId: asProtocolZod(AutomationIdV1Schema), checkpointSafe: z.literal(true) }).strict(),
  z.object({ kind: z.literal('rejoined'), runId: asProtocolZod(AutomationIdV1Schema), checkpointSafe: z.literal(true) }).strict(),
  z.object({ kind: z.literal('blocked'), reason: z.enum(['capacity', 'temporarilyUnavailable', 'occurrenceConflict']), checkpointSafe: z.literal(false) }).strict(),
]);
export type AutomationConversationAdmitResultV1 = z.infer<typeof AutomationConversationAdmitResultV1Schema>;

export const AutomationResultDeliveryInputV1Schema = z.object({
  v: z.literal(1),
  handoffId: asProtocolZod(AutomationIdV1Schema),
  runId: asProtocolZod(AutomationIdV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  source: AutomationResultDeliverySourceV1Schema,
  result: AutomationRunResultV1Schema,
  opaqueContext: asProtocolZod(AutomationEventReplyContextV1Schema),
}).strict();
export type AutomationResultDeliveryInputV1 = z.infer<typeof AutomationResultDeliveryInputV1Schema>;

export const AutomationResultDeliveryResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), custodyId: asProtocolZod(AutomationIdV1Schema) }).strict(),
  z.object({ kind: z.literal('retired') }).strict(),
  z.object({ kind: z.literal('suppressed'), reason: z.enum(['bindingDisabled', 'bindingDeleted', 'audienceRevoked']) }).strict(),
  z.object({
    kind: z.literal('retry'),
    retryAfterMs: AutomationNonnegativeSafeIntegerV1Schema.max(MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS),
    code: z.enum(['temporarilyUnavailable', 'outcomeUnknown']),
  }).strict(),
  z.object({ kind: z.literal('blocked'), code: z.enum(['contractIncompatible', 'invalidCustodyRequest', 'unauthorizedCaller']) }).strict(),
]);
export type AutomationResultDeliveryResultV1 = z.infer<typeof AutomationResultDeliveryResultV1Schema>;

/**
 * JSON Schema projections for the one Action contract. Channels consumes these
 * exact Protocol-owned values rather than maintaining a second DTO/schema.
 */
export const AutomationRunResultV1JsonSchema: PluginJsonSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    kind: { type: 'string', const: 'text' },
    // The Zod contract also enforces the exact UTF-8 byte ceiling.
    text: { type: 'string', maxLength: MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES },
  },
  required: ['v', 'kind', 'text'],
} satisfies PluginJsonSchemaV2;

export const AutomationResultDeliverySourceV1JsonSchema: PluginJsonSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'automationResult' },
    automationRunId: HOST_ID_JSON_SCHEMA,
    resultId: HOST_ID_JSON_SCHEMA,
    automationId: HOST_ID_JSON_SCHEMA,
    templateVersion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    resultDelivery: { type: 'string', const: 'finalResult' },
  },
  required: [
    'kind',
    'automationRunId',
    'resultId',
    'automationId',
    'templateVersion',
    'resultDelivery',
  ],
} satisfies PluginJsonSchemaV2;

export const AutomationResultDeliveryInputV1JsonSchema: PluginJsonSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    handoffId: HOST_ID_JSON_SCHEMA,
    runId: HOST_ID_JSON_SCHEMA,
    automationId: HOST_ID_JSON_SCHEMA,
    source: AutomationResultDeliverySourceV1JsonSchema,
    result: AutomationRunResultV1JsonSchema,
    opaqueContext: {},
  },
  required: ['v', 'handoffId', 'runId', 'automationId', 'source', 'result', 'opaqueContext'],
} satisfies PluginJsonSchemaV2;

export const AutomationResultDeliveryResultV1JsonSchema: PluginJsonSchemaV2 = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'accepted' },
        custodyId: HOST_ID_JSON_SCHEMA,
      },
      required: ['kind', 'custodyId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'retired' },
      },
      required: ['kind'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'suppressed' },
        reason: { type: 'string', enum: ['bindingDisabled', 'bindingDeleted', 'audienceRevoked'] },
      },
      required: ['kind', 'reason'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'retry' },
        retryAfterMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
        },
        code: { type: 'string', enum: ['temporarilyUnavailable', 'outcomeUnknown'] },
      },
      required: ['kind', 'retryAfterMs', 'code'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'blocked' },
        code: { type: 'string', enum: ['contractIncompatible', 'invalidCustodyRequest', 'unauthorizedCaller'] },
      },
      required: ['kind', 'code'],
    },
  ],
} satisfies PluginJsonSchemaV2;
