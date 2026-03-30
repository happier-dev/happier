import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const nativePickFilesSpy = vi.hoisted(() => vi.fn<(params?: unknown) => Promise<unknown[]>>(async () => []));
const nativePickImagesSpy = vi.hoisted(() => vi.fn<(params?: unknown) => Promise<unknown[]>>(async () => []));

vi.mock('@/utils/files/nativePickFiles', () => ({
    nativePickFiles: (params?: unknown) => nativePickFilesSpy(params),
}));

vi.mock('@/utils/files/nativePickImages', () => ({
    nativePickImages: (params?: unknown) => nativePickImagesSpy(params),
}));

describe('AttachmentFilePicker', () => {
    it('exposes openFiles and openImages methods and keeps open() as a compatibility alias', async () => {
        const { AttachmentFilePicker } = await import('./AttachmentFilePicker');
        const onAttachmentsPicked = vi.fn();
        const ref = React.createRef<any>();

        await renderScreen(
            <AttachmentFilePicker
                ref={ref}
                onAttachmentsPicked={onAttachmentsPicked}
                multiple={false}
            />,
        );

        expect(typeof ref.current?.openFiles).toBe('function');
        expect(typeof ref.current?.openImages).toBe('function');
        expect(typeof ref.current?.open).toBe('function');
    });

    it('picks files via expo-document-picker when openFiles() (or open()) is used', async () => {
        const { AttachmentFilePicker } = await import('./AttachmentFilePicker');
        const onAttachmentsPicked = vi.fn();
        const ref = React.createRef<any>();

        nativePickFilesSpy.mockResolvedValueOnce([
            {
                kind: 'native',
                uri: 'file:///tmp/note.txt',
                name: 'note.txt',
                sizeBytes: 12,
                mimeType: 'text/plain',
            },
        ]);

        await renderScreen(
            <AttachmentFilePicker
                ref={ref}
                onAttachmentsPicked={onAttachmentsPicked}
                multiple={false}
            />,
        );
        await ref.current?.open?.();

        expect(nativePickFilesSpy).toHaveBeenCalled();
        expect(onAttachmentsPicked).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'native',
                uri: 'file:///tmp/note.txt',
                name: 'note.txt',
                mimeType: 'text/plain',
            }),
        ]);
    });

    it('picks images via expo-image-picker when openImages() is used', async () => {
        const { AttachmentFilePicker } = await import('./AttachmentFilePicker');
        const onAttachmentsPicked = vi.fn();
        const ref = React.createRef<any>();

        nativePickImagesSpy.mockResolvedValueOnce([
            {
                kind: 'native',
                uri: 'file:///tmp/photo.png',
                name: 'photo.png',
                sizeBytes: 123,
                mimeType: 'image/png',
            },
        ]);

        await renderScreen(
            <AttachmentFilePicker
                ref={ref}
                onAttachmentsPicked={onAttachmentsPicked}
                multiple={false}
            />,
        );
        await ref.current?.openImages?.();

        expect(nativePickImagesSpy).toHaveBeenCalled();
        expect(onAttachmentsPicked).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'native',
                uri: 'file:///tmp/photo.png',
                name: 'photo.png',
                mimeType: 'image/png',
            }),
        ]);
    });
});
