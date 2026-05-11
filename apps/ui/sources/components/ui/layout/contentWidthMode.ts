import { CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS } from '@/utils/platform/viewportClass';

export type UiContentWidthMode = 'compact' | 'medium' | 'full';

export const DEFAULT_UI_CONTENT_WIDTH_MODE: UiContentWidthMode = 'compact';

export const CONTENT_WIDTH_PX_BY_MODE = {
    compact: 850,
    medium: CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.medium,
} as const satisfies Record<Exclude<UiContentWidthMode, 'full'>, number>;

export function normalizeUiContentWidthMode(value: unknown): UiContentWidthMode {
    if (value === 'medium' || value === 'full') return value;
    return DEFAULT_UI_CONTENT_WIDTH_MODE;
}

export function resolveContentMaxWidthForMode(mode: unknown): number {
    const normalizedMode = normalizeUiContentWidthMode(mode);
    if (normalizedMode === 'full') return Number.POSITIVE_INFINITY;
    return CONTENT_WIDTH_PX_BY_MODE[normalizedMode];
}
