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

export async function nativePickImages(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
    if (!isImagePickerNativeModuleAvailable()) return [];

    const ImagePicker: any = await import('expo-image-picker');
    const requestMediaLibraryPermissionsAsync: any =
        ImagePicker.requestMediaLibraryPermissionsAsync
        ?? ImagePicker.default?.requestMediaLibraryPermissionsAsync
        ?? null;
    const launchImageLibraryAsync: any =
        ImagePicker.launchImageLibraryAsync
        ?? ImagePicker.default?.launchImageLibraryAsync
        ?? null;
    const mediaTypeImages: any =
        ImagePicker.MediaTypeOptions?.Images
        ?? ImagePicker.default?.MediaTypeOptions?.Images
        ?? 'images';
    if (typeof launchImageLibraryAsync !== 'function') return [];

    if (typeof requestMediaLibraryPermissionsAsync === 'function') {
        const permission = await requestMediaLibraryPermissionsAsync();
        if (!permission?.granted) {
            throw new Error('Photo library permission is required to pick images.');
        }
    }

    const result = await launchImageLibraryAsync({
        mediaTypes: mediaTypeImages,
        allowsMultipleSelection: multiple,
        quality: 1,
    });
    if (!result || result.canceled) return [];

    const assets = Array.isArray(result.assets) ? result.assets : [];
    const mapped: NativePickedFile[] = assets
        .map((asset: any) => {
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

    return mapped;
}
