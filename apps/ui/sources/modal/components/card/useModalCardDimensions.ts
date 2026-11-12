import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useModalContentViewport } from '../../context/ModalBoundaryContext';

export type ModalCardSizePreset = 'dialog' | 'md' | 'lg';

export type ModalCardDimensions = Readonly<{
    width: number;
    maxHeight: number;
}>;

export type ModalCardDimensionOptions = Readonly<{
    fullscreen?: boolean;
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

/** A dialog's share of the window height: a short alert or prompt, and a value picker hung from its field. */
export const MODAL_CARD_DIALOG_HEIGHT_RATIO = 0.48;

const MODAL_CARD_PRESETS: Record<ModalCardSizePreset, ModalCardDimensionPreset> = {
    dialog: {
        minWidth: 280,
        maxWidth: HAPPIER_PAGE_METRICS.dialogWidthPx.narrow,
        minHeight: 180,
        heightRatio: MODAL_CARD_DIALOG_HEIGHT_RATIO,
    },
    md: {
        minWidth: 320,
        maxWidth: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
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
    const preset = options.size
        ? MODAL_CARD_PRESETS[options.size]
        : { ...MODAL_CARD_PRESETS.md, maxWidth: HAPPIER_PAGE_METRICS.dialogWidthPx.default };
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

    if (options.fullscreen && hasWindowWidth && hasWindowHeight) {
        return { width: windowDimensions.width, maxHeight: windowDimensions.height };
    }

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

    // A preset minimum is only a preference when the viewport is unknown. Once
    // the host reports a real height, the card must fit inside it; enforcing the
    // preset minimum here makes short browser/Tauri windows overflow their shell.
    const maxHeight = hasWindowHeight
        ? Math.min(availableHeight, preset.maxHeight ?? availableHeight)
        : clamp(availableHeight, preset.minHeight, preset.maxHeight ?? availableHeight);

    return {
        width,
        maxHeight,
    };
}

export function useModalCardDimensions(options: ModalCardDimensionOptions = {}): ModalCardDimensions {
    const windowDimensions = useWindowDimensions();
    const modalViewport = useModalContentViewport();
    const viewport = modalViewport ?? windowDimensions;
    return React.useMemo(
        () => resolveModalCardDimensions(viewport, options),
        [options, viewport.height, viewport.width],
    );
}
