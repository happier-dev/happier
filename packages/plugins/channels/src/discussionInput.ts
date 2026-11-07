import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicFile } from '@happier-dev/plugin-sdk/fs';
import { isPluginActionApprovalRequestCreated, type PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { SessionSendAttachment } from '@happier-dev/plugin-sdk/sessions';
import type { ConversationObservationV1 } from '@happier-dev/channels-protocol/v1';
import { readChannelFileInputs } from './channelAttachmentRuntime.js';

/** The existing Discussion writer's retry identity also identifies the inbound binding. */
export function createConversationDiscussionInputLocalId(bindingId: string, obligationId: string): string {
  return `channels:${bindingId.length}:${bindingId}:${obligationId}`;
}

export function readConversationDiscussionInputOrigin(localId: string | null): Readonly<{ bindingId: string; obligationId: string }> | undefined {
  if (localId === null) return undefined;
  const frame = /^channels:([1-9][0-9]*):/u.exec(localId);
  if (frame === null) return undefined;
  const length = Number(frame[1]);
  const bindingId = localId.slice(frame[0].length, frame[0].length + length);
  const suffix = localId.slice(frame[0].length + length);
  return bindingId.length === length && /^:[A-Za-z0-9_-]{43}$/u.test(suffix)
    ? { bindingId, obligationId: suffix.slice(1) } : undefined;
}

export function readConversationDiscussionInputBindingId(localId: string | null): string | undefined {
  return readConversationDiscussionInputOrigin(localId)?.bindingId;
}

/** Exact native local-id lookup groups a thread without a second registry or history scan. */
export async function postConversationDiscussionInput(input: Readonly<{
  discussionId: string; localId: string; threadRootLocalId?: string;
  providerPluginId: string; observation: ConversationObservationV1;
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
      conversationDisplayName: (input.observation.endpoint.label || 'External conversation').normalize('NFC'),
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
