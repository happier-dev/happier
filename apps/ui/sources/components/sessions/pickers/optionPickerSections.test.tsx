import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { useOptionPickerSections } from './optionPickerSections';
import { OptionPickerSelectedControlsContext } from './optionPickerSelectedControlsState';

const getValueKey = (value: string) => value;
const renderVisuals = () => ({});
const onPressIn = () => {};

function ControlReading() {
    const { controls } = React.useContext(OptionPickerSelectedControlsContext);
    return React.createElement('output', { value: controls?.[0]?.effectiveValue });
}
const controlReading = <ControlReading />;

describe('Option picker descriptor publication', () => {
    it('keeps catalog descriptors stable while current control values and selection reach the mounted leaf', async () => {
        let unrelatedLabelReads = 0;
        // Constructed catalog shape; no claim about a real Account census.
        const options = Array.from({ length: 400 }, (_, index) => ({ value: `model-${index}`,
            get label() { if (index > 1) unrelatedLabelReads += 1; return `Model ${index}`; } }));
        const sourceSections = [{ id: 'models', options }];
        let sections: readonly SelectionListSectionDescriptor[] = [];
        function Picker(props: { value: 'low' | 'high'; selectedIndex: number }) {
            sections = useOptionPickerSections({ sourceSections, getValueKey, optionTestIDPrefix: 'model',
                selectedControlsExpandedContent: controlReading, renderVisuals, onPressIn });
            const section = sections[0];
            if (section?.kind !== 'static') throw new Error('Expected static model catalog');
            const content = section.options[props.selectedIndex]?.expandedContent;
            if (typeof content === 'function') throw new Error('Expected mounted controls');
            return <OptionPickerSelectedControlsContext.Provider value={{ controls: [{
                option: { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: props.value,
                    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
                effectiveValue: props.value, isPending: false,
            }] }}>{content}</OptionPickerSelectedControlsContext.Provider>;
        }
        const screen = await renderScreen(<Picker value="low" selectedIndex={0} />);
        const baseline = sections;
        unrelatedLabelReads = 0;
        await screen.update(<Picker value="high" selectedIndex={0} />);
        expect(screen.tree.root.findByType('output').props.value).toBe('high');
        expect(sections).toBe(baseline);
        await screen.update(<Picker value="low" selectedIndex={1} />);
        expect(screen.tree.root.findByType('output').props.value).toBe('low');
        expect(sections).toBe(baseline);
        expect(unrelatedLabelReads).toBe(0);
    });
});
