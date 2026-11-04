import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Image } from 'react-native';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { commitComposerPicture, readComposerPictureSource, replaceComposerPicture, type ComposerPictureOccurrence } from './replaceComposerPicture';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  // The installed react-native-web Image API is callback-only (unlike native's Promise overload).
  Image: { getSize: (_uri: string, success: (width: number, height: number) => void) => success(40, 30) },
}));

describe('composer picture replacement', () => {
  it('retains the explicit capture scale when resolving an already-loaded original', async () => {
    expect(await readComposerPictureSource({ kind: 'preview', source: { uri: 'blob:capture', width: 6144, height: 3072, scale: 2 } }))
      .toEqual({ uri: 'blob:capture', width: 6144, height: 3072, scale: 2 });
  });
  it.each([[6144, 3072, 6144 / 1440], [1440, 2880, 2], [800, 600, 1]])('chooses the unknown scale at original acquisition for %s × %s', async (width, height, scale) => {
    const size = vi.spyOn(Image, 'getSize').mockImplementationOnce((_uri, success) => { success!(width, height); });
    const draft: AttachmentDraft = { id: 'picture', status: 'pending', source: { kind: 'memory', name: 'Picture.png', bytes: new Uint8Array([1]), previewUri: 'blob:original' } };
    try {
      await expect(readComposerPictureSource({ kind: 'picked', attachmentId: 'picture', getDraftsSnapshot: () => [draft], replaceDrafts: () => {} }))
        .resolves.toEqual({ uri: 'blob:original', width, height, scale });
    } finally { size.mockRestore(); }
  });
  it('resolves original dimensions through the web callback Image boundary', async () => {
    const draft: AttachmentDraft = { id: 'picture', status: 'pending', source: { kind: 'memory', name: 'Picture.png', bytes: new Uint8Array([1]), previewUri: 'blob:original' } };
    await expect(readComposerPictureSource({ kind: 'picked', attachmentId: 'picture', getDraftsSnapshot: () => [draft], replaceDrafts: () => {} }))
      .resolves.toEqual({ uri: 'blob:original', width: 40, height: 30, scale: 1 });
  });
  it('does not flatten or republish an empty edit of an unchanged uploaded picture', async () => {
    const source = { kind: 'memory' as const, bytes: new Uint8Array([1, 2, 3]), name: 'Original.png', mimeType: 'image/png' };
    const draft: AttachmentDraft = { id: 'picture', source, status: 'uploaded', uploadedPath: '/original.png' };
    const replaceDrafts = vi.fn();
    const decode = vi.fn(() => { throw new Error('Unexpected decode'); });
    vi.stubGlobal('Image', decode);
    try {
      expect(await commitComposerPicture({ kind: 'picked', attachmentId: 'picture', getDraftsSnapshot: () => [draft], replaceDrafts },
        { v: 1, image: { width: 10, height: 10, scale: 1 }, marks: [] }, { uri: 'blob:picture', width: 10, height: 10, scale: 1 })).toEqual({ ok: true, status: 'reverted' });
      expect(decode).not.toHaveBeenCalled();
      expect(replaceDrafts).not.toHaveBeenCalled();
      expect(draft.uploadedPath).toBe('/original.png');
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps attachment/chip identity and other rows while clearing every upload checkpoint, then restores exact original bytes', () => {
    const original = { kind: 'memory' as const, bytes: new Uint8Array([1, 2, 3, 4]), name: 'Original.png', mimeType: 'image/png' };
    let drafts: readonly AttachmentDraft[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), source: original, status: 'uploaded' as const, uploadedPath: '/old.png', uploadedSizeBytes: 4, uploadedMimeType: 'image/png', sha256: 'old', error: 'old', errorCode: 'old', uploadProgress: { uploadedBytes: 4, totalBytes: 4 } }));
    const previous = drafts;
    const replaceDrafts = vi.fn((next: readonly AttachmentDraft[]) => { drafts = next; });
    const occurrence: ComposerPictureOccurrence = { kind: 'picked', attachmentId: '3', getDraftsSnapshot: () => drafts, replaceDrafts };
    const document = { v: 1 as const, image: { width: 20, height: 10, scale: 1 }, marks: [{ id: 'b', kind: 'blur' as const, rect: { x: 0, y: 0, width: 10, height: 10 }, size: 's' as const }] };
    const source = { kind: 'memory' as const, bytes: new Uint8Array([9, 8, 7]), name: 'Marked.png', mimeType: 'image/png' };
    expect(replaceComposerPicture(occurrence, { source, edit: { original, document } })).toBe(true);
    expect(replaceDrafts).toHaveBeenCalledTimes(1);
    expect(drafts[3]).toEqual({ id: '3', status: 'pending', source, edit: { original, document } });
    for (let i = 0; i < 20; i++) if (i !== 3) expect(drafts[i]).toBe(previous[i]);
    expect(replaceComposerPicture(occurrence, { source: original })).toBe(true);
    expect(drafts[3]!.source).toBe(original);
    expect(createHash('sha256').update(original.bytes).digest('hex')).toBe(createHash('sha256').update((drafts[3]!.source as typeof original).bytes).digest('hex'));
    expect(drafts[3]!.edit).toBeUndefined();
  });
});
