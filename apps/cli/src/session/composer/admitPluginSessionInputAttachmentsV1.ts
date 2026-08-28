import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  ComposerAttachmentInputV1Schema,
  type ComposerAttachmentInputV1,
  type ComposerAttachmentDraftV1,
  type PluginSessionInputAttachmentV1,
} from '@happier-dev/protocol';

import { admitSessionStructuredInputV1 } from '@/session/services/admitSessionStructuredInputV1';
import {
  prepareComposerAttachmentDraftsForSendV1,
  type ComposerAttachmentSendPreparationRegistryV1,
} from './prepareComposerAttachmentDraftsForSendV1';

export type PluginSessionInputAttachmentAdmissionV1 =
  | Readonly<{
    status: 'admitted';
    meta: Record<string, unknown>;
    attachments: readonly ComposerAttachmentInputV1[];
  }>
  | Readonly<{
    status: 'rejected';
    code: 'session_input_invalid' | 'session_input_target_unavailable';
  }>;

/**
 * Builds the canonical draft envelope for a plugin-authored Session input.
 *
 * This pure half is also used by the daemon's pending-first-input handoff:
 * that handoff must be serializable before the child knows its Session id,
 * while the child's existing input transformer still owns declaration lookup,
 * prepareForSend and final admission once the real Session is mounted.
 */
export function buildPluginSessionInputAttachmentDraftsV1(params: Readonly<{
  pluginId: string;
  messageLocalId: string;
  authored: readonly PluginSessionInputAttachmentV1[];
}>): readonly ComposerAttachmentDraftV1[] {
  return params.authored.map((authored, index) => ({
    v: 1,
    instanceId: `${params.messageLocalId}#${index}`,
    attachment: { pluginId: params.pluginId, localId: authored.attachmentLocalId },
    key: authored.value.key,
    value: authored.value.value,
    presentation: {
      ...authored.value.presentation,
      typeLabel: authored.value.presentation.label,
    },
  }));
}

/**
 * Turns the attachment drafts a plugin declared on `SessionHandle.send` into
 * the one canonical structured-input envelope a Message may carry.
 *
 * The plugin authors only the half the Composer's `attachment.add` authors —
 * its own attachment's local id, key, value and presentation. This host owner
 * qualifies the calling plugin's id, derives an instance identity from the
 * durable input identity, then runs the incumbent lifecycle: draft admission
 * against the declaration, `prepareForSend`, prepared admission and finally
 * `admitSessionStructuredInputV1`. Dispatch later resolves the same attachment
 * through `resolveForDispatch`, and the transcript replays the bounded
 * presentation this envelope persists.
 */
export async function admitPluginSessionInputAttachmentsV1(params: Readonly<{
  attachments: ComposerAttachmentSendPreparationRegistryV1 | null;
  pluginId: string;
  sessionId: string;
  messageLocalId: string;
  text: string;
  authored: readonly PluginSessionInputAttachmentV1[];
  signal?: AbortSignal;
}>): Promise<PluginSessionInputAttachmentAdmissionV1> {
  if (!params.attachments) {
    return { status: 'rejected', code: 'session_input_target_unavailable' };
  }
  const drafts = buildPluginSessionInputAttachmentDraftsV1(params);
  try {
    const prepared = await prepareComposerAttachmentDraftsForSendV1({
      attachments: params.attachments,
      sessionId: params.sessionId,
      messageLocalId: params.messageLocalId,
      drafts,
      signal: params.signal ?? new AbortController().signal,
    });
    // A direct plugin send has no staged-media phase: the public author shape
    // cannot carry content. Narrow the prepared drafts through the finalized
    // owner before entering the prepared admission overload.
    const finalized = prepared.map((attachment) => ComposerAttachmentInputV1Schema.parse(attachment));
    const preparedComposerAttachments = params.attachments.admit({
      phase: 'prepared',
      attachments: finalized,
    });
    const admitted = admitSessionStructuredInputV1({
      text: params.text,
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, composerAttachments: drafts },
      },
      preparedComposerAttachments,
    });
    return {
      status: 'admitted',
      meta: admitted.meta,
      attachments: admitted.structuredInput?.composerAttachments ?? [],
    };
  } catch {
    // Every failure below is pre-persistence: an undeclared attachment, a value
    // the declaration rejects, a blocked preparation, or a staged-media claim a
    // direct send has no stage for. None of them may reach the Session writer.
    return { status: 'rejected', code: 'session_input_invalid' };
  }
}
