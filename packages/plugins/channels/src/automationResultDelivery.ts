import type {
  ConversationDeliveryLinkPreviewPolicyV1,
  ConversationDeliveryReplyContextV1,
  ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import {
  CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
  ConversationBindingIdV1Schema,
  ConversationConnectionIdV1Schema,
  ConversationDeliveryReplyContextV1Schema,
  ConversationResolvedEndpointV1Schema,
} from '@happier-dev/channels-protocol/v1';
import {
  AutomationResultDeliveryInputV1Schema,
  type AutomationResultDeliveryInputV1,
  type AutomationResultDeliveryResultV1,
  type AutomationResultDeliverySourceV1,
} from '@happier-dev/plugin-sdk/automations';
import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createProtocolStoredReadSchema, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { conversationRetryDelayMs } from './retryBackoff.js';
import {
  admitConversationOutwardDeliveryReady,
  createConversationOutwardDeliveryCollectionStore,
  type ConversationOutwardDeliveryObligation,
  type ConversationOutwardDeliverySuppressionReason,
} from './outwardDelivery.js';

export type ConversationAutomationResultRouteV1 = Readonly<{
  connectionId: string;
  bindingId: string;
  bindingRevision?: number;
  connectionAuthorityEpoch?: number;
  bindingAuthorityEpoch?: number;
  endpoint: ConversationResolvedEndpointV1;
  replyContext: ConversationDeliveryReplyContextV1;
  linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
}>;

type AutomationTextResultDeliveryInputV1 = AutomationResultDeliveryInputV1 & Readonly<{
  result: Extract<AutomationResultDeliveryInputV1['result'], Readonly<{ kind: 'text' }>>;
}>;

export type PreparedConversationAutomationResultDelivery = Readonly<{
  kind: 'prepared';
  input: AutomationTextResultDeliveryInputV1;
  route: ConversationAutomationResultRouteV1;
  source: AutomationResultDeliverySourceV1;
}>;

export type ConversationAutomationResultDeliveryPreparation =
  | PreparedConversationAutomationResultDelivery
  | Readonly<{
    kind: 'blocked';
    code: 'contractIncompatible' | 'invalidCustodyRequest' | 'unauthorizedCaller';
  }>;

type ParsedConversationAutomationResultHandoff = Readonly<{
  route: ConversationAutomationResultRouteV1;
}>;

const positiveSafeIntegerSchema = defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// Automation persists this provider-private route as opaque JSON. Project its
// known facts here; the outer Automation Action still uses strict admission.
const storedAutomationResultRouteSchema = createProtocolStoredReadSchema(defineProtocolObject({
  v: defineProtocolLiteral(1),
  kind: defineProtocolLiteral('conversationAutomationResultDelivery'),
  connectionId: ConversationConnectionIdV1Schema,
  bindingId: ConversationBindingIdV1Schema,
  bindingRevision: positiveSafeIntegerSchema.optional(),
  connectionAuthorityEpoch: positiveSafeIntegerSchema.optional(),
  bindingAuthorityEpoch: positiveSafeIntegerSchema.optional(),
  endpoint: ConversationResolvedEndpointV1Schema,
  reply: defineProtocolObject({
    providerMessageId: defineProtocolString(),
  }, { policy: 'closed' }),
  linkPreviewPolicy: defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[0]),
    defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[1]),
  ]),
}, { policy: 'closed' }));

function isExactAutomationRunCaller(input: Readonly<{
  caller: PluginInvocationCaller | undefined;
  automationId: string;
  runId: string;
}>): boolean {
  const { caller } = input;
  return caller?.kind === 'automationRun'
    && caller.cause.kind === 'conversation'
    && caller.automationId === input.automationId
    && caller.runId === input.runId;
}

function readRoute(opaqueContext: unknown): ParsedConversationAutomationResultHandoff | undefined {
  const parsed = storedAutomationResultRouteSchema.safeParse(opaqueContext);
  if (!parsed.success) return undefined;
  const context = parsed.data;
  if (!ConversationDeliveryReplyContextV1Schema.safeParse({
      replyToMessageId: context.reply.providerMessageId,
    }).success) return undefined;

  return {
    route: {
      connectionId: context.connectionId,
      bindingId: context.bindingId,
      endpoint: context.endpoint,
      replyContext: { replyToMessageId: context.reply.providerMessageId },
      linkPreviewPolicy: context.linkPreviewPolicy,
    },
  };
}

function matchesOuterAutomationResultSource(input: Readonly<{
  source: AutomationResultDeliverySourceV1;
  handoffId: string;
  runId: string;
  automationId: string;
}>): boolean {
  return input.source.automationRunId === input.runId
    && input.source.resultId === input.handoffId
    && input.source.automationId === input.automationId;
}

/**
 * Validates only the immutable host/Automation and Channels admission seam.
 * It neither reads Account state nor creates custody; C4 owns those effects.
 */
export function prepareConversationAutomationResultDelivery(input: Readonly<{
  input: unknown;
  caller?: PluginInvocationCaller;
}>): ConversationAutomationResultDeliveryPreparation {
  const parsedInput = AutomationResultDeliveryInputV1Schema.safeParse(input.input);
  if (!parsedInput.success) return { kind: 'blocked', code: 'invalidCustodyRequest' };
  const admitted = parsedInput.data;
  if (!isExactAutomationRunCaller({
    caller: input.caller,
    automationId: admitted.automationId,
    runId: admitted.runId,
  })) return { kind: 'blocked', code: 'unauthorizedCaller' };
  if (!matchesOuterAutomationResultSource(admitted)) {
    return { kind: 'blocked', code: 'invalidCustodyRequest' };
  }
  const result = admitted.result;
  if (result.kind !== 'text') {
    return { kind: 'blocked', code: 'contractIncompatible' };
  }
  if (result.text.length === 0) {
    return { kind: 'blocked', code: 'invalidCustodyRequest' };
  }
  const handoff = readRoute(admitted.opaqueContext);
  if (handoff === undefined) return { kind: 'blocked', code: 'invalidCustodyRequest' };

  return {
    kind: 'prepared',
    input: { ...admitted, result },
    route: handoff.route,
    source: admitted.source,
  };
}

function resultForSuppressedCustody(
  reason: ConversationOutwardDeliverySuppressionReason,
): AutomationResultDeliveryResultV1 {
  if (reason === 'bindingDisabled' || reason === 'connectionDisabled') {
    return { kind: 'suppressed', reason: 'bindingDisabled' };
  }
  if (reason === 'audienceChanged') {
    return { kind: 'suppressed', reason: 'audienceRevoked' };
  }
  return { kind: 'suppressed', reason: 'bindingDeleted' };
}

/**
 * The registered Automation Action accepts only a sealed route/source into C4
 * custody. It never reads a Run, Automation, or binding to construct source
 * facts, and it deliberately leaves all provider effects to the supervisor.
 */
export async function deliverConversationAutomationResultForInvocation(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AutomationResultDeliveryResultV1> {
  const admission = prepareConversationAutomationResultDelivery({
    input,
    caller: context.caller,
  });
  if (admission.kind === 'blocked') return admission;

  const obligation = {
    connectionId: admission.route.connectionId,
    bindingId: admission.route.bindingId,
    routeAuthority: {},
    source: admission.source,
    endpoint: admission.route.endpoint,
    content: { text: admission.input.result.text },
    deliveryKey: `automation:${admission.source.resultId}`,
    replyContext: admission.route.replyContext,

    linkPreviewPolicy: admission.route.linkPreviewPolicy,
  } satisfies ConversationOutwardDeliveryObligation;
  const stateCollection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const accepted = await admitConversationOutwardDeliveryReady({
    stateCollection,
    store: createConversationOutwardDeliveryCollectionStore({
      stateCollection,
      deliveriesCollection: requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION),
      signal: context.signal,
    }),
    obligation,
    signal: context.signal,
  });
  if (accepted.kind === 'accepted') {
    return { kind: 'accepted', custodyId: accepted.custodyId };
  }
  if (accepted.kind === 'retired') return accepted;
  if (accepted.kind === 'suppressed') return resultForSuppressedCustody(accepted.reason);
  if (accepted.kind === 'invalid') return { kind: 'blocked', code: 'invalidCustodyRequest' };
  return {
    kind: 'retry',
    retryAfterMs: conversationRetryDelayMs(1),
    code: 'temporarilyUnavailable',
  };
}
