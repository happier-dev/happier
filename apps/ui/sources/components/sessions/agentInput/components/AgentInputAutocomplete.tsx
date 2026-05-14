import * as React from 'react';
import { View } from 'react-native';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import type { SelectionListOption, SelectionListStep } from '@/components/ui/selectionList/_types';
import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';

interface AgentInputAutocompleteProps {
    items: readonly AgentInputAutocompleteItem[];
    selectedIndex?: number;
    onSelect: (index: number) => void;
    maxHeight?: number;
}

export type AgentInputAutocompleteItem = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
    content?: React.ReactNode;
    minHeight?: number;
}>;

export const AgentInputAutocomplete = React.memo((props: AgentInputAutocompleteProps) => {
    const { items, selectedIndex = -1, onSelect, maxHeight = 240 } = props;

    if (items.length === 0) {
        return null;
    }

    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => (
        items.map((item) => ({
            id: item.id,
            label: item.label,
            subtitle: item.subtitle,
            content: item.content === undefined ? undefined : (
                <View style={{ minHeight: item.minHeight }}>
                    {item.content}
                </View>
            ),
        }))
    ), [items]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'root',
        sections: [
            {
                kind: 'static',
                id: 'suggestions',
                options,
                virtualization: 'never',
            },
        ],
    }), [options]);

    const selectedOptionId = selectedIndex >= 0 && selectedIndex < items.length
        ? items[selectedIndex]?.id ?? null
        : null;

    return (
        <AgentInputPopoverSurface
            maxHeight={maxHeight}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={false}
            edgeFades={false}
            edgeIndicators={false}
        >
            <SelectionList
                rootStep={rootStep}
                selectedOptionId={selectedOptionId}
                activeScrollOptionId={selectedOptionId}
                onSelect={(id) => {
                    const index = options.findIndex((option) => option.id === id);
                    if (index < 0) return;
                    onSelect(index);
                }}
                onRequestClose={() => {}}
                keyboardHintsEnabled={false}
                disableTransitions
                testID="agent-input-autocomplete"
                maxHeight={maxHeight}
            />
        </AgentInputPopoverSurface>
    );
});
