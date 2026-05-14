import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionStatus } from 'expo-modules-core';

const grantedMediaLibraryPermission = {
    granted: true,
    status: 'granted' as PermissionStatus,
    expires: 'never' as const,
    canAskAgain: true,
};

const nativeImagePickerModule = vi.hoisted(() => ({
    current: { launchImageLibraryAsync: () => undefined } as unknown,
}));

vi.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: vi.fn(async () => ({ granted: true })),
    launchImageLibraryAsync: vi.fn(async () => ({ canceled: true })),
    MediaTypeOptions: { Images: 'images' },
}));

vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: vi.fn(() => nativeImagePickerModule.current),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
}));

describe('nativePickImages', () => {
    beforeEach(async () => {
        nativeImagePickerModule.current = { launchImageLibraryAsync: () => undefined };
        const ImagePicker = await import('expo-image-picker');
        vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockReset();
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
        vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue(grantedMediaLibraryPermission);
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });
    });

    it('requests media library permission before opening the picker', async () => {
        const ImagePicker = await import('expo-image-picker');
        vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValueOnce(grantedMediaLibraryPermission);
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({ canceled: true, assets: null });

        const { nativePickImages } = await import('./nativePickImages');
        await nativePickImages({ multiple: false });

        expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    });

    it('returns web File sources when expo-image-picker provides `asset.file`', async () => {
        const ImagePicker = await import('expo-image-picker');
        const file = new File([new Uint8Array([7, 8, 9])], 'photo.png', { type: 'image/png' });

        vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValueOnce(grantedMediaLibraryPermission);
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
            canceled: false,
            assets: [
                {
                    uri: 'blob://fake',
                    fileName: 'photo.png',
                    fileSize: file.size,
                    width: 100,
                    height: 100,
                    mimeType: 'image/png',
                    file,
                },
            ],
        });

        const { nativePickImages } = await import('./nativePickImages');
        const picked = await nativePickImages({ multiple: false });

        expect(picked).toEqual([{ kind: 'web', file }]);
    });

    it('returns no files when the native image picker module is unavailable', async () => {
        nativeImagePickerModule.current = null;
        const ImagePicker = await import('expo-image-picker');
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockRejectedValueOnce(
            new Error("Cannot find native module 'ExponentImagePicker'"),
        );

        const { nativePickImages } = await import('./nativePickImages');
        const picked = await nativePickImages({ multiple: true });

        expect(picked).toEqual([]);
        expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
        expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    });
});
