import * as React from 'react';

import { ListOptionPositionContext, ListOptionSetSizeContext } from '@/components/ui/lists/listOptionSetPosition';

import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import { PlanOptionRow, resolveSelectionListRowOrder } from './SelectionListOptionRow';
import type { SelectionListOption } from './_types';

/**
 * The list-wide facts a virtualized option row shows: the keyboard highlight, the selection, its place
 * in the set and the set's size. They change on every arrow press and whenever results arrive.
 *
 * A recycled cell is invalidated by its item and by the list's `extraData`. Feeding these facts
 * through the cell renderer made every highlight move and every arriving result redraw every
 * mounted cell (and its recycler container). Delivered here instead, the cell stays keyed to its
 * item alone, only rows whose highlight or selection changed redraw, and the set size and each row's
 * position reach the option's own element through `listOptionSetPosition`.
 */
export type SelectionListVirtualizedRowState = Readonly<{
    selectedOptionIds: ReadonlySet<string>;
    focusedOptionId: string | null;
    /** Position of each option in the popup-wide set; absent where the row's item carries it. */
    optionPositionById?: ReadonlyMap<string, number>;
    /** The next option of a row's section (`null` for its last), for the one list-row rule; absent where unstated. */
    nextOptionOf?: (optionId: string) => SelectionListOption | null;
}>;

const SelectionListVirtualizedRowStateContext =
    React.createContext<SelectionListVirtualizedRowState | null>(null);

export function SelectionListVirtualizedRowStateProvider(props: Readonly<{
    selectedOptionIds: ReadonlySet<string>;
    focusedOptionId: string | null;
    optionPositionById?: ReadonlyMap<string, number>;
    nextOptionOf?: (optionId: string) => SelectionListOption | null;
    /** Popup-wide set size every option row reports. */
    optionSetSize: number;
    children: React.ReactNode;
}>): React.ReactElement {
    const { selectedOptionIds, focusedOptionId, optionPositionById, nextOptionOf } = props;
    const value = React.useMemo<SelectionListVirtualizedRowState>(
        () => ({ selectedOptionIds, focusedOptionId, optionPositionById, nextOptionOf }),
        [selectedOptionIds, focusedOptionId, optionPositionById, nextOptionOf],
    );
    return (
        <SelectionListVirtualizedRowStateContext.Provider value={value}>
            <ListOptionSetSizeContext.Provider value={props.optionSetSize}>
                {props.children}
            </ListOptionSetSizeContext.Provider>
        </SelectionListVirtualizedRowStateContext.Provider>
    );
}

type PlanOptionRowProps = React.ComponentProps<typeof PlanOptionRow>;

/**
 * `PlanOptionRow` inside a virtualized cell. It reads the list-wide row facts from the nearest
 * provider and hands the memoized row only its own values, so a fact change redraws the rows it
 * changes and nothing else. Its position is published for the option's element; the row receives it
 * as a prop only where it lays itself out by it (a card's gap) or numbers a grid row with it.
 */
export function SelectionListVirtualizedOptionRow(props: Readonly<
    Omit<PlanOptionRowProps, 'isSelected' | 'isFocused' | 'positionInSet' | 'setSize' | 'followed' | 'nextFocused' | 'nextSelected'> & {
        /** Position when the provider has none for this option (a row the item numbers itself). */
        positionInSet: number;
        /** The next option of this row's section (`null` when it is the last), when the renderer has it at hand. */
        nextOption?: SelectionListOption | null;
    }
>): React.ReactElement {
    const state = React.useContext(SelectionListVirtualizedRowStateContext);
    if (state === null) throw new Error('SelectionListVirtualizedOptionRow renders inside SelectionListVirtualizedRowStateProvider');
    const a11yPattern = React.useContext(SelectionListA11yPatternContext);
    const presentation = React.useContext(SelectionListOptionPresentationContext);
    const { nextOption: itemNextOption, ...rowProps } = props;
    const id = props.option.id;
    const nextOption = itemNextOption !== undefined ? itemNextOption : state.nextOptionOf?.(id);
    const position = state.optionPositionById?.get(id) ?? props.positionInSet;
    const rowReadsPosition = a11yPattern === 'grid' || presentation === 'card';
    return (
        <ListOptionPositionContext.Provider value={position}>
            <PlanOptionRow
                {...rowProps}
                isSelected={state.selectedOptionIds.has(id)}
                isFocused={state.focusedOptionId !== null && state.focusedOptionId === id}
                positionInSet={rowReadsPosition ? position : undefined}
                {...(nextOption === undefined ? {} : resolveSelectionListRowOrder(nextOption, state))}
            />
        </ListOptionPositionContext.Provider>
    );
}
