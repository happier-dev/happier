import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { View } from 'react-native';
import { Text } from '@/components/ui/text/Text';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 900 }),
        Dimensions: {
            get: () => ({ width: mockEnv.windowWidth, height: 900, scale: 1, fontScale: 1 }),
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('OptionPickerOverlay', () => {
    function flattenStyleFromCallback(
        styleProp: unknown,
        state: { pressed: boolean; hovered?: boolean },
    ): Record<string, unknown> {
        if (typeof styleProp !== 'function') {
            throw new Error('Expected style prop to be a function');
        }
        const resolved = (styleProp as (s: any) => unknown)(state);
        const resolvedArray = Array.isArray(resolved) ? resolved : [resolved];
        return Object.assign({}, ...resolvedArray.filter(Boolean));
    }

    function flattenStyle(styleProp: unknown): Record<string, unknown> {
        const resolvedArray = Array.isArray(styleProp) ? styleProp : [styleProp];
        return Object.assign({}, ...resolvedArray.filter(Boolean));
    }

    it('uses a single option-card column on narrow screens', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        mockEnv.windowWidth = 390;

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: 'd' },
                        { value: 'fast', label: 'Fast', description: 'f' },
                        { value: 'balanced', label: 'Balanced', description: 'b' },
                        { value: 'deep', label: 'Deep', description: 'x' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                />);

        expect(screen.findByTestId('model-picker-overlay-column:0')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-column:1')).toBeNull();
    });

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

    it('renders a loading hint when the probe is loading and only the default option is available', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[{ value: 'default', label: 'Default' }]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    probe={{ phase: 'loading', onRefresh: () => {} }}
                    onSelect={() => {}}
                />);

        expect(screen.getTextContent()).toContain('modelPickerOverlay.loadingModelsA11y');
    });

    it('commits a custom model on blur (no Save button) without pushing a value up-tree on each keystroke', async () => {
        const onSubmitCustomValue = vi.fn();
        const onSelect = vi.fn();
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
                    onSelect={onSelect}
                />);

        expect(screen.findByTestId('model-picker-overlay-custom')).toBeTruthy();
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeTruthy();

        // Typing must NOT commit up-tree per keystroke. Committing mid-type churns the
        // parent picker option list, which remounts this input and drops the keyboard.
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'c');
        });
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'custom-model');
        });
        expect(onSubmitCustomValue).not.toHaveBeenCalled();

        // There is no explicit Save button; commit happens on blur with the full value.
        expect(screen.findByTestId('model-picker-overlay-custom-save')).toBeNull();
        await act(async () => {
            screen.findByTestId('model-picker-overlay-custom-input')?.props.onBlur?.();
        });

        expect(onSubmitCustomValue).toHaveBeenCalledTimes(1);
        expect(onSubmitCustomValue).toHaveBeenCalledWith('custom-model');
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not commit typed custom text when a listed option is selected instead', async () => {
        const onSubmitCustomValue = vi.fn();
        let closeOnSelect = false;
        const host: { unmount: () => Promise<void> } = { unmount: async () => {} };
        const onSelect = vi.fn(() => {
            if (closeOnSelect) void host.unmount();
        });
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
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={onSelect}
                />);
        host.unmount = screen.unmount;

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'half-typed');
        });

        // A host that closes the picker on select unmounts inside the onSelect call, before the
        // passive effect that refreshes the pending-commit ref can run. The unmount flush must
        // already know the editor was abandoned, or it commits the half-typed id over the choice.
        closeOnSelect = true;
        await screen.pressByTestIdAsync('model-picker-overlay-option:fast');

        expect(onSelect).toHaveBeenCalledWith('fast');
        expect(onSubmitCustomValue).not.toHaveBeenCalled();
    });

    it('discards abandoned custom text when a listed option is selected', async () => {
        const onSubmitCustomValue = vi.fn();
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
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={onSelect}
                />);

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'half-typed');
        });
        await screen.pressByTestIdAsync('model-picker-overlay-option:fast');

        // Reopening the editor must not revive the abandoned text, or dismissing later would
        // commit it over the selection the user actually made.
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(screen.findByTestId('model-picker-overlay-custom-input')?.props.value).toBe('');

        await screen.unmount();
        expect(onSubmitCustomValue).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledWith('fast');
    });

    it('allows re-selecting the same custom model after picking a listed option', async () => {
        const onSubmitCustomValue = vi.fn();
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
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={() => {}}
                />);

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'my-model');
        });
        await act(async () => {
            screen.findByTestId('model-picker-overlay-custom-input')?.props.onSubmitEditing?.();
        });
        expect(onSubmitCustomValue).toHaveBeenCalledTimes(1);

        // Switching to a listed option abandons that custom selection, so choosing the same custom
        // id again is a real new selection — the commit de-dup must not swallow it.
        await screen.pressByTestIdAsync('model-picker-overlay-option:fast');
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'my-model');
        });
        await act(async () => {
            screen.findByTestId('model-picker-overlay-custom-input')?.props.onSubmitEditing?.();
        });

        expect(onSubmitCustomValue).toHaveBeenCalledTimes(2);
        expect(onSubmitCustomValue).toHaveBeenLastCalledWith('my-model');
    });

    it('discards abandoned custom text when the selection changes from outside the picker', async () => {
        const onSubmitCustomValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        let setSelected: ((next: string) => void) | null = null;
        function Host() {
            const [selectedValue, setSelectedValue] = React.useState('default');
            setSelected = setSelectedValue;
            return (
                <OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: '' },
                        { value: 'fast', label: 'Fast', description: '' },
                    ]}
                    selectedValue={selectedValue}
                    emptyText="empty"
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={() => {}}
                />
            );
        }

        const screen = await renderScreen(<Host />);
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'half-typed');
        });

        // The selection changes programmatically, not through the picker's own handler.
        await act(async () => {
            setSelected?.('fast');
        });

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(screen.findByTestId('model-picker-overlay-custom-input')?.props.value).toBe('');

        await screen.unmount();
        expect(onSubmitCustomValue).not.toHaveBeenCalled();
    });

    it('discards the draft when an external listed selection replaces an initially custom one', async () => {
        const onSubmitCustomValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        let setSelected: ((next: string) => void) | null = null;
        function Host() {
            const [selectedValue, setSelectedValue] = React.useState('my-model');
            setSelected = setSelectedValue;
            return (
                <OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: '' },
                        { value: 'fast', label: 'Fast', description: '' },
                    ]}
                    selectedValue={selectedValue}
                    emptyText="empty"
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={() => {}}
                />
            );
        }

        // Mounts with a custom model already selected, so the editor opens with reason
        // 'selected-custom' — the branch that returns early.
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('model-picker-overlay-custom-input')?.props.value).toBe('my-model');

        await act(async () => {
            setSelected?.('fast');
        });
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(screen.findByTestId('model-picker-overlay-custom-input')?.props.value).toBe('');

        await screen.unmount();
        expect(onSubmitCustomValue).not.toHaveBeenCalled();
    });

    it('does not commit the draft when blur is caused by tapping a listed option', async () => {
        const onSubmitCustomValue = vi.fn();
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
                    canEnterCustomValue
                    customLabel="Custom model"
                    onSubmitCustomValue={onSubmitCustomValue}
                    onSelect={onSelect}
                />);

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'half-typed');
        });

        // Tapping another control blurs the focused input first. Committing there would publish an
        // unintended intermediate model change before the option the user actually chose.
        await act(async () => {
            screen.findByTestId('model-picker-overlay-option:fast')?.props.onPressIn?.();
            screen.findByTestId('model-picker-overlay-custom-input')?.props.onBlur?.();
        });
        await screen.pressByTestIdAsync('model-picker-overlay-option:fast');

        expect(onSubmitCustomValue).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledWith('fast');
    });

    it('commits a typed custom model when the picker is dismissed without a blur', async () => {
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

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', 'custom-model');
        });
        expect(onSubmitCustomValue).not.toHaveBeenCalled();

        // Dismissing the overlay unmounts a still-focused input, which fires no blur on
        // either React Native or React Native Web — the typed id must not be lost.
        await screen.unmount();

        expect(onSubmitCustomValue).toHaveBeenCalledTimes(1);
        expect(onSubmitCustomValue).toHaveBeenCalledWith('custom-model');
    });

    it('matches and submits model identifiers as exact opaque values', async () => {
        const onSelect = vi.fn();
        const onSubmitCustomValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(
            <OptionPickerOverlay
                title="Models"
                options={[
                    { value: 'model-a', label: 'Plain' },
                    { value: ' model-a ', label: 'Spaced' },
                ]}
                selectedValue=" model-a "
                onSelect={onSelect}
                emptyText="No models"
                canEnterCustomValue
                customLabel="Custom model"
                onSubmitCustomValue={onSubmitCustomValue}
            />,
        );

        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
        expect(screen.findByTestId('model-picker-overlay-option-selected-indicator: model-a ')).toBeTruthy();
    });

    it('renders runtime status in the trailing indicator group without replacing a leading provider icon', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(
            <OptionPickerOverlay
                title="Models"
                summary="Last used: GPT 5.6 Terra"
                notes={['The selected model will be used when this session resumes.']}
                options={[
                    {
                        value: 'gpt-5.6-terra',
                        label: 'GPT 5.6 Terra',
                        icon: <View testID="provider-logo:terra" />,
                        trailingStatusIcon: <React.Fragment />,
                        accessibilityLabel: 'Last used: GPT 5.6 Terra',
                    },
                    { value: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
                ]}
                selectedValue="gpt-5.6-sol"
                onSelect={() => {}}
                emptyText="No models"
                canEnterCustomValue={false}
            />,
        );

        const terra = screen.findByTestId('model-picker-overlay-option:gpt-5.6-terra');
        const sol = screen.findByTestId('model-picker-overlay-option:gpt-5.6-sol');
        expect(terra?.props.accessibilityLabel).toBe('Last used: GPT 5.6 Terra');
        expect(terra?.props.accessibilityState).toEqual({ selected: false });
        expect(sol?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByTestId('model-picker-overlay-option-selected-indicator:gpt-5.6-terra')).toBeNull();
        expect(screen.findByTestId('model-picker-overlay-option-selected-indicator:gpt-5.6-sol')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-option-icon:gpt-5.6-terra')).toBeTruthy();
        expect(screen.findByTestId('provider-logo:terra')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-option-status-icon:gpt-5.6-terra')).toBeTruthy();
        expect(screen.getTextContent()).toContain('The selected model will be used when this session resumes.');
    });

    it('stacks the runtime-status icon below the checkmark when the selected model is also running', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(
            <OptionPickerOverlay
                title="Models"
                options={[
                    {
                        value: 'gpt-5.6-sol',
                        label: 'GPT 5.6 Sol',
                        trailingStatusIcon: <React.Fragment />,
                    },
                ]}
                selectedValue="gpt-5.6-sol"
                onSelect={() => {}}
                emptyText="No models"
                canEnterCustomValue={false}
            />,
        );

        const trailingGroup = screen.findByTestId('model-picker-overlay-option-selected-indicator:gpt-5.6-sol');
        expect(trailingGroup).toBeTruthy();
        expect(
            trailingGroup?.findAll((node) => node.props?.testID === 'model-picker-overlay-option-status-icon:gpt-5.6-sol'),
        ).toHaveLength(1);
    });

    it('keeps the custom editor open across parent rerenders while the selected listed value has not changed yet', async () => {
        const onSubmitCustomValue = vi.fn();
        const onSelect = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const renderOverlay = () => (
            <OptionPickerOverlay
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
                onSelect={onSelect}
            />
        );

        const screen = await renderScreen(renderOverlay());

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeTruthy();

        await act(async () => {
            screen.tree.update(renderOverlay());
        });

        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeTruthy();
    });

    it('shows the selected listed option after async options hydrate a previously custom-looking value', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const renderOverlay = (options: Array<{ value: string; label: string; description?: string }>) => (
            <OptionPickerOverlay
                title="Model"
                effectiveLabel="gpt-5.5"
                notes={[]}
                options={options}
                selectedValue="openai-codex/gpt-5.5"
                emptyText="empty"
                canEnterCustomValue
                customLabel="Custom model"
                onSelect={() => {}}
            />
        );

        const screen = await renderScreen(renderOverlay([
            { value: 'default', label: 'Default', description: '' },
        ]));

        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeTruthy();

        await act(async () => {
            screen.tree.update(renderOverlay([
                { value: 'default', label: 'Default', description: '' },
                { value: 'openai-codex/gpt-5.5', label: 'gpt-5.5', description: 'OpenAI' },
            ]));
        });

        expect(Boolean(screen.findByTestId('model-picker-overlay-custom-input'))).toBe(false);
        expect(Boolean(screen.findByTestId('model-picker-overlay-option-selected-indicator:openai-codex/gpt-5.5'))).toBe(true);
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

    it('keeps the refresh affordance inside the header row so it stays visible inside overflow-clipped surfaces', async () => {
        const onRefresh = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="Use CLI settings"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Use CLI settings', description: '' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                    headerAccessory={<View testID="model-picker-overlay-header-accessory" />}
                    probe={{ phase: 'idle', onRefresh }}
                />);

        const refresh = screen.findByTestId('model-picker-overlay-refresh');
        const headerAccessory = screen.findByTestId('model-picker-overlay-header-accessory');
        expect(refresh).toBeTruthy();
        expect(headerAccessory).toBeTruthy();
        expect(typeof refresh?.props.style).toBe('function');

        const resolved = refresh?.props.style({ pressed: false }) as unknown;
        const resolvedArray = Array.isArray(resolved) ? resolved : [resolved];
        const base = resolvedArray[0] as any;
        // If the refresh control is positioned outside the header row (e.g. negative right offsets),
        // it can be clipped by overflow-hidden popover surfaces (like agent-input pickers).
        expect(base?.right).toBeUndefined();
        expect(base?.position).not.toBe('absolute');

        // The refresh button and header accessory should stay together in the same
        // trailing title-row action group so the accessory does not float between
        // the title text and the refresh affordance.
        expect(headerAccessory?.parent?.parent).toBe(refresh?.parent);

        // The refresh button should still be part of the title row subtree.
        let cursor: any = refresh;
        let titleRow: any = null;
        for (let i = 0; i < 8 && cursor?.parent; i += 1) {
            cursor = cursor.parent;
            const style = cursor?.props?.style;
            if (!style) continue;
            const styleObject = Array.isArray(style)
                ? Object.assign({}, ...style.filter(Boolean))
                : style;
            if (
                styleObject
                && styleObject.flexDirection === 'row'
                && styleObject.alignItems === 'flex-start'
            ) {
                titleRow = cursor;
                break;
            }
        }

        expect(titleRow).toBeTruthy();
    });

    it('keeps selected model controls outside the option selection pressable and routes option changes', async () => {
        const onSelect = vi.fn();
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
                    onSelect={onSelect}
                />);

        const selectedOptionPressable = screen.findByTestId('model-picker-overlay-option:gpt-5.4');
        expect(selectedOptionPressable).not.toBeNull();
        const selectedCardContainer = screen.findByTestId('model-picker-overlay-option-container:gpt-5.4');
        expect(selectedCardContainer).not.toBeNull();
        const selectedCardContainerStyle = Object.assign(
            {},
            ...((Array.isArray(selectedCardContainer?.props.style)
                ? selectedCardContainer?.props.style
                : [selectedCardContainer?.props.style]).filter(Boolean)),
        );
        expect(selectedCardContainerStyle.alignSelf).toBe('stretch');
        expect(
            selectedOptionPressable?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control:reasoning_effort'),
        ).toHaveLength(0);
        expect(
            selectedOptionPressable?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control:speed'),
        ).toHaveLength(0);

        const selectedControls = screen.findByTestId('model-picker-overlay-option-controls:gpt-5.4');
        expect(selectedControls).not.toBeNull();
        expect(
            selectedControls?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control:reasoning_effort'),
        ).not.toHaveLength(0);
        expect(
            selectedControls?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control:speed'),
        ).not.toHaveLength(0);

        await screen.pressByTestIdAsync('model-picker-overlay-selected-option-control-option:reasoning_effort:high');

        expect(onSelectOptionControlValue).toHaveBeenCalledWith('reasoning_effort', 'high');
        expect(onSelect).not.toHaveBeenCalled();

        const speedControl = selectedControls?.findAll((node) => (
            node.props?.testID === 'model-picker-overlay-selected-option-control:speed'
        ))[0];
        const speedSwitch = speedControl?.findAll((node) => (
            typeof node.props?.onValueChange === 'function'
            && Object.prototype.hasOwnProperty.call(node.props, 'value')
        ))[0];

        expect(speedSwitch).toBeTruthy();
        expect(
            selectedControls?.findAll((node) => node.props?.testID === 'model-picker-overlay-selected-option-control-switch:speed'),
        ).not.toHaveLength(0);

        await act(async () => {
            speedSwitch?.props.onValueChange?.(true);
        });

        expect(onSelectOptionControlValue).toHaveBeenCalledWith('speed', 'fast');
    });

    it('renders option icons beside the model title and provider subtitle', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Favorites"
                    effectiveLabel="Fable 5"
                    notes={[]}
                    options={[
                        {
                            value: 'claude-fable-5',
                            label: 'Fable 5',
                            description: 'Claude',
                            icon: React.createElement('ProviderLogo', { testID: 'provider-logo:claude' }),
                        },
                    ]}
                    selectedValue="claude-fable-5"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    onSelect={() => {}}
                />);

        const option = screen.findByTestId('model-picker-overlay-option:claude-fable-5');
        expect(option).toBeTruthy();
        expect(option?.findAll((node) => node.props?.testID === 'model-picker-overlay-option-icon:claude-fable-5')).toHaveLength(1);
        expect(option?.findAll((node) => node.props?.testID === 'provider-logo:claude')).toHaveLength(1);
        expect(screen.findByTestId(
            'model-picker-overlay-option-selected-indicator:claude-fable-5',
        )).toBeTruthy();
        expect(option?.findAll((node) => (
            String(node.type) === 'Text' && node.props?.children === 'Fable 5'
        ))).toHaveLength(1);
        expect(option?.findAll((node) => (
            String(node.type) === 'Text' && node.props?.children === 'Claude'
        ))).toHaveLength(1);
    });

    it('renders boolean fast model controls as segmented choices', async () => {
        const onSelectOptionControlValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
                    title="Model"
                    effectiveLabel="composer"
                    notes={[]}
                    options={[{ value: 'composer', label: 'Composer', description: '' }]}
                    selectedValue="composer"
                    emptyText="empty"
                    canEnterCustomValue={false}
                    selectedOptionControls={[
                        {
                            option: {
                                id: 'fast',
                                name: 'Fast',
                                type: 'boolean',
                                currentValue: 'false',
                                options: [
                                    { value: 'false', name: 'Off' },
                                    { value: 'true', name: 'Fast' },
                                ],
                            },
                            effectiveValue: 'false',
                            isPending: false,
                        },
                    ]}
                    onSelectOptionControlValue={onSelectOptionControlValue}
                    onSelect={() => {}}
                />);

        expect(screen.findByTestId('model-picker-overlay-selected-option-control-switch:fast')).toBeNull();

        await screen.pressByTestIdAsync('model-picker-overlay-selected-option-control-option:fast:true');

        expect(onSelectOptionControlValue).toHaveBeenCalledWith('fast', 'true');
    });

    it('renders the favorite toggle only inside the selected option card and routes favorite changes separately from selection', async () => {
        const onSelect = vi.fn();
        const onToggleFavorite = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            effectiveLabel="GPT 5.4"
            notes={[]}
            options={[
                { value: 'gpt-5.4', label: 'GPT 5.4', description: 'Frontier model.' },
                { value: 'gpt-5.4-mini', label: 'GPT 5.4 Mini', description: 'Smaller model.' },
            ]}
            selectedValue="gpt-5.4"
            emptyText="empty"
            canEnterCustomValue={false}
            favoriteOptions={{
                values: new Set(['gpt-5.4']),
                onToggle: onToggleFavorite,
            }}
            onSelect={onSelect}
        />);

        expect(screen.findByTestId('model-picker-overlay-option-favorite:gpt-5.4')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-option-favorite:gpt-5.4-mini')).toBeNull();

        await screen.pressByTestIdAsync('model-picker-overlay-option-favorite:gpt-5.4');

        expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({
            value: 'gpt-5.4',
            label: 'GPT 5.4',
        }));
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps the favorite toggle hit target above option card content', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            effectiveLabel="GPT 5.4"
            notes={[]}
            options={[
                {
                    value: 'gpt-5.4',
                    label: 'GPT 5.4',
                    description: 'A long description that wraps under the right-side icon area.',
                },
            ]}
            selectedValue="gpt-5.4"
            emptyText="empty"
            canEnterCustomValue={false}
            favoriteOptions={{
                values: new Set(['gpt-5.4']),
                onToggle: vi.fn(),
            }}
            onSelect={vi.fn()}
        />);

        const indicator = screen.findByTestId('model-picker-overlay-option-selected-indicator:gpt-5.4');
        const indicatorStyle = flattenStyle(indicator?.props.style);

        expect(indicator?.props.pointerEvents).toBe('box-none');
        expect(indicatorStyle.zIndex).toBeGreaterThan(0);
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
                    summary={<Text testID="agent-input-session-mode-summary">Build mode summary</Text>}
                    headerAccessory={<View testID="agent-input-session-mode-refresh" />}
                    optionTestIDPrefix="agent-input-session-mode-option"
                />);

        expect(screen.findByTestId('agent-input-session-mode-summary')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-refresh')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-option:review')).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-session-mode-option:review');

        expect(onSelect).toHaveBeenCalledWith('review');
    });

    it('applies hover background styling to option cards on web', async () => {
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
            onSelect={() => {}}
        />);

        const card = screen.findByTestId('model-picker-overlay-option:review');
        if (!card) {
            throw new Error('Expected option card to render');
        }
        const base = flattenStyleFromCallback(card.props.style, { pressed: false, hovered: false });
        const hovered = flattenStyleFromCallback(card.props.style, { pressed: false, hovered: true });
        expect(hovered.backgroundColor).not.toBe(base.backgroundColor);
    });

    it('applies hover background styling to the custom option card on web', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            effectiveLabel=""
            notes={[]}
            options={[{ value: 'default', label: 'Default', description: '' }]}
            selectedValue="default"
            emptyText="empty"
            canEnterCustomValue
            onSelect={() => {}}
        />);

        const customCard = screen.findByTestId('model-picker-overlay-custom');
        if (!customCard) {
            throw new Error('Expected custom option card to render');
        }
        const base = flattenStyleFromCallback(customCard.props.style, { pressed: false, hovered: false });
        const hovered = flattenStyleFromCallback(customCard.props.style, { pressed: false, hovered: true });
        expect(hovered.backgroundColor).not.toBe(base.backgroundColor);
    });
});
