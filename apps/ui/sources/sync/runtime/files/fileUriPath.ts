export function joinFileUri(baseUri: string, childPath: string): string {
    const base = String(baseUri ?? '').trim();
    const child = String(childPath ?? '').trim().replace(/^\/+/g, '');
    if (!base) return child;
    if (!child) return base;
    const withSlash = base.endsWith('/') ? base : `${base}/`;
    return `${withSlash}${child}`;
}

// Android/Linux cache filesystems limit each filename component to 255 UTF-8 bytes.
export const MAX_CACHE_FILE_NAME_BYTES = 255;
const filenameEncoder = new TextEncoder();

function truncateUtf8(value: string, maxBytes: number): string {
    let bytes = 0;
    let result = '';
    for (const character of value) {
        bytes += filenameEncoder.encode(character).byteLength;
        if (bytes > maxBytes) break;
        result += character;
    }
    return result;
}

export function sanitizeFileUriSegment(value: string, fallback: string, maxBytes = MAX_CACHE_FILE_NAME_BYTES): string {
    const safe = String(value ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean).at(-1)
        ?.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/g, '_') || fallback;
    const extensionIndex = safe.lastIndexOf('.');
    const extension = extensionIndex > 0 ? safe.slice(extensionIndex) : '';
    const extensionBytes = filenameEncoder.encode(extension).byteLength;
    if (extension && extensionBytes < maxBytes) {
        return `${truncateUtf8(safe.slice(0, extensionIndex), maxBytes - extensionBytes)}${extension}`;
    }
    return truncateUtf8(safe, maxBytes);
}
