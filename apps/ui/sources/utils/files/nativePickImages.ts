import type { NativePickedFile } from './nativePickFiles';

function sanitizePickedName(raw: unknown): string {
    const value = typeof raw === 'string' ? raw : '';
    const trimmed = value.trim();
    if (!trimmed) return 'image';
    const base = trimmed.split(/[/\\]/g).pop() ?? 'image';
    return base.trim() || 'image';
}

function sanitizePickedNameFromAsset(asset: unknown): string {
    const anyAsset = asset as any;
    return sanitizePickedName(anyAsset?.fileName ?? anyAsset?.name ?? anyAsset?.uri);
}

export async function nativePickImages(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
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

    const assets = Array.isArray(result.assets) ? result.assets : [];
    const mapped: NativePickedFile[] = assets
        .map((asset: any) => ({
            kind: 'native' as const,
            uri: typeof asset?.uri === 'string' ? asset.uri : '',
            name: sanitizePickedNameFromAsset(asset),
            sizeBytes: typeof asset?.fileSize === 'number' ? asset.fileSize : null,
            mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
        }))
        .filter((entry: NativePickedFile) => entry.uri.length > 0);

    return mapped;
}

