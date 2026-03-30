import type { AttachmentFilePickerHandle } from './AttachmentFilePicker.types';

let hasOpenedThisTick = false;

function runOpenOncePerTick(action: () => void): void {
    if (hasOpenedThisTick) return;
    hasOpenedThisTick = true;
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
            hasOpenedThisTick = false;
        });
    } else {
        setTimeout(() => {
            hasOpenedThisTick = false;
        }, 0);
    }
    action();
}

export function openAttachmentFilePickerFiles(handle: AttachmentFilePickerHandle | null | undefined): void {
    if (!handle) return;
    if (typeof handle.openFiles === 'function') {
        runOpenOncePerTick(() => {
            handle.openFiles();
        });
        return;
    }
    if (typeof handle.open === 'function') {
        runOpenOncePerTick(() => {
            handle.open();
        });
    }
}

export function openAttachmentFilePickerImages(handle: AttachmentFilePickerHandle | null | undefined): void {
    if (!handle) return;
    if (typeof handle.openImages === 'function') {
        runOpenOncePerTick(() => {
            handle.openImages();
        });
        return;
    }
    if (typeof handle.openFiles === 'function') {
        runOpenOncePerTick(() => {
            handle.openFiles();
        });
        return;
    }
    if (typeof handle.open === 'function') {
        runOpenOncePerTick(() => {
            handle.open();
        });
    }
}
