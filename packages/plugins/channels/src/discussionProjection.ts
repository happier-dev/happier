import type { ConversationDeliveryReplyContextV1 } from '@happier-dev/channels-protocol/v1';
import { readConversationDiscussionInputReplyContext } from './ingress.js';
import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type ActionsService, type PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import { readDiscussionMessagePartsV1 } from '@happier-dev/plugin-sdk/protocol';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { asChannelStateRow, isChannelStateJsonRecord, readConversationBindingParentEligibility, readConversationBindingUpdateRow,
  type ChannelStateRow } from './accountLocalBindingPolicy.js';
import { createConversationSessionProjectionFrontierRowId, type ConversationSessionProjectionResult } from './sessionProjection.js';
import { isConversationDeliveryAutomaticTerminal } from './deliveryCustody.js';
import type { ConversationOutwardDeliveryResult, ConversationOutwardSourceV1 } from './outwardDelivery.js';
import { readConversationDiscussionInputBindingId } from './discussionInputIdentity.js';
import { readConversationDiscussionReplyInput } from './discussionReplyDestination.js';

type DiscussionRead = PluginActionResultById['discussion.read'];
type DiscussionMessage = DiscussionRead['messages'][number];
type StateCollection = Pick<PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>, 'get' | 'batch'>;
export type ConversationDiscussionProjectionBinding = Readonly<{
  bindingId: string;
  revision: number;
  connectionId: string;
  target: Readonly<{ discussionId: string; deliveryMode: 'repliesOnly' }>;
}>;
export type ConversationDiscussionProjectionSource = Extract<ConversationOutwardSourceV1, { kind: 'discussionProjection' }>;

/** Discussion and Session progress occupy the same binding-owned frontier record. */
export function createConversationDiscussionProjectionFrontierRow(input: Readonly<{
  bindingId: string; targetDiscussionId: string; lastScannedSeq: number; now: number; createdAt?: number;
}>): Readonly<Record<string, JsonValue>> & Readonly<{ id: string }> {
  return { id: createConversationSessionProjectionFrontierRowId(input.bindingId),
    'record-kind': CHANNEL_STATE_RECORD_KIND.projectionFrontier, v: 1, 'binding-id': input.bindingId,
    'created-at': input.createdAt ?? input.now, 'updated-at': input.now,
    payload: { targetDiscussionId: input.targetDiscussionId, lastScannedSeq: input.lastScannedSeq } };
}

/** Read, order and ancestry stay Discussion-owned; effects use incumbent Channels custody. */
export async function projectConversationDiscussionPage(input: Readonly<{
  actions: ActionsService;
  stateCollection: StateCollection;
  bindingRow: ChannelStateRow;
  bindingId: string;
  signal: AbortSignal;
  now: () => number;
  observeDiscussion?: (discussionId: string, bindingId: string) => void;
  deliver: (input: Readonly<{ binding: ConversationDiscussionProjectionBinding;
    frontierRowRevision: number;
    source: ConversationDiscussionProjectionSource; content: string; replyContext: ConversationDeliveryReplyContextV1 }>) => Promise<ConversationOutwardDeliveryResult>;
}>): Promise<ConversationSessionProjectionResult> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  const current = readConversationBindingUpdateRow({ row: input.bindingRow, bindingId: input.bindingId }).binding;
  if (!current.enabled || current.deletionState !== 'none' || current.target.kind !== 'discussion') {
    return { kind: 'unavailable', reason: 'bindingUnavailable' };
  }
  const parent = await readConversationBindingParentEligibility({ collection: input.stateCollection, binding: current, signal: input.signal });
  if (parent.kind !== 'eligible') return { kind: 'unavailable', reason: 'bindingUnavailable' };
  const binding: ConversationDiscussionProjectionBinding = { bindingId: input.bindingId,
    revision: input.bindingRow.revision, connectionId: current.connectionId,
    target: { discussionId: current.target.discussionId, deliveryMode: current.target.policy.deliveryMode } };
  input.observeDiscussion?.(binding.target.discussionId, binding.bindingId);
  const frontierId = createConversationSessionProjectionFrontierRowId(binding.bindingId);
  const frontierRow = asChannelStateRow(await input.stateCollection.get(frontierId, { signal: input.signal }));
  const payload = frontierRow?.value.payload;
  if (frontierRow === undefined || !isChannelStateJsonRecord(payload)
    || frontierRow.value['record-kind'] !== CHANNEL_STATE_RECORD_KIND.projectionFrontier
    || frontierRow.value['binding-id'] !== binding.bindingId
    || payload.targetDiscussionId !== binding.target.discussionId
    || typeof payload.lastScannedSeq !== 'number' || !Number.isSafeInteger(payload.lastScannedSeq) || payload.lastScannedSeq < 0) {
    return { kind: 'unavailable', reason: 'frontierUnavailable' };
  }
  const lastScannedSeq = payload.lastScannedSeq;
  const read = async (selection: Readonly<{ afterSeq: number }> | Readonly<{ messageId: string }>): Promise<DiscussionRead> => {
    const result = await input.actions.execute('discussion.read', { discussionId: binding.target.discussionId, ...selection }, { signal: input.signal });
    if (isPluginActionApprovalRequestCreated(result)) throw new PluginError({
      code: 'approval_required', message: 'Discussion read requires approval.', retryable: false,
    });
    return result;
  };
  try {
    const page = await read({ afterSeq: lastScannedSeq });
    if (page.incomplete) throw new PluginError({ code: 'discussion_content_unavailable', message: 'Discussion content is unavailable.', retryable: false });
    const messages = new Map(page.messages.map(message => [message.id, message]));
    const getMessage = async (messageId: string): Promise<DiscussionMessage> => {
      const present = messages.get(messageId);
      if (present !== undefined) return present;
      const exact = await read({ messageId });
      const message = exact.messages.find(message => message.id === messageId);
      if (exact.incomplete || message === undefined || message.content === null) throw new PluginError({
        code: 'discussion_content_unavailable', message: 'Discussion reply ancestry is unavailable.', retryable: false,
      });
      messages.set(messageId, message);
      return message;
    };
    const readReplyContext = async (message: DiscussionMessage): Promise<ConversationDeliveryReplyContextV1 | undefined> => {
      const origin = message.replyTarget?.kind === 'message'
        ? await readConversationDiscussionReplyInput({ messageId: message.replyTarget.messageId, readMessage: getMessage }) : undefined;
      if (origin !== undefined) {
        const ancestor = origin.message;
        return origin.bindingId === binding.bindingId
          ? await readConversationDiscussionInputReplyContext({ stateCollection: input.stateCollection,
            bindingId: binding.bindingId, connectionId: binding.connectionId, discussionId: binding.target.discussionId,
            localId: ancestor.content !== null && 'externalSource' in ancestor.content
              ? ancestor.content.externalSource?.inputLocalId ?? ancestor.localId : ancestor.localId,
            signal: input.signal })
          : undefined;
      }
      return undefined;
    };
    let scannedThrough = lastScannedSeq;
    let deliveredItemCount = 0;
    for (const message of page.messages) {
      const replyContext = message.content !== null && readConversationDiscussionInputBindingId(message.localId) === undefined
        ? await readReplyContext(message) : undefined;
      if (message.content !== null && replyContext !== undefined) {
        const content = readDiscussionMessagePartsV1(message.content).filter(part => part.t === 'text').map(part => part.text).join('');
        if (content.length > 0) {
          const delivered = await input.deliver({ binding, frontierRowRevision: frontierRow.revision, source: { kind: 'discussionProjection',
            discussionId: binding.target.discussionId, semanticItemId: message.id }, content, replyContext });
          if (!(delivered.kind === 'retired' || ((delivered.kind === 'settled' || delivered.kind === 'suppressed')
            && isConversationDeliveryAutomaticTerminal(delivered.custody)))) {
            return { kind: 'blocked', reason: 'deliveryPending', semanticItemId: message.id };
          }
          deliveredItemCount++;
        }
      }
      scannedThrough = message.seq;
    }
    // An empty ordered page proves the remaining sequence contains no readable messages.
    if (page.messages.length === 0) scannedThrough = Math.max(scannedThrough, page.messageSeq);
    if (scannedThrough === lastScannedSeq) return { kind: 'idle', deliveredItemCount };
    const result = await input.stateCollection.batch([
      { kind: 'assert', rowId: binding.bindingId, expectedRevision: binding.revision },
      { kind: 'put', expectedRevision: frontierRow.revision,
        value: createConversationDiscussionProjectionFrontierRow({ bindingId: binding.bindingId,
          targetDiscussionId: binding.target.discussionId, lastScannedSeq: scannedThrough, now: input.now(),
          ...(typeof frontierRow.value['created-at'] === 'number' ? { createdAt: frontierRow.value['created-at'] } : {}) }) },
    ], { signal: input.signal });
    return result.status === 'updated'
      ? { kind: 'advanced', hasMore: scannedThrough < page.messageSeq, deliveredItemCount }
      : { kind: 'blocked', reason: 'frontierChanged' };
  } catch (error) {
    if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    if (!isPluginError(error)) throw error;
    return { kind: 'unavailable', reason: 'transcriptUnavailable', actionErrorCode: error.code, retryable: error.retryable === true };
  }
}
