import * as React from 'react';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { OptionPickerOption, OptionPickerSection } from './OptionPickerOverlay';

type OptionVisuals = Pick<SelectionListOption, 'icon' | 'rightAccessory' | 'rightAccessoryOutsidePressable'>;

/** Descriptor projection is separate from the mounted native row visuals. */
export function useOptionPickerSections<TValue>(input: Readonly<{
    sourceSections: readonly OptionPickerSection<TValue>[];
    getValueKey: (value: TValue) => string;
    optionTestIDPrefix: string;
    selectedControlsExpandedContent: SelectionListOption['expandedContent'];
    renderVisuals: (option: OptionPickerOption<TValue>, valueKey: string) => OptionVisuals;
    onPressIn: () => void;
}>): readonly SelectionListSectionDescriptor[] {
    const { sourceSections, getValueKey, optionTestIDPrefix,
        selectedControlsExpandedContent, renderVisuals, onPressIn } = input;
    return React.useMemo(() => {
        const seen = new Set<string>();
        return sourceSections.map(section => ({
            kind: 'static' as const,
            id: section.id,
            title: section.title,
            virtualization: 'auto' as const,
            options: section.options.flatMap((option): SelectionListOption[] => {
                const valueKey = getValueKey(option.value);
                if (seen.has(valueKey)) return [];
                seen.add(valueKey);
                return [{
                    id: valueKey,
                    testID: `${optionTestIDPrefix}:${valueKey}`,
                    label: option.label,
                    titleAccessory: option.titleAccessory,
                    ...(option.labelSuffix ? { titleQualifier: option.labelSuffix } : {}),
                    searchText: [option.searchText, option.labelSuffix].filter(Boolean).join(' '),
                    onPressIn,
                    subtitle: option.description,
                    subtitleLines: option.descriptionLines,
                    subtitleContent: option.descriptionContent,
                    accessibilityLabel: option.accessibilityLabel,
                    disabled: option.disabled,
                    ...renderVisuals(option, valueKey),
                    expandedContent: selectedControlsExpandedContent,
                }];
            }),
        }));
    }, [sourceSections, getValueKey, optionTestIDPrefix,
        selectedControlsExpandedContent, renderVisuals, onPressIn]);
}
