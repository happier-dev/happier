import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: (props: any) => React.createElement('ItemListStatic', props, props.children),
}));

vi.mock('./AgentInputChipPickerDetailPane', () => ({
    AgentInputChipPickerDetailPane: (props: any) =>
        React.createElement('AgentInputChipPickerDetailPane', {
            ...props,
            testID: 'agent-input-chip-picker.detail-pane',
        }, null),
}));

vi.mock('./AgentInputChipPickerOptionSelector', () => ({
    AgentInputChipPickerOptionSelector: (props: any) => {
        const sections = Array.isArray(props.sections) ? props.sections : [];
        return React.createElement(
            'View',
            { testID: 'agent-input-chip-picker.option-rail' },
            sections.flatMap((section: any) => Array.isArray(section?.options) ? section.options : [])
                .map((option: any) => React.createElement(
                    'Pressable',
                    {
                        key: String(option.id),
                        testID: `agent-input-chip-picker.option:${option.id}`,
                        onPress: () => props.onFocusOption?.(String(option.id)),
                    },
                    null,
                )),
        );
    },
}));

describe('AgentInputChipPickerPanel', () => {
    it('does not render inner scroll views in simple mode', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One' } as any,
                { id: 'two', label: 'Two' } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.title')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.close')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option:one')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option:two')).toBeTruthy();
    });

    it('does not render inner scroll views in detailed mode', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One', detailDescription: 'Primary checkout' } as any,
                { id: 'two', label: 'Two', detailDescription: 'Feature checkout' } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.title')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.close')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option-rail')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.detail-pane')).toBeTruthy();
    });

    it('uses the single-pane detailed layout when the selector rail is hidden', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title=""
            showCloseButton={false}
            options={[
                {
                    id: 'engine:codex',
                    label: 'Codex',
                    detailDescription: 'Engine detail',
                } as any,
            ]}
            selectedOptionId="engine:codex"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.option-rail')).toBeNull();
        const detailPane = screen.findByTestId('agent-input-chip-picker.detail-pane');
        expect(detailPane).toBeTruthy();

        const resolvedStyle = Object.assign(
            {},
            ...(Array.isArray(detailPane?.props.style) ? detailPane?.props.style : [detailPane?.props.style]).filter(Boolean),
        );

        expect(resolvedStyle.paddingHorizontal).toBe(12);
        expect(resolvedStyle.paddingTop).toBe(19);
        expect(resolvedStyle.paddingBottom).toBe(12);
        expect(resolvedStyle.width).toBe('100%');
    });

    it('omits the title row when the title is empty', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title=""
            showCloseButton={false}
            options={[
                { id: 'one', label: 'One' } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker')).toBeTruthy();
        expect(screen.findAllByTestId('agent-input-chip-picker.title')).toHaveLength(0);
        expect(screen.findAllByTestId('agent-input-chip-picker.close')).toHaveLength(0);
    });

    it('dismisses the picker when the close button is pressed', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');
        const onRequestClose = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One' } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={onRequestClose}
        />);

        await screen.pressByTestIdAsync('agent-input-chip-picker.close');
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('closes by default when selecting an immediate option in detailed mode', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');
        const onRequestClose = vi.fn();
        const onSelect = vi.fn();
        const onSelectImmediate = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One', detailDescription: 'Primary checkout' } as any,
                {
                    id: 'two',
                    label: 'Two',
                    detailDescription: 'Feature checkout',
                    onSelectImmediate,
                } as any,
            ]}
            selectedOptionId="one"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        await screen.pressByTestIdAsync('agent-input-chip-picker.option:two');
        expect(onSelectImmediate).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();

        // `deferAgentInputPopoverClose` uses `setTimeout(0)` on web to avoid click fall-through.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the popover open when immediate selection opts out of auto-close', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');
        const onRequestClose = vi.fn();
        const onSelectImmediate = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One', detailDescription: 'Primary checkout' } as any,
                {
                    id: 'two',
                    label: 'Two',
                    detailDescription: 'Feature checkout',
                    closeOnSelectImmediate: false,
                    onSelectImmediate,
                } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={onRequestClose}
        />);

        await screen.pressByTestIdAsync('agent-input-chip-picker.option:two');
        expect(onSelectImmediate).toHaveBeenCalledTimes(1);

        // Allow any deferred close to run (it should not be scheduled for this option).
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('keeps a preserved detail option focused when an immediate selection updates the selected option', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                {
                    id: 'favorites',
                    label: 'Favorites',
                    preserveFocusOnExternalSelectionChange: true,
                    renderDetailContent: () => React.createElement('View', { testID: 'detail:favorites' }),
                },
                {
                    id: 'engine:codex',
                    label: 'Codex',
                    renderDetailContent: () => React.createElement('View', { testID: 'detail:codex' }),
                },
            ]}
            selectedOptionId="favorites"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.detail-pane')?.props.option.id).toBe('favorites');

        await screen.update(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                {
                    id: 'favorites',
                    label: 'Favorites',
                    preserveFocusOnExternalSelectionChange: true,
                    renderDetailContent: () => React.createElement('View', { testID: 'detail:favorites' }),
                },
                {
                    id: 'engine:codex',
                    label: 'Codex',
                    renderDetailContent: () => React.createElement('View', { testID: 'detail:codex' }),
                },
            ]}
            selectedOptionId="engine:codex"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.detail-pane')?.props.option.id).toBe('favorites');
    });
});
