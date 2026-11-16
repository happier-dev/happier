import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { useOptionPickerSections } from './optionPickerSections';
import { foldUnavailableRows } from './foldUnavailableRows';
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

    it('lists every unavailable source in the folded group, each with its own status row (owner 11-15 C6)', async () => {
        // Two Team credential sources whose broker is down: each publishes one status row (no model value).
        type Value = string | null;
        const status = (key: string, label: string) => ({ value: null as Value, key, label, description: 'Broker offline',
            disabled: true, availability: 'unavailable' as const });
        const folded = foldUnavailableRows({
            sections: [
                { id: 'native', options: [{ value: 'model-a' as Value, label: 'Model A', availability: 'available' as const }] },
                { id: 'team-resource:t1:muse', options: [status('team-resource:t1:muse', 'Muse')] },
                { id: 'team-resource:t1:sonnet', options: [status('team-resource:t1:sonnet', 'Sonnet pool')] },
            ],
            isUnavailable: option => option.availability === 'unavailable',
            group: (options, title) => ({ id: 'unavailable', title, options }),
            title: 'Unavailable',
        });
        let sections: readonly SelectionListSectionDescriptor[] = [];
        function Picker() {
            sections = useOptionPickerSections<Value>({ sourceSections: folded, getValueKey: value => String(value),
                optionTestIDPrefix: 'model', selectedControlsExpandedContent: undefined, renderVisuals, onPressIn });
            return null;
        }
        await renderScreen(<Picker />);
        const unavailable = sections.find(section => section.id === 'unavailable');
        if (unavailable?.kind !== 'static') throw new Error('Expected the folded Unavailable group');
        expect(unavailable.title).toBe('Unavailable (2)');
        expect(unavailable.options.map(option => option.label)).toEqual(['Muse', 'Sonnet pool']);
    });
});
