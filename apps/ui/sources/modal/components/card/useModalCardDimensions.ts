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
}>;

type ModalCardDimensionPreset = Readonly<{
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    heightRatio: number;
}>;

const MODAL_CARD_PRESETS: Record<ModalCardSizePreset, ModalCardDimensionPreset> = {
    dialog: {
        minWidth: 280,
        maxWidth: 360,
        minHeight: 180,
        maxHeight: 320,
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
    const horizontalMargin = 80;
    const availableWidth = Math.max(0, Math.floor(windowDimensions.width - horizontalMargin));
    const width = options.width != null
        ? Math.min(availableWidth, options.width)
        : clamp(availableWidth, preset.minWidth, preset.maxWidth);
    const availableHeight = Math.floor(windowDimensions.height * (options.maxHeightRatio ?? preset.heightRatio));
    const maxHeight = clamp(availableHeight, preset.minHeight, preset.maxHeight);

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
