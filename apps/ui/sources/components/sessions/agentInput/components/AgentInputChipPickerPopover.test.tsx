import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedSelectionPopoverProps: any = null;
let capturedPopoverSurfaceProps: any = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
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
                modal: {
                    border: '#ddd',
                },
                shadow: {
                    color: '#000',
                    opacity: 0.2,
                },
                divider: '#ddd',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/sessions/agentInput/selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: any) => {
        capturedSelectionPopoverProps = props;
        return props.open ? React.createElement('AgentInputSelectionPopover', props, props.children({ maxHeight: 320 })) : null;
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
        capturedPopoverSurfaceProps = null;

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={anchorRef}
            title="Pick"
            options={[
                { id: 'one', label: 'One', icon: React.createElement('View', { testID: 'agent-input-chip-picker.icon:one' }) } as any,
                { id: 'two', label: 'Two', icon: React.createElement('View', { testID: 'agent-input-chip-picker.icon:two' }) } as any,
            ]}
            selectedOptionId="one"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        expect(capturedSelectionPopoverProps?.anchorRef).toBe(anchorRef);
        expect(capturedSelectionPopoverProps?.maxWidthCap).toBe(720);
        expect(capturedPopoverSurfaceProps?.scrollEnabled).toBe(true);

        expect(screen.findByTestId('agent-input-chip-picker.icon:one')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.icon:two')).toBeTruthy();

        expect(screen.findByTestId('agent-input-chip-picker.option:two')).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-chip-picker.option:two');

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onRequestClose).toHaveBeenCalled();
    });

    it('selects immediately in detailed mode for pure selection options', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        capturedPopoverSurfaceProps = null;

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={{ current: { nodeType: 'View' } } as any}
            title="Pick"
            options={[
                {
                    id: 'one',
                    label: 'Primary',
                    icon: React.createElement('View', { testID: 'agent-input-chip-picker.icon:primary' }),
                    sectionId: 'linked',
                    sectionLabel: 'Linked',
                    detailDescription: 'Primary checkout',
                } as any,
                {
                    id: 'two',
                    label: 'Feature',
                    icon: React.createElement('View', { testID: 'agent-input-chip-picker.icon:feature' }),
                    sectionId: 'linked',
                    sectionLabel: 'Linked',
                    detailDescription: 'Feature checkout',
                    onSelectImmediate: () => {
                        onSelect('two');
                    },
                } as any,
            ]}
            selectedOptionId="one"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.icon:primary')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.icon:feature')).toBeTruthy();

        expect(screen.findByTestId('agent-input-chip-picker.option:two')).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-chip-picker.option:two');

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(capturedPopoverSurfaceProps?.scrollEnabled).toBe(true);

        expect(screen.findByTestId('agent-input-chip-picker.apply')).toBeNull();
    });

    it('keeps the popover open for immediate detailed selections that opt out of auto-close', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPopover
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
                } as any,
                {
                    id: 'two',
                    label: 'Feature',
                    sectionId: 'linked',
                    sectionLabel: 'Linked',
                    detailDescription: 'Feature checkout',
                    closeOnSelectImmediate: false,
                    onSelectImmediate: () => {
                        onSelect('two');
                    },
                } as any,
            ]}
            selectedOptionId="one"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        await screen.pressByTestIdAsync('agent-input-chip-picker.option:two');

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('keeps the popover open when switching focused options that have detail panes (engine-style)', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={{ current: { nodeType: 'View' } } as any}
            title="Pick"
            options={[
                {
                    id: 'one',
                    label: 'Primary',
                    detailDescription: 'Primary checkout',
                    renderDetailContent: () => React.createElement('View', { testID: 'detail:one' }),
                } as any,
                {
                    id: 'two',
                    label: 'Feature',
                    detailDescription: 'Feature checkout',
                    renderDetailContent: () => React.createElement('View', { testID: 'detail:two' }),
                    onSelectImmediate: () => {
                        onSelect('two');
                    },
                } as any,
            ]}
            selectedOptionId="one"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        await screen.pressByTestIdAsync('agent-input-chip-picker.option:two');
        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('selects and closes when choosing a detail list option', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={{ current: { nodeType: 'View' } } as any}
            title="Pick"
            options={[
                {
                    id: 'existing',
                    label: 'Existing Worktree',
                    detailDescription: 'Pick an existing worktree',
                    detailSelectOptions: [
                        { id: 'worktree:a', label: 'feature/a', subtitle: '/repo/.worktrees/feature-a' },
                        { id: 'worktree:b', label: 'feature/b', subtitle: '/repo/.worktrees/feature-b' },
                    ],
                },
            ]}
            selectedOptionId="existing"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.detailSelectOption:worktree:b')).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-chip-picker.detailSelectOption:worktree:b');

        expect(onSelect).toHaveBeenCalledWith('worktree:b');
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to generic selection for focus-only detailed options', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={{ current: { nodeType: 'View' } } as any}
            title="Pick"
            options={[
                {
                    id: 'engine:codex',
                    label: 'Codex',
                    detailDescription: 'Engine detail',
                    renderDetailContent: () => React.createElement('Detail'),
                },
            ]}
            selectedOptionId="engine:codex"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.option:engine:codex')).toBeNull();
        expect(screen.findByType('Detail')).toBeTruthy();
        expect(onSelect).not.toHaveBeenCalled();
        expect(onRequestClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-chip-picker.apply')).toBeNull();
    });

    it('hides the option selector when detailed content has no alternative choice', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={{ current: { nodeType: 'View' } } as any}
            title="Pick"
            options={[
                {
                    id: 'engine:codex',
                    label: 'Codex',
                    detailDescription: 'Engine detail',
                    renderDetailContent: () => React.createElement('Detail'),
                },
            ]}
            selectedOptionId="engine:codex"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.option:engine:codex')).toBeNull();
        expect(screen.findByType('Detail')).toBeTruthy();
    });

    it('supports a secondary detail action inside the popover detail pane', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        const onDetailAction = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPopover
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
        />);

        expect(screen.findByTestId('agent-input-chip-picker.detail-action')).toBeTruthy();
        screen.pressByTestId('agent-input-chip-picker.detail-action');

        expect(onDetailAction).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('retains explicit apply for editor-style detailed options', async () => {
        const { AgentInputChipPickerPopover } = await import('./AgentInputChipPickerPopover');
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        const onApply = vi.fn();

        const screen = await renderScreen(<AgentInputChipPickerPopover
            open
            anchorRef={{ current: { nodeType: 'View' } } as any}
            title="Pick"
            options={[
                {
                    id: 'create',
                    label: 'Create',
                    detailDescription: 'Editor flow',
                    onApply,
                },
            ]}
            selectedOptionId="create"
            onSelect={onSelect}
            onRequestClose={onRequestClose}
        />);

        expect(screen.findByTestId('agent-input-chip-picker.apply')).toBeTruthy();
        screen.pressByTestId('agent-input-chip-picker.apply');

        expect(onApply).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });
});
