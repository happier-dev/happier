import {
  ComposerAttachmentPrepareRequestV1Schema,
  type ComposerAttachmentDraftV1,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { createTargetComposerAttachmentRegistry } from '@/plugins/runtime/lifecycle/contributions/targetComposerAttachments';

/**
 * The exact composer-attachment surface this owner consumes. It is the shape
 * the runtime registry publishes, narrowed to the direct-send lifecycle,
 * so a caller cannot pass a look-alike that skips declaration checks or the
 * post-admission notification owner.
 */
export type ComposerAttachmentSendPreparationRegistryV1 = Pick<
  ReturnType<typeof createTargetComposerAttachmentRegistry>,
  'admit' | 'isDeclared' | 'requires' | 'supports' | 'prepareForSend' | 'afterMessageAccepted'
>;

/**
 * The one owner of "authored composer attachment drafts -> prepared drafts".
 *
 * Both Session-input producers reach the declared attachment lifecycle through
 * this function: the Runner's `transformSessionInput` operation (composer
 * authored drafts) and the plugin `SessionHandle.send` seam (plugin authored
 * drafts). Preparation is all-or-none and keeps the plugin's typed reason.
 * Durable media finalization and prepared-phase admission stay with the caller
 * that owns them, because only the composer path has a media stage.
 */
export async function prepareComposerAttachmentDraftsForSendV1(params: Readonly<{
  attachments: ComposerAttachmentSendPreparationRegistryV1;
  sessionId: string;
  messageLocalId: unknown;
  drafts: readonly ComposerAttachmentDraftV1[];
  signal: AbortSignal;
}>): Promise<readonly ComposerAttachmentDraftV1[]> {
  const admittedSelected = params.attachments.admit({
    phase: 'draft',
    attachments: params.drafts,
  });
  const groups = new Map<string, {
    attachment: PluginContributionIdentityV1;
    inputs: ComposerAttachmentDraftV1[];
  }>();
  for (const input of admittedSelected) {
    const attachment = input.attachment;
    const key = `${attachment.pluginId}\u0000${attachment.localId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        attachment: Object.freeze({
          pluginId: attachment.pluginId,
          localId: attachment.localId,
        }),
        inputs: [],
      };
      groups.set(key, group);
    }
    group.inputs.push(input);
  }
  const preparedByInstanceId = new Map<string, ComposerAttachmentDraftV1>();
  for (const group of groups.values()) {
    if (!params.attachments.isDeclared(group.attachment)) {
      throw new PluginError({
        code: 'composer_attachment_unavailable',
        message: `Composer attachment '${group.attachment.pluginId}/${group.attachment.localId}' is unavailable`,
      });
    }
    const parsedRequest = ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: params.sessionId,
      localId: params.messageLocalId,
      attachments: group.inputs.map((input) => ({
        instanceId: input.instanceId,
        key: input.key,
        value: input.value,
        ...(input.content ? { content: input.content } : {}),
      })),
    });
    if (!parsedRequest.success) {
      throw new PluginError({
        code: 'composer_attachment_request_invalid',
        message: 'Composer attachment preparation requires the canonical session and local identity',
      });
    }
    if (!params.attachments.requires({ attachment: group.attachment, phase: 'prepareForSend' })) {
      for (const input of group.inputs) {
        preparedByInstanceId.set(input.instanceId, input);
      }
      continue;
    }
    if (!await params.attachments.supports({ attachment: group.attachment, phase: 'prepareForSend' })) {
      throw new PluginError({
        code: 'composer_attachment_callback_unavailable',
        message: `Composer attachment '${group.attachment.pluginId}/${group.attachment.localId}' does not provide 'prepareForSend'`,
      });
    }
    const result = await params.attachments.prepareForSend({
      attachment: group.attachment,
      request: parsedRequest.data,
      signal: params.signal,
    });
    result.attachments.forEach((outcome, index) => {
      // Message preparation is all-or-none, like the dispatch-phase resolution
      // owner: a blocked outcome rejects the whole preparation and keeps the
      // plugin's typed reason, instead of silently admitting the remaining
      // attachments.
      if (outcome.status !== 'ready') {
        throw new PluginError({
          code: `composer_attachment_prepare_${outcome.status}`,
          retryable: outcome.retryable,
          message: outcome.message ?? `Composer attachment preparation is ${outcome.status}`,
        });
      }
      const input = group.inputs[index]!;
      preparedByInstanceId.set(
        input.instanceId,
        Object.freeze({
          ...input,
          value: outcome.value,
          ...(outcome.content ? { content: outcome.content } : {}),
          ...(outcome.presentation
            ? {
                presentation: Object.freeze({
                  ...input.presentation,
                  ...outcome.presentation,
                }),
              }
            : {}),
        }),
      );
    });
  }
  return admittedSelected.flatMap((input) => {
    const prepared = preparedByInstanceId.get(input.instanceId);
    return prepared ? [prepared] : [];
  });
}
