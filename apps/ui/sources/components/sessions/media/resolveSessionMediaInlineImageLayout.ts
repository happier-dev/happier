export type SessionMediaInlineImageDimensions = Readonly<{
    width: number;
    height: number;
}>;

const FALLBACK_THUMBNAIL_SIZE = 84;
const MAX_THUMBNAIL_WIDTH = 220;
const MAX_THUMBNAIL_HEIGHT = 160;

function readPositiveDimension(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

export function resolveSessionMediaInlineImageDimensions(
    value: Readonly<{ width?: number; height?: number }> | null,
): SessionMediaInlineImageDimensions | null {
    const width = readPositiveDimension(value?.width);
    const height = readPositiveDimension(value?.height);
    return width && height ? { width, height } : null;
}

export function resolveSessionMediaInlineImageLayout(input: Readonly<{
    persistedDimensions?: Readonly<{ width?: number; height?: number }> | null;
    loadedDimensions?: Readonly<{ width?: number; height?: number }> | null;
}>): SessionMediaInlineImageDimensions {
    const dimensions =
        resolveSessionMediaInlineImageDimensions(input.persistedDimensions ?? null)
        ?? resolveSessionMediaInlineImageDimensions(input.loadedDimensions ?? null);

    if (!dimensions) {
        return {
            width: FALLBACK_THUMBNAIL_SIZE,
            height: FALLBACK_THUMBNAIL_SIZE,
        };
    }

    const scale = Math.min(
        MAX_THUMBNAIL_WIDTH / dimensions.width,
        MAX_THUMBNAIL_HEIGHT / dimensions.height,
    );
    return {
        width: Math.max(1, Math.round(dimensions.width * scale)),
        height: Math.max(1, Math.round(dimensions.height * scale)),
    };
}
