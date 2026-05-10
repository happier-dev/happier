import { describe, expect, it, vi } from 'vitest';

const getImageAsyncSpy = vi.fn();

vi.mock('expo-clipboard', () => ({
    getImageAsync: (...args: unknown[]) => getImageAsyncSpy(...args),
}));

describe('nativeClipboardImageAttachment', () => {
    it('converts a clipboard PNG data URI into an in-memory attachment source', async () => {
        getImageAsyncSpy.mockResolvedValue({
            data: 'data:image/png;base64,AQID',
        });

        const { nativeReadClipboardImageAttachment } = await import('./nativeClipboardImageAttachment');

        await expect(nativeReadClipboardImageAttachment({
            now: new Date('2026-05-10T09:40:00.000Z'),
        })).resolves.toEqual([{
            kind: 'memory',
            name: 'pasted-image-20260510-094000.png',
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            previewUri: 'data:image/png;base64,AQID',
        }]);
        expect(getImageAsyncSpy).toHaveBeenCalledWith({ format: 'png' });
    });

    it('returns no attachments when the clipboard does not contain an image', async () => {
        getImageAsyncSpy.mockResolvedValue(null);

        const { nativeReadClipboardImageAttachment } = await import('./nativeClipboardImageAttachment');

        await expect(nativeReadClipboardImageAttachment()).resolves.toEqual([]);
    });
});
