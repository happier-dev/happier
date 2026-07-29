export type TerminalSelectionSnapshot = Readonly<{
    hasSelection: boolean;
    text: string;
}>;

export function readTerminalSelectionSnapshot(input: Readonly<{
    hasSelection?: () => boolean;
    getSelectionText?: () => string;
}>): TerminalSelectionSnapshot {
    const hasSelection = input.hasSelection?.() === true;
    return {
        hasSelection,
        text: hasSelection ? input.getSelectionText?.() ?? '' : '',
    };
}
