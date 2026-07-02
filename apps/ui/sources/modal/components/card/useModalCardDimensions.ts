import * as React from 'react';
import { useWindowDimensions } from 'react-native';

export type ModalCardSizePreset = 'dialog' | 'md' | 'lg';

export type ModalCardDimensions = Readonly<{
    width: number;
    maxHeight: number;
}>;

export type ModalCardDimensionOptions = Readonly<{
    size?: ModalCardSizePreset;
    width?: number;
    maxHeightRatio?: number;
    viewportMargin?: number | Readonly<{ horizontal?: number; vertical?: number }>;
}>;

type ModalCardDimensionPreset = Readonly<{
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight?: number;
    heightRatio: number;
}>;

const DEFAULT_MODAL_CARD_VIEWPORT_MARGIN = {
    horizontal: 40,
    vertical: 48,
} as const;

const MODAL_CARD_MIN_VERTICAL_VIEWPORT_MARGIN = DEFAULT_MODAL_CARD_VIEWPORT_MARGIN.vertical;

const MODAL_CARD_PRESETS: Record<ModalCardSizePreset, ModalCardDimensionPreset> = {
    dialog: {
        minWidth: 280,
        maxWidth: 360,
        minHeight: 180,
        heightRatio: 0.48,
    },
    md: {
        minWidth: 320,
        maxWidth: 560,
        minHeight: 280,
        maxHeight: 760,
        heightRatio: 0.85,
    },
    lg: {
        minWidth: 320,
        maxWidth: 840,
        minHeight: 320,
        maxHeight: 860,
        heightRatio: 0.85,
    },
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveModalCardDimensions(
    windowDimensions: Readonly<{ width: number; height: number }>,
    options: ModalCardDimensionOptions = {},
): ModalCardDimensions {
    const preset = MODAL_CARD_PRESETS[options.size ?? 'md'];
    const viewportMargin = (() => {
        if (typeof options.viewportMargin === 'number') {
            return {
                horizontal: options.viewportMargin,
                vertical: Math.max(options.viewportMargin, MODAL_CARD_MIN_VERTICAL_VIEWPORT_MARGIN),
            };
        }

        return {
            horizontal: options.viewportMargin?.horizontal ?? DEFAULT_MODAL_CARD_VIEWPORT_MARGIN.horizontal,
            vertical: Math.max(
                options.viewportMargin?.vertical ?? DEFAULT_MODAL_CARD_VIEWPORT_MARGIN.vertical,
                MODAL_CARD_MIN_VERTICAL_VIEWPORT_MARGIN,
            ),
        };
    })();
    const hasWindowWidth = Number.isFinite(windowDimensions.width) && windowDimensions.width > 0;
    const hasWindowHeight = Number.isFinite(windowDimensions.height) && windowDimensions.height > 0;

    const availableWidth = hasWindowWidth
        ? Math.max(0, Math.floor(windowDimensions.width - viewportMargin.horizontal * 2))
        : preset.maxWidth;

    const width = options.width != null
        ? (hasWindowWidth
            ? Math.min(availableWidth, options.width)
            : clamp(options.width, preset.minWidth, preset.maxWidth))
        : clamp(availableWidth, preset.minWidth, preset.maxWidth);

    const availableHeight = hasWindowHeight
        ? Math.min(
            Math.max(0, Math.floor(windowDimensions.height - viewportMargin.vertical * 2)),
            Math.floor(windowDimensions.height * (options.maxHeightRatio ?? preset.heightRatio)),
        )
        : (preset.maxHeight ?? preset.minHeight);

    const maxHeight = clamp(
        availableHeight,
        preset.minHeight,
        preset.maxHeight ?? availableHeight,
    );

    return {
        width,
        maxHeight,
    };
}

export function useModalCardDimensions(options: ModalCardDimensionOptions = {}): ModalCardDimensions {
    const windowDimensions = useWindowDimensions();
    return React.useMemo(
        () => resolveModalCardDimensions(windowDimensions, options),
        [options, windowDimensions.height, windowDimensions.width],
    );
}
