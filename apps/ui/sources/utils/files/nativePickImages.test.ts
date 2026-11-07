import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeImagePickerModule = vi.hoisted(() => ({
    current: { launchImageLibraryAsync: () => undefined } as unknown,
}));

vi.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: vi.fn(async () => ({ canceled: true })),
    launchCameraAsync: vi.fn(async () => ({ canceled: true })),
    requestCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
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
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
        vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });
        vi.mocked(ImagePicker.launchCameraAsync).mockReset();
        vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({ canceled: true, assets: null });
        vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockReset();
        vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
            granted: true,
            status: 'granted' as never,
            canAskAgain: true,
            expires: 'never',
        });
    });

    it('returns web File sources when expo-image-picker provides `asset.file`', async () => {
        const ImagePicker = await import('expo-image-picker');
        const file = new File([new Uint8Array([7, 8, 9])], 'photo.png', { type: 'image/png' });

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
        expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    });

    it('takes a photo with the device camera and returns it as a native attachment source', async () => {
        const ImagePicker = await import('expo-image-picker');
        vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValueOnce({
            canceled: false,
            assets: [
                {
                    uri: 'file:///camera/photo-1.jpg',
                    fileName: 'photo-1.jpg',
                    fileSize: 1234,
                    width: 100,
                    height: 100,
                    mimeType: 'image/jpeg',
                },
            ],
        });

        const { nativeTakePhoto } = await import('./nativePickImages');
        const result = await nativeTakePhoto();

        expect(result).toEqual({
            status: 'captured',
            files: [{ kind: 'native', uri: 'file:///camera/photo-1.jpg', name: 'photo-1.jpg', sizeBytes: 1234, mimeType: 'image/jpeg' }],
        });
    });

    it('does not open the camera when camera permission is denied', async () => {
        const ImagePicker = await import('expo-image-picker');
        vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValueOnce({
            granted: false,
            status: 'denied' as never,
            canAskAgain: false,
            expires: 'never',
        });

        const { nativeTakePhoto } = await import('./nativePickImages');
        const result = await nativeTakePhoto();

        expect(result).toEqual({ status: 'permissionDenied' });
        expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    });

    it('returns cancelled when the user dismisses the camera', async () => {
        const { nativeTakePhoto } = await import('./nativePickImages');
        const result = await nativeTakePhoto();

        expect(result).toEqual({ status: 'cancelled' });
    });
});
