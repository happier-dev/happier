export type SelectionListOptionA11yProps = Readonly<{
    id: string;
    role: 'option';
    'aria-selected': boolean;
    accessibilityLabel?: string;
    'aria-label'?: string;
}>;

export function buildSelectionListOptionA11yProps(params: Readonly<{
    optionTestId: string;
    isSelected: boolean;
    accessibilityLabel?: string;
}>): SelectionListOptionA11yProps {
    const accessibilityLabel = params.accessibilityLabel?.trim() ?? '';
    const base = {
        id: params.optionTestId,
        role: 'option' as const,
        'aria-selected': params.isSelected,
    };
    if (!accessibilityLabel) return base;
    return {
        ...base,
        accessibilityLabel,
        'aria-label': accessibilityLabel,
    };
}
