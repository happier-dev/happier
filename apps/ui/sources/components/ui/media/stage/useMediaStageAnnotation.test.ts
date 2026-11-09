import { afterEach, describe, expect, it, vi } from 'vitest';
import { Image } from 'react-native';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { useMediaStageAnnotation } from './useMediaStageAnnotation';
import { createImageAnnotator } from '../annotation/annotatorStore';
import type { MediaStageItem } from './mediaStageItems';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { commitComposerPicture, composerPictureStageEdit, type ComposerPictureOccurrence } from '@/components/sessions/composer/replaceComposerPicture';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Image: { getSize: vi.fn((_uri: string, success: (width: number, height: number) => void) => success(100, 60)) },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const picked = { kind: 'memory' as const, name: 'Picture.png', mimeType: 'image/png', bytes: new Uint8Array([1]), previewUri: 'blob:original' };

describe('media stage annotation mode', () => {
  it('does no original acquisition while viewing 50 pictures and keeps edit/discard/undo state in its owners', async () => {
    const source = { uri: 'blob:original', width: 100, height: 60, scale: 1 };
    const manager = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024, initialDrafts: [{ id: 'picture', source: picked, status: 'pending' }] }));
    const occurrence: ComposerPictureOccurrence = { kind: 'picked', attachmentId: 'picture', ...manager.getCurrent() };
    const edit = composerPictureStageEdit(occurrence);
    let index = 0;
    const item = (): MediaStageItem => ({ kind: 'image', title: `Picture ${index}`, source: { enabled: true, source: { kind: 'uri', uri: `blob:${index}` } }, edit });
    const hook = await renderHook(() => useMediaStageAnnotation(item()));
    try {
      for (index = 1; index < 50; index++) await hook.rerender();
      expect(Image.getSize).not.toHaveBeenCalled();
      expect(hook.getCurrent().session).toBeNull();
      await act(async () => hook.getCurrent().enter(source));
      expect(Image.getSize).toHaveBeenCalledTimes(1);
      const initial = hook.getCurrent().session!.initial;
      const annotator = createImageAnnotator({ source, initial });
      annotator.apply([{ kind: 'mark.add', mark: { id: 'b', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 's' } }]);
      await act(async () => hook.getCurrent().cancel(annotator.store.getState().document));
      expect(hook.getCurrent().confirmDiscard).toBe(true);
      await act(async () => hook.getCurrent().cancel(annotator.store.getState().document));
      expect(hook.getCurrent().confirmDiscard).toBe(false);
      expect(hook.getCurrent().mode).toBe('annotate');
      annotator.undo();
      await act(async () => hook.getCurrent().cancel(annotator.store.getState().document));
      expect(hook.getCurrent().mode).toBe('view');
      expect(manager.getCurrent().getDraftRevisionSnapshot()).toBe(0);
    } finally { await hook.unmount(); await manager.unmount(); }
  });
  it('keeps marks and the error when flatten refuses, then Done recovers', async () => {
    const source = { uri: 'blob:original', width: 100, height: 60, scale: 1 };
    const manager = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024, initialDrafts: [{ id: 'picture', source: picked, status: 'pending' }] }));
    const occurrence: ComposerPictureOccurrence = { kind: 'picked', attachmentId: 'picture', ...manager.getCurrent() };
    const item: MediaStageItem = { kind: 'image', title: 'Picture', source: { enabled: true, source: { kind: 'uri', uri: source.uri } }, edit: {
      ...composerPictureStageEdit(occurrence), commit: ({ source, document }) => commitComposerPicture(occurrence, document, source),
    } };
    const hook = await renderHook(() => useMediaStageAnnotation(item));
    try {
      await act(async () => hook.getCurrent().enter(source));
      const initial = hook.getCurrent().session!.initial;
      const annotator = createImageAnnotator({ source, initial });
      annotator.apply([{ kind: 'mark.add', mark: { id: 'b', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 's' } }]);
      const doc = annotator.store.getState().document;
      installImageAnnotationCanvasBoundary({ ...source, pixels: new Uint8ClampedArray(100 * 60 * 4), canvasUnavailable: true });
      await act(async () => { await hook.getCurrent().done(doc); });
      expect(hook.getCurrent().failure).toBe('canvasUnavailable');
      expect(hook.getCurrent().session!.initial).toBe(initial);
      expect(manager.getCurrent().getDraftRevisionSnapshot()).toBe(0);
      installImageAnnotationCanvasBoundary();
      await act(async () => { await hook.getCurrent().done(doc); });
      expect(hook.getCurrent().session).toBeNull();
      expect(manager.getCurrent().drafts[0]!.edit!.document).toBe(doc);
    } finally { await hook.unmount(); await manager.unmount(); }
  });
});
