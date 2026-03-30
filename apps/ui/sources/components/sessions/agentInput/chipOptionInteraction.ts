export type ChipOptionInteraction<T extends string> =
    | Readonly<{
        kind: 'none';
        selectableOptionIds: ReadonlyArray<T>;
    }>
    | Readonly<{
        kind: 'cycle';
        selectableOptionIds: ReadonlyArray<T>;
        nextOptionId: T;
    }>
    | Readonly<{
        kind: 'picker';
        selectableOptionIds: ReadonlyArray<T>;
    }>;

export const DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS = 3;

export function resolveChipOptionInteraction<T extends string>(params: Readonly<{
    currentOptionId: T;
    selectableOptionIds: ReadonlyArray<T>;
    cycleMaxOptions: number;
}>): ChipOptionInteraction<T> {
    const selectable = params.selectableOptionIds;
    if (selectable.length === 0) {
        return {
            kind: 'none',
            selectableOptionIds: selectable,
        };
    }

    const clampedCycleMaxOptions = Math.max(1, Math.floor(params.cycleMaxOptions));
    if (selectable.length > clampedCycleMaxOptions) {
        return {
            kind: 'picker',
            selectableOptionIds: selectable,
        };
    }

    const currentIndex = selectable.indexOf(params.currentOptionId);
    if (currentIndex < 0) {
        return {
            kind: 'cycle',
            selectableOptionIds: selectable,
            nextOptionId: selectable[0]!,
        };
    }

    const nextOptionId = selectable[(currentIndex + 1) % selectable.length] ?? selectable[0]!;
    if (!nextOptionId || nextOptionId === params.currentOptionId) {
        return {
            kind: 'none',
            selectableOptionIds: selectable,
        };
    }

    return {
        kind: 'cycle',
        selectableOptionIds: selectable,
        nextOptionId,
    };
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
