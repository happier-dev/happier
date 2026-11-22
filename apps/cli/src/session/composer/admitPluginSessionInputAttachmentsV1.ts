import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { ComposerAttachmentInputV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type { ActionPluginCaller, ComposerAttachmentInputV1, ComposerAttachmentDraftV1, PluginSessionInputAttachmentV1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import { admitSessionStructuredInputV1 } from '@/session/services/admitSessionStructuredInputV1';
import {
  prepareComposerAttachmentDraftsForSendV1,
  type ComposerAttachmentSendPreparationRegistryV1,
} from './prepareComposerAttachmentDraftsForSendV1';

import { rejectUnavailableSessionInputV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

export type PluginSessionInputAttachmentAdmissionV1 =
  | Readonly<{
    status: 'admitted';
    meta: Record<string, unknown>;
    attachments: readonly ComposerAttachmentInputV1[];
  }>
  | Readonly<{ status: 'rejected'; code: 'session_input_invalid' }>
  | ReturnType<typeof rejectUnavailableSessionInputV1>;

/**
 * Builds the canonical draft envelope for a plugin-authored Session input.
 *
 * This declaration-only half is also used by the daemon's pending-first-input handoff:
 * that handoff must be serializable before the child knows its Session id,
 * while the child's existing input transformer still owns value admission,
 * prepareForSend and final admission once the real Session is mounted. Caller
 * provenance is host-private and never comes from the authored attachments.
 */
export function buildPluginSessionInputAttachmentDraftsV1(params: Readonly<{
  caller: ActionPluginCaller;
  attachments: Pick<ComposerAttachmentSendPreparationRegistryV1, 'isDeclared'> | null;
  messageLocalId: string;
  authored: readonly PluginSessionInputAttachmentV1[];
}>): readonly ComposerAttachmentDraftV1[] {
  if (!params.attachments) {
    throw new PluginError({ code: 'session_input_target_unavailable', message: 'Attachment declarations are unavailable' });
  }
  const declarations = params.attachments;
  const initiatingCaller = params.caller.initiatingCaller;
  return params.authored.map((authored, index) => {
    const ownAttachment = { pluginId: params.caller.pluginId, localId: authored.attachmentLocalId };
    const delegatedAttachment = initiatingCaller?.kind === 'plugin'
      ? { pluginId: initiatingCaller.pluginId, localId: authored.attachmentLocalId }
      : null;
    const attachment = declarations.isDeclared(ownAttachment)
      ? ownAttachment
      : delegatedAttachment && declarations.isDeclared(delegatedAttachment) ? delegatedAttachment : null;
    if (!attachment) {
      throw new PluginError({ code: 'session_input_invalid', message: 'Attachment is not declared by the sender or its immediate plugin caller' });
    }
    return {
      v: 1,
      instanceId: `${params.messageLocalId}#${index}`,
      attachment,
      key: authored.value.key,
      value: authored.value.value,
      presentation: {
        ...authored.value.presentation,
        typeLabel: authored.value.presentation.label,
      },
    };
  });
}

/**
 * Turns the attachment drafts a plugin declared on `SessionHandle.send` into
 * the one canonical structured-input envelope a Message may carry.
 *
 * The plugin authors only the half the Composer's `attachment.add` authors —
 * an attachment's local id, key, value and presentation. This host owner
 * qualifies the declaring plugin through the host-stamped caller (own-first,
 * then the immediate initiating plugin only), derives an instance identity from the
 * durable input identity, then runs the incumbent lifecycle: draft admission
 * against the declaration, `prepareForSend`, prepared admission and finally
 * `admitSessionStructuredInputV1`. Dispatch later resolves the same attachment
 * through `resolveForDispatch`, and the transcript replays the bounded
 * presentation this envelope persists.
 */
export async function admitPluginSessionInputAttachmentsV1(params: Readonly<{
  attachments: ComposerAttachmentSendPreparationRegistryV1 | null;
  caller: ActionPluginCaller;
  sessionId: string;
  messageLocalId: string;
  text: string;
  authored: readonly PluginSessionInputAttachmentV1[];
  signal?: AbortSignal;
}>): Promise<PluginSessionInputAttachmentAdmissionV1> {
  if (!params.attachments) {
    return rejectUnavailableSessionInputV1('session.message.attachment_registry');
  }
  try {
    const drafts = buildPluginSessionInputAttachmentDraftsV1(params);
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
