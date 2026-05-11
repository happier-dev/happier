import { SessionMediaItemV1Schema } from '@happier-dev/protocol';

export type SessionMediaInlineImageSummary = Readonly<{
    id: string;
    name: string;
    path: string;
    mimeType: string;
    sizeBytes: number;
    sha256?: string;
    width?: number;
    height?: number;
    category: 'attachment' | 'generated' | 'tool-artifact';
    role: 'input' | 'output';
}>;

export type ParsedSessionMediaMessageMeta = Readonly<{
    inlineImages: readonly SessionMediaInlineImageSummary[];
}>;

function isSafeSessionMediaPath(path: string): boolean {
    if (!path || path.startsWith('/') || path.startsWith('\\')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
    if (path.includes('\\')) return false;
    return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function sanitizeAdvisoryDimensions(item: Record<string, unknown>): Record<string, unknown> {
    const withoutDimensions = { ...item };
    delete withoutDimensions.width;
    delete withoutDimensions.height;
    const width = readPositiveInteger(item.width);
    const height = readPositiveInteger(item.height);
    return width && height
        ? { ...withoutDimensions, width, height }
        : withoutDimensions;
}

export function parseSessionMediaMessageMeta(value: unknown): ParsedSessionMediaMessageMeta | null {
    if (!isRecord(value) || value.kind !== 'session_media.v1') return null;
    if (!isRecord(value.payload) || !Array.isArray(value.payload.media)) return null;

    const inlineImages: SessionMediaInlineImageSummary[] = [];
    for (const rawItem of value.payload.media) {
        if (!isRecord(rawItem)) continue;
        const parsedItem = SessionMediaItemV1Schema.safeParse(sanitizeAdvisoryDimensions(rawItem));
        if (!parsedItem.success) continue;
        const item = parsedItem.data;
        if (item.mediaKind !== 'image') continue;
        if (!isSafeSessionMediaPath(item.path)) continue;
        inlineImages.push({
            id: item.id,
            name: item.name,
            path: item.path,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            ...(item.sha256 ? { sha256: item.sha256 } : {}),
            ...(typeof item.width === 'number' && typeof item.height === 'number'
                ? { width: item.width, height: item.height }
                : {}),
            category: item.category,
            role: item.role,
        });
    }

    return inlineImages.length > 0 ? { inlineImages } : null;
}
