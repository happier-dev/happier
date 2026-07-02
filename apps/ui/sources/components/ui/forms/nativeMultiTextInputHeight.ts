import {
    MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
    MULTI_TEXT_INPUT_DEFAULT_MAX_HEIGHT,
} from './multiTextInputTypography';

function normalizeNonNegativeNumber(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
    return value;
}

export function normalizeNativeMultiTextInputMaxHeight(maxHeight: number | undefined): number {
    if (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight)) {
        return MULTI_TEXT_INPUT_DEFAULT_MAX_HEIGHT;
    }
    return Math.max(0, maxHeight);
}

export function resolveNativeMultiTextInputMinHeight(params: Readonly<{
    maxHeight?: number;
    lineHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
}>): number {
    const maxHeight = normalizeNativeMultiTextInputMaxHeight(params.maxHeight);
    if (maxHeight <= 0) return 0;

    const lineHeight = normalizePositiveNumber(params.lineHeight, MULTI_TEXT_INPUT_BASE_LINE_HEIGHT);
    const verticalPadding =
        normalizeNonNegativeNumber(params.paddingTop)
        + normalizeNonNegativeNumber(params.paddingBottom);
    return Math.min(maxHeight, Math.ceil(lineHeight + verticalPadding));
}
