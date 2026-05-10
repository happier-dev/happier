import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { decodeBase64 } from '@/encryption/base64';

type ClipboardImageResult = Readonly<{
    data: string;
}>;

const DATA_URI_IMAGE_PATTERN = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.*)$/s;

function padDatePart(value: number, width = 2): string {
    return String(value).padStart(width, '0');
}

function buildClipboardImageFileName(now: Date): string {
    const timestamp = [
        padDatePart(now.getUTCFullYear(), 4),
        padDatePart(now.getUTCMonth() + 1),
        padDatePart(now.getUTCDate()),
        '-',
        padDatePart(now.getUTCHours()),
        padDatePart(now.getUTCMinutes()),
        padDatePart(now.getUTCSeconds()),
    ].join('');
    return `pasted-image-${timestamp}.png`;
}

function decodeClipboardImageDataUri(dataUri: string): Readonly<{
    bytes: Uint8Array;
    mimeType: string;
}> | null {
    const trimmed = dataUri.trim();
    if (!trimmed) return null;

    const match = DATA_URI_IMAGE_PATTERN.exec(trimmed);
    if (match) {
        return {
            mimeType: match[1] ?? 'image/png',
            bytes: decodeBase64(match[2] ?? ''),
        };
    }

    return {
        mimeType: 'image/png',
        bytes: decodeBase64(trimmed),
    };
}

export async function nativeReadClipboardImageAttachment(params?: Readonly<{
    now?: Date;
}>): Promise<readonly AttachmentsUploadFileSource[]> {
    const Clipboard = await import('expo-clipboard') as Readonly<{
        getImageAsync?: (options?: Readonly<{ format?: 'png' | 'jpeg' }>) => Promise<ClipboardImageResult | null>;
    }>;
    const image = typeof Clipboard.getImageAsync === 'function'
        ? await Clipboard.getImageAsync({ format: 'png' })
        : null;
    if (!image?.data) return [];

    const decoded = decodeClipboardImageDataUri(image.data);
    if (!decoded || decoded.bytes.byteLength === 0) return [];

    return [{
        kind: 'memory',
        name: buildClipboardImageFileName(params?.now ?? new Date()),
        bytes: decoded.bytes,
        mimeType: decoded.mimeType,
        previewUri: image.data,
    }];
}
