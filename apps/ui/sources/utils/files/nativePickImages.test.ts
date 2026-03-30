import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: vi.fn(async () => ({ canceled: true })),
    MediaTypeOptions: { Images: 'images' },
}));

describe('nativePickImages', () => {
    it('returns web File sources when expo-image-picker provides `asset.file`', async () => {
        const ImagePicker = await import('expo-image-picker');
        const file = new File([new Uint8Array([7, 8, 9])], 'photo.png', { type: 'image/png' });

        (ImagePicker.launchImageLibraryAsync as any).mockResolvedValueOnce({
            canceled: false,
            assets: [
                {
                    uri: 'blob://fake',
                    fileName: 'photo.png',
                    fileSize: file.size,
                    mimeType: 'image/png',
                    file,
                },
            ],
        });

        const { nativePickImages } = await import('./nativePickImages');
        const picked = await nativePickImages({ multiple: false });

        expect(picked).toEqual([{ kind: 'web', file }]);
    });
});
