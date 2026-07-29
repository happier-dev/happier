import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { View } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SelectionList } from '@/components/ui/selectionList';


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

describe('OptionPickerOverlay', () => {
    function flattenStyle(style: unknown): Record<string, unknown> {
        if (!Array.isArray(style)) {
            return (style ?? {}) as Record<string, unknown>;
        }

        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...(entry ?? {}),
        }), {});
    }

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

    function resolveInteractiveStyle(styleProp: unknown): Record<string, unknown> {
        return flattenStyle(typeof styleProp === 'function'
            ? (styleProp as (state: Readonly<{ pressed: boolean; hovered: boolean; focused: boolean }>) => unknown)({
                pressed: false,
                hovered: false,
                focused: false,
            })
            : styleProp);
    }

    function hasAncestor(node: any, possibleAncestor: any): boolean {
        let current = node?.parent;
        while (current) {
            if (current === possibleAncestor) return true;
            current = current.parent;
        }
        return false;
    }

    function findInteractiveAncestor(node: any): any | null {
        let current = node?.parent;
        while (current) {
            if (String(current.type) === 'Pressable' || current.props?.accessibilityRole === 'button') {
                return current;
            }
            current = current.parent;
        }
        return null;
    }

    it('carries typed values with the same model id by their exact stable key', async () => {
        type ModelRef = Readonly<{
            agentTargetKey: string;
            providerConnectionId: string | null;
            modelId: string;
        }>;
        const native: ModelRef = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'shared-model',
        };
        const external: ModelRef = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'connection-work',
            modelId: 'shared-model',
        };
        const onSelect = vi.fn();
        const onToggle = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const getValueKey = (value: ModelRef) => JSON.stringify([
            value.agentTargetKey,
            value.providerConnectionId,
            value.modelId,
        ]);
        const externalKey = getValueKey(external);
        const screen = await renderScreen(
            <OptionPickerOverlay<ModelRef>
                title="Model"
                options={[]}
                sections={[
                    {
                        id: 'native',
                        title: 'Built-in',
                        options: [{ value: native, label: 'Shared model' }],
                    },
                    {
                        id: 'work',
                        title: 'OpenRouter · Work',
                        options: [{ value: external, label: 'Shared model' }],
                    },
                ]}
                selectedValue={native}
                getValueKey={getValueKey}
                emptyText="empty"
                canEnterCustomValue={false}
                favoriteOptions={{
                    values: new Set([externalKey]),
                    onToggle,
                }}
                onSelect={onSelect}
            />,
        );

        expect(screen.findByTestId('model-picker-overlay-selection-list')).toBeTruthy();
        await screen.pressByTestIdAsync(`model-picker-overlay-option:${externalKey}`);
        expect(onSelect).toHaveBeenCalledWith(external);

        await screen.pressByTestIdAsync(`model-picker-overlay-option-favorite:${externalKey}`);
        expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ value: external }));
    });

    it('keeps the inline custom editor available for typed callers without reconstructing a typed value', async () => {
        type ModelRef = Readonly<{
            agentTargetKey: string;
            providerConnectionId: string | null;
            modelId: string;
        }>;
        const selected: ModelRef = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'connection-work',
            modelId: 'listed-model',
        };
        const onSubmitCustomValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(
            <OptionPickerOverlay<ModelRef>
                title="Model"
                options={[{ value: selected, label: 'Listed model' }]}
                selectedValue={selected}
                getValueKey={(value) => JSON.stringify([
                    value.agentTargetKey,
                    value.providerConnectionId,
                    value.modelId,
                ])}
                emptyText="empty"
                canEnterCustomValue
                onSubmitCustomValue={onSubmitCustomValue}
                onSelect={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        act(() => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', '  unlisted-model  ');
        });
        expect(onSubmitCustomValue).toHaveBeenCalledWith('unlisted-model');
    });

    it('replaces the custom row action with the text input so interactive controls never nest', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            options={[{ value: 'default', label: 'Default' }]}
            selectedValue="default"
            emptyText="empty"
            canEnterCustomValue
            onSelect={() => {}}
        />);

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        const customInput = screen.findByTestId('model-picker-overlay-custom-input');
        expect(customInput).toBeTruthy();
        expect(findInteractiveAncestor(customInput)).toBeNull();
    });

    it('moves focus into the named 44px custom input and returns it to the trigger on Escape', async () => {
        const triggerFocus = vi.fn();
        const inputFocus = vi.fn();
        const onSubmitCustomValue = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            options={[{ value: 'default', label: 'Default' }]}
            selectedValue="default"
            emptyText="empty"
            canEnterCustomValue
            onSubmitCustomValue={onSubmitCustomValue}
            onSelect={() => {}}
        />, {
            createNodeMock: (element) => {
                const elementProps = element.props as { testID?: string };
                if (elementProps.testID === 'model-picker-overlay-custom') return { focus: triggerFocus };
                if (elementProps.testID === 'model-picker-overlay-custom-input') return { focus: inputFocus };
                return {};
            },
        });

        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        expect(inputFocus).toHaveBeenCalledOnce();

        const input = screen.findByTestId('model-picker-overlay-custom-input');
        expect(input?.props.accessibilityLabel).toBe('modelPickerOverlay.customInputA11y');
        const inputStyle = flattenStyle(input?.props.style);
        expect(inputStyle.minHeight ?? inputStyle.height).toBeGreaterThanOrEqual(44);

        const escapeEvent = {
            key: 'Escape',
            nativeEvent: { key: 'Escape' },
            preventDefault: vi.fn(),
        };
        await act(async () => input?.props.onKeyDown?.(escapeEvent));

        expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
        expect(screen.findByTestId('model-picker-overlay-custom')).toBeTruthy();
        expect(triggerFocus).toHaveBeenCalledOnce();
        expect(onSubmitCustomValue).not.toHaveBeenCalled();
    });

    it('keeps an already-selected custom value closed after Escape and returns focus to its trigger', async () => {
        const triggerFocus = vi.fn();
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            options={[{ value: 'default', label: 'Default' }]}
            selectedValue="unlisted-model"
            emptyText="empty"
            canEnterCustomValue
            onSelect={() => {}}
        />, {
            createNodeMock: (element) => {
                const elementProps = element.props as { testID?: string };
                if (elementProps.testID === 'model-picker-overlay-custom') return { focus: triggerFocus };
                return {};
            },
        });

        const input = screen.findByTestId('model-picker-overlay-custom-input');
        expect(input).toBeTruthy();

        await act(async () => input?.props.onKeyDown?.({
            key: 'Escape',
            nativeEvent: { key: 'Escape' },
            preventDefault: vi.fn(),
        }));

        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
        expect(screen.findByTestId('model-picker-overlay-custom')?.props.accessibilityRole).toBe('button');
        expect(triggerFocus).toHaveBeenCalledOnce();
    });

    it('owns custom-editor Escape ahead of the enclosing popover capture layer', async () => {
        const triggerFocus = vi.fn();
        const enclosingPopoverEscape = vi.fn(() => true);
        const {
            dispatchEscapeToLayerStack,
            ESCAPE_LAYER_PRIORITIES,
            registerEscapeLayer,
        } = await import('@/keyboard/escape');
        const unregisterPopover = registerEscapeLayer({
            priority: ESCAPE_LAYER_PRIORITIES.popover,
            allowEditableTarget: true,
            onEscape: enclosingPopoverEscape,
        });

        try {
            const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
            const screen = await renderScreen(<OptionPickerOverlay
                title="Model"
                options={[{ value: 'default', label: 'Default' }]}
                selectedValue="default"
                emptyText="empty"
                canEnterCustomValue
                onSelect={() => {}}
            />, {
                createNodeMock: (element) => {
                    const elementProps = element.props as { testID?: string };
                    if (elementProps.testID === 'model-picker-overlay-custom') return { focus: triggerFocus };
                    return {};
                },
            });

            await screen.pressByTestIdAsync('model-picker-overlay-custom');
            const escapeEvent = {
                key: 'Escape',
                target: { tagName: 'INPUT' },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
                stopImmediatePropagation: vi.fn(),
            };
            await act(async () => {
                expect(dispatchEscapeToLayerStack(escapeEvent)).toBe(true);
            });

            expect(enclosingPopoverEscape).not.toHaveBeenCalled();
            expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
            expect(triggerFocus).toHaveBeenCalledOnce();

            await act(async () => {
                expect(dispatchEscapeToLayerStack({
                    key: 'Escape',
                    target: { tagName: 'BUTTON' },
                    preventDefault: vi.fn(),
                    stopPropagation: vi.fn(),
                    stopImmediatePropagation: vi.fn(),
                })).toBe(true);
            });
            expect(enclosingPopoverEscape).toHaveBeenCalledOnce();
        } finally {
            unregisterPopover();
        }
    });

    it('uses the canonical selection list instead of a local column renderer on narrow screens', async () => {
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

        expect(screen.findByTestId('model-picker-overlay-selection-list')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-column:0')).toBeNull();
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

    it('updates the custom value immediately (no Save button) when entering a custom model', async () => {
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
        await act(async () => {
            screen.changeTextByTestId('model-picker-overlay-custom-input', '  custom-model  ');
        });

        expect(screen.findByTestId('model-picker-overlay-custom-save')).toBeNull();
        expect(onSubmitCustomValue).toHaveBeenCalledWith('custom-model');
        expect(onSelect).not.toHaveBeenCalled();
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

    it('keeps the fallback model-list scope stable across non-structural parent rerenders', async () => {
        await withPopoverWebGlobals(async () => {
        const options = Array.from({ length: 100 }, (_, index) => ({
            value: `model-${index}`,
            label: `Model ${index}`,
        }));
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const renderOverlay = (
            effectiveLabel: string,
            renderedOptions = options,
        ) => (
            <OptionPickerOverlay
                title="Model"
                effectiveLabel={effectiveLabel}
                options={renderedOptions}
                selectedValue="model-0"
                emptyText="empty"
                canEnterCustomValue={false}
                onSelect={() => {}}
            />
        );
        const screen = await renderScreen(renderOverlay('Model 0'));
        const rootStepBefore = screen.findByType(SelectionList).props.rootStep;

        await act(async () => {
            screen.tree.update(renderOverlay('Model 0 · refreshed'));
        });

        expect(screen.findByType(SelectionList).props.rootStep).toBe(rootStepBefore);

        await act(async () => {
            screen.tree.update(renderOverlay('Model 0 · refreshed', [
                ...options,
                { value: 'model-100', label: 'Model 100' },
            ]));
        });

        expect(screen.findByType(SelectionList).props.rootStep).not.toBe(rootStepBefore);
        });
    });

    it('keeps the explicitly sectioned model-list scope stable across non-structural parent rerenders', async () => {
        await withPopoverWebGlobals(async () => {
        const sections = [{
            id: 'provider-models',
            title: 'Provider models',
            options: Array.from({ length: 100 }, (_, index) => ({
                value: `model-${index}`,
                label: `Model ${index}`,
            })),
        }];
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const renderOverlay = (
            effectiveLabel: string,
            renderedSections = sections,
        ) => (
            <OptionPickerOverlay
                title="Model"
                effectiveLabel={effectiveLabel}
                options={[]}
                sections={renderedSections}
                selectedValue="model-0"
                emptyText="empty"
                canEnterCustomValue={false}
                onSelect={() => {}}
            />
        );
        const screen = await renderScreen(renderOverlay('Model 0'));
        const rootStepBefore = screen.findByType(SelectionList).props.rootStep;

        await act(async () => {
            screen.tree.update(renderOverlay('Model 0 · refreshed'));
        });

        expect(screen.findByType(SelectionList).props.rootStep).toBe(rootStepBefore);

        await act(async () => {
            screen.tree.update(renderOverlay('Model 0 · refreshed', [{
                ...sections[0]!,
                options: [
                    ...sections[0]!.options,
                    { value: 'model-100', label: 'Model 100' },
                ],
            }]));
        });

        expect(screen.findByType(SelectionList).props.rootStep).not.toBe(rootStepBefore);
        });
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
        expect(hasAncestor(refresh, headerAccessory?.parent?.parent)).toBe(true);

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

    it('renders selected model controls beside the selected row and routes option changes without nested actions', async () => {
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
        const selectedControls = screen.findByTestId('model-picker-overlay-selected-controls');
        expect(selectedControls).toBeTruthy();
        expect(hasAncestor(selectedControls, selectedCard)).toBe(false);

        const selectedReasoningLabel = screen
            .findByTestId('model-picker-overlay-selected-option-control-option:reasoning_effort:medium')
            ?.findByType('Text' as never);

        expect(selectedReasoningLabel).toBeTruthy();
        expect(flattenStyle(selectedReasoningLabel?.props.style)).toMatchObject(Typography.default('semiBold'));

        await screen.pressByTestIdAsync('model-picker-overlay-selected-option-control-option:reasoning_effort:high');

        expect(onSelectOptionControlValue).toHaveBeenCalledWith('reasoning_effort', 'high');

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
        expect(findInteractiveAncestor(speedSwitch)).toBeNull();

        const speedSwitchTarget = screen.findByTestId('model-picker-overlay-selected-option-control-switch:speed');
        expect(speedSwitchTarget?.props.accessibilityLabel).toBe('modelPickerOverlay.optionControlA11y');

        const reasoningTab = screen.findByTestId('model-picker-overlay-selected-option-control-option:reasoning_effort:medium');
        expect(reasoningTab?.props.accessibilityLabel).toBe('Medium');
        expect(reasoningTab?.parent?.props.accessibilityLabel).toBe('modelPickerOverlay.optionControlA11y');

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

    it('renders runtime status in the trailing selection-status group without replacing a leading provider icon', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
            title="Models"
            options={[
                {
                    value: 'gpt-5.6-terra',
                    label: 'GPT 5.6 Terra',
                    icon: <View testID="provider-logo:terra" />,
                    trailingStatusIcon: <View testID="runtime-status:terra" />,
                },
                { value: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
            ]}
            selectedValue="gpt-5.6-sol"
            emptyText="empty"
            canEnterCustomValue={false}
            onSelect={vi.fn()}
        />);

        expect(screen.findByTestId('model-picker-overlay-option-icon:gpt-5.6-terra')).toBeTruthy();
        expect(screen.findByTestId('provider-logo:terra')).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-option-status-icon:gpt-5.6-terra')).toBeTruthy();
        expect(screen.findByTestId('runtime-status:terra')).toBeTruthy();
    });

    it('stacks runtime status below the checkmark when the selected model is also running', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

        const screen = await renderScreen(<OptionPickerOverlay
            title="Models"
            options={[
                {
                    value: 'gpt-5.6-sol',
                    label: 'GPT 5.6 Sol',
                    trailingStatusIcon: <View testID="runtime-status:sol" />,
                },
            ]}
            selectedValue="gpt-5.6-sol"
            emptyText="empty"
            canEnterCustomValue={false}
            onSelect={vi.fn()}
        />);

        const statusGroup = screen.findByTestId('model-picker-overlay-option-selection-status:gpt-5.6-sol');
        const statusIcon = screen.findByTestId('model-picker-overlay-option-status-icon:gpt-5.6-sol');
        expect(statusGroup).toBeTruthy();
        expect(statusIcon?.parent).toBe(statusGroup);
        expect(statusGroup?.children).toHaveLength(2);
    });

    it('renders the favorite toggle only beside the selected option row and routes favorite changes separately from selection', async () => {
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

    it('uses sibling 44px favorite and refresh actions with translated names and focus tooltips', async () => {
        const { OptionPickerOverlay } = await import('./OptionPickerOverlay');
        const screen = await renderScreen(<OptionPickerOverlay
            title="Model"
            options={[{
                value: 'gpt-5.4',
                label: 'GPT 5.4',
                description: 'Frontier model.',
                accessibilityLabel: 'Gateway, Work, GPT 5.4',
            }]}
            selectedValue="gpt-5.4"
            emptyText="empty"
            canEnterCustomValue={false}
            favoriteOptions={{ values: new Set(['gpt-5.4']), onToggle: vi.fn() }}
            probe={{ phase: 'idle', onRefresh: vi.fn() }}
            onSelect={vi.fn()}
        />);

        const row = screen.findByTestId('model-picker-overlay-option:gpt-5.4');
        const favoriteAction = screen.findByTestId('model-picker-overlay-option-favorite:gpt-5.4');
        expect(row).toBeTruthy();
        expect(favoriteAction).toBeTruthy();
        expect(hasAncestor(favoriteAction, row)).toBe(false);
        expect(favoriteAction?.props.accessibilityLabel).toBe('Gateway, Work, GPT 5.4, profiles.actions.removeFromFavorites');

        for (const action of [favoriteAction, screen.findByTestId('model-picker-overlay-refresh')]) {
            const targetStyle = resolveInteractiveStyle(action?.props.style);
            expect(targetStyle.width ?? targetStyle.minWidth).toBeGreaterThanOrEqual(44);
            expect(targetStyle.height ?? targetStyle.minHeight).toBeGreaterThanOrEqual(44);
            expect(typeof action?.props.onFocus).toBe('function');
            await act(async () => {
                action?.props.onFocus?.();
            });
            expect(screen.findByTestId(`${action?.props.testID}-tooltip`)).toBeTruthy();
            await act(async () => {
                action?.props.onBlur?.();
            });
        }
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
                    notes={['The selected model will be used when this session resumes.']}
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
        expect(screen.getTextContent()).toContain('The selected model will be used when this session resumes.');
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
        await act(async () => {
            card.props.onHoverIn?.();
        });
        const hoveredCard = screen.findByTestId('model-picker-overlay-option:review');
        const hovered = flattenStyleFromCallback(hoveredCard?.props.style, { pressed: false, hovered: true });
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
