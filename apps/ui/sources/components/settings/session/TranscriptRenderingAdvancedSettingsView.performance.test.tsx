import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const setCoalesceEnabled = vi.fn();
vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'transcriptStreamingCoalesceEnabled') return [true, setCoalesceEnabled];
        if (key === 'transcriptStreamingCoalesceWindowMs') return [16, vi.fn()];
        if (key === 'transcriptStreamingCoalesceMaxBatchSize') return [200, vi.fn()];
        if (key === 'transcriptThinkingPulseStaleMs') return [120_000, vi.fn()];
        if (key === 'transcriptListImplementation') return ['flash_v2', vi.fn()];
        if (key === 'transcriptMotionPreset') return ['subtle', vi.fn()];
        if (key === 'transcriptMotionFreshnessMs') return [60_000, vi.fn()];
        if (key === 'transcriptAnimateNewItemsEnabled') return [true, vi.fn()];
        if (key === 'transcriptAnimateToolExpandCollapseEnabled') return [true, vi.fn()];
        if (key === 'transcriptAnimateToolExpandCollapseFreshOnly') return [true, vi.fn()];
        if (key === 'transcriptAnimateThinkingEnabled') return [true, vi.fn()];
        if (key === 'transcriptScrollPinOffsetThresholdPx') return [72, vi.fn()];
        if (key === 'transcriptScrollAutoFollowWhenPinned') return [true, vi.fn()];
        if (key === 'transcriptScrollJumpToBottomMinNewCount') return [1, vi.fn()];
        if (key === 'transcriptScrollJumpToBottomAnimateScroll') return [true, vi.fn()];
        return [null, vi.fn()];
    },
}));

afterEach(() => {
    setCoalesceEnabled.mockClear();
});
describe('Transcript advanced settings (performance)', () => {
    it('toggles streaming coalescing enabled', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const Component = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Component));
        });

        const items = tree.root.findAllByType('Item' as any);
        const coalesceItem = items.find((item: any) => item?.props?.title === 'settingsSession.transcript.advanced.coalesceEnabledTitle');
        expect(coalesceItem).toBeTruthy();

        await act(async () => {
            coalesceItem!.props.onPress?.();
        });

        expect(setCoalesceEnabled).toHaveBeenCalledWith(false);
    });
});
