import type {
  ComposerAttachmentInputV1,
  ComposerAttachmentMessageAcceptedV1,
  ComposerAttachmentValueV1,
  PluginContributionIdentityV1,
} from '@happier-dev/protocol';

export type ComposerAttachmentMessageAcceptedNotifier = (input: Readonly<{
  attachment: PluginContributionIdentityV1;
  event: ComposerAttachmentMessageAcceptedV1<ComposerAttachmentValueV1>;
  signal: AbortSignal;
}>) => Promise<void> | void;

/** Starts the existing post-admission plugin notification without extending admission custody. */
export function notifyComposerAttachmentsAfterMessageAccepted(params: Readonly<{
  sessionId: string;
  localId: string;
  attachments: readonly ComposerAttachmentInputV1[];
  notify?: ComposerAttachmentMessageAcceptedNotifier;
  signal: AbortSignal;
}>): void {
  if (!params.notify || params.attachments.length === 0) return;

  const groups = new Map<string, {
    attachment: PluginContributionIdentityV1;
    attachments: Array<ComposerAttachmentMessageAcceptedV1<ComposerAttachmentValueV1>['attachments'][number]>;
  }>();
  for (const input of params.attachments) {
    const attachment = input.attachment;
    const groupKey = `${attachment.pluginId}\u0000${attachment.localId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        attachment: Object.freeze({
          pluginId: attachment.pluginId,
          localId: attachment.localId,
        }),
        attachments: [],
      };
      groups.set(groupKey, group);
    }
    group.attachments.push(Object.freeze({
      instanceId: input.instanceId,
      key: input.key,
      value: input.value,
    }));
  }

  for (const group of groups.values()) {
    const event: ComposerAttachmentMessageAcceptedV1<ComposerAttachmentValueV1> = Object.freeze({
      sessionId: params.sessionId,
      localId: params.localId,
      attachments: Object.freeze(group.attachments),
    });
    try {
      void Promise.resolve(params.notify({
        attachment: group.attachment,
        event,
        signal: params.signal,
      })).catch(() => undefined);
    } catch {
      // Durable admission is complete; a synchronous plugin failure cannot reverse it.
    }
  }
}
