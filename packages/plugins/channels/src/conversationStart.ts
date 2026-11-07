import {
  ConversationStartInputV1Schema,
  type ConversationStartResultV1,
  type ConversationSessionBindingTargetV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, projectPluginFailureText, type PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { asChannelStateRow, readConversationBindingUpdateRow } from './accountLocalBindingPolicy.js';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_COLLECTION } from './collections.js';
import { hasPendingConversationThreadBinding } from './deliveryCustody.js';
import { createConversationThreadBindingForInvocation } from './management.js';
import {
  admitConversationOutwardDeliveryReady,
  createConversationOutwardDeliveryCollectionStore,
  type ConversationOutwardDeliveryObligation,
  type ConversationOutwardDeliveryRecord,
  type ConversationOutwardDeliveryStore,
} from './outwardDelivery.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { readConversationSessionProjectionNoHistoryBaseline } from './sessionProjection.js';

const startedConversationPolicy: ConversationSessionBindingTargetV1['policy'] = {
  deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
  approvals: { kind: 'off' }, newSession: { kind: 'off' },
};

/** Starts enter the same write-ahead custody as every other outward message. */
export async function startConversationForInvocation(input: unknown, context: PluginInvocationContext): Promise<ConversationStartResultV1> {
  const request = ConversationStartInputV1Schema.parse(input);
  if (context.invocationId === undefined) throw new PluginError({
    code: 'channels_conversation_start_identity_unavailable', message: 'Starting a conversation requires the host Action identity.',
  });
  const account = requireChannelsAccountStorage(context);
  const state = account.collection(CHANNEL_STATE_COLLECTION);
  const row = asChannelStateRow(await state.get(request.routerBindingId, { signal: context.signal }));
  if (row === undefined) throw new PluginError({ code: 'channels_conversation_start_router_not_found', message: 'The conversation router is unavailable.' });
  const router = readConversationBindingUpdateRow({ row, bindingId: request.routerBindingId }).binding;
  if (router.target.kind !== 'threadRouter') throw new PluginError({ code: 'channels_conversation_start_router_required', message: 'Starting a conversation requires a thread router.' });
  const audience = router.target.principalGroups.find((group) => group.id === request.audienceGroupId);
  if (audience === undefined || audience.principalIds.length === 0) throw new PluginError({ code: 'channels_conversation_start_audience_not_found', message: 'Choose a configured router audience.' });
  const obligation: ConversationOutwardDeliveryObligation = {
    connectionId: router.connectionId, bindingId: router.id,
    routeAuthority: {},
    source: { kind: 'conversationStart', sessionId: request.sessionId, requestId: context.invocationId },
    endpoint: router.endpoint, content: request.content,
    newThread: { recipients: audience.principalIds, subject: request.subject },
    deliveryKey: `conversation-start:${context.invocationId}`,
     linkPreviewPolicy: router.linkPreviewPolicy,
  };
  const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state,
    deliveriesCollection: account.collection(CHANNEL_DELIVERIES_COLLECTION), signal: context.signal });
  // An accepted effect rejoins its durable row before mutable Session state is read.
  const retained = await store.lookup(obligation);
  if (retained.kind === 'rejoined') return { kind: 'accepted', custodyId: retained.record.custodyId };
  if (retained.kind !== 'absent') throw new PluginError({ code: `channels_conversation_start_${retained.kind}`,
    message: projectPluginFailureText(new Error(`The existing conversation delivery custody is unavailable.${'reason' in retained ? ` (${retained.reason})` : ''}`)),
    retryable: retained.kind === 'unavailable',
    ...('reason' in retained ? { details: { reason: retained.reason } } : {}),
  });
  const session = await context.services.sessions.get(request.sessionId, { signal: context.signal }).catch(() => null);
  if (session === null) throw new PluginError({ code: 'channels_conversation_start_session_unavailable',
    message: 'The reply Session is unavailable.', retryable: true });
  const summary = await session.summary({ signal: context.signal }).catch(() => null);
  // Protected birth identity belongs to the Session owner. Unknown is not an
  // unattested Session, and a multi-principal thread cannot reuse that identity.
  if (summary?.hasAttestedContext !== false) throw new PluginError({
    code: 'channels_conversation_start_session_attestation_unavailable',
    message: 'The reply Session must be confirmed to have no attested sender identity.',
    retryable: summary?.hasAttestedContext === undefined,
  });
  const target = await readConversationSessionProjectionNoHistoryBaseline({
    actions: context.services.actions, sessionId: request.sessionId, signal: context.signal,
  });
  if (target.kind !== 'ready') {
    const details = { projectionKind: target.kind, projectionReason: target.reason,
      ...(target.kind === 'unavailable' && target.actionErrorCode !== undefined ? { actionErrorCode: target.actionErrorCode } : {}),
    };
    // Target approval receipts deliberately exclude opaque plugin details.
    // Record only the projection owner's classified facts, never the caught
    // throwable, Action payload, transcript, or conversation content.
    context.services.logger.info('[Channels] Conversation start baseline unavailable', { sessionId: request.sessionId, ...details });
    throw new PluginError({ code: 'channels_conversation_start_session_unavailable',
      message: 'The reply Session transcript is unavailable.', retryable: target.kind === 'retry' || target.kind === 'unavailable', details });
  }
  const accepted = await admitConversationOutwardDeliveryReady({
    stateCollection: state, store,
    obligation, signal: context.signal,
  });
  if (accepted.kind !== 'accepted') throw new PluginError({
    code: `channels_conversation_start_${accepted.kind}`,
    message: projectPluginFailureText(new Error(`The conversation start could not enter delivery custody.${'reason' in accepted ? ` (${accepted.reason})` : ''}`)),
    retryable: accepted.kind === 'unavailable',
    ...('reason' in accepted ? { details: { reason: accepted.reason } } : {}),
  });
  return { kind: 'accepted', custodyId: accepted.custodyId };
}

/** Recovery completes reply routing after the external effect, without another send. */
export async function finishStartedConversationBinding(input: Readonly<{
  record: ConversationOutwardDeliveryRecord; store: ConversationOutwardDeliveryStore;
  context: PluginInvocationContext;
}>): Promise<boolean> {
  const { record, context } = input;
  if (!hasPendingConversationThreadBinding(record.custody)) return true;
  if (record.obligation.source.kind !== 'conversationStart' || record.obligation.newThread === undefined
    || record.obligation.bindingId === undefined || record.custody.endpoint === undefined) return false;
  const state = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const routerRow = await state.get(record.obligation.bindingId, { signal: context.signal });
  const connectionRow = await state.get(record.obligation.connectionId, { signal: context.signal });
  if (routerRow === null || connectionRow === null) return false;
  const child = await createConversationThreadBindingForInvocation({
    routerBindingId: record.obligation.bindingId,
    expectedRouterRevision: routerRow.revision, expectedConnectionRevision: connectionRow.revision,
    endpoint: record.custody.endpoint, sessionId: record.obligation.source.sessionId,
    allowedPrincipalIds: record.obligation.newThread.recipients, policy: startedConversationPolicy,
  }, context);
  if (child.kind !== 'created') return false;
  const settled = await input.store.compareAndSwap({ custodyId: record.custodyId, expectedRevision: record.revision,
    custody: { ...record.custody, threadBindingPending: false } });
  return settled.kind === 'updated';
}
