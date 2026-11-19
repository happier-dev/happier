import { Platform } from 'react-native';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';
import { resolveHappierTypeScale } from '../text/typeScale.js';

import { resolveHappierIconSize } from '../content/Icon.js';
import type { HappierItemDensity } from '../collection/semantics.js';

function roleMetrics(role: Parameters<typeof resolveHappierTypeScale>[0]): PageRowText {
    const { weight: _weight, ...metrics } = resolveHappierTypeScale(role, Platform.OS);
    return metrics;
}

/**
 * The densities a configuration-page row is drawn at: the user's list-density preference. An explicit
 * `tight` (editor-like lists) has no page shape of its own and draws as `compact`.
 *
 * `inspector` is not a preference: a page hosted as a side-pane inspector (Session Info beside its
 * conversation, lab csinfo I2) draws its rows at it whatever the preference — small type, regular-weight
 * titles, 36px rows with right-aligned values — so the pane reads as a dense inspector, not a settings page.
 */
export type HappierPageRowDensity = 'comfortable' | 'cozy' | 'compact' | 'inspector';

/**
 * A page row's two shapes. `standard` is any row of a section; `list` is a row of a long index-style
 * list of single-line rows (the section asks for it with `ItemGroup density="compact"`), which is the
 * compact shape of the same density rather than a density of its own — so the preference still reaches
 * it.
 */
export type HappierPageRowShape = 'standard' | 'list';

/** What a page section's rows are: settings (the default, label first) or `facts` about one thing (value first). */
export type HappierPageRowRole = 'rows' | 'facts';

type PageRowText = Readonly<{ fontSize: number; lineHeight: number; letterSpacing: number }>;

export type HappierPageRowMetrics = Readonly<{
    minHeightPx: number;
    paddingVerticalPx: number;
    title: PageRowText;
    /** A settings row's title is medium; an inspector row's is the body face, its value carrying the weight. */
    titleWeight: 'regular' | 'medium';
    /**
     * A fact row (an inspector's list of facts: Run on, Folder, Started; a section of `facts` rows) reads
     * value first: its label steps back to secondary and the value takes the primary ink. Settings rows keep
     * label first.
     */
    valueLeads: boolean;
    /**
     * A `facts` section sets its keys in one column this wide and each value, with its note under it, left-aligned in
     * a second column beside it (lab Themes C2 `th-kv`), so the values scan down one edge. Null for every other row.
     */
    factKeyColumnPx: number | null;
    subtitle: PageRowText & Readonly<{ marginTop: number }>;
    iconGlyphPx: number;
}>;

/**
 * The finger's hit-area height (iOS HIG 44pt). A page row never draws at it: a full-width row is its own
 * hit area and keeps its density's height (DESIGN.md → touch targets are hit areas, not drawn sizes).
 * Kept for consumers that size layout quanta in finger units.
 */
export const HAPPIER_PAGE_ROW_TOUCH_MIN_HEIGHT_PX = 44;


/**
 * The configuration-page row at each density: the lab's desktop scale, where the default (`cozy`) is
 * exactly the shared page anatomy plugin pages draw (`HAPPIER_PAGE_METRICS` / `HAPPIER_PAGE_TEXT`), and
 * the other two step one notch roomier or denser around it. Line heights stay close to the type size
 * so a description sits a few pixels under its title at every density, not a line away.
 */
const PAGE_ROW_DENSITY_METRICS: Record<HappierPageRowDensity, Readonly<{
    standard: Readonly<{ minHeightPx: number; paddingVerticalPx: number }>;
    list: Readonly<{ minHeightPx: number; paddingVerticalPx: number }>;
    title: PageRowText;
    titleWeight?: 'regular';
    subtitle: PageRowText;
    iconGlyphPx: number;
}>> = {
    comfortable: {
        standard: { minHeightPx: 56, paddingVerticalPx: 16 },
        list: { minHeightPx: 44, paddingVerticalPx: 12 },
        title: roleMetrics('heading'),
        subtitle: roleMetrics('body'),
        iconGlyphPx: resolveHappierIconSize('medium'),
    },
    cozy: {
        standard: { minHeightPx: HAPPIER_PAGE_METRICS.rowMinHeightPx, paddingVerticalPx: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx },
        list: { minHeightPx: HAPPIER_PAGE_METRICS.compactRowMinHeightPx, paddingVerticalPx: HAPPIER_PAGE_METRICS.compactRowPaddingVerticalPx },
        title: roleMetrics('label'),
        subtitle: roleMetrics('body'),
        iconGlyphPx: HAPPIER_PAGE_METRICS.rowIconGlyphPx,
    },
    compact: {
        standard: { minHeightPx: 44, paddingVerticalPx: 10 },
        list: { minHeightPx: 34, paddingVerticalPx: 7 },
        title: roleMetrics('body'),
        subtitle: roleMetrics('meta'),
        iconGlyphPx: resolveHappierIconSize('small'),
    },
    inspector: {
        standard: { minHeightPx: 36, paddingVerticalPx: 5 },
        list: { minHeightPx: 32, paddingVerticalPx: 4 },
        title: roleMetrics('body'),
        titleWeight: 'regular',
        subtitle: roleMetrics('meta'),
        iconGlyphPx: resolveHappierIconSize('small'),
    },
};

/** A facts key's column: room for "Reshapes layout" on two lines and its gap before the value (lab C2 `th-kv`). */
const PAGE_ROW_FACT_KEY_COLUMN_PX = 112;

/** Between a page row's title and its description, at every density. */
const PAGE_ROW_SUBTITLE_GAP_PX = 2;

const resolvedHappierPageRowMetrics = new Map<string, HappierPageRowMetrics>();

/**
 * A page row's box, type and glyph for a density and shape. Referentially stable per input, so rows
 * can put the result straight into style arrays without churning memoized children.
 */
export function resolveHappierPageRowMetrics(input: Readonly<{
    density: HappierPageRowDensity;
    shape: HappierPageRowShape;
    /**
     * `facts`: the section lists facts about one thing (a Store listing's Includes, Licence), not
     * settings. At the user's density, its labels take the regular face and step back so each value leads.
     */
    role?: HappierPageRowRole;
    /** @deprecated A row's height no longer depends on the pointer: its hit area is the row itself. Ignored. */
    touch?: boolean;
}>): HappierPageRowMetrics {
    const facts = input.role === 'facts';
    const key = `${input.density}:${input.shape}:${facts ? 'facts' : 'rows'}`;
    const cached = resolvedHappierPageRowMetrics.get(key);
    if (cached) return cached;
    const table = PAGE_ROW_DENSITY_METRICS[input.density];
    const box = table[input.shape];
    const metrics: HappierPageRowMetrics = Object.freeze({
        minHeightPx: box.minHeightPx,
        paddingVerticalPx: box.paddingVerticalPx,
        title: table.title,
        titleWeight: facts ? 'regular' : table.titleWeight ?? 'medium',
        valueLeads: facts || (input.density === 'inspector' && input.shape === 'list'),
        factKeyColumnPx: facts ? PAGE_ROW_FACT_KEY_COLUMN_PX : null,
        subtitle: Object.freeze({ ...table.subtitle, marginTop: PAGE_ROW_SUBTITLE_GAP_PX }),
        iconGlyphPx: table.iconGlyphPx,
    });
    resolvedHappierPageRowMetrics.set(key, metrics);
    return metrics;
}

/** The page shape of a resolved item density: its scale, and whether a section asked for a list. */
export function resolveHappierPageRowDensityInput(input: Readonly<{
    preferred: HappierPageRowDensity;
    requested: HappierItemDensity;
    requestedExplicitly: boolean;
}>): Readonly<{ density: HappierPageRowDensity; shape: HappierPageRowShape }> {
    const shape: HappierPageRowShape = input.requestedExplicitly && (input.requested === 'compact' || input.requested === 'tight') ? 'list' : 'standard';
    return { density: input.preferred, shape };
}

export { HAPPIER_ROW_TITLE_META_GAP_PX, resolveHappierRowTitleMetaPlacement } from './pageMetrics.js';
