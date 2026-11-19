import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { NativePickedFile } from './nativePickFiles';
import { isBrowserFile, sanitizePickedName } from './pickedFileNormalization';

type ImagePickerNativeModule = Readonly<{
    launchImageLibraryAsync?: unknown;
    launchCameraAsync?: unknown;
}>;

function isImagePickerNativeModuleAvailable(camera: boolean): boolean {
    if (Platform.OS === 'web') return !camera;
    const nativeModule = requireOptionalNativeModule<ImagePickerNativeModule>('ExponentImagePicker');
    return typeof (camera ? nativeModule?.launchCameraAsync : nativeModule?.launchImageLibraryAsync) === 'function';
}

function sanitizePickedNameFromAsset(asset: unknown): string {
    const anyAsset = asset as any;
    return sanitizePickedName(anyAsset?.fileName ?? anyAsset?.name ?? anyAsset?.uri, 'image');
}

export async function nativePickImages(params?: Readonly<{
    multiple?: boolean;
    source?: 'camera';
    onPermissionDenied?: () => void;
}>): Promise<NativePickedFile[]> {
    const camera = params?.source === 'camera';
    const multiple = !camera && params?.multiple !== false;
    if (!isImagePickerNativeModuleAvailable(camera)) return [];

    const ImagePicker = await import('expo-image-picker');
    if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
            params?.onPermissionDenied?.();
            return [];
        }
        return mapPickedImages(await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 }));
    }

    const libraryFallback = 'default' in ImagePicker ? (ImagePicker.default as Partial<typeof ImagePicker>) : undefined;
    const requestMediaLibraryPermissionsAsync = ImagePicker.requestMediaLibraryPermissionsAsync
        ?? libraryFallback?.requestMediaLibraryPermissionsAsync;
    const launchImageLibraryAsync = ImagePicker.launchImageLibraryAsync ?? libraryFallback?.launchImageLibraryAsync;
    const mediaTypeImages = ImagePicker.MediaTypeOptions?.Images ?? libraryFallback?.MediaTypeOptions?.Images ?? 'images';
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
        // Photos can preserve HEIC originals that our native image decoder cannot
        // open. Let the platform supply a compatible representation at acquisition.
        preferredAssetRepresentationMode: 'compatible' as import('expo-image-picker').UIImagePickerPreferredAssetRepresentationMode,
    });
    return mapPickedImages(result);
}

function mapPickedImages(result: Awaited<ReturnType<typeof import('expo-image-picker')['launchCameraAsync']>>): NativePickedFile[] {
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
