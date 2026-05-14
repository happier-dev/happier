import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';

export type SessionMediaInlineRenderableImageMimeType =
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/gif';

export function isSessionMediaInlineRenderableImageMimeType(
    mimeType: string | null | undefined,
): mimeType is SessionMediaInlineRenderableImageMimeType {
    if (typeof mimeType !== 'string') return false;
    const normalized = mimeType.trim().toLowerCase();
    return normalized === 'image/png'
        || normalized === 'image/jpeg'
        || normalized === 'image/webp'
        || normalized === 'image/gif';
}

export function resolveSessionMediaInlineRenderableImageMimeType(input: Readonly<{
    mimeType?: string;
    path: string;
    name?: string;
}>): SessionMediaInlineRenderableImageMimeType | null {
    const explicitMimeType = typeof input.mimeType === 'string' && input.mimeType.trim().length > 0
        ? input.mimeType.trim().toLowerCase()
        : null;
    const resolvedMimeType =
        explicitMimeType
        ?? getImageMimeTypeFromPath(input.path)
        ?? (input.name ? getImageMimeTypeFromPath(input.name) : null);
    return isSessionMediaInlineRenderableImageMimeType(resolvedMimeType) ? resolvedMimeType : null;
}
