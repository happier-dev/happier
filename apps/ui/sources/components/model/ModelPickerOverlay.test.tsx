import React from 'react';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ModelPickerOverlay } from './ModelPickerOverlay';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function findSearchInput(tree: renderer.ReactTestRenderer): ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.props?.onChangeText === 'function' &&
        typeof node.props?.placeholder === 'string' &&
        node.props.placeholder.startsWith('Search models')
    ))[0];
}

function findTextNode(tree: renderer.ReactTestRenderer, value: string): ReactTestInstance | undefined {
    return tree.root.findAll((node) => nodeContainsExactText(node, value))[0];
}

describe('ModelPickerOverlay', () => {
    it('selects a named option', () => {
        const onSelect = vi.fn();

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

    it('hides search input when option count is below threshold', () => {
        const onSelect = vi.fn();

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

    it('filters options through the search input and selects the filtered match', () => {
        const onSelect = vi.fn();

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

    it('renders empty text when there are no options', () => {
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

    it('calls custom-model handler when custom option is enabled', () => {
        const onRequestCustomModel = vi.fn();

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
});
