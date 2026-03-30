import { describe, expect, it, vi } from 'vitest';

import type { AttachmentFilePickerHandle } from './AttachmentFilePicker.types';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from './attachmentFilePickerActions';

describe('attachmentFilePickerActions', () => {
    it('opens files using openFiles() when available (does not fall back to open())', () => {
        const openFiles = vi.fn(() => undefined);
        const open = vi.fn(() => undefined);
        const handle: Partial<AttachmentFilePickerHandle> = { openFiles, open };

        openAttachmentFilePickerFiles(handle as AttachmentFilePickerHandle);

        expect(openFiles).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
    });

    it('opens files using open() when openFiles() is not available', () => {
        const open = vi.fn(() => undefined);
        const handle: Partial<AttachmentFilePickerHandle> = { open };

        openAttachmentFilePickerFiles(handle as AttachmentFilePickerHandle);

        expect(open).toHaveBeenCalledTimes(1);
    });

    it('opens images using openImages() when available (does not fall back to openFiles/open)', () => {
        const openImages = vi.fn(() => undefined);
        const openFiles = vi.fn(() => undefined);
        const open = vi.fn(() => undefined);
        const handle: Partial<AttachmentFilePickerHandle> = { openImages, openFiles, open };

        openAttachmentFilePickerImages(handle as AttachmentFilePickerHandle);

        expect(openImages).toHaveBeenCalledTimes(1);
        expect(openFiles).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });

    it('opens images using openFiles() when openImages() is not available', () => {
        const openFiles = vi.fn(() => undefined);
        const open = vi.fn(() => undefined);
        const handle: Partial<AttachmentFilePickerHandle> = { openFiles, open };

        openAttachmentFilePickerImages(handle as AttachmentFilePickerHandle);

        expect(openFiles).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
    });

    it('does not invoke the picker twice within the same tick (web double-open guard)', async () => {
        const openFiles = vi.fn(() => undefined);
        const handle: Partial<AttachmentFilePickerHandle> = { openFiles };

        openAttachmentFilePickerFiles(handle as AttachmentFilePickerHandle);
        openAttachmentFilePickerFiles(handle as AttachmentFilePickerHandle);

        expect(openFiles).toHaveBeenCalledTimes(1);

        await new Promise<void>((resolve) => queueMicrotask(resolve));

        openAttachmentFilePickerFiles(handle as AttachmentFilePickerHandle);
        expect(openFiles).toHaveBeenCalledTimes(2);
    });
});
