import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedPopoverProps: any = null;
let capturedPopoverSurfaceProps: any = null;

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
                surface: '#fff',
                surfaceHigh: '#f2f2f2',
                surfaceHighest: '#e9e9e9',
                surfacePressed: '#ececec',
                surfacePressedOverlay: '#f4f4f4',
                surfaceSelected: '#f7f7f7',
                backgroundSecondary: '#f5f5f5',
                card: { background: '#f8f8f8' },
                accent: { blue: '#00f' },
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
    StyleSheet: {
        create: (factory: any) => {
            const theme = {
                colors: {
                    text: '#111',
                    textSecondary: '#666',
                    surface: '#fff',
                    surfaceHigh: '#f2f2f2',
                    surfaceHighest: '#e9e9e9',
                    surfacePressed: '#ececec',
                    surfacePressedOverlay: '#f4f4f4',
                    surfaceSelected: '#f7f7f7',
                    backgroundSecondary: '#f5f5f5',
                    card: { background: '#f8f8f8' },
                    accent: { blue: '#00f' },
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
                    modal: {
                        border: '#ddd',
                    },
                    shadow: {
                        color: '#000',
                        opacity: 0.2,
                    },
                    divider: '#ddd',
                },
            };
            return typeof factory === 'function' ? factory(theme) : factory;
        },
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        capturedPopoverProps = props;
        return props.open ? React.createElement('Popover', props, props.children({ maxHeight: 320 })) : null;
    },
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: any) => {
        capturedPopoverSurfaceProps = props;
        return React.createElement('AgentInputPopoverSurface', props, props.children);
    },
}));

describe('AgentInputChipPickerPopover', () => {
    it('anchors to the provided full-width popover anchor and selects immediately in simple mode', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        const anchorRef = { current: { nodeType: 'View' } } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerPopover
                    open
                    anchorRef={anchorRef}
                    title="Pick"
                    options={[
                        { id: 'one', label: 'One' },
                        { id: 'two', label: 'Two' },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onRequestClose={onRequestClose}
                />,
            );
        });

        expect(capturedPopoverProps?.anchorRef).toBe(anchorRef);
        expect(capturedPopoverProps?.portal?.matchAnchorWidth).toBe(false);

        const item = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            item.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onRequestClose).toHaveBeenCalled();
    });

    it('uses explicit apply in detailed mode inside the popover', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        capturedPopoverSurfaceProps = null;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerPopover
                    open
                    anchorRef={{ current: { nodeType: 'View' } } as any}
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
                    onRequestClose={onRequestClose}
                />,
            );
        });

        const option = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            option.props.onPress();
        });

        expect(onSelect).not.toHaveBeenCalled();
        expect(capturedPopoverSurfaceProps?.scrollEnabled).toBe(true);

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onRequestClose).toHaveBeenCalled();
    });

    it('supports a secondary detail action inside the popover detail pane', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        const onDetailAction = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerPopover
                    open
                    anchorRef={{ current: { nodeType: 'View' } } as any}
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
                    onRequestClose={onRequestClose}
                />,
            );
        });

        const detailAction = tree!.root.findByProps({ testID: 'agent-input-chip-picker.detail-action' });
        await act(async () => {
            detailAction.props.onPress();
        });

        expect(onDetailAction).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onRequestClose).not.toHaveBeenCalled();
    });
});
