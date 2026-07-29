export type PluginWebModuleNamespace = Readonly<{
    default?: unknown;
}> & Readonly<Record<string, unknown>>;

export type PluginWebModuleImporter = (url: string) => Promise<PluginWebModuleNamespace>;

export function decodeWebModuleSource(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return '';
    }
}

export function hasForbiddenWebModuleImport(source: string): boolean {
    return /(?:from\s*['"]@\/|import\s*\(\s*['"]@\/|from\s*['"]react(?:\/jsx-runtime|\/jsx-dev-runtime)?['"]|from\s*['"]react-native-web['"]|import\s*\(\s*['"]react(?:\/jsx-runtime|\/jsx-dev-runtime)?['"]|import\s*\(\s*['"]react-native-web['"]|apps\/ui\/sources)/u
        .test(source);
}

export async function importWebModuleFromBytesViaBlobUrl(
    bytes: Uint8Array,
    importModule: PluginWebModuleImporter,
    urlHelpers?: Readonly<{ createObjectUrl?: (blob: Blob) => string; revokeObjectUrl?: (url: string) => void }>,
): Promise<PluginWebModuleNamespace> {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined') {
        throw new Error('blob module import unavailable');
    }
    const createObjectUrl = urlHelpers?.createObjectUrl ?? URL.createObjectURL.bind(URL);
    const revokeObjectUrl = urlHelpers?.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
    const blobBytes = Uint8Array.from(bytes);
    const blobUrl = createObjectUrl(new Blob([blobBytes.buffer], { type: 'text/javascript' }));
    try {
        return await importModule(blobUrl);
    } finally {
        revokeObjectUrl(blobUrl);
    }
}
