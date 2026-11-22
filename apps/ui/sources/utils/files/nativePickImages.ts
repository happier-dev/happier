import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';

import type { NativePickedFile } from './nativePickFiles';
import { isBrowserFile, sanitizePickedName } from './pickedFileNormalization';

type ImagePickerNativeModule = Readonly<{
    launchImageLibraryAsync?: unknown;
}>;

function isImagePickerNativeModuleAvailable(): boolean {
    if (Platform.OS === 'web') return true;
    const nativeModule = requireOptionalNativeModule<ImagePickerNativeModule>('ExponentImagePicker');
    return typeof nativeModule?.launchImageLibraryAsync === 'function';
}

type PickedImageAsset = ImagePickerAsset & Readonly<{ name?: unknown }>;
type ImagePickerModule = typeof import('expo-image-picker');

type ImportedImagePicker = ImagePickerModule & { default?: Partial<ImagePickerModule> };

function imageMediaTypes(module: ImportedImagePicker) {
    return module.MediaTypeOptions?.Images ?? module.default?.MediaTypeOptions?.Images ?? ['images' as const];
}

function mapPickedImageAssets(assets: readonly PickedImageAsset[] | null): NativePickedFile[] {
    return (assets ?? [])
        .map((asset): NativePickedFile => {
            const file = asset?.file;
            if (isBrowserFile(file)) {
                return { kind: 'web' as const, file };
            }

            return {
                kind: 'native' as const,
                uri: typeof asset?.uri === 'string' ? asset.uri : '',
                name: sanitizePickedName(asset?.fileName ?? asset?.name ?? asset?.uri, 'image'),
                sizeBytes: typeof asset?.fileSize === 'number' ? asset.fileSize : null,
                mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
            };
        })
        .filter((entry: NativePickedFile) => entry.kind === 'web' || entry.uri.length > 0);
}

export async function nativePickImages(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
    if (!isImagePickerNativeModuleAvailable()) return [];

    const picker: ImportedImagePicker = await import('expo-image-picker');
    const launchImageLibraryAsync = picker.launchImageLibraryAsync ?? picker.default?.launchImageLibraryAsync;
    if (typeof launchImageLibraryAsync !== 'function') return [];

    const result = await launchImageLibraryAsync({
        mediaTypes: imageMediaTypes(picker),
        allowsMultipleSelection: multiple,
        quality: 1,
    });
    if (!result || result.canceled) return [];

    return mapPickedImageAssets(result.assets);
}

type NativeTakePhotoResult =
    | Readonly<{ status: 'captured'; files: NativePickedFile[] }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'permissionDenied' }>;

/**
 * Captures one photo with the device camera through the same expo-image-picker module used for
 * library picks, so camera photos flow into attachments exactly like picked images.
 */
export async function nativeTakePhoto(): Promise<NativeTakePhotoResult> {
    if (!isImagePickerNativeModuleAvailable()) return { status: 'cancelled' };

    const picker: ImportedImagePicker = await import('expo-image-picker');
    const launchCameraAsync = picker.launchCameraAsync ?? picker.default?.launchCameraAsync;
    const requestCameraPermissionsAsync = picker.requestCameraPermissionsAsync ?? picker.default?.requestCameraPermissionsAsync;
    if (typeof launchCameraAsync !== 'function') return { status: 'cancelled' };

    if (typeof requestCameraPermissionsAsync === 'function') {
        const permission = await requestCameraPermissionsAsync();
        if (!permission?.granted) return { status: 'permissionDenied' };
    }

    const result = await launchCameraAsync({ mediaTypes: imageMediaTypes(picker), quality: 1 });
    if (!result || result.canceled) return { status: 'cancelled' };

    const files = mapPickedImageAssets(result.assets);
    return files.length > 0 ? { status: 'captured', files } : { status: 'cancelled' };
}
