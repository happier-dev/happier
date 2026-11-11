/**
 * Built-in file presentation policy. Syntax highlighting remains in fileLanguage.
 * Session-media wire admission, favicons/logos, LLM ingestion and the isolated
 * public-share viewer have distinct trust/transport contracts and keep theirs.
 */
import { isHappierAlphaCapableImageMimeType } from '@happier-dev/plugin-ui/presentation';

export type FileViewerKind = 'code' | 'markdown' | 'html' | 'image' | 'svg' | 'pdf' | 'video' | 'audio' | 'binary';
export type FileViewerClass = Readonly<{
    kind: FileViewerKind;
    mimeType: string;
    previewable: boolean;
    alphaCapable: boolean;
    labelKey: string;
}>;

type FileKindRow = Readonly<{ extensions: readonly string[]; mimeType: string; kind: FileViewerKind; labelKey?: string; alphaCapable?: boolean }>;
const FILE_KINDS: readonly FileKindRow[] = [
    { extensions: ['png'], mimeType: 'image/png', kind: 'image', labelKey: 'files.kind.png' },
    { extensions: ['jpg', 'jpeg'], mimeType: 'image/jpeg', kind: 'image', labelKey: 'files.kind.jpeg' },
    { extensions: ['gif'], mimeType: 'image/gif', kind: 'image', labelKey: 'files.kind.gif' },
    { extensions: ['webp'], mimeType: 'image/webp', kind: 'image', labelKey: 'files.kind.webp' },
    { extensions: ['bmp'], mimeType: 'image/bmp', kind: 'image', labelKey: 'files.kind.bmp' },
    { extensions: ['ico'], mimeType: 'image/x-icon', kind: 'image', labelKey: 'files.kind.ico' },
    { extensions: ['avif'], mimeType: 'image/avif', kind: 'image', labelKey: 'files.kind.avif' },
    { extensions: ['svg'], mimeType: 'image/svg+xml', kind: 'svg' },
    { extensions: ['md', 'markdown', 'mdx'], mimeType: 'text/markdown', kind: 'markdown' },
    { extensions: ['html', 'htm'], mimeType: 'text/html', kind: 'html' },
    { extensions: ['pdf'], mimeType: 'application/pdf', kind: 'pdf' },
    { extensions: ['mp4'], mimeType: 'video/mp4', kind: 'video', labelKey: 'files.kind.mp4' },
    { extensions: ['m4v'], mimeType: 'video/x-m4v', kind: 'video', labelKey: 'files.kind.mp4' },
    { extensions: ['mov'], mimeType: 'video/quicktime', kind: 'video', labelKey: 'files.kind.mov' },
    { extensions: ['webm'], mimeType: 'video/webm', kind: 'video', labelKey: 'files.kind.webm' },
    { extensions: ['avi'], mimeType: 'video/x-msvideo', kind: 'video' },
    { extensions: ['wmv'], mimeType: 'video/x-ms-wmv', kind: 'video' },
    { extensions: ['flv'], mimeType: 'video/x-flv', kind: 'video' },
    { extensions: ['mp3'], mimeType: 'audio/mpeg', kind: 'audio', labelKey: 'files.kind.mp3' },
    { extensions: ['wav'], mimeType: 'audio/wav', kind: 'audio', labelKey: 'files.kind.wav' },
    { extensions: ['flac'], mimeType: 'audio/flac', kind: 'audio', labelKey: 'files.kind.flac' },
    { extensions: ['aac'], mimeType: 'audio/aac', kind: 'audio', labelKey: 'files.kind.aac' },
    { extensions: ['ogg', 'oga'], mimeType: 'audio/ogg', kind: 'audio', labelKey: 'files.kind.ogg' },
    { extensions: ['m4a'], mimeType: 'audio/mp4', kind: 'audio', labelKey: 'files.kind.aac' },
    { extensions: ['zip'], mimeType: 'application/zip', kind: 'binary', labelKey: 'files.kind.zip' },
    { extensions: ['tar'], mimeType: 'application/x-tar', kind: 'binary', labelKey: 'files.kind.tar' },
    { extensions: ['gz'], mimeType: 'application/gzip', kind: 'binary', labelKey: 'files.kind.gzip' },
    { extensions: ['rar'], mimeType: 'application/vnd.rar', kind: 'binary', labelKey: 'files.kind.rar' },
    { extensions: ['7z'], mimeType: 'application/x-7z-compressed', kind: 'binary', labelKey: 'files.kind.sevenZip' },
    { extensions: ['db', 'sqlite', 'sqlite3'], mimeType: 'application/vnd.sqlite3', kind: 'binary', labelKey: 'files.kind.sqlite' },
    { extensions: ['exe', 'dll'], mimeType: 'application/vnd.microsoft.portable-executable', kind: 'binary', labelKey: 'files.kind.pe' },
    { extensions: ['elf', 'so'], mimeType: 'application/x-elf', kind: 'binary', labelKey: 'files.kind.elf' },
    { extensions: ['dylib', 'macho'], mimeType: 'application/x-mach-binary', kind: 'binary', labelKey: 'files.kind.machO' },
    { extensions: ['doc'], mimeType: 'application/msword', kind: 'binary', labelKey: 'files.kind.office' },
    { extensions: ['docx'], mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'binary', labelKey: 'files.kind.office' },
    { extensions: ['xls'], mimeType: 'application/vnd.ms-excel', kind: 'binary', labelKey: 'files.kind.office' },
    { extensions: ['xlsx'], mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'binary', labelKey: 'files.kind.office' },
    { extensions: ['ppt'], mimeType: 'application/vnd.ms-powerpoint', kind: 'binary', labelKey: 'files.kind.office' },
    { extensions: ['pptx'], mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'binary', labelKey: 'files.kind.office' },
    { extensions: ['woff'], mimeType: 'font/woff', kind: 'binary', labelKey: 'files.kind.font' },
    { extensions: ['woff2'], mimeType: 'font/woff2', kind: 'binary', labelKey: 'files.kind.font' },
    { extensions: ['ttf'], mimeType: 'font/ttf', kind: 'binary', labelKey: 'files.kind.font' },
    { extensions: ['otf'], mimeType: 'font/otf', kind: 'binary', labelKey: 'files.kind.font' },
    { extensions: ['dmg'], mimeType: 'application/x-apple-diskimage', kind: 'binary' },
    { extensions: ['deb'], mimeType: 'application/vnd.debian.binary-package', kind: 'binary' },
    { extensions: ['rpm'], mimeType: 'application/x-rpm', kind: 'binary' },
    { extensions: ['lockb'], mimeType: 'application/octet-stream', kind: 'binary' },
];

function getPathExtension(path: string): string | null {
    const basename = path.split(/[\\/]/).pop() ?? path;
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex >= basename.length - 1) return null;
    return basename.slice(lastDotIndex + 1).toLowerCase();
}

function magicMimeType(head: Uint8Array): string | null {
    const matches = (bytes: readonly number[], offset = 0) => bytes.every((byte, index) => head[offset + index] === byte);
    if (matches([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
    if (matches([255, 216, 255])) return 'image/jpeg';
    if (matches([71, 73, 70, 56]) && (head[4] === 55 || head[4] === 57) && head[5] === 97) return 'image/gif';
    if (matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8)) return 'image/webp';
    for (let offset = 0; offset + 5 <= Math.min(head.length, 1024); offset++) {
        if (matches([37, 80, 68, 70, 45], offset)) return 'application/pdf';
    }
    if (matches([80, 75]) && (matches([3, 4], 2) || matches([5, 6], 2) || matches([7, 8], 2))) return 'application/zip';
    if (matches([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0])) return 'application/vnd.sqlite3';
    if (matches([35, 33])) return 'text/plain';
    return null;
}

export function resolveFileViewerKind(input: Readonly<{
    path: string;
    mimeType?: string | null;
    isBinaryContent?: boolean;
    head?: Uint8Array;
}>): FileViewerClass {
    const mime = input.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    const specificMime = mime !== '' && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream';
    const extension = getPathExtension(input.path);
    let row = specificMime ? FILE_KINDS.find((entry) => entry.mimeType === mime) : undefined;
    if (!specificMime) row = FILE_KINDS.find((entry) => entry.extensions.includes(extension ?? ''));
    if (input.head && (!extension || !specificMime)) {
        const magic = magicMimeType(input.head);
        if (magic) row = FILE_KINDS.find((entry) => entry.mimeType === magic)
            ?? { extensions: [], mimeType: magic, kind: 'code' };
    }
    let kind: FileViewerKind = row?.kind ?? (specificMime
        ? mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video'
                : mime.startsWith('audio/') ? 'audio'
                    : mime.startsWith('text/') ? 'code' : 'binary'
        : 'code');
    let mimeType = row?.mimeType ?? (specificMime && kind !== 'code' ? mime : 'text/plain');
    if (kind === 'pdf' && input.head && magicMimeType(input.head) !== 'application/pdf') {
        kind = 'binary';
        mimeType = 'application/octet-stream';
        row = undefined;
    }
    // Git's binary numstat means no text diff; it does not disqualify a media viewer.
    if (input.isBinaryContent === true && (kind === 'code' || kind === 'markdown' || kind === 'html')) {
        kind = 'binary';
        mimeType = 'application/octet-stream';
        row = undefined;
    }
    return {
        kind,
        mimeType,
        previewable: kind === 'image' || kind === 'svg' || kind === 'pdf' || kind === 'video' || kind === 'audio',
        alphaCapable: (kind === 'image' || kind === 'svg') && isHappierAlphaCapableImageMimeType(row?.mimeType),
        labelKey: row?.labelKey ?? `files.kind.${kind}`,
    };
}

/** Kinds whose page opens on a rendered Preview of the held text, with Source one tap away. */
export function hasRenderedTextPreview(kind: FileViewerKind | (string & {})): boolean {
    return kind === 'markdown' || kind === 'svg' || kind === 'html';
}

/** Kinds the page reads as text (Source, Changes, find), including those with a rendered Preview. */
export function isTextReadableFileViewerKind(kind: FileViewerKind): boolean {
    return kind === 'code' || hasRenderedTextPreview(kind);
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
