/**
 * FR4-W2-BODY — option-row rendering extracted from `SelectionListBody.tsx`.
 *
 * Owns:
 *  - testID / role / ARIA / id generation for option rows (with FR3-A
 *    `measureMode` suppression so the hidden measure mirror inside
 *    `SelectionListAnimatedHeight` never duplicates identity props).
 *  - Activation via `activateSelectionListRow` + right-accessory propagation.
 *  - `PlanSuccessRows` mapping helper.
 *  - The two `SlideTransitionSwitch` wrappers (`PlanAnimatedSuccessRows` and
 *    `VirtualizedTransitionShell`) used by the body when a section advertises
 *    a `transitionKey` (directory-drill animation).
 */

import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';

import { activateSelectionListRow } from './SelectionListRowActivation';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import {
    SELECTION_LIST_CARD_ACCESSORY_BOX_PX,
    SELECTION_LIST_CARD_ACCESSORY_GAP_PX,
    SELECTION_LIST_CARD_CONTENT_INSET_PX,
    SELECTION_LIST_CARD_INSET_PX,
} from './_constants';
import {
    chunkIntoColumnRows,
    resolveSelectionListCardRowGapPx,
    SelectionListColumnRow,
} from './SelectionListColumnRow';
import {
    resolveSelectionListSectionColumnCount,
    resolveSelectionListSectionColumnSpan,
} from './selectionListGridGeometry';
import {
    buildSelectionListGridCellWrapperA11yProps,
    buildSelectionListOptionA11yProps,
    buildSelectionListRowA11yProps,
    selectionListOptionWebRole,
    SELECTION_LIST_SINGLE_COLUMN_CELL_PLACEMENT,
    type SelectionListGridCellPlacement,
} from './buildSelectionListOptionA11yProps';
import type { SelectionListGridRowPlacement } from './selectionListGridRowModel';
import { renderSelectionListAccessory } from './renderSelectionListAccessory';
import { resolveSelectionListOptionDomId } from './resolveSelectionListOptionDomId';
import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import { SelectionListInputAttentionContext } from './SelectionListInputAttentionContext';
import { SelectionListScrollIntoViewContext } from './SelectionListScrollIntoViewContext';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type { SelectionListOption, SelectionListStep } from './_types';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

/**
 * Card geometry (`optionPresentation: 'card'`). Only the theme-INDEPENDENT
 * parts live here; the fill is resolved per render from the live theme so a
 * theme swap repaints the card without a remount.
 */
const cardStyles = StyleSheet.create((theme) => ({
    container: {
        alignSelf: 'stretch',
        // The positioning context for `accessory`. Without it the overlay
        // would anchor to whatever ancestor happened to be relative.
        position: 'relative',
        borderRadius: theme.borderRadius.xl,
        // Makes the card ONE shape: the row's own square selected fill and the
        // expanded controls panel are both clipped to these corners, which is
        // what lets a selected option and its inline controls read as a single
        // envelope instead of a row plus a differently-shaped panel.
        overflow: 'hidden',
    },
    accessory: {
        position: 'absolute',
        top: SELECTION_LIST_CARD_INSET_PX,
        right: SELECTION_LIST_CARD_INSET_PX,
        // Above the row's fill and its ripple/hover layer.
        zIndex: 2,
        elevation: 2,
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
        gap: SELECTION_LIST_CARD_ACCESSORY_GAP_PX,
    },
    accessoryReserve: {
        width: SELECTION_LIST_CARD_ACCESSORY_BOX_PX,
    },
    // Applied OVER `Item`'s density inset (its `style` prop lands last on the
    // padded container), not added to it — the two would otherwise compound
    // into roughly triple the intended clearance. See
    // SELECTION_LIST_CARD_CONTENT_INSET_PX for why a card does not want the
    // inset a full-width list row does. `minHeight` is left alone, so the press
    // target keeps its density's touch floor.
    itemInset: {
        paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX,
        paddingVertical: SELECTION_LIST_CARD_CONTENT_INSET_PX,
    },
}));

export type RenderPlanRowsProps = Readonly<{
    plan: SectionRenderPlan;
    rootTestID: string | undefined;
    stepId: string;
    selectedOptionId: string | null | undefined;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    optionPositionById?: ReadonlyMap<string, number>;
    optionSetSize?: number;
    /** FR3-1 / FR3-8 — propagate identity-free measure rendering. */
    measureMode?: boolean;
    /**
     * Lane G — visual columns per row. Anything `<= 1` (including the default)
     * renders the classic one-row-per-option stack, unchanged.
     */
    columnCount?: number;
    /** Gutter between adjacent columns. Defaults to the shared list gutter. */
    columnGapPx?: number;
    /**
     * Rows preceding this section's first option row, in BOTH numberings: the
     * `aria-rowindex` sequence (which counts this section's own header row) and
     * the option-row sequence (which does not, because the card gap separates
     * cards and a header is not a card). Popup-wide, so a section cannot number
     * its own rows from 1. Supplied at EVERY column count in `grid` mode, and
     * absent in `listbox` mode, which emits no row indices.
     */
    rowOffset?: SelectionListGridRowPlacement;
}>;

export function PlanOptionRow(props: Readonly<{
    option: SelectionListOption;
    rootTestID: string | undefined;
    stepId: string;
    isSelected: boolean;
    isFocused: boolean;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    positionInSet?: number;
    setSize?: number;
    /**
     * Popup-wide 1-based `aria-rowindex` for the SINGLE-COLUMN grid, where this
     * wrapper is the row. From the shared row model, so it counts the section
     * header rows the option position knows nothing about.
     *
     * Falls back to `positionInSet` for a row rendered by a harness with no row
     * model. It is deliberately NOT the same number: the two agree only in a
     * grid with no rendered section headers.
     */
    rowIndex?: number;
    /**
     * FR3-1 / FR3-8 — when true, suppress every identity / accessibility prop
     * on this row so the hidden measure mirror inside SelectionListAnimatedHeight
     * does not duplicate testIDs / aria-* props in the live DOM. Layout is
     * preserved so the measure host still reports the correct natural height.
     */
    measureMode?: boolean;
    /**
     * Placement inside a MULTI-COLUMN grid row. When present this wrapper is
     * the row's cell rather than the row itself (`SelectionListColumnRow` owns
     * the row). Absent for every single-column list, which keeps the exact
     * markup it has always emitted.
     */
    cellPlacement?: SelectionListGridCellPlacement | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const optionLabel = props.option.renderLabel?.() ?? props.option.label;
    const optionAccessibilityLabel = props.measureMode === true
        ? undefined
        : props.option.renderAccessibilityLabel?.() ?? props.option.accessibilityLabel;
    const subtitleContent = renderSelectionListAccessory(props.option.subtitleContent);
    const icon = renderSelectionListAccessory(props.option.icon);
    const rightAccessory = renderSelectionListAccessory(props.option.rightAccessory);
    // Per-option controls belong to the SELECTED row only, and are resolved
    // lazily so a virtualized list never constructs them for the other rows.
    const expandedContent = props.isSelected
        ? renderSelectionListAccessory(props.option.expandedContent)
        : undefined;
    const registerScrollItemLayout = React.useContext(SelectionListScrollIntoViewContext);
    const requestInputAttention = React.useContext(SelectionListInputAttentionContext);
    const optionTestId = resolveSelectionListOptionDomId({
        option: props.option,
        rootTestID: props.rootTestID,
        stepId: props.stepId,
    });
    const optionWrapperTestId = selectionListTestId(
        props.rootTestID,
        props.stepId,
        'option-wrapper',
        props.option.id,
    );
    const handlePress = React.useCallback(() => {
        activateSelectionListRow({
            option: props.option,
            onSelect: props.onSelect,
            onPushStep: props.onPushStep,
            onRequiresInput: requestInputAttention ?? undefined,
        });
    }, [props.option, props.onSelect, props.onPushStep, requestInputAttention]);
    // The popup-wide ARIA pattern (see SelectionListA11yPatternContext). It is
    // a declared capability of the whole list, so it is settled before the
    // first frame and cannot move while the popup is open.
    const a11yPattern = React.useContext(SelectionListA11yPatternContext);
    const optionAria = buildSelectionListOptionA11yProps({
        optionTestId,
        isSelected: props.isSelected,
        disabled: props.option.disabled === true,
        positionInSet: props.positionInSet ?? 1,
        setSize: props.setSize ?? 1,
        accessibilityLabel: optionAccessibilityLabel,
        pattern: a11yPattern,
    });
    // ONE OPTION IS ONE CELL, at every column count — the control, the corner
    // accessory and the expanded panel all live in it. Only WHICH node is that
    // cell changes with the layout:
    //
    //  - multi-column: the visual row above owns the cells, so this wrapper IS
    //    the cell;
    //  - single column: there is no `SelectionListColumnRow`, so this wrapper
    //    is the ROW and the cell is one node inside it.
    //
    // The single-column shape used to split the option across up to three
    // sibling cells (control, accessory overlay, open panel), which left every
    // unexpanded row one cell wide next to a two-cell selected row — the
    // raggedness that made assistive technology invent a second column.
    const cellPlacement = props.cellPlacement ?? null;
    const wrapperCellAria = buildSelectionListGridCellWrapperA11yProps({
        pattern: a11yPattern,
        placement: cellPlacement,
        optionDomId: optionTestId,
        isSelected: props.isSelected,
        disabled: props.option.disabled === true,
    });
    const rowAria = wrapperCellAria !== null
        ? null
        : buildSelectionListRowA11yProps({
            pattern: a11yPattern,
            rowIndex: props.rowIndex ?? props.positionInSet ?? 1,
        });
    const innerCellAria = rowAria === null
        ? null
        : buildSelectionListGridCellWrapperA11yProps({
            pattern: a11yPattern,
            placement: SELECTION_LIST_SINGLE_COLUMN_CELL_PLACEMENT,
            optionDomId: optionTestId,
            isSelected: props.isSelected,
            disabled: props.option.disabled === true,
        });
    // True wherever the activatable control sits inside a cell — it is then a
    // widget, and the cell owns the role, the DOM id and the selected state.
    const isGridCell = wrapperCellAria !== null || innerCellAria !== null;
    // Card presentation (see `SelectionListOptionPresentationContext`). Read
    // here rather than threaded as a prop because only this leaf consumes it.
    const isCard = React.useContext(SelectionListOptionPresentationContext) === 'card';
    // The card is the SINGLE owner of the option's fill: an unselected card
    // paints the base surface (invisible on a base pane, by design) and a
    // selected one paints the selected surface over both the row and its
    // expanded controls. Resolved per render so the card follows a live theme
    // swap; the geometry above is theme-independent and stays in the sheet.
    const cardFillStyle = isCard
        ? {
            backgroundColor: props.isSelected
                ? theme.colors.surface.selected
                : theme.colors.surface.base,
        }
        : null;
    // At one column there is no `SelectionListColumnRow`, so this envelope IS
    // the card row and carries the gap that separates it from the row above —
    // the same gap, from the same owner, that the column wrapper applies at two.
    // A card that is a grid CELL takes none: its row already carries one, and a
    // second would double it. Spread rather than merged into a `style` array so
    // a flush row still carries no style prop at all.
    // Deliberately the option's POSITION, not its `aria-rowindex`: the gap
    // separates one card from the card above it, and a section header is not a
    // card. Feeding the row index here would open an 8px gap above the first
    // card of every section the moment header rows started taking indices.
    const cardRowGapPx = resolveSelectionListCardRowGapPx({
        isCard,
        rowIndex: props.cellPlacement === undefined || props.cellPlacement === null
            ? props.positionInSet
            : undefined,
    });
    const cardWrapperProps = isCard
        ? {
            style: [
                cardStyles.container,
                cardFillStyle,
                cardRowGapPx === undefined ? null : { marginTop: cardRowGapPx },
            ],
        }
        : {};
    // In card mode the trailing accessory leaves the row's flow entirely and
    // becomes a corner overlay, so stacking a selection mark above a favourite
    // toggle costs zero row height. `Item` still reserves the horizontal room
    // (see SELECTION_LIST_CARD_ACCESSORY_BOX_PX) so a long title cannot run
    // underneath it.
    const cardAccessory = isCard ? rightAccessory : undefined;
    const itemRightElement = isCard
        ? (rightAccessory === undefined ? undefined : <View style={cardStyles.accessoryReserve} />)
        : rightAccessory;
    // Spread rather than passed as `style={isCard ? … : undefined}` so a flush
    // row carries NO style prop at all and `Item` resolves the user's density
    // setting exactly as it does for every other list in the app.
    const cardItemInsetProps = isCard ? { style: cardStyles.itemInset } : {};
    // The overlay carries no role of its own: it is part of the option, and the
    // option's cell (this wrapper at two columns, the node inside it at one)
    // already owns it. Giving it a cell of its own was how the single-column
    // grid grew columns it never declared.
    //
    // `identified` is false for the measure mirror, which must stay free of
    // testIDs and roles while keeping the identical layout.
    const renderCardAccessoryOverlay = (identified: boolean) => (cardAccessory === undefined ? null : (
        <View
            testID={identified
                ? selectionListTestId(props.rootTestID, props.stepId, 'option-card-accessory', props.option.id)
                : undefined}
            pointerEvents="box-none"
            style={cardStyles.accessory}
        >
            {cardAccessory}
        </View>
    ));
    // Inside a grid CELL the control is a widget, not the cell: the cell above
    // already carries the role, the DOM id `aria-activedescendant` points at,
    // and the selected/disabled state. Re-emitting them here would nest a
    // gridcell inside a gridcell and duplicate the id.
    const { role: _cellOwnedRole, id: _cellOwnedId, ...optionAriaWithoutCellIdentity } = optionAria;
    const webOptionAria = isGridCell ? optionAriaWithoutCellIdentity : optionAria;
    const customContentAccessibilityProps = Platform.OS === 'web'
        ? webOptionAria as unknown as Record<string, never>
        : {
            accessibilityLabel: optionAria.accessibilityLabel,
            accessibilityState: optionAria.accessibilityState,
        };
    if (props.measureMode === true) {
        // Identity-free mirror. Skip the role="option" ARIA spread and option
        // testID / wrapper testID. The Item — and the selected row's expanded
        // body — still render so the layout matches the visible row exactly
        // (height-stable).
        return (
            // The mirror takes the SAME card treatment as the live row —
            // including the accessory relocation, which is what actually
            // changes the natural height, and the row gap, which the measured
            // stack's height includes — or it would measure a layout the user
            // never sees.
            <View {...cardWrapperProps}>
                <Item
                    title={optionLabel}
                    subtitle={subtitleContent ?? props.option.subtitle}
                    titleEllipsizeMode={props.option.labelEllipsizeMode}
                    subtitleEllipsizeMode={props.option.subtitleEllipsizeMode}
                    icon={icon}
                    rightElement={itemRightElement}
                    rightElementOutsidePressable={!isCard && props.option.rightAccessoryOutsidePressable === true}
                    selected={props.isSelected}
                    focused={props.isFocused}
                    disabled={props.option.disabled === true}
                    loading={props.option.loading === true}
                    showChevron={Boolean(props.option.openStep)}
                    keepChevronWithRightElement={props.option.keepChevronWithAccessory === true}
                    webRole="presentation"
                    {...cardItemInsetProps}
                />
                {renderCardAccessoryOverlay(false)}
                {expandedContent}
            </View>
        );
    }
    const selectedOrFocused = props.isSelected || props.isFocused;
    const row = props.option.content !== undefined ? (
        <Pressable
            testID={optionTestId}
            onPressIn={props.option.onPressIn}
            onPress={handlePress}
            {...(Platform.OS === 'web'
                ? ({ onKeyDown: (event: any) => {
                    if (props.option.disabled === true) return;
                    const key = event?.nativeEvent?.key ?? event?.key;
                    if (key !== ' ' && key !== 'Spacebar' && key !== 'Enter') return;
                    event?.preventDefault?.();
                    handlePress();
                } } as Record<string, unknown>)
                : {})}
            accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
            disabled={props.option.disabled === true}
            {...customContentAccessibilityProps}
            style={(state) => {
                const hovered = (state as WebHoverablePressableState).hovered === true;
                return ({
                // In card mode the card owns the selected fill and wraps the
                // expanded content with it. Painting it here too would put a
                // SQUARE-cornered surface behind the rounded card — the exact
                // conflict that made the card impossible to add at the call
                // site. Transient hover/press feedback still belongs to the
                // pressable, since it tracks this control, not the option.
                backgroundColor: state.pressed || hovered
                    ? theme.colors.surface.pressed
                    : selectedOrFocused && !isCard
                        ? theme.colors.surface.selected
                        : undefined,
                opacity: props.option.disabled === true ? 0.5 : 1,
            });}}
        >
            {props.option.content}
        </Pressable>
    ) : (
        <Item
            testID={optionTestId}
            title={optionLabel}
            subtitle={subtitleContent ?? props.option.subtitle}
            titleEllipsizeMode={props.option.labelEllipsizeMode}
            subtitleEllipsizeMode={props.option.subtitleEllipsizeMode}
            icon={icon}
            rightElement={itemRightElement}
            rightElementOutsidePressable={!isCard && props.option.rightAccessoryOutsidePressable === true}
            onPressIn={props.option.onPressIn}
            onPress={handlePress}
            selected={props.isSelected}
            focused={props.isFocused}
            disabled={props.option.disabled === true}
            loading={props.option.loading === true}
            showChevron={Boolean(props.option.openStep)}
            keepChevronWithRightElement={props.option.keepChevronWithAccessory === true}
            accessibilityRole="button"
            accessibilityLabel={optionAria.accessibilityLabel}
            webRole={isGridCell ? 'button' : selectionListOptionWebRole(a11yPattern)}
            webId={isGridCell ? undefined : optionAria.id}
            accessibilityPositionInSet={optionAria.role === 'option' ? optionAria['aria-posinset'] : undefined}
            accessibilitySetSize={optionAria.role === 'option' ? optionAria['aria-setsize'] : undefined}
            {...cardItemInsetProps}
        />
    );
    // Everything the option owns, in reading order. In `listbox` mode these are
    // the wrapper's direct children exactly as they have always been; in `grid`
    // mode they are the contents of the option's one cell.
    const optionOwnedContent = (
        <>
            {row}
            {renderCardAccessoryOverlay(true)}
            {expandedContent}
        </>
    );
    return (
        <View
            testID={optionWrapperTestId}
            onLayout={registerScrollItemLayout?.(props.option.id)}
            {...cardWrapperProps}
            {...((wrapperCellAria ?? rowAria ?? {}) as unknown as Record<string, never>)}
        >
            {innerCellAria === null ? optionOwnedContent : (
                <View {...(innerCellAria as unknown as Record<string, never>)}>
                    {optionOwnedContent}
                </View>
            )}
        </View>
    );
}

export function PlanSuccessRows(props: RenderPlanRowsProps): React.ReactElement {
    const options = props.plan.options;
    const renderOption = (
        option: SelectionListOption,
        index: number,
        cellPlacement?: SelectionListGridCellPlacement,
        rowIndex?: number,
    ): React.ReactElement => (
        <PlanOptionRow
            key={option.id}
            option={option}
            rootTestID={props.rootTestID}
            stepId={props.stepId}
            isSelected={props.selectedOptionId === option.id}
            isFocused={props.focusedOptionId === option.id}
            onSelect={props.onSelect}
            onPushStep={props.onPushStep}
            positionInSet={props.optionPositionById?.get(option.id) ?? index + 1}
            setSize={props.optionSetSize ?? options.length}
            measureMode={props.measureMode}
            {...(cellPlacement === undefined ? {} : { cellPlacement })}
            {...(rowIndex === undefined ? {} : { rowIndex })}
        />
    );
    const columnCount = props.columnCount ?? 1;
    // Single column returns the SAME tree it always did — not a parallel
    // "simple" branch, but literally the rows with nothing wrapped around
    // them. That identity is what guarantees mobile and every existing
    // consumer are untouched by this variant, and it is asserted directly in
    // `SelectionListOptionRow.columns.test.tsx`.
    if (columnCount <= 1) {
        // At one column the option wrapper is the row, so it needs the popup-
        // wide index directly. `rowIndexOffset` is absent outside `grid` mode
        // (and in a bare harness), where no row index is emitted at all.
        const offset = props.rowOffset;
        return (
            <>
                {options.map((option, index) => renderOption(
                    option,
                    index,
                    undefined,
                    offset === undefined ? undefined : offset.rowIndex + index + 1,
                ))}
            </>
        );
    }
    // A section too short to fill a row spans the pane instead of leaving a
    // hole beside its only card. Decided by the geometry module so the ARIA
    // column indices and the arrow keys agree with what is painted.
    const sectionColumnCount = resolveSelectionListSectionColumnCount(options.length, columnCount);
    const columnSpan = resolveSelectionListSectionColumnSpan(options.length, columnCount);
    const rowOffset = props.rowOffset;
    return (
        <>
            {chunkIntoColumnRows(options, sectionColumnCount).map((rowOptions, rowIndex) => (
                <SelectionListColumnRow
                    // Keyed by the row's LEADING option so a row keeps its
                    // identity when the list above it grows or shrinks.
                    key={`column-row:${rowOptions[0]?.id ?? rowIndex}`}
                    columnCount={sectionColumnCount}
                    columnGapPx={props.columnGapPx}
                    rowIndex={(rowOffset?.rowIndex ?? 0) + rowIndex + 1}
                    optionRowIndex={(rowOffset?.optionRowIndex ?? 0) + rowIndex + 1}
                >
                    {rowOptions.map((option, columnIndex) => renderOption(
                        option,
                        (rowIndex * sectionColumnCount) + columnIndex,
                        { columnIndex: columnIndex + 1, columnSpan },
                    ))}
                </SelectionListColumnRow>
            ))}
        </>
    );
}

/**
 * RUX-1 Issue 8: animated wrapper for dynamic-section success rows. Tracks
 * the previous `transitionKey` so the slide direction can be derived from
 * key length (longer key = drill deeper = forward; shorter = walk-up =
 * backward). Same-length swaps default to forward — they're rare in
 * practice (e.g. typing into a sibling directory) and forward feels right
 * for "switching context".
 */
export function PlanAnimatedSuccessRows(props: RenderPlanRowsProps & {
    transitionKey: string;
    sectionTestId: string;
}): React.ReactElement {
    const previousKeyRef = React.useRef<string>(props.transitionKey);
    const direction: 'forward' | 'backward' = React.useMemo(() => {
        const prev = previousKeyRef.current;
        const next = props.transitionKey;
        if (prev === next) return 'forward';
        return next.length < prev.length ? 'backward' : 'forward';
    }, [props.transitionKey]);
    React.useEffect(() => {
        previousKeyRef.current = props.transitionKey;
    }, [props.transitionKey]);
    return (
        <SlideTransitionSwitch
            contentKey={props.transitionKey}
            direction={direction}
            blur={false}
            preset="compact"
            testID={selectionListTestId(props.sectionTestId, 'transition')}
        >
            <PlanSuccessRows
                plan={props.plan}
                rootTestID={props.rootTestID}
                stepId={props.stepId}
                selectedOptionId={props.selectedOptionId}
                focusedOptionId={props.focusedOptionId}
                onSelect={props.onSelect}
                onPushStep={props.onPushStep}
                optionPositionById={props.optionPositionById}
                optionSetSize={props.optionSetSize}
                measureMode={props.measureMode}
                columnCount={props.columnCount}
                columnGapPx={props.columnGapPx}
                rowOffset={props.rowOffset}
            />
        </SlideTransitionSwitch>
    );
}

/**
 * FR3-9 — `SlideTransitionSwitch` wrapper around virtualized rows for
 * directory-drill animation. Mirrors `PlanAnimatedSuccessRows` direction
 * inference (longer key = drill deeper = forward; shorter = walk-up =
 * backward) but accepts arbitrary children so the virtualized list-hosted
 * virtualized section can participate in the same animation contract as
 * mapped rows.
 *
 * Why a separate component (rather than threading children into
 * `PlanAnimatedSuccessRows`): the mapped helper internally renders
 * `<PlanSuccessRows>` from a `RenderPlanRowsProps`; coupling that helper to
 * "either rows or a virtualized hosting child" would muddy a clean contract.
 * Keeping a small dedicated shell keeps both paths self-contained.
 */
export function VirtualizedTransitionShell(props: Readonly<{
    transitionKey: string;
    sectionTestId: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const previousKeyRef = React.useRef<string>(props.transitionKey);
    const direction: 'forward' | 'backward' = React.useMemo(() => {
        const prev = previousKeyRef.current;
        const next = props.transitionKey;
        if (prev === next) return 'forward';
        return next.length < prev.length ? 'backward' : 'forward';
    }, [props.transitionKey]);
    React.useEffect(() => {
        previousKeyRef.current = props.transitionKey;
    }, [props.transitionKey]);
    return (
        <SlideTransitionSwitch
            contentKey={props.transitionKey}
            direction={direction}
            blur={false}
            preset="compact"
            testID={selectionListTestId(props.sectionTestId, 'transition')}
        >
            {props.children}
        </SlideTransitionSwitch>
    );
}
