export type NativePickedFile = Readonly<{
    kind: 'native';
    uri: string;
    name: string;
    sizeBytes: number | null;
    mimeType: string | null;
}>;

function sanitizePickedName(raw: unknown): string {
    const value = typeof raw === 'string' ? raw : '';
    const trimmed = value.trim();
    if (!trimmed) return 'file';
    const base = trimmed.split(/[/\\]/g).pop() ?? 'file';
    return base.trim() || 'file';
}

export async function nativePickFiles(params?: Readonly<{ multiple?: boolean }>): Promise<NativePickedFile[]> {
    const multiple = params?.multiple !== false;
    const DocumentPicker: any = await import('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({
        multiple,
        type: '*/*',
    });
    if (!result || result.canceled) return [];

    const assets = Array.isArray(result.assets) ? result.assets : [];
    const mapped: NativePickedFile[] = assets
        .map((asset: any) => ({
            kind: 'native' as const,
            uri: typeof asset?.uri === 'string' ? asset.uri : '',
            name: sanitizePickedName(asset?.name),
            sizeBytes: typeof asset?.size === 'number' ? asset.size : null,
            mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
        }))
        .filter((entry: NativePickedFile) => entry.uri.length > 0);

    return mapped;
}
