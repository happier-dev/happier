import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from './sessionListRowHeights';
import { VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from '@/utils/platform/viewportClass';

export type SessionListRowPlatform = 'ios' | 'android' | 'web' | 'windows' | 'macos';
export type SessionListRowDensity = 'default' | 'compact' | 'minimal';

export const SESSION_LIST_ROW_CORNER_RADIUS = 12;
/**
 * A row's own fill inside the column — the open session inside its group's sheet, and a navigation
 * row's hover — rounded tighter than the sheet so the sheet's paper shows around it.
 */
export const SESSION_LIST_ROW_SELECTION_RADIUS = 8;

export const SESSION_LIST_ROW_TITLE_TEXT_METRICS = {
    default: { fontSize: 14, lineHeight: 18 },
    compact: { fontSize: 14, lineHeight: 18 },
    minimal: { fontSize: 12, lineHeight: 16 },
    minimalNativePhone: { fontSize: 17, lineHeight: 22 },
} as const;

export const SESSION_LIST_ROW_STATUS_TEXT_METRICS = {
    default: { fontSize: 12, lineHeight: 16 },
    compact: { fontSize: 11, lineHeight: 11 },
    minimal: { fontSize: 10, lineHeight: 12 },
} as const;

export const SESSION_LIST_ROW_IDENTITY_METRICS = {
    default: { slotSize: 48, agentLogoSize: 37 },
    compact: { slotSize: 30, agentLogoSize: 23 },
    minimal: { slotSize: 18, agentLogoSize: 14 },
    minimalNativePhone: { slotSize: 20, agentLogoSize: 16 },
} as const;

export function resolveSessionListRowTitleTextMetrics(params: Readonly<{
    density: SessionListRowDensity;
    readableNativePhoneMinimal: boolean;
}>): Readonly<{ fontSize: number; lineHeight: number }> {
    if (params.density === 'minimal' && params.readableNativePhoneMinimal) {
        return SESSION_LIST_ROW_TITLE_TEXT_METRICS.minimalNativePhone;
    }
    return SESSION_LIST_ROW_TITLE_TEXT_METRICS[params.density];
}

export function resolveSessionListRowIdentityMetrics(params: Readonly<{
    density: SessionListRowDensity;
    readableNativePhoneMinimal: boolean;
}>): Readonly<{ slotSize: number; agentLogoSize: number }> {
    if (params.density === 'minimal' && params.readableNativePhoneMinimal) {
        return SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone;
    }
    return SESSION_LIST_ROW_IDENTITY_METRICS[params.density];
}

export type SessionListDensityViewState = Readonly<{
    compact: boolean;
    compactMinimal: boolean;
    rowHeight: number;
}>;

export type ResolveSessionListDensityViewStateOptions = Readonly<{
    isTablet: boolean;
    platform: SessionListRowPlatform | string;
    uiFontScale?: number;
    /** Web's narrow window, not a short desktop window, uses phone row anatomy. */
    windowWidth?: number;
}>;

function scaleRowHeight(height: number, uiFontScale: number | undefined): number {
    const scale = typeof uiFontScale === 'number' && Number.isFinite(uiFontScale)
        ? Math.max(1, Math.min(uiFontScale, 2.5))
        : 1;
    return scale > 1.1 ? Math.ceil(height * scale) : height;
}

const SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT: SessionListDensityViewState = Object.freeze({
    compact: false,
    compactMinimal: false,
    rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
});

const SESSION_LIST_DENSITY_VIEW_STATE_COMPACT: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: false,
    rowHeight: SESSION_LIST_ROW_HEIGHT_COMPACT,
});

const SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: true,
    rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
});

const SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL_NATIVE_PHONE: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: true,
    rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
});

export function shouldUseReadablePhoneMinimalSessionRow(
    options: ResolveSessionListDensityViewStateOptions | null | undefined,
): boolean {
    return Boolean(
        options
        && !options.isTablet
        && (options.platform === 'ios' || options.platform === 'android'
            || (options.platform === 'web' && options.windowWidth !== undefined
                && options.windowWidth < VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin)),
    );
}

export function resolveSessionListDensityViewState(
    sessionListDensity: string | null | undefined,
    options?: ResolveSessionListDensityViewStateOptions,
): SessionListDensityViewState {
    const scale = (state: SessionListDensityViewState): SessionListDensityViewState => {
        const rowHeight = scaleRowHeight(state.rowHeight, options?.uiFontScale);
        return rowHeight === state.rowHeight ? state : { ...state, rowHeight };
    };
    if (sessionListDensity === 'narrow') {
        if (shouldUseReadablePhoneMinimalSessionRow(options)) {
            return scale(SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL_NATIVE_PHONE);
        }
        return scale(SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL);
    }

    if (sessionListDensity === 'cozy') {
        return scale(SESSION_LIST_DENSITY_VIEW_STATE_COMPACT);
    }

    return scale(SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT);
}
