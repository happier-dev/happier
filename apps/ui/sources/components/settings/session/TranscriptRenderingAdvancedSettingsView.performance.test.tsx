import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const transcriptAdvancedSettingsTestState = vi.hoisted(() => ({
    requestedSettings: [] as string[],
    setCoalesceEnabled: vi.fn(),
}));

installSessionSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TextInput: 'TextInput',
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    transcriptAdvancedSettingsTestState.requestedSettings.push(key);
                    if (key === 'transcriptStreamingCoalesceEnabled') return [true, transcriptAdvancedSettingsTestState.setCoalesceEnabled];
                    if (key === 'transcriptStreamingCoalesceWindowMs') return [16, vi.fn()];
                    if (key === 'transcriptStreamingCoalesceMaxBatchSize') return [200, vi.fn()];
                    if (key === 'transcriptThinkingPulseStaleMs') return [120_000, vi.fn()];
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
                }),
            },
        });
    },
});

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

afterEach(() => {
    standardCleanup();
    transcriptAdvancedSettingsTestState.requestedSettings.length = 0;
    transcriptAdvancedSettingsTestState.setCoalesceEnabled.mockClear();
});

describe('Transcript advanced settings (performance)', () => {
    async function renderView() {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        return renderSettingsView(React.createElement(mod.default));
    }

    it('toggles streaming coalescing enabled', async () => {
        const screen = await renderView();

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle');
        });

        expect(transcriptAdvancedSettingsTestState.setCoalesceEnabled).toHaveBeenCalledWith(false);
    });

    it('omits the obsolete renderer menu without reading a writable renderer setting', async () => {
        const screen = await renderView();

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceWindowTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.transcript.advanced.listImplementationTitle')).toBeNull();
        expect(screen.findAllByType('DropdownMenu' as any)).toHaveLength(0);
        expect(transcriptAdvancedSettingsTestState.requestedSettings).not.toContain('transcriptListImplementation');
    });
});
