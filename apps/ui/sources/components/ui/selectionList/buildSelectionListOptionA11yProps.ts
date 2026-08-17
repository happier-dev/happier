import type { ViewProps } from 'react-native';

/**
 * Which ARIA pattern the popup composes its rows with.
 *
 * `listbox` — the default, and the only valid shape while every row is a
 *   single activatable option in a single-file list: ARIA requires a `listbox`
 *   to own nothing but `option` (or a `group` of options), and it describes one
 *   dimension.
 *
 * `grid` — required by EITHER of two independent CAPABILITIES THE CALLER
 *   DECLARES about the popup:
 *
 *   - `optionsHostInlineControls`: rows may hold interactive `expandedContent`
 *     (segmented tab bars, switches, sliders), which is non-option markup that
 *     a listbox may not own;
 *   - `columns`: rows are two-dimensional, so the arrow keys move in two
 *     dimensions.
 *
 *   The spec-sanctioned popup for a combobox whose rows hold several
 *   interactive elements — or several options — is the grid (WAI-ARIA APG,
 *   "combobox with grid popup"): `role="grid"` → `role="row"` →
 *   `role="gridcell"`. `aria-posinset`/`aria-setsize` are option-only and are
 *   replaced by `aria-rowindex`/`aria-rowcount` + `aria-colindex`/
 *   `aria-colcount`.
 *
 * Both couplings are architectural, not incidental: INLINE ROW CONTROLS AND
 * MULTIPLE COLUMNS EACH REQUIRE THE GRID PATTERN. Applying one without the
 * other — a columned `listbox`, or a `grid` that stops being one when the
 * expanded row is filtered away — is worse than either pattern applied
 * consistently.
 *
 * The pattern follows the DECLARATION, not what the popup currently holds or
 * currently measures: see `resolveSelectionListA11yPattern`.
 */
export type SelectionListA11yPattern = 'listbox' | 'grid';

/**
 * The pattern is a CAPABILITY THE CALLER DECLARES, never something inferred
 * from what the popup currently contains.
 *
 * Three implementations were tried and two of them shipped a role set that
 * flipped while the popup was open, which is the one thing a composite widget
 * may not do — a screen reader re-announces the whole structure and the user's
 * model of the widget is destroyed. Both failures had the same cause, so the
 * rule now is absolute:
 *
 *   ANY input that depends on content, selection, filtering, or measured
 *   layout will flip, because all four move while the popup is open.
 *
 *  - Keying on `expandedContent` in the FILTERED plan flipped the moment a
 *    query excluded the option carrying it.
 *  - Keying on `expandedContent` in the DECLARED sections still flipped,
 *    because the shipped producer REBUILDS its declared sections from the
 *    current selection — "declared" was itself selection-derived.
 *  - Keying on the RESOLVED `columnCount` flipped twice more: it is `1` until
 *    `onLayout` measures, so every columned pane opened as a `listbox` and was
 *    promoted to `grid` one frame later, and it fell back again on any resize
 *    across the column threshold.
 *
 * Both inputs below are static props of the SelectionList: this resolver reads
 * nothing from the plan, the selection, the filter, or a measurement, so the
 * pattern is settled on the FIRST FRAME and cannot move on its own.
 *
 * What it cannot do is make a CALLER's prop static. `declaresInlineRowControls`
 * holds for the life of the open step exactly as long as the caller keeps
 * passing the same value, and that is a contract on callers, not an invariant
 * this function enforces — `OptionPickerOverlay` broke it once by deriving the
 * declaration from a handler its own parent withdrew on certain selections.
 * A caller computing either flag from anything that moves while the popup is
 * open is the defect; there is no latch here that would hide it.
 *
 * `declaresColumns` is the PRESENCE of a `columns` config, not the count it
 * currently resolves to: a caller that asked for a grid gets the grid pattern
 * even on a frame (or a viewport) where the pane only fits one column. The
 * count still decides the LAYOUT and the emitted `aria-colcount`; it just no
 * longer decides the pattern.
 *
 * `declaresInlineRowControls` is the caller stating that option rows may host
 * interactive `expandedContent` while this list is open. It is a declaration
 * rather than a scan for the same reason: whether any option carries controls
 * right now depends on the selection. A caller that renders `expandedContent`
 * without declaring the capability gets `listbox`, which is the contract, not a
 * detection gap — including for dynamic (async) sections, which no shipped
 * caller gives `expandedContent` to.
 */
export function resolveSelectionListA11yPattern(source: Readonly<{
    /** The caller passed a `columns` layout, whatever it currently resolves to. */
    declaresColumns: boolean;
    /** The caller declared that rows may host interactive `expandedContent`. */
    declaresInlineRowControls: boolean;
}>): SelectionListA11yPattern {
    return source.declaresColumns || source.declaresInlineRowControls
        ? 'grid'
        : 'listbox';
}

/**
 * `gridcell` is ARIA 1.2 but is absent from React Native's `Role` union, which
 * predates it. Only the web renderer has ARIA at all, and react-native-web
 * forwards `role` verbatim to the DOM, so the value is correct where it is
 * read; the cast is the type model catching up, not a behavior claim.
 */
const GRID_CELL_ROLE = 'gridcell' as unknown as NonNullable<ViewProps['role']>;

export function selectionListOptionWebRole(
    pattern: SelectionListA11yPattern,
): NonNullable<ViewProps['role']> {
    return pattern === 'grid' ? GRID_CELL_ROLE : 'option';
}

export type SelectionListContainerA11yProps = Readonly<{
    id: string;
    role: 'listbox' | 'grid';
    'aria-rowcount'?: number;
    'aria-colcount'?: number;
    accessibilityLabel?: string;
    'aria-label'?: string;
}>;

export function buildSelectionListContainerA11yProps(params: Readonly<{
    containerId: string;
    pattern: SelectionListA11yPattern;
    /**
     * Number of VISUAL rows in the plan: one per option in a single-column
     * list, one per grid row once the pane is columned, PLUS one per rendered
     * section header, which is a full-width header row of the grid (see
     * `buildSelectionListSectionHeaderGridA11yProps`). Only consumed in `grid`
     * mode, and owned by `buildSelectionListGridRowModel` so this count and
     * every emitted `aria-rowindex` come from one walk of the same plan.
     */
    rowCount: number;
    /**
     * Resolved columns per visual row.
     *
     * Emitted as `aria-colcount` for EVERY grid, single column included.
     * Omitting it let assistive technology infer the count from the widest row
     * it could find — and a single-column grid's widest row was the selected
     * one, whose expanded controls used to be a second cell. Every unexpanded
     * row was then announced as "column 1 of 2" of a grid that has one column.
     * Both halves of that defect are fixed: the count is stated, and one option
     * is now exactly one cell (see `buildSelectionListGridCellWrapperA11yProps`).
     */
    columnCount?: number;
    accessibilityLabel?: string;
}>): SelectionListContainerA11yProps {
    const accessibilityLabel = params.accessibilityLabel?.trim();
    const columnCount = Math.max(1, params.columnCount ?? 1);
    return {
        id: params.containerId,
        role: params.pattern === 'grid' ? 'grid' : 'listbox',
        ...(params.pattern === 'grid'
            ? { 'aria-rowcount': params.rowCount, 'aria-colcount': columnCount }
            : {}),
        ...(accessibilityLabel
            ? {
                accessibilityLabel,
                'aria-label': accessibilityLabel,
            }
            : {}),
    };
}

/**
 * In `grid` mode the layout wrapper that already exists around each option (it
 * owns the scroll-into-view layout callback and hosts the expanded panel)
 * becomes the row. In `listbox` mode it stays role-free, exactly as before.
 *
 * SINGLE COLUMN ONLY. Once the pane resolves more than one column that wrapper
 * is no longer a row — the visual row is, and one row holds several options.
 * `SelectionListColumnRow` then calls this builder instead; the option wrapper
 * becomes the row's CELL (see `buildSelectionListGridCellWrapperA11yProps`).
 */
export type SelectionListRowA11yProps = Readonly<{
    role: 'row';
    'aria-rowindex': number;
}>;

export function buildSelectionListRowA11yProps(params: Readonly<{
    pattern: SelectionListA11yPattern;
    rowIndex: number;
}>): SelectionListRowA11yProps | null {
    if (params.pattern !== 'grid') return null;
    return { role: 'row', 'aria-rowindex': params.rowIndex };
}

/**
 * `columnheader` is ARIA 1.2 and, like `gridcell`, predates React Native's
 * `Role` union. Same reasoning as `GRID_CELL_ROLE`: correct where it is read.
 */
const COLUMN_HEADER_ROLE = 'columnheader' as unknown as NonNullable<ViewProps['role']>;

export type SelectionListSectionHeaderGridA11yProps = Readonly<{
    row: Readonly<{ role: 'row'; 'aria-rowindex': number }>;
    cell: Readonly<{
        role: NonNullable<ViewProps['role']>;
        'aria-colindex': 1;
        'aria-colspan'?: number;
    }>;
}>;

export type SelectionListSectionGroupA11yProps = Readonly<{
    accessibilityLabel?: string;
    'aria-label'?: string;
}>;

/**
 * A listbox may own options or groups of options, never a text-bearing
 * role-free section wrapper. The body supplies this one result to every
 * renderer so mapped, section-virtualized, and flat-virtualized sections all
 * use the same structural ownership.
 */
export function buildSelectionListSectionGroupA11yProps(params: Readonly<{
    pattern: SelectionListA11yPattern;
    title?: string;
}>): SelectionListSectionGroupA11yProps | null {
    if (params.pattern !== 'listbox') return null;
    const title = params.title?.trim();
    return title
        ? { accessibilityLabel: title, 'aria-label': title }
        : {};
}

/**
 * A SECTION HEADER IS A ROW.
 *
 * A grid may own only `row`, `rowgroup` or `caption`. Every other node the body
 * puts between the grid and its rows — the fade host, the scroll container, the
 * per-section wrapper, the per-column layout boxes — is an empty container that
 * the accessibility tree flattens away, so the rows stay owned by the grid. The
 * section header is the exception: it renders TEXT, and flattening its wrapper
 * re-parents that text onto the grid as a child that is not a row.
 *
 * So the header takes a row of its own holding one `columnheader` that spans
 * the declared columns — the shape a data table uses for `<tr><th colspan>`.
 * The title stays visible AND announced; making it presentational would fix the
 * ownership violation by deleting the information, which is not a fix.
 *
 * `caption` was the other candidate and is invalid twice over: it is an owned
 * element of `grid`/`table` and never of `rowgroup`, and a grid captions the
 * whole grid rather than each of several sections.
 *
 * Returns `null` in `listbox` mode because the header itself keeps its visual
 * role-free shape. Its parent is instead the named `group` built by
 * `buildSelectionListSectionGroupA11yProps`, which works for mapped,
 * section-virtualized, and flat-virtualized sections alike.
 */
export function buildSelectionListSectionHeaderGridA11yProps(params: Readonly<{
    pattern: SelectionListA11yPattern;
    /** Popup-wide 1-based row index, or `undefined` outside a numbered body. */
    rowIndex: number | undefined;
    /** The grid's declared column count — what the header spans. */
    columnCount: number;
}>): SelectionListSectionHeaderGridA11yProps | null {
    if (params.pattern !== 'grid') return null;
    if (params.rowIndex === undefined) return null;
    const columnSpan = Math.max(1, params.columnCount);
    return {
        row: { role: 'row', 'aria-rowindex': params.rowIndex },
        cell: {
            role: COLUMN_HEADER_ROLE,
            'aria-colindex': 1,
            ...(columnSpan > 1 ? { 'aria-colspan': columnSpan } : {}),
        },
    };
}

/** Where one option sits inside its visual row. */
export type SelectionListGridCellPlacement = Readonly<{
    /** 1-based column of this cell within its visual row. */
    columnIndex: number;
    /** Grid columns the cell occupies. Above 1 only for full-width sections. */
    columnSpan: number;
}>;

/**
 * A single-column grid still has a column, and the option still occupies it.
 *
 * Naming it here rather than letting the single-column path skip the cell
 * model is what makes every row the same shape: exactly one cell, at column 1,
 * of a grid that declares one column. The previous shape gave the SELECTED row
 * a second cell for its expanded panel and left every other row with one, so
 * assistive technology inferred two columns from the widest row and announced
 * "column 1 of 2" for rows that had no column 2.
 */
export const SELECTION_LIST_SINGLE_COLUMN_CELL_PLACEMENT: SelectionListGridCellPlacement = {
    columnIndex: 1,
    columnSpan: 1,
};

export type SelectionListGridCellWrapperA11yProps = Readonly<{
    role: 'gridcell';
    id: string;
    'aria-colindex': number;
    'aria-colspan'?: number;
    'aria-selected': boolean;
    'aria-disabled'?: true;
}>;

/**
 * ONE OPTION IS ONE CELL — at every column count.
 *
 * The cell holds everything that belongs to that option: the activatable
 * control, its corner accessory overlay, and its expanded controls. That is
 * what makes `aria-colcount` honest (every row accounts for exactly the
 * declared number of columns) and it matches the card the user sees, which is
 * one shape containing all three.
 *
 * At two columns the cell is the option WRAPPER, which the visual row owns.
 * At one column the wrapper is the ROW, so the cell is a node inside it — the
 * same props, one level down. Splitting the option across several cells (which
 * the single-column path used to do, one for the control and one for the open
 * panel) is what made rows ragged and the column count unreadable.
 *
 * The cell carries the option's DOM id (so `aria-activedescendant` points at
 * the cell, as the grid-popup pattern expects) and its selected/disabled
 * state. The control inside keeps `role="button"`: a widget within a gridcell
 * is the sanctioned shape, a gridcell within a gridcell is not.
 *
 * Returns `null` in `listbox` mode, where the historical shape is preserved
 * byte for byte.
 */
export function buildSelectionListGridCellWrapperA11yProps(params: Readonly<{
    pattern: SelectionListA11yPattern;
    placement: SelectionListGridCellPlacement | null | undefined;
    optionDomId: string;
    isSelected: boolean;
    disabled: boolean;
}>): SelectionListGridCellWrapperA11yProps | null {
    if (params.pattern !== 'grid') return null;
    const placement = params.placement;
    if (!placement) return null;
    return {
        role: 'gridcell',
        id: params.optionDomId,
        'aria-colindex': placement.columnIndex,
        ...(placement.columnSpan > 1 ? { 'aria-colspan': placement.columnSpan } : {}),
        'aria-selected': params.isSelected,
        ...(params.disabled ? { 'aria-disabled': true as const } : {}),
    };
}

type SelectionListActivatableA11yBase = Readonly<{
    id: string;
    'aria-selected': boolean;
    'aria-disabled'?: true;
    accessibilityState: Readonly<{ selected: boolean; disabled?: true }>;
    tabIndex: 0 | -1;
    accessibilityLabel?: string;
    'aria-label'?: string;
}>;

export type SelectionListOptionA11yProps = SelectionListActivatableA11yBase & Readonly<{
    role: 'option';
    'aria-posinset': number;
    'aria-setsize': number;
}>;

export type SelectionListGridCellA11yProps = SelectionListActivatableA11yBase & Readonly<{
    role: 'gridcell';
}>;

export type SelectionListActivatableA11yProps =
    | SelectionListOptionA11yProps
    | SelectionListGridCellA11yProps;

export function buildSelectionListOptionA11yProps(params: Readonly<{
    optionTestId: string;
    isSelected: boolean;
    disabled: boolean;
    positionInSet: number;
    setSize: number;
    accessibilityLabel?: string;
    /** Defaults to `'listbox'` so existing consumers keep the option role set. */
    pattern?: SelectionListA11yPattern;
}>): SelectionListActivatableA11yProps {
    const accessibilityLabel = params.accessibilityLabel?.trim() ?? '';
    const isGrid = params.pattern === 'grid';
    const base = {
        id: params.optionTestId,
        ...(isGrid
            // `aria-posinset`/`aria-setsize` are not supported on `gridcell`;
            // the row carries `aria-rowindex` and the grid `aria-rowcount`.
            ? { role: 'gridcell' as const }
            : {
                role: 'option' as const,
                'aria-posinset': params.positionInSet,
                'aria-setsize': params.setSize,
            }),
        'aria-selected': params.isSelected,
        ...(params.disabled ? { 'aria-disabled': true as const } : {}),
        accessibilityState: {
            selected: params.isSelected,
            ...(params.disabled ? { disabled: true as const } : {}),
        },
        tabIndex: params.disabled ? -1 as const : 0 as const,
    };
    if (!accessibilityLabel) return base;
    return {
        ...base,
        accessibilityLabel,
        'aria-label': accessibilityLabel,
    };
}
