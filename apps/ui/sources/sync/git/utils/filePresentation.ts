const FILE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    html: 'html',
    htm: 'html',
    css: 'css',
    json: 'json',
    md: 'markdown',
    xml: 'xml',
    svg: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    go: 'go',
    rust: 'rust',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
};

const KNOWN_BINARY_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
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
]);

function getPathExtension(path: string): string | null {
    const basename = path.split('/').pop() ?? path;
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex >= basename.length - 1) return null;
    return basename.slice(lastDotIndex + 1).toLowerCase();
}

export function getFileLanguageFromPath(path: string): string | null {
    const extension = getPathExtension(path);
    if (!extension) return null;
    return FILE_LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function isKnownBinaryPath(path: string): boolean {
    const extension = getPathExtension(path);
    return extension ? KNOWN_BINARY_EXTENSIONS.has(extension) : false;
}

export function isBinaryContent(content: string): boolean {
    if (!content) return false;
    if (content.includes('\0')) return true;

    const nonPrintableCount = content.split('').filter((char) => {
        const code = char.charCodeAt(0);
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;

    return nonPrintableCount / content.length > 0.1;
}
