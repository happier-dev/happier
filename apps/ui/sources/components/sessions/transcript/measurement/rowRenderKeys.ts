import { Dimensions, PixelRatio } from 'react-native';

const TRANSCRIPT_ROW_WIDTH_BUCKET_PX = 64;

export function resolveTranscriptRowWidthBucket(width: unknown): string {
    const normalizedWidth = typeof width === 'number' && Number.isFinite(width)
        ? Math.max(1, Math.trunc(width))
        : 1;
    const bucket = Math.max(
        TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
        Math.ceil(normalizedWidth / TRANSCRIPT_ROW_WIDTH_BUCKET_PX) * TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
    );
    return `width:${bucket}`;
}

export function resolveInitialTranscriptRowWidthBucket(): string {
    return resolveTranscriptRowWidthBucket(Dimensions.get('window')?.width);
}

export function resolveFontScaleKey(): string {
    const fontScale = typeof PixelRatio.getFontScale === 'function'
        ? PixelRatio.getFontScale()
        : Dimensions.get('window')?.fontScale;
    const normalized = typeof fontScale === 'number' && Number.isFinite(fontScale)
        ? Math.max(0.5, fontScale)
        : 1;
    return `font:${Math.round(normalized * 100)}`;
}
