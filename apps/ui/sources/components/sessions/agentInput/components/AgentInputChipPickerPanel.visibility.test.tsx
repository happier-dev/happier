import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { computeSessionConfigOptionControlsForProvider } from '@/sync/domains/sessionControl/configOptionsControl';
import { AgentInputChipPickerPanel } from './AgentInputChipPickerPanel';
import { AgentInputEngineDetail } from './AgentInputEngineDetail';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('bounded engine presentation', () => {
    it('keeps selected-model effort inside the selected model card and applies its real choice', async () => {
        const onSelect = vi.fn();
        const controls = computeSessionConfigOptionControlsForProvider({ providerId: 'claude', overrides: null,
            configOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'low',
                options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] });
        const screen = await renderScreen(<AgentInputEngineDetail fillAvailableSpace
            modelOptions={Array.from({ length: 20 }, (_, i) => ({ value: `model-${i}`, label: `Model ${i}`, description: '' }))}
            selectedModelId="model-0" selectedModelOptionControls={controls} onSelectModelOptionValue={onSelect} />);
        expect(screen.findByTestId('model-picker-overlay-selection-list')?.findAllByProps({ testID: 'model-picker-overlay-selected-controls' }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('model-picker-overlay-selected-option-control-option:reasoning_effort:high');
        expect(onSelect).toHaveBeenCalledWith('reasoning_effort', 'high');
    });

    it('keeps the final agent row reachable in the bounded scrolling rail', async () => {
        const screen = await renderScreen(<AgentInputChipPickerPanel title="" showCloseButton={false}
            maxHeight={300} detailContentOwnsScroll selectedOptionId="agent-0" onSelect={() => {}} onRequestClose={() => {}}
            options={Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, label: `Agent ${i}`, detailContent: <View testID={`models-${i}`} /> }))} />);
        const rail = screen.findHostByTestId('agent-input-chip-picker.option-rail-scroll');
        expect(rail).not.toBeNull();
        await act(async () => {
            rail?.props.onLayout?.({ nativeEvent: { layout: { width: 190, height: 300, x: 0, y: 0 } } });
            rail?.props.onContentSizeChange?.(190, 600);
        });
        const fades = screen.findAllByType(ScrollEdgeFades);
        expect(fades.some((fade) => fade.props.edges.bottom === true)).toBe(true);
        await act(async () => {
            rail?.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 300 },
                contentSize: { width: 190, height: 600 }, layoutMeasurement: { width: 190, height: 300 } } });
        });
        expect(screen.findAllByType(ScrollEdgeFades).some((fade) => fade.props.edges.bottom === true)).toBe(false);
        await screen.pressByTestIdAsync('agent-input-chip-picker.option:agent-11');
        expect(screen.findByTestId('models-11')).not.toBeNull();
    });
});
