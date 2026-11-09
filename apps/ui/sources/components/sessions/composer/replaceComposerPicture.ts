import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { Image } from 'react-native';
import { isEmptyEdit, type ImageMarksDocumentV1, type ImageMarksOperationV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { MediaAnnotationApplyResultV1Schema } from '@happier-dev/protocol/actions/mediaAnnotationAction';
import { encodeBase64 } from '@/encryption/base64';
import { flattenAnnotatedImage } from '@/components/ui/media/annotation/flattenImage';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/annotatorStore';
import type { FlattenImageResult } from '@/components/ui/media/annotation/flattenImage.types';
import type { StagePictureEdit, StagePictureCommitResult } from '@/components/ui/media/stage/mediaStageItems';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';

export type ComposerPictureOccurrence = Readonly<{
  kind: 'picked'; attachmentId: string;
  getDraftsSnapshot: () => readonly AttachmentDraft[];
  replaceDrafts: (drafts: readonly AttachmentDraft[]) => void;
}>;
export function readComposerPicture(occurrence: ComposerPictureOccurrence): AttachmentDraft | null {
  return occurrence.getDraftsSnapshot().find(draft => draft.id === occurrence.attachmentId) ?? null;
}
export function replaceComposerPicture(occurrence: ComposerPictureOccurrence, replacement: Readonly<{ source: AttachmentUploadSource; edit?: AttachmentDraft['edit'] }>): boolean {
  const drafts = occurrence.getDraftsSnapshot();
  if (!drafts.some(draft => draft.id === occurrence.attachmentId)) return false;
  occurrence.replaceDrafts(drafts.map(draft => draft.id === occurrence.attachmentId
    ? { id: draft.id, source: replacement.source, status: 'pending', ...(replacement.edit ? { edit: replacement.edit } : {}),
      ...(draft.browserAnnotation ? { browserAnnotation: draft.browserAnnotation } : {}) }
    : draft));
  return true;
}

/** The edit record's original is the only source of a reopened editor or headless apply. */
export async function readComposerPictureSource(occurrence: ComposerPictureOccurrence | Readonly<{
  kind: 'preview'; source: Readonly<{ uri: string; width?: number; height?: number; scale?: number }>;
}>): Promise<ImageAnnotationSource | null> {
  // P2 A1: one logical stroke scale for preview, headless apply and burned pixels.
  // Explicit scales (capture metadata or a reopened edit) keep their original meaning.
  const resolve = (source: Omit<ImageAnnotationSource, 'scale'> & Readonly<{ scale?: number }>): ImageAnnotationSource => ({
    ...source, scale: source.scale ?? Math.max(1, Math.max(source.width, source.height) / 1440),
  });
  const readSize = (uri: string) => new Promise<Readonly<{ width: number; height: number }>>((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
  if (occurrence.kind === 'preview') {
    try {
      const { source } = occurrence;
      const size = source.width !== undefined && source.height !== undefined
        ? { width: source.width, height: source.height } : await readSize(source.uri);
      return resolve({ ...source, ...size });
    } catch { return null; }
  }
  const draft = readComposerPicture(occurrence);
  if (!draft) return null;
  const source = draft.edit?.original ?? draft.source;
  if (source.kind === 'folder') return null;
  try {
    const uri = source.kind === 'native' ? source.uri : source.kind === 'memory'
      ? source.previewUri ?? `data:${source.mimeType ?? 'image/png'};base64,${encodeBase64(source.bytes)}`
      : `data:${source.file.type || 'image/png'};base64,${encodeBase64(new Uint8Array(await source.file.arrayBuffer()))}`;
    if (draft.edit) return resolve({ uri, ...draft.edit.document.image });
    // The callback form is shared by native and the web Image adapter.
    const size = await readSize(uri);
    return resolve({ uri, width: size.width, height: size.height });
  } catch { return null; }
}

export type CommitComposerPictureResult = Readonly<{ ok: true; status: 'replaced' | 'reverted' }>
  | Extract<FlattenImageResult, { ok: false }>
  | Readonly<{ ok: false; reason: 'annotation.targetUnavailable' }>;

/** Both UI Done and media.annotation.apply call this exact transaction. */
export async function commitComposerPicture(occurrence: ComposerPictureOccurrence, document: ImageMarksDocumentV1, source: ImageAnnotationSource): Promise<CommitComposerPictureResult> {
  const draft = readComposerPicture(occurrence);
  if (!draft) return { ok: false, reason: 'annotation.targetUnavailable' };
  const original = draft.edit?.original ?? draft.source;
  if (isEmptyEdit(document) && !draft.edit) return { ok: true, status: 'reverted' };
  if (isEmptyEdit(document)) return replaceComposerPicture(occurrence, { source: original })
    ? { ok: true, status: 'reverted' } : { ok: false, reason: 'annotation.targetUnavailable' };
  const result = await flattenAnnotatedImage(source, document);
  if (!result.ok) return result;
  const name = original.kind === 'web' ? original.file.name : original.name;
  const bytes = result.png;
  return replaceComposerPicture(occurrence, { source: { kind: 'memory', name: `${name.replace(/\.[^.]+$/, '')}.png`, mimeType: 'image/png', bytes, previewUri: `data:image/png;base64,${encodeBase64(bytes)}` }, edit: { original, document } })
    ? { ok: true, status: 'replaced' } : { ok: false, reason: 'annotation.targetUnavailable' };
}

export function composerPictureStageEdit(occurrence: ComposerPictureOccurrence, readAddress?: () => Readonly<{ scope: ServerAccountScope; ref: ComposerRefV1 }> | null): StagePictureEdit {
  const draft = readComposerPicture(occurrence);
  const execute = async (document?: ImageMarksDocumentV1): Promise<StagePictureCommitResult> => {
    const address = readAddress?.();
    if (!address) return { ok: false, reason: 'annotation.targetUnavailable' };
    // The Action owns admission and resolves the mounted occurrence; this leaf retains no authority.
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const operations: ImageMarksOperationV1[] = document ? [
      { kind: 'reset' }, ...document.marks.map(mark => ({ kind: 'mark.add' as const, mark })),
      ...(document.crop ? [{ kind: 'crop.set' as const, rect: document.crop }] : []),
    ] : [];
    const outcome = await createDefaultActionExecutor().execute('media.annotation.apply', {
      scope: address.scope, target: { kind: 'composerAttachment', ref: address.ref, attachmentId: occurrence.attachmentId },
      ...(document ? { operations } : { reset: true }),
    }, { surface: 'ui', authority: 'present_user', serverId: address.scope.serverId, expectedAccountId: address.scope.accountId });
    if (!outcome.ok) return { ok: false, reason: outcome.errorCode };
    const result = MediaAnnotationApplyResultV1Schema.parse(outcome.result);
    if (result.status === 'unavailable') return { ok: false, reason: result.reason };
    return result.status === 'appended' ? { ok: false, reason: 'annotation.targetUnavailable' } : { ok: true, status: result.status };
  };
  return {
    document: draft?.edit?.document,
    original: () => readComposerPictureSource(occurrence),
    commit: ({ document }) => execute(document),
    revert: () => execute(),
  };
}
