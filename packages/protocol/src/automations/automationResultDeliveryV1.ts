import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import {
  PluginContributionIdentityV1JsonSchema,
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../plugins/contributionIdentity.js';
import {
  AutomationHostIdentifierV1JsonSchema as HOST_ID_JSON_SCHEMA,
  AutomationIdV1Schema,
} from './automationIdV1.js';
import {
  AutomationEventReplyContextV1Schema,
  AutomationEventSourceOrOccurrenceIdV1Schema,
  boundedAutomationEventJsonValueV1,
} from './automationEventJsonBoundsV1.js';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationPullRequestTriggerSchema } from './automationTriggerDefinition.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod, projectZodProtocolSchema } from "../plugins/actions/internalProtocolZodAdapter.js";
import type { JsonValue } from '../json/strictJsonValue.js';
import { defineProtocolJsonValue } from '../plugins/actions/protocolComposableSchema.js';

export { AutomationIdV1Schema };
export type { AutomationIdV1 } from './automationIdV1.js';

export const MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES = 2 * 1024;
/**
 * The Conversation admission body is a channel message, not a resolution query.
 * Its boundary is the Conversation ingress message ceiling every channel provider
 * already admits (`MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES`, 64 KiB in
 * `@happier-dev/channels-protocol/v1`), restated here because the protocol package
 * sits below channels-protocol and cannot import it. Borrowing the 2 KiB
 * resolution-input ceiling made every ordinary long channel message fail admission
 * permanently. Downstream Automation persistence stays well above this: a
 * materialized input holds 256 KiB and a stored envelope 512 KiB.
 */
export const MAX_AUTOMATION_CONVERSATION_ADMIT_TEXT_UTF8_BYTES = 64 * 1024;
export const MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS = 86_400_000;

const UTF8_ENCODER = new TextEncoder();

/** Shared bounded integer grammar for Automation source and result contracts. */
export const AutomationNonnegativeSafeIntegerV1Schema = z.number().check(z.int(), z.nonnegative(), z.int());

export const AutomationRunResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('text'),
  text: z.string(),
}));
export type AutomationRunResultV1 = z.infer<typeof AutomationRunResultV1Schema>;

/**
 * Immutable Automation facts carried from Conversation admission through the
 * daemon and into the receiving plugin's custody owner. Correspondence stays separate
 * so the server can route without opening the sealed source payload.
 */
export const AutomationResultDeliverySourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('automationResult'),
  automationRunId: asProtocolZod(AutomationIdV1Schema),
  resultId: asProtocolZod(AutomationIdV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  resultDelivery: z.literal('finalResult'),
}));
export type AutomationResultDeliverySourceV1 = z.infer<typeof AutomationResultDeliverySourceV1Schema>;

/**
 * The one result Action accepted for a Conversation Automation handoff is the
 * receiving plugin's own declared Action contribution, expressed as the
 * canonical qualified contribution identity. No plugin id is named here: any
 * plugin that declares this contract may receive the Automation reply for a
 * Conversation it admitted. The server freezes this reference during admission,
 * so neither the admitting plugin nor a daemon caller may substitute a
 * different target Action at delivery time, and
 * `isAutomationConversationResultDeliveryOwnedByCallerV1` keeps the frozen
 * target inside the admitting plugin.
 */
export const AutomationResultDeliveryActionRefV1Schema = asProtocolZod(
  PluginContributionIdentityV1Schema,
);
export type AutomationResultDeliveryActionRefV1 = PluginContributionIdentityV1;

/** Portable projection so a plugin can declare the same ref in its manifest. */
export const AutomationResultDeliveryActionRefV1JsonSchema: PluginJsonSchemaV2 =
  PluginContributionIdentityV1JsonSchema;

export const AutomationConversationResultDeliveryV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('finalResult'),
    actionRef: AutomationResultDeliveryActionRefV1Schema,
    opaqueContext: asProtocolZod(AutomationEventReplyContextV1Schema),
  }),
]));
export type AutomationConversationResultDeliveryV1 = z.infer<
  typeof AutomationConversationResultDeliveryV1Schema
>;

/**
 * A Conversation Automation reply is delivered back to the plugin that admitted
 * the Conversation. Any plugin may participate; none may name another plugin's
 * contribution as the recipient of a user's reply, which would misroute that
 * reply out of its owning plugin. This is the single owner of that rule for the
 * admission wire contract and for the server admission writer that freezes the
 * target.
 */
export function isAutomationConversationResultDeliveryOwnedByCallerV1(params: Readonly<{
  callerPluginId: string;
  resultDelivery: AutomationConversationResultDeliveryV1;
}>): boolean {
  return params.resultDelivery.kind !== 'finalResult'
    || params.resultDelivery.actionRef.pluginId === params.callerPluginId;
}

/** Host-side scoped correspondence, including the private PR selector. */
export const AutomationConversationScopedTriggerRefV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.enum(['prComment', 'ciFailed']),
  pullRequest: AutomationPullRequestTriggerSchema.shape.pullRequest,
}));
const conversationScopedActorV1Schema = lazyZodSchema(() => z.strictObject({
  principalId: z.string().check(z.minLength(1)), repositoryWriteAccess: z.nullable(z.boolean()),
}));
const conversationEventActorsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  occurrenceId: AutomationEventSourceOrOccurrenceIdV1Schema,
  // This correspondence is also visible beside E2EE ciphertext. Display
  // labels and other private sender content stay in the sealed input only.
  sender: z.strictObject({ principalId: z.string().check(z.minLength(1)) }),
  observationActorPrincipalId: z.string().check(z.minLength(1)),
  actor: conversationScopedActorV1Schema,
})));
/** One parser supplies native input and the retaining association's declaration. */
export const AutomationConversationEventActorsV1Schema = projectZodProtocolSchema(conversationEventActorsV1Schema);
export const AutomationConversationScopedTriggerEvidenceV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationConversationScopedTriggerRefV1Schema, {
  bindingId: asProtocolZod(AutomationIdV1Schema),
  observationActorPrincipalId: z.string().check(z.minLength(1)),
  actor: conversationScopedActorV1Schema,
  /** Ordered original senders of one composite admission; omission retains the single-event contract. */
  eventActors: z.optional(asProtocolZod(AutomationConversationEventActorsV1Schema)),
})));
export type AutomationConversationScopedTriggerEvidenceV1 = z.infer<typeof AutomationConversationScopedTriggerEvidenceV1Schema>;
export type AutomationConversationScopedTriggerRefV1 = z.infer<typeof AutomationConversationScopedTriggerRefV1Schema>;

export const AutomationConversationAdmitInputV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  bindingId: asProtocolZod(AutomationIdV1Schema),
  occurrenceId: AutomationEventSourceOrOccurrenceIdV1Schema,
  occurredAt: AutomationOccurredAtV1Schema,
  sender: asProtocolZod(boundedAutomationEventJsonValueV1(
    MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
  )),
  text: z.string().check(z.superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_CONVERSATION_ADMIT_TEXT_UTF8_BYTES) {
      context.addIssue({ code: "custom", message: 'Conversation text exceeds its UTF-8 byte limit' });
    }
  })),
  /** Opaque source-admitted PR evidence; only a declared exact-name workflow input consumes it. */
  prUpdate: z.optional(asProtocolZod(defineProtocolJsonValue<JsonValue>())),
  resultDelivery: AutomationConversationResultDeliveryV1Schema,
  hostEvidence: z.optional(AutomationConversationScopedTriggerEvidenceV1Schema),
}));
export type AutomationConversationAdmitInputV1 = z.infer<typeof AutomationConversationAdmitInputV1Schema>;

/** Shared identity correspondence for plain input and the host's sealed projection. */
export function isAutomationConversationScopedActorCorrespondenceV1(
  evidence: Pick<AutomationConversationScopedTriggerEvidenceV1, 'actor' | 'observationActorPrincipalId' | 'eventActors'>,
): boolean {
  if (evidence.actor.principalId !== evidence.observationActorPrincipalId) return false;
  const actors = evidence.eventActors;
  if (actors === undefined) return true;
  if (actors.length === 0 || actors[0]!.actor.principalId !== evidence.actor.principalId
    || actors[0]!.actor.repositoryWriteAccess !== evidence.actor.repositoryWriteAccess) return false;
  const occurrences = new Set<string>();
  for (const entry of actors) {
    if (occurrences.has(entry.occurrenceId) || entry.actor.principalId !== entry.observationActorPrincipalId
      || !senderMatchesPrincipal(entry.sender, entry.actor.principalId)) return false;
    occurrences.add(entry.occurrenceId);
  }
  return true;
}

function senderMatchesPrincipal(sender: JsonValue, principalId: string): boolean {
  return typeof sender === 'object' && sender !== null && !Array.isArray(sender)
    && 'principalId' in sender && sender.principalId === principalId;
}

/** Binds scoped permission evidence to the same semantic senders, events and binding. */
export function isAutomationConversationAdmitScopedCorrespondenceV1(
  input: AutomationConversationAdmitInputV1,
): boolean {
  const evidence = input.hostEvidence;
  if (evidence === undefined) return true;
  if (evidence.bindingId !== input.bindingId || !isAutomationConversationScopedActorCorrespondenceV1(evidence)
    || !senderMatchesPrincipal(input.sender, evidence.actor.principalId)) return false;
  const actors = evidence.eventActors;
  if (actors === undefined) return true;
  const update = input.prUpdate;
  if (actors[0]!.occurrenceId !== input.occurrenceId || typeof update !== 'object' || update === null
    || Array.isArray(update) || !('events' in update) || !Array.isArray(update.events) || update.events.length !== actors.length) return false;
  return update.events.every((event: unknown, index: number) => {
    if (typeof event !== 'object' || event === null || Array.isArray(event) || !('author' in event)) return false;
    const author = event.author;
    // A native CI check is authored by a process, not the integration person
    // whose measured repository permission admits that observation.
    if ('kind' in event && event.kind === 'check' && typeof author === 'object' && author !== null
      && 'kind' in author && author.kind === 'process' && 'principalId' in author && author.principalId === null) return true;
    return typeof author === 'object' && author !== null && !Array.isArray(author)
      && 'principalId' in author && author.principalId === actors[index]!.actor.principalId;
  });
}

export const AutomationConversationAdmitResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('refused'),
    reason: z.enum(['repositoryWriteAccessUnknown', 'repositoryWriteAccessDenied', 'scopedTriggerIdentityMismatch']),
    checkpointSafe: z.literal(true),
  }),
  z.strictObject({ kind: z.literal('admitted'), runId: asProtocolZod(AutomationIdV1Schema), checkpointSafe: z.literal(true) }),
  z.strictObject({ kind: z.literal('rejoined'), runId: asProtocolZod(AutomationIdV1Schema), checkpointSafe: z.literal(true) }),
  z.strictObject({
    kind: z.literal('blocked'),
    reason: z.enum([
      'capacity',
      'temporarilyUnavailable',
      'occurrenceConflict',
      'noEnabledAssignment',
      'resultDeliveryUnsupported',
    ]),
    checkpointSafe: z.literal(false),
  }),
]));
export type AutomationConversationAdmitResultV1 = z.infer<typeof AutomationConversationAdmitResultV1Schema>;

export const AutomationResultDeliveryInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  handoffId: asProtocolZod(AutomationIdV1Schema),
  runId: asProtocolZod(AutomationIdV1Schema),
  automationId: asProtocolZod(AutomationIdV1Schema),
  source: AutomationResultDeliverySourceV1Schema,
  result: AutomationRunResultV1Schema,
  opaqueContext: asProtocolZod(AutomationEventReplyContextV1Schema),
}));
export type AutomationResultDeliveryInputV1 = z.infer<typeof AutomationResultDeliveryInputV1Schema>;

export const AutomationResultDeliveryResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), custodyId: asProtocolZod(AutomationIdV1Schema) }),
  z.strictObject({ kind: z.literal('retired') }),
  z.strictObject({ kind: z.literal('suppressed'), reason: z.enum(['bindingDisabled', 'bindingDeleted', 'audienceRevoked']) }),
  z.strictObject({
    kind: z.literal('retry'),
    retryAfterMs: AutomationNonnegativeSafeIntegerV1Schema.check(z.maximum(MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS)),
    code: z.enum(['temporarilyUnavailable', 'outcomeUnknown']),
  }),
  z.strictObject({ kind: z.literal('blocked'), code: z.enum(['contractIncompatible', 'invalidCustodyRequest', 'unauthorizedCaller']) }),
]));
export type AutomationResultDeliveryResultV1 = z.infer<typeof AutomationResultDeliveryResultV1Schema>;

/**
 * JSON Schema projections for the one Action contract. A receiving plugin
 * declares these exact Protocol-owned values rather than maintaining a second
 * DTO/schema.
 */
export const AutomationRunResultV1JsonSchema: PluginJsonSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    kind: { type: 'string', const: 'text' },
    text: { type: 'string' },
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
    resultDelivery: { type: 'string', const: 'finalResult' },
  },
  required: [
    'kind',
    'automationRunId',
    'resultId',
    'automationId',
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
