import { readDiscussionAttachmentPayloadsV1 } from '@happier-dev/protocol/discussions/content';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';
import { DiscussionAttachmentReadResultV1Schema } from '@happier-dev/protocol/discussions/attachments';
import { decodeBase64 } from '@/api/encryption';
import { materializeSessionAttachments } from '@/session/attachments/materializeSessionAttachments';
import { readDiscussionInputMessages } from './readDiscussionInputMessages';
import type { createDiscussionActionDeps } from './discussionActionDeps';
import type { HappierStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { SessionAttachmentDescriptorV1 } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';

export type DiscussionAttachmentDispatchInput = Readonly<{
  addressing: DiscussionAddressingV1; localId: string; signal: AbortSignal;
}>;
export type DiscussionAttachmentDispatchResult = Readonly<{
  structuredInput: HappierStructuredInputV1 | null;
  attachments: readonly SessionAttachmentDescriptorV1[];
}> | null;

export class DiscussionAttachmentPreparationError extends Error {
  readonly code = 'discussion_attachment_preparation_unavailable';
  readonly retryable = true;
  constructor() {
    super('Discussion attachment context is unavailable for the target Session');
    this.name = 'DiscussionAttachmentPreparationError';
  }
}

/** The protected original identifies the exact committed sources; current reads supply no path authority. */
export async function materializeDiscussionInputAttachments(input: Readonly<{
  serverId: string;
  addressing: DiscussionAddressingV1;
  discussion: ReturnType<typeof createDiscussionActionDeps>;
  target: Pick<Parameters<typeof materializeSessionAttachments>[0],
    'sessionId' | 'messageLocalId' | 'rpc' | 'resolveSessionAttachment'>;
  signal: AbortSignal;
}>) {
  const { addressing, signal } = input;
  const discussionAction = input.discussion.discussionAction!;
  const unavailable = () => new Error('discussion_attachment_unavailable');
  const messages = await readDiscussionInputMessages({ ...input, discussionAction });
  if (!messages) throw unavailable();
  const sources = messages.flatMap(message => message.content
    ? readDiscussionAttachmentPayloadsV1(message.content).map(attachment => ({ messageId: message.id, attachment })) : []);
  if (sources.length === 0) return null;
  const key = await input.discussion.readAttachmentContext({ discussionId: addressing.discussionId, signal });
  // Bind every leaf to its committed message. No newer peer-answer or unrelated history is loaded.
  const projected = await materializeSessionAttachments({ ...input.target,
    attachments: sources.map(({ attachment, messageId }) => attachment.kind === 'file'
      ? { ...attachment, file: { messageId, reference: attachment.file } }
      : { ...attachment, entries: attachment.entries.map(entry => ({ ...entry, file: { messageId, reference: entry.file } })) }), signal,
    readFile: async ({ messageId, reference }) => {
      signal.throwIfAborted();
      const read = DiscussionAttachmentReadResultV1Schema.safeParse(await input.discussion.readOpenedAttachment({
        discussionId: addressing.discussionId, messageId, reference, key, throughSeq: addressing.throughSeq, signal }));
      if (!read.success || read.data.blobId !== reference.blobId || read.data.mime !== reference.mime
        || read.data.sizeBytes !== reference.sizeBytes || read.data.sha256 !== reference.sha256) throw unavailable();
      if ('removedByAccountId' in read.data) throw new Error('discussion_attachment_removed');
      return decodeBase64(read.data.bytesBase64);
    },
  });
  signal.throwIfAborted();
  const current = await input.discussion.readAttachmentContext({ discussionId: addressing.discussionId, signal });
  if (current.mode !== key.mode || current.dataEncryptionKey !== key.dataEncryptionKey) throw unavailable();
  return projected;
}
