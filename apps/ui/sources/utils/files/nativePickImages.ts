import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

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

function sanitizePickedNameFromAsset(asset: unknown): string {
    const anyAsset = asset as any;
    return sanitizePickedName(anyAsset?.fileName ?? anyAsset?.name ?? anyAsset?.uri, 'image');
}

function mapPickedImageAssets(assets: unknown): NativePickedFile[] {
    const list = Array.isArray(assets) ? assets : [];
    return list
        .map((asset: any): NativePickedFile => {
            const file = asset?.file;
            if (isBrowserFile(file)) {
                return { kind: 'web' as const, file };
            }

            return {
                kind: 'native' as const,
                uri: typeof asset?.uri === 'string' ? asset.uri : '',
                name: sanitizePickedNameFromAsset(asset),
                sizeBytes: typeof asset?.fileSize === 'number' ? asset.fileSize : null,
                mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
            };
        })
        .filter((entry: NativePickedFile) => entry.kind === 'web' || entry.uri.length > 0);
}

export async function nativePickImages(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
    if (!isImagePickerNativeModuleAvailable()) return [];

    const ImagePicker: any = await import('expo-image-picker');
    const launchImageLibraryAsync: any =
        ImagePicker.launchImageLibraryAsync
        ?? ImagePicker.default?.launchImageLibraryAsync
        ?? null;
    const mediaTypeImages: any =
        ImagePicker.MediaTypeOptions?.Images
        ?? ImagePicker.default?.MediaTypeOptions?.Images
        ?? 'images';
    if (typeof launchImageLibraryAsync !== 'function') return [];

    const result = await launchImageLibraryAsync({
        mediaTypes: mediaTypeImages,
        allowsMultipleSelection: multiple,
        quality: 1,
    });
    if (!result || result.canceled) return [];

    return mapPickedImageAssets(result.assets);
}

export type NativeTakePhotoResult =
    | Readonly<{ status: 'captured'; files: NativePickedFile[] }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'permissionDenied' }>;

/**
 * Captures one photo with the device camera through the same expo-image-picker module used for
 * library picks, so camera photos flow into attachments exactly like picked images.
 */
export async function nativeTakePhoto(): Promise<NativeTakePhotoResult> {
    if (!isImagePickerNativeModuleAvailable()) return { status: 'cancelled' };

    const ImagePicker: any = await import('expo-image-picker');
    const launchCameraAsync: any = ImagePicker.launchCameraAsync ?? ImagePicker.default?.launchCameraAsync ?? null;
    const requestCameraPermissionsAsync: any =
        ImagePicker.requestCameraPermissionsAsync
        ?? ImagePicker.default?.requestCameraPermissionsAsync
        ?? null;
    const mediaTypeImages: any =
        ImagePicker.MediaTypeOptions?.Images
        ?? ImagePicker.default?.MediaTypeOptions?.Images
        ?? 'images';
    if (typeof launchCameraAsync !== 'function') return { status: 'cancelled' };

    if (typeof requestCameraPermissionsAsync === 'function') {
        const permission = await requestCameraPermissionsAsync();
        if (!permission?.granted) return { status: 'permissionDenied' };
    }

    const result = await launchCameraAsync({ mediaTypes: mediaTypeImages, quality: 1 });
    if (!result || result.canceled) return { status: 'cancelled' };

    const files = mapPickedImageAssets(result.assets);
    return files.length > 0 ? { status: 'captured', files } : { status: 'cancelled' };
}
