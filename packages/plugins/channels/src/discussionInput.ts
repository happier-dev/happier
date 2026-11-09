import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import { isPluginActionApprovalRequestCreated, type PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { SessionSendAttachment } from '@happier-dev/plugin-sdk/sessions';
import type { ConversationObservationV1 } from '@happier-dev/channels-protocol/v1';
import { readChannelFileInputs } from './channelAttachmentRuntime.js';

export { createConversationDiscussionInputLocalId, readConversationDiscussionInputOrigin,
  readConversationDiscussionInputBindingId } from './discussionInputIdentity.js';

// Only unfinished publications are retained. The thread identity includes the
// connection's Account-scoped routing HMAC, so unrelated threads remain free.
const activeThreadPublications = new Map<string, Promise<unknown>>();

export async function postConversationDiscussionInput(input: Parameters<typeof postDiscussionInput>[0], context: PluginInvocationContext) {
  if (input.threadRootLocalId === undefined) return await postDiscussionInput(input, context);
  const key = JSON.stringify([input.discussionId, input.threadRootLocalId]);
  const previous = activeThreadPublications.get(key);
  const running = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    context.signal.throwIfAborted();
    return await postDiscussionInput(input, context);
  }).finally(() => {
    if (activeThreadPublications.get(key) === running) activeThreadPublications.delete(key);
  });
  // Keep root lookup and the resulting native approval/publication together:
  // a later arrival must see the committed root before freezing its operands.
  activeThreadPublications.set(key, running);
  return await running;
}

/** Exact native local-id lookup groups a thread without a second history scan. */
async function postDiscussionInput(input: Readonly<{
  discussionId: string; localId: string; threadRootLocalId?: string;
  providerPluginId: string; observation: ConversationObservationV1;
  conversationDisplayName: string;
  attachments: readonly SessionSendAttachment[];
}>, context: PluginInvocationContext) {
  let localId = input.localId;
  let replyTarget: PluginActionInputById['discussion.post']['replyTarget'];
  if (input.threadRootLocalId !== undefined) {
    const read = await context.services.actions.execute('discussion.read', {
      discussionId: input.discussionId, localId: input.threadRootLocalId,
    }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(read)) return read;
    if (read.incomplete) throw new PluginError({ code: 'discussion_content_unavailable', message: 'The Discussion thread root is unavailable.' });
    const root = read.messages.find(message => message.localId === input.threadRootLocalId);
    if (root === undefined) localId = input.threadRootLocalId;
    else {
      if (root.content === null || !('externalSource' in root.content) || root.content.externalSource?.inputLocalId === undefined) {
        throw new PluginError({ code: 'discussion_content_unavailable', message: 'The Discussion thread origin is unavailable.' });
      }
      if (root.content.externalSource.inputLocalId === input.localId) localId = input.threadRootLocalId;
      else replyTarget = { kind: 'message', messageId: root.id };
    }
  }
  const content: PluginActionInputById['discussion.post']['content'] = {
    v: 1, parts: input.observation.message.text.trim().length
      ? [{ t: 'text', text: input.observation.message.text.normalize('NFC') }] : [],
    externalSource: { kind: 'channel', providerPluginId: input.providerPluginId,
      conversationDisplayName: input.conversationDisplayName.normalize('NFC'),
      ...(input.observation.actor.label ? { senderDisplayName: input.observation.actor.label.normalize('NFC') } : {}),
      ...(input.threadRootLocalId === undefined ? {} : { inputLocalId: input.localId }),
    },
  };
  const post = (attachmentSources?: PluginActionInputById['discussion.post']['attachmentSources']) =>
    context.services.actions.execute('discussion.post', {
      discussionId: input.discussionId, localId, content,
      ...(replyTarget === undefined ? {} : { replyTarget }),
      ...(attachmentSources === undefined ? {} : { attachmentSources }),
    }, { signal: context.signal });
  if (input.attachments.length === 0) return await post();
  const files = await readChannelFileInputs(input.attachments, context);
  const directory = createSecureTempDirectorySync({ prefix: 'channel-attachments' });
  try {
    const sources: NonNullable<PluginActionInputById['discussion.post']['attachmentSources']> = [];
    for (const [index, file] of files.entries()) {
      context.signal.throwIfAborted();
      // A native retry must keep the same leaf identities and authored content.
      const hash = createHash('sha256').update(JSON.stringify(['discussion-file', input.localId, file.key])).digest('hex');
      const blobId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const path = join(directory.path, String(index));
      await writeAtomicFile({ path, contents: file.bytes, mode: 0o600 });
      content.parts.push({ t: 'attachment', attachment: { kind: 'file', id: blobId, name: file.descriptor.name.normalize('NFC'),
        file: { blobId, mime: file.descriptor.mediaType, sizeBytes: file.bytes.byteLength,
          sha256: createHash('sha256').update(file.bytes).digest('hex') } } });
      sources.push({ blobId, path });
    }
    return await post(sources);
  } finally { directory.cleanup(); }
}
