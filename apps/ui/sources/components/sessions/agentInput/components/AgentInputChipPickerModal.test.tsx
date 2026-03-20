import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { AgentInputChipPickerModal } from './AgentInputChipPickerModal';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockWindowDimensions } = vi.hoisted(() => ({
    mockWindowDimensions: {
        width: 800,
        height: 600,
        scale: 2,
        fontScale: 1,
    },
}));

afterAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(() => {
    mockWindowDimensions.width = 800;
    mockWindowDimensions.height = 600;
    mockWindowDimensions.scale = 2;
    mockWindowDimensions.fontScale = 1;
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', async () => {
    const actual = await import('@/dev/reactNativeStub');
    return {
        ...actual,
        Dimensions: {
            ...actual.Dimensions,
            get: () => mockWindowDimensions,
        },
        useWindowDimensions: () => mockWindowDimensions,
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
                surface: '#fff',
                divider: '#ddd',
                backgroundSecondary: '#f5f5f5',
                card: { background: '#f8f8f8' },
                status: { connected: '#0f0' },
                button: {
                    primary: { background: '#00f', tint: '#fff' },
                },
                groupped: {
                    background: '#f2f2f2',
                    border: '#ddd',
                    separator: '#eee',
                    sectionTitle: '#777',
                },
                input: {
                    background: '#fafafa',
                },
            },
        },
    }),
    StyleSheet: { create: (factory: any) => factory({
        colors: {
            text: '#111',
            textSecondary: '#666',
            surface: '#fff',
            divider: '#ddd',
            backgroundSecondary: '#f5f5f5',
            card: { background: '#f8f8f8' },
            status: { connected: '#0f0' },
            button: {
                primary: { background: '#00f', tint: '#fff' },
            },
            groupped: {
                background: '#f2f2f2',
                border: '#ddd',
                separator: '#eee',
                sectionTitle: '#777',
            },
            input: {
                background: '#fafafa',
            },
        },
    }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown> & {
        open?: boolean;
        onOpenChange?: (next: boolean) => void;
        trigger?: React.ReactNode | ((props: {
            open: boolean;
            toggle: () => void;
            openMenu: () => void;
            closeMenu: () => void;
            selectedItem: unknown;
        }) => React.ReactNode);
        children?: React.ReactNode;
    }) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({
                open: Boolean(props.open),
                toggle: () => props.onOpenChange?.(!props.open),
                openMenu: () => props.onOpenChange?.(true),
                closeMenu: () => props.onOpenChange?.(false),
                selectedItem: null,
            })
            : props.trigger;
        return React.createElement('DropdownMenu', props, trigger, props.children);
    },
}));

vi.mock('./AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

describe('AgentInputChipPickerModal', () => {
    it('selects immediately in the simple single-column mode', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        { id: 'one', label: 'One' },
                        { id: 'two', label: 'Two' },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const item = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            item.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalled();
    });

    it('uses the detail pane and explicit apply action when options include detail metadata', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Primary',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Primary checkout',
                        },
                        {
                            id: 'two',
                            label: 'Feature',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Feature checkout',
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const option = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            option.props.onPress();
        });

        expect(onSelect).not.toHaveBeenCalled();

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalled();
    });

    it('switches detailed mode to the stacked top selector on narrow screens without changing apply semantics', async () => {
        mockWindowDimensions.width = 420;
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Primary',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Primary checkout',
                        },
                        {
                            id: 'two',
                            label: 'Feature',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Feature checkout',
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        expect(tree!.root.findAllByProps({ testID: 'agent-input-chip-picker.top-selector' })).toHaveLength(1);
        expect(tree!.root.findAllByProps({ testID: 'agent-input-chip-picker.option-rail' })).toHaveLength(0);
        expect(tree!.root.findAllByProps({ testID: 'agent-input-chip-picker.top-selector-trigger' })).toHaveLength(1);
        expect(tree!.root.findAllByProps({ testID: 'agent-input-chip-picker.option:two' })).toHaveLength(0);

        const dropdown = tree!.root.findByType('DropdownMenu' as any);
        await act(async () => {
            dropdown.props.onSelect('two');
        });

        expect(onSelect).not.toHaveBeenCalled();

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalled();
    });

    it('prefers the option-specific apply handler over the shared onSelect callback', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const optionApply = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Primary',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Primary checkout',
                        },
                        {
                            id: 'two',
                            label: 'Feature',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Feature checkout',
                            onApply: optionApply,
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const option = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            option.props.onPress();
        });

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(optionApply).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it('keeps immediate selection when options only provide section headers', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Primary',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                        },
                        {
                            id: 'two',
                            label: 'Feature',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const option = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            option.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(tree!.root.findAllByProps({ testID: 'agent-input-chip-picker.apply' })).toHaveLength(0);
    });

    it('renders an optional detail action without replacing the default apply flow', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const onDetailAction = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Current folder',
                            sectionId: 'current',
                            sectionLabel: 'Current',
                            detailDescription: 'Current linked workspace',
                            detailActionLabel: 'Open Settings',
                            onDetailAction,
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const detailAction = tree!.root.findByProps({ testID: 'agent-input-chip-picker.detail-action' });
        await act(async () => {
            detailAction.props.onPress();
        });

        expect(onDetailAction).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('renders custom detail content inside the shared detail pane without removing apply', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Codex',
                            sectionId: 'engine',
                            sectionLabel: 'Engine',
                            detailDescription: 'Primary engine',
                            detailContent: React.createElement('EngineDetail', {
                                testID: 'agent-input-chip-picker.custom-detail',
                            }),
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        expect(tree!.root.findAllByProps({ testID: 'agent-input-chip-picker.custom-detail' })).toHaveLength(1);

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('one');
        expect(onClose).toHaveBeenCalled();
    });

    it('preserves the focused detail option when option metadata rerenders without changing the selected option', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        function Probe() {
            const [detailDescription, setDetailDescription] = React.useState('Feature checkout');

            return (
                <>
                    <AgentInputChipPickerModal
                        title="Pick"
                        options={[
                            {
                                id: 'one',
                                label: 'No Worktree',
                                sectionId: 'current',
                                sectionLabel: 'Current',
                                detailDescription: 'Current folder',
                            },
                            {
                                id: 'two',
                                label: 'New Worktree',
                                sectionId: 'actions',
                                sectionLabel: 'Actions',
                                detailDescription,
                            },
                        ]}
                        selectedOptionId="one"
                        onSelect={onSelect}
                        onClose={onClose}
                    />
                    <TriggerDetailRerender
                        onTrigger={() => {
                            setDetailDescription('Feature checkout (updated)');
                        }}
                    />
                </>
            );
        }

        function TriggerDetailRerender(props: Readonly<{ onTrigger: () => void }>) {
            return React.createElement('TriggerDetailRerender', props);
        }

        await act(async () => {
            tree = renderer.create(<Probe />);
        });

        const option = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            option.props.onPress();
        });

        const trigger = tree!.root.findByType('TriggerDetailRerender' as any);
        await act(async () => {
            trigger.props.onTrigger();
        });

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalled();
    });
});
