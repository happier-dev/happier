import type { ComposerHandle, ComposerRequestOptions, ComposerTransactionResultV1 } from '@happier-dev/plugin-ui';
import {
  ProtocolTranscriptAnnotationV1Schema,
  TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1,
  buildTranscriptAnnotationPresentationV1,
} from '@happier-dev/plugin-sdk/protocol';

export async function saveTranscriptAnnotationNote(
  handle: Pick<ComposerHandle, 'read' | 'apply'>, instanceId: string, note: string,
  options?: ComposerRequestOptions,
): Promise<ComposerTransactionResultV1> {
  const current = await handle.read(options);
  if (current.status !== 'ready') return { status: 'composerUnavailable' };
  if (!current.snapshot.state.editable) return { status: 'notEditable' };
  const instance = current.snapshot.attachments.find(attachment => attachment.instanceId === instanceId
    && attachment.attachment.pluginId === TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1.pluginId
    && attachment.attachment.localId === TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1.localId);
  if (!instance) return { status: 'composerUnavailable' };
  const annotation = ProtocolTranscriptAnnotationV1Schema.parse(instance.value);
  const updated = ProtocolTranscriptAnnotationV1Schema.parse({ ...annotation, note });
  return handle.apply({ expectedRevision: current.snapshot.revision, operations: [{
    kind: 'attachment.update', instanceId,
    update: { value: updated, presentation: buildTranscriptAnnotationPresentationV1(updated) },
  }] }, options);
}
