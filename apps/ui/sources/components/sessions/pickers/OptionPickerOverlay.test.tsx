import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { View } from 'react-native';
import { Text } from '@/components/ui/text/Text';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('OptionPickerOverlay', () => {
    it('selects a named option', async () => {
        const onSelect = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={['note']}
                    options={[
                        { value: 'default', label: 'Default', description: 'd' },
                        { value: 'fast', label: 'Fast', description: 'f' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={onSelect}
                />);

        expect(screen.findByTestId('model-picker-overlay-option:fast')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-summary')).toBeTruthy();

        await screen.pressByTestIdAsync('model-picker-overlay-option:fast');

        expect(onSelect).toHaveBeenCalledWith('fast');
    });

    it('hides search input when option count is below threshold', async () => {
        const onSelect = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: '' },
                        { value: 'fast', label: 'Fast', description: '' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={onSelect}
                />);

        expect(screen.findByTestId('model-picker-overlay-search')).toBeNull();
    });

    it('filters options through the search input and selects the filtered match', async () => {
        const onSelect = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const options = [
            { value: 'default', label: 'Default', description: '' },
            ...Array.from({ length: 20 }).map((_, idx) => ({
                value: `model-${idx}`,
                label: idx === 7 ? 'GPT-5.2' : `Model ${idx}`,
                description: '',
            })),
        ];

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={options}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={onSelect}
                />);

        expect(screen.findByTestId('model-picker-overlay-search')).toBeTruthy();
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-search', 'gpt');
        });

        expect(screen.findByTestId('model-picker-overlay-option:model-7')).toBeTruthy();
        await screen.pressByTestIdAsync('model-picker-overlay-option:model-7');

        expect(onSelect).toHaveBeenCalledWith('model-7');
    });

    it('renders empty text when there are no options', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[]}
                    selectedValue="default"
                    emptyText="No models available"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                />);

        expect(screen.getTextContent()).toContain('No models available');
    });

    it('captures and submits a trimmed inline custom model when enabled', async () => {
        const onSubmitCustomValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: '' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={() => {}}
                />);

        expect(screen.findByTestId('model-picker-overlay-custom')).toBeTruthy();
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeTruthy();
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', '  custom-model  ');
        });
        expect(screen.findByTestId('model-picker-overlay-custom-save')).toBeTruthy();
        await screen.pressByTestIdAsync('model-picker-overlay-custom-save');

        expect(onSubmitCustomValue).toHaveBeenCalledWith('custom-model');
    });

    it('shows a loading indicator when models are being probed', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[{ value: 'default', label: 'Default', description: '' }]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                    probe={{ phase: 'loading' }}
                />);

        expect(screen.findByProps({ accessibilityLabel: 'modelPickerOverlay.loadingModelsA11y' })).toBeTruthy();
    });

    it('calls refresh handler from the picker when provided', async () => {
        const onRefresh = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[{ value: 'default', label: 'Default', description: '' }]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                    probe={{ phase: 'idle', onRefresh }}
                />);

        expect(screen.findByTestId('model-picker-overlay-refresh')).toBeTruthy();
        expect(screen.findByProps({ accessibilityLabel: 'modelPickerOverlay.refreshModelsA11y' })).toBeTruthy();
        await screen.pressByTestIdAsync('model-picker-overlay-refresh');

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('renders selected model controls inside the selected model card and routes option changes', async () => {
        const onSelectOptionControlValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="gpt-5.4"
                    notes={[]}
                    options={[
                        { value: 'gpt-5.4', label: 'gpt-5.4', description: 'Latest frontier model.' },
                        { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini', description: 'Smaller model.' },
                    ]}
                    selectedValue="gpt-5.4"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    selectedOptionControls={[
                        {
                            option: {
                                id: 'reasoning_effort',
                                name: 'Thinking',
                                type: 'select',
                                currentValue: 'medium',
                                options: [
                                    { value: 'low', name: 'Low' },
                                    { value: 'medium', name: 'Medium' },
                                    { value: 'high', name: 'High' },
                                ],
                            },
                            effectiveValue: 'medium',
                            isPending: false,
                        },
                        {
                            option: {
                                id: 'speed',
                                name: 'Fast',
                                type: 'boolean',
                                currentValue: 'standard',
                                options: [
                                    { value: 'standard', name: 'Standard' },
                                    { value: 'fast', name: 'Fast' },
                                ],
                            },
                            effectiveValue: 'standard',
                            isPending: false,
                        },
                    ]}
                    onSelectOptionControlValue={onSelectOptionControlValue}
                    onSelect={() => {}}
                />);

        const selectedCard = screen.findByTestId('model-picker-overlay-option:gpt-5.4');
        expect(selectedCard).not.toBeNull();
        expect(
            selectedCard?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control:reasoning_effort'),
        ).not.toHaveLength(0);
        expect(
            selectedCard?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control:speed'),
        ).not.toHaveLength(0);

        await screen.pressByTestIdAsync('model-picker-overlay-selected-option-control-option:reasoning_effort:high');

        expect(onSelectOptionControlValue).toHaveBeenCalledWith('reasoning_effort', 'high');

        const speedControl = selectedCard?.findAll((node) => (
            node.props?.testID === 'model-picker-overlay-selected-option-control:speed'
        ))[0];
        const speedSwitch = speedControl?.findAll((node) => (
            typeof node.props?.onValueChange === 'function'
            && Object.prototype.hasOwnProperty.call(node.props, 'value')
        ))[0];

        expect(speedSwitch).toBeTruthy();
        expect(
            selectedCard?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control-switch:speed'),
        ).toHaveLength(1);

        await act(async () => {
            speedSwitch?.props.onValueChange?.(true);
        });

        expect(onSelectOptionControlValue).toHaveBeenCalledWith('speed', 'fast');
    });

    it('uses caller-provided search and refresh copy when supplied', async () => {
        const onRefresh = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Branches"
                    effectiveLabel="Current branch"
                    notes={[]}
                    options={Array.from({ length: 12 }).map((_, index) => ({
                        value: `branch-${index}`,
                        label: `Branch ${index}`,
                        description: '',
                    }))}
                    selectedValue="branch-0"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                    searchPlaceholder="Search branches…"
                    probe={{
                        phase: 'idle',
                        onRefresh,
                        refreshAccessibilityLabel: 'Refresh branches',
                    }}
                />);

        expect(screen.findByProps({ testID: 'model-picker-overlay-search' }).props.placeholder).toBe('Search branches…');

        expect(screen.findByProps({ testID: 'model-picker-overlay-refresh' }).props.accessibilityLabel).toBe('Refresh branches');
    });

    it('renders caller-provided summary content, header accessory, and option test id prefix', async () => {
        const onSelect = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Mode"
                    effectiveLabel=""
                    notes={[]}
                    options={[
                        { value: 'build', label: 'Build', description: 'Default behavior.' },
                        { value: 'review', label: 'Review', description: 'Review and critique mode.' },
                    ]}
                    selectedValue="build"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={onSelect}
                    testIDBase="agent-input-session-mode-overlay"
                    summary={<Text testID="agent-input-session-mode-summary">Build mode summary</Text>}
                    headerAccessory={<View testID="agent-input-session-mode-refresh" />}
                    optionTestIDPrefix="agent-input-session-mode-option"
                />);

        expect(screen.findByTestId('agent-input-session-mode-overlay')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-summary')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-refresh')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-option:review')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-overlay-option-selected-indicator:build')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-option-selected-indicator:build')).toBeNull();

        await screen.pressByTestIdAsync('agent-input-session-mode-option:review');

        expect(onSelect).toHaveBeenCalledWith('review');
    });
});
