import { Platform } from 'react-native';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    HAPPIER_COLLECTION_ROW_METRICS,
    resolveHappierCollectionRowHeight,
    resolveHappierCollectionRowIdentityMetrics,
    resolveHappierCollectionRowLineMetrics,
    resolveHappierCollectionRowTitleMetrics,
    type HappierCollectionRowDensity,
} from '@happier-dev/plugin-ui/presentation';
import { shouldUseTouchCompactRow } from '@/components/ui/lists/collection/CollectionRowContent';

/**
 * The Session list's density adapter over the shared work-row metrics (`HAPPIER_COLLECTION_ROW_METRICS`, the one
 * geometry owner). The Account preference (`narrow | cozy | detailed`) is the row's Lines (1 | 2 | 3, lab
 * ideas-1118-shell scene 7): rows draw the one-line anatomy and Lines 2 and 3 add detail lines; previews and the
 * shell's width floor read the shared values through it.
 */
export type SessionListRowPlatform = 'ios' | 'android' | 'web' | 'windows' | 'macos';
export type SessionListRowDensity = 'default' | 'compact' | 'minimal';

const COLLECTION_ROW_DENSITY: Readonly<Record<SessionListRowDensity, HappierCollectionRowDensity>> = Object.freeze({
    default: 'detailed',
    compact: 'comfortable',
    minimal: 'compact',
});

/** The shared row density a Session list density draws at. */
export function resolveCollectionRowDensity(density: SessionListRowDensity): HappierCollectionRowDensity {
    return COLLECTION_ROW_DENSITY[density];
}

/**
 * A row's own fill on the column's plane (the open session, the pointer's hover): the list anatomy's row
 * radius, so Session rows and every other navigation row take one shape. Rows draw no sheet around them.
 */
export const SESSION_LIST_ROW_SELECTION_RADIUS = HAPPIER_COLLECTION_LIST_METRICS.rowRadius;

export function resolveSessionListRowStatusTextMetrics(density: SessionListRowDensity) {
    return resolveHappierCollectionRowLineMetrics(COLLECTION_ROW_DENSITY[density], Platform.OS);
}

const identityOf = (metrics: Readonly<{ slotSize: number; markSize: number }>) =>
    Object.freeze({ slotSize: metrics.slotSize, agentLogoSize: metrics.markSize });
export const SESSION_LIST_ROW_IDENTITY_METRICS = Object.freeze({
    default: identityOf(HAPPIER_COLLECTION_ROW_METRICS.identity.detailed),
    compact: identityOf(HAPPIER_COLLECTION_ROW_METRICS.identity.comfortable),
    minimal: identityOf(HAPPIER_COLLECTION_ROW_METRICS.identity.compact),
    minimalNativePhone: identityOf(HAPPIER_COLLECTION_ROW_METRICS.identity.touchCompact),
});

/** Fixed horizontal anatomy shared by row paint and the shell's content-derived width floor. */
const R = HAPPIER_COLLECTION_ROW_METRICS;
export const SESSION_LIST_ROW_WIDTH_METRICS = Object.freeze({
    // Rows lie flat on the column's plane: no sheet edge, so the content padding alone reaches the text edge.
    borderPx: 0,
    default: Object.freeze({ paddingPx: R.padding.detailed, contentMarginPx: R.contentGap.detailed, trailingMaxShare: R.trailingMaxShare }),
    compact: Object.freeze({ paddingPx: R.padding.comfortable, contentMarginPx: R.contentGap.comfortable, trailingMaxShare: R.trailingMaxShare }),
    minimal: Object.freeze({ paddingPx: R.padding.compact, contentMarginPx: R.contentGap.compact, trailingMaxShare: R.trailingMaxShare }),
    trailingMarginPx: R.trailingGap,
    // A status mark remains distinguishable when its word yields to the title.
    trailingMinPx: R.trailingMinPx,
    titleMinCharacters: 16,
});

/**
 * The shared list `Item` density a session-list row of this density uses (Drafts, Scheduled, "Show more").
 * A minimal row is the list's compact row, as `COLLECTION_ROW_DENSITY` says: its glyph column and gap are the
 * list's, so the row's title lands on the session rows' edge (phone 50) instead of `tight`'s 46.
 */
export function resolveSessionListItemDensity(density: SessionListRowDensity): 'comfortable' | 'compact' {
    return density === 'default' ? 'comfortable' : 'compact';
}

export function resolveSessionListRowTitleTextMetrics(params: Readonly<{
    density: SessionListRowDensity;
    readableNativePhoneMinimal: boolean;
}>) {
    return resolveHappierCollectionRowTitleMetrics(COLLECTION_ROW_DENSITY[params.density], Platform.OS, params.readableNativePhoneMinimal);
}

export function resolveSessionListRowIdentityMetrics(params: Readonly<{
    density: SessionListRowDensity;
    readableNativePhoneMinimal: boolean;
}>): Readonly<{ slotSize: number; agentLogoSize: number }> {
    return identityOf(resolveHappierCollectionRowIdentityMetrics(COLLECTION_ROW_DENSITY[params.density], params.readableNativePhoneMinimal));
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

/**
 * Lines 2 and 3 draw the one-line row plus the detail lines it has to say (lab ideas-1118-shell scene 7); a row is
 * measured once drawn, so the estimate is the common case: one detail line.
 */
function linedRowEstimate(touch: boolean): number {
    const line = HAPPIER_COLLECTION_ROW_METRICS.detailLine;
    return resolveHappierCollectionRowHeight('compact', touch) + line.minHeight + line.gap;
}

const SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT: SessionListDensityViewState = Object.freeze({
    compact: false,
    compactMinimal: false,
    rowHeight: linedRowEstimate(false),
});

const SESSION_LIST_DENSITY_VIEW_STATE_COMPACT: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: false,
    rowHeight: linedRowEstimate(false),
});

const SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT_TOUCH: SessionListDensityViewState = Object.freeze({
    ...SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT,
    rowHeight: linedRowEstimate(true),
});

const SESSION_LIST_DENSITY_VIEW_STATE_COMPACT_TOUCH: SessionListDensityViewState = Object.freeze({
    ...SESSION_LIST_DENSITY_VIEW_STATE_COMPACT,
    rowHeight: linedRowEstimate(true),
});

const SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: true,
    rowHeight: resolveHappierCollectionRowHeight('compact'),
});

const SESSION_LIST_DENSITY_VIEW_STATE_MINIMAL_NATIVE_PHONE: SessionListDensityViewState = Object.freeze({
    compact: true,
    compactMinimal: true,
    rowHeight: resolveHappierCollectionRowHeight('compact', true),
});

/** A narrow row on a phone-width window is the readable touch row (the shared rule, `shouldUseTouchCompactRow`). */
export function shouldUseReadablePhoneMinimalSessionRow(
    options: ResolveSessionListDensityViewStateOptions | null | undefined,
): boolean {
    return Boolean(options && shouldUseTouchCompactRow(options));
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

    const touch = shouldUseReadablePhoneMinimalSessionRow(options);
    if (sessionListDensity === 'cozy') {
        return scale(touch ? SESSION_LIST_DENSITY_VIEW_STATE_COMPACT_TOUCH : SESSION_LIST_DENSITY_VIEW_STATE_COMPACT);
    }

    return scale(touch ? SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT_TOUCH : SESSION_LIST_DENSITY_VIEW_STATE_DEFAULT);
}
