import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { StoredAttachmentPayloadV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';

import {
  AttachmentsInlineImages,
  type InlineImageAttachmentSummary,
} from '@/components/sessions/attachments/messages/AttachmentsInlineImages';
import {
  AttachmentsMessageRow,
  type MessageAttachmentSummary,
} from '@/components/sessions/attachments/messages/AttachmentsMessageRow';
import type { SessionMediaInlinePreviewSource } from '@/components/sessions/media/SessionMediaInlineImages';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useDiscussionAttachmentResources } from '@/sync/ops/discussions/discussionAttachmentPreview';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';

import { discussionFailureLabel } from './discussionFailureLabel';
import { readDiscussionAttachmentImageNumbers } from './discussionTimelineProjection';

/** The Discussion's exact attachment read, bound once per thread. */
export type DiscussionAttachmentReader = Readonly<{
  repository: DiscussionRepository;
  client: Pick<ReturnType<typeof createDiscussionClient>, 'readAttachment'>;
  discussionId: string;
}>;

const FOLDER_MIME = 'inode/directory';
const STAGE_KINDS = new Set(['image', 'svg', 'video', 'pdf']);

const styles = StyleSheet.create((theme) => ({
  failure: {
    ...Typography.variant('meta'),
    color: theme.colors.text.destructive,
  },
}));

type FileTarget = Readonly<{
  attachmentId: string;
  blobId: string;
  name: string;
  mime: string;
  sizeBytes: number;
}>;

/** A file the Session transcript draws as an inline picture (the rest are attachment chips). */
function isPicture(attachment: StoredAttachmentPayloadV1): boolean {
  return (
    attachment.kind === 'file' &&
    resolveSessionMediaInlineRenderableImageMimeType({
      mimeType: attachment.file.mime,
      path: attachment.name,
    }) !== null
  );
}

/**
 * A message's files in the Session's own presentation: pictures as the transcript's inline tiles (opening
 * the media stage), every other file and folder as the attachment chips. Bytes come only from this
 * Discussion's exact read, on demand; a folder opens into its files in place.
 */
export const DiscussionMessageAttachments = React.memo(
  function DiscussionMessageAttachments(
    props: Readonly<{
      reader: DiscussionAttachmentReader;
      messageId: string;
      attachments: readonly StoredAttachmentPayloadV1[];
      removedAttachments?: DiscussionOpenedMessageV1['removedAttachments'];
    }>,
  ) {
    const resources = useDiscussionAttachmentResources({
      ...props.reader,
      messageId: props.messageId,
      attachments: props.attachments,
    });
    const stage = useMediaStage();
    const [openFolders, setOpenFolders] = React.useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [failure, setFailure] = React.useState<string | null>(null);
    const removedBlobIds = React.useMemo(
      () => props.removedAttachments && new Set(props.removedAttachments.map(({ blobId }) => blobId)),
      [props.removedAttachments],
    );

    const pictures = React.useMemo<InlineImageAttachmentSummary[]>(
      () =>
        props.attachments.flatMap((attachment) =>
          attachment.kind === 'file' && !removedBlobIds?.has(attachment.file.blobId) && isPicture(attachment)
            ? [{
              name: attachment.name,
              path: attachment.id,
              mimeType: attachment.file.mime,
              sizeBytes: attachment.file.sizeBytes,
              sha256: attachment.file.sha256,
            }]
            : []),
      [props.attachments, removedBlobIds],
    );
    // The same Image #N the inline chips carry, on each picture's corner (as a Session draws them).
    const imageNumbers = React.useMemo(() => readDiscussionAttachmentImageNumbers(props.attachments), [props.attachments]);
    const previewSource = React.useCallback<SessionMediaInlinePreviewSource>(
      (media) => {
        const resource = resources.get(media.path);
        // Every tile is one of this message's own file attachments (its id is the blob id).
        if (!resource)
          throw new Error(
            'Discussion attachment tile without its message attachment',
          );
        return resource.previewFile(media.path, media.name, true);
      },
      [resources],
    );

    // Chips: other files and folders; an opened folder lists its files after it.
    const { chips, files } = React.useMemo(() => {
      const chips: MessageAttachmentSummary[] = [];
      const files = new Map<string, FileTarget>();
      for (const attachment of props.attachments) {
        if (attachment.kind === 'file') {
          const removed = removedBlobIds?.has(attachment.file.blobId);
          if (!removed && isPicture(attachment)) continue;
          chips.push({
            name: attachment.name,
            path: attachment.id,
            mimeType: attachment.file.mime,
            sizeBytes: attachment.file.sizeBytes,
            removed,
          });
          if (removed) continue;
          files.set(attachment.id, {
            attachmentId: attachment.id,
            blobId: attachment.file.blobId,
            name: attachment.name,
            mime: attachment.file.mime,
            sizeBytes: attachment.file.sizeBytes,
          });
          continue;
        }
        chips.push({
          name: attachment.name,
          path: attachment.id,
          mimeType: FOLDER_MIME,
          sizeBytes: attachment.entries.reduce(
            (total, entry) => total + (removedBlobIds?.has(entry.file.blobId) ? 0 : entry.file.sizeBytes),
            0,
          ),
        });
        if (!openFolders.has(attachment.id)) continue;
        for (const entry of attachment.entries) {
          const path = `${attachment.id}/${entry.relativePath}`;
          const removed = removedBlobIds?.has(entry.file.blobId);
          chips.push({
            name: `${attachment.name}/${entry.relativePath}`,
            path,
            mimeType: entry.file.mime,
            sizeBytes: entry.file.sizeBytes,
            removed,
          });
          if (removed) continue;
          files.set(path, {
            attachmentId: attachment.id,
            blobId: entry.file.blobId,
            name: entry.relativePath.split('/').pop() ?? entry.relativePath,
            mime: entry.file.mime,
            sizeBytes: entry.file.sizeBytes,
          });
        }
      }
      return { chips, files };
    }, [openFolders, props.attachments, removedBlobIds]);

    const download = React.useCallback(
      async (target: FileTarget) => {
        const resource = resources.get(target.attachmentId);
        if (!resource) return;
        setFailure(null);
        const controller = new AbortController();
        try {
          const bytes = await resource.readFile(
            target.blobId,
            controller.signal,
          );
          await saveFileBytes({
            bytes,
            fileName: target.name,
            mimeType: target.mime,
            isCurrent: () => resource.lifetime.isCurrent(),
          });
        } catch (error) {
          const code =
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : 'discussion_content_unavailable';
          setFailure(`${target.name}: ${discussionFailureLabel(code)}`);
        }
      },
      [resources],
    );

    const open = React.useCallback(
      (path: string) => {
        const target = files.get(path);
        if (!target) {
          // A folder chip: show or hide its files.
          setOpenFolders((current) => {
            const next = new Set(current);
            if (!next.delete(path)) next.add(path);
            return next;
          });
          return;
        }
        const resource = resources.get(target.attachmentId);
        const viewer = resolveFileViewerKind({
          path: target.name,
          mimeType: target.mime,
        });
        if (resource && STAGE_KINDS.has(viewer.kind)) {
          stage.open([
            {
              kind:
                viewer.kind === 'svg'
                  ? 'svg'
                  : viewer.kind === 'video'
                    ? 'video'
                    : viewer.kind === 'pdf'
                      ? 'pdf'
                      : 'image',
              title: target.name,
              source: resource.previewFile(target.blobId, target.name, true),
              sizeBytes: target.sizeBytes,
              openFile: () => {
                void download(target);
              },
            },
          ]);
          return;
        }
        void download(target);
      },
      [download, files, resources, stage],
    );

    return (
      <>
        {pictures.length > 0 ? (
          <AttachmentsInlineImages
            previewSource={previewSource}
            attachments={pictures}
            numbers={imageNumbers}
            onOpenPath={open}
            fileOpenEnabled
            mediaPreviewEnabled
          />
        ) : null}
        {chips.length > 0 ? (
          <AttachmentsMessageRow attachments={chips} onOpenPath={open} />
        ) : null}
        {failure ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={styles.failure}
            testID={`session-discussion-attachment-failure-${props.messageId}`}
          >
            {failure}
          </Text>
        ) : null}
      </>
    );
  },
);
