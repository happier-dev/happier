/**
 * What pressing an option chip does. Two or more choices always open a visible picker, where each
 * option says what it does: DESIGN.md forbids tap-to-cycle, because one stray tap would silently
 * change how the agent works. A keyboard shortcut may still step through modes (an expert accelerator).
 */
export type ChipOptionInteraction<T extends string> =
    | Readonly<{
        kind: 'none';
        selectableOptionIds: ReadonlyArray<T>;
    }>
    | Readonly<{
        kind: 'picker';
        selectableOptionIds: ReadonlyArray<T>;
    }>;

export function resolveChipOptionInteraction<T extends string>(params: Readonly<{
    currentOptionId: T | null;
    selectableOptionIds: ReadonlyArray<T>;
}>): ChipOptionInteraction<T> {
    const selectable = params.selectableOptionIds;
    const onlyChoiceIsCurrent = selectable.length === 1 && selectable[0] === params.currentOptionId;
    if (selectable.length === 0 || onlyChoiceIsCurrent) {
        return { kind: 'none', selectableOptionIds: selectable };
    }
    return { kind: 'picker', selectableOptionIds: selectable };
}

export function shouldRenderChipForOptions(params: Readonly<{
    optionCount: number;
    showWhenNoOptions: boolean;
    showWhenSingleOption: boolean;
}>): boolean {
    if (params.optionCount <= 0) return params.showWhenNoOptions;
    if (params.optionCount === 1) return params.showWhenSingleOption;
    return true;
}
