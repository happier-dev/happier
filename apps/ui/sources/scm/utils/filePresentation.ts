const KNOWN_BINARY_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'ico',
    'mp4',
    'avi',
    'mov',
    'wmv',
    'flv',
    'webm',
    'mp3',
    'wav',
    'flac',
    'aac',
    'ogg',
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'zip',
    'tar',
    'gz',
    'rar',
    '7z',
    'exe',
    'dmg',
    'deb',
    'rpm',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'db',
    'sqlite',
    'sqlite3',
    'lockb',
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
};

function getPathExtension(path: string): string | null {
    const basename = path.split('/').pop() ?? path;
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex >= basename.length - 1) return null;
    return basename.slice(lastDotIndex + 1).toLowerCase();
}

export function isKnownBinaryPath(path: string): boolean {
    const extension = getPathExtension(path);
    return extension ? KNOWN_BINARY_EXTENSIONS.has(extension) : false;
}

export function getImageMimeTypeFromPath(path: string): string | null {
    const extension = getPathExtension(path);
    if (!extension) return null;
    return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export function isKnownImagePath(path: string): boolean {
    return getImageMimeTypeFromPath(path) != null;
}

export function isBinaryContent(content: string): boolean {
    if (!content) return false;
    if (content.includes('\0')) return true;

    const len = content.length;
    if (len === 0) return false;
    const maxAllowed = Math.floor(len * 0.1);

    let nonPrintableCount = 0;
    for (let i = 0; i < len; i++) {
        const code = content.charCodeAt(i);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            nonPrintableCount += 1;
            if (nonPrintableCount > maxAllowed) return true;
        }
    }

    return false;
}
