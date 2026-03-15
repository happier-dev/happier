import React from 'react';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

function nodeContainsExactText(node: ReactTestInstance, value: string): boolean {
    return node.children.some((child) => {
        if (typeof child === 'string') return child === value;
        return nodeContainsExactText(child, value);
    });
}

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string): ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.props?.onPress === 'function' &&
        nodeContainsExactText(node, label)
    ))[0];
}

function findPressableByAccessibilityLabel(tree: renderer.ReactTestRenderer, label: string): ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.props?.onPress === 'function' &&
        typeof node.props?.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel === label
    ))[0];
}

function findSearchInput(tree: renderer.ReactTestRenderer): ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.props?.onChangeText === 'function' &&
        typeof node.props?.placeholder === 'string' &&
        node.props.placeholder === 'modelPickerOverlay.searchPlaceholder'
    ))[0];
}

function findTextNode(tree: renderer.ReactTestRenderer, value: string): ReactTestInstance | undefined {
    return tree.root.findAll((node) => nodeContainsExactText(node, value))[0];
}

function findNodeByAccessibilityLabel(tree: renderer.ReactTestRenderer, label: string): ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.props?.accessibilityLabel === 'string' && node.props.accessibilityLabel === label
    ))[0];
}

describe('ModelPickerOverlay', () => {
    it('selects a named option', async () => {
        const onSelect = vi.fn();
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={['note']}
                    options={[
                        { value: 'default', label: 'Default', description: 'd' },
                        { value: 'fast', label: 'Fast', description: 'f' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomModel={false}
                    onSelect={onSelect}
                />,
            );
        });

        const fastOption = findPressableByLabel(tree!, 'Fast');
        expect(fastOption).toBeTruthy();

        act(() => {
            fastOption?.props?.onPress?.();
        });

        expect(onSelect).toHaveBeenCalledWith('fast');
    });

    it('hides search input when option count is below threshold', async () => {
        const onSelect = vi.fn();
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: '' },
                        { value: 'fast', label: 'Fast', description: '' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomModel={false}
                    onSelect={onSelect}
                />,
            );
        });

        expect(findSearchInput(tree!)).toBeUndefined();
    });

    it('filters options through the search input and selects the filtered match', async () => {
        const onSelect = vi.fn();
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        const options = [
            { value: 'default', label: 'Default', description: '' },
            ...Array.from({ length: 20 }).map((_, idx) => ({
                value: `model-${idx}`,
                label: idx === 7 ? 'GPT-5.2' : `Model ${idx}`,
                description: '',
            })),
        ];

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={options}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomModel={false}
                    onSelect={onSelect}
                />,
            );
        });

        const searchInput = findSearchInput(tree!);
        expect(searchInput).toBeTruthy();

        act(() => {
            searchInput?.props?.onChangeText?.('gpt');
        });

        const gptOption = findPressableByLabel(tree!, 'GPT-5.2');
        expect(gptOption).toBeTruthy();

        act(() => {
            gptOption?.props?.onPress?.();
        });

        expect(onSelect).toHaveBeenCalledWith('model-7');
    });

    it('renders empty text when there are no options', async () => {
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[]}
                    selectedValue="default"
                    emptyText="No models available"
                    canEnterCustomModel={false}
                    onSelect={() => {}}
                />,
            );
        });

        expect(findTextNode(tree!, 'No models available')).toBeTruthy();
    });

    it('calls custom-model handler when custom option is enabled', async () => {
        const onRequestCustomModel = vi.fn();
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[
                        { value: 'default', label: 'Default', description: '' },
                    ]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomModel
                    customLabel="Custom model"
                    onRequestCustomModel={onRequestCustomModel}
                    onSelect={() => {}}
                />,
            );
        });

        const customOption = findPressableByLabel(tree!, 'Custom model');
        expect(customOption).toBeTruthy();

        act(() => {
            customOption?.props?.onPress?.();
        });

        expect(onRequestCustomModel).toHaveBeenCalledTimes(1);
    });

    it('shows a loading indicator when models are being probed', async () => {
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[{ value: 'default', label: 'Default', description: '' }]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomModel={false}
                    onSelect={() => {}}
                    probe={{ phase: 'loading' }}
                />,
            );
        });

        expect(findNodeByAccessibilityLabel(tree!, 'modelPickerOverlay.loadingModelsA11y')).toBeTruthy();
    });

    it('calls refresh handler from the picker when provided', async () => {
        const onRefresh = vi.fn();
        const { ModelPickerOverlay } = await import('./ModelPickerOverlay');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                <ModelPickerOverlay
                    title="Model"
                    effectiveLabel="Default"
                    notes={[]}
                    options={[{ value: 'default', label: 'Default', description: '' }]}
                    selectedValue="default"
                    emptyText="empty"
                    canEnterCustomModel={false}
                    onSelect={() => {}}
                    probe={{ phase: 'idle', onRefresh }}
                />,
            );
        });

        const refreshButton = findPressableByAccessibilityLabel(tree!, 'modelPickerOverlay.refreshModelsA11y');
        expect(refreshButton).toBeTruthy();

        act(() => {
            refreshButton?.props?.onPress?.();
        });

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });
});
