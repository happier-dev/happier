export type SelectionListOptionA11yProps = Readonly<{
    id: string;
    role: 'option';
    'aria-selected': boolean;
    'aria-disabled'?: true;
    'aria-posinset': number;
    'aria-setsize': number;
    accessibilityState: Readonly<{ selected: boolean; disabled?: true }>;
    tabIndex: 0 | -1;
    accessibilityLabel?: string;
    'aria-label'?: string;
}>;

export function buildSelectionListOptionA11yProps(params: Readonly<{
    optionTestId: string;
    isSelected: boolean;
    disabled: boolean;
    positionInSet: number;
    setSize: number;
    accessibilityLabel?: string;
}>): SelectionListOptionA11yProps {
    const accessibilityLabel = params.accessibilityLabel?.trim() ?? '';
    const base = {
        id: params.optionTestId,
        role: 'option' as const,
        'aria-selected': params.isSelected,
        ...(params.disabled ? { 'aria-disabled': true as const } : {}),
        'aria-posinset': params.positionInSet,
        'aria-setsize': params.setSize,
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
