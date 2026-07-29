import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setTranscriptMessageTimestampDisplayMode = vi.fn();

installSessionSettingsCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader((name) => {
                    if (name === 'transcriptGroupingMode') {
                        return ['turns', vi.fn()];
                    }
                    if (name === 'transcriptGroupToolCalls') {
                        return [true, vi.fn()];
                    }
                    if (name === 'transcriptTurnToolCallsGroupStrategy') {
                        return ['consecutive_tools', vi.fn()];
                    }
                    if (name === 'transcriptToolCallsCollapsedPreviewCount') {
                        return [null, vi.fn()];
                    }
                    if (name === 'transcriptToolCallsGroupShowBackground') {
                        return [true, vi.fn()];
                    }
                    if (name === 'toolViewTimelineChromeMode') {
                        return ['activity_feed', vi.fn()];
                    }
                    if (name === 'transcriptMessageTimestampDisplayMode') {
                        return ['hover_web_hidden_mobile', setTranscriptMessageTimestampDisplayMode];
                    }
                    return [null, vi.fn()];
                }),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: string }) =>
        React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

describe('TranscriptSettingsView', () => {
    it('defaults the tool calls collapsed preview dropdown to three when the setting is unavailable', async () => {
        const { TranscriptSettingsView } = await import('./TranscriptSettingsView');
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const dropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.advanced.toolCallsCollapsedPreviewCountTitle'
        )[0];

        expect(dropdown?.props?.selectedId).toBe('3');
    });

    it('renders the message timestamp display dropdown in transcript layout settings', async () => {
        const { TranscriptSettingsView } = await import('./TranscriptSettingsView');
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const dropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.messageTimestampsTitle'
        )[0];
        expect(dropdown).toBeTruthy();
        expect(dropdown?.props?.selectedId).toBe('hover_web_hidden_mobile');
        expect(dropdown?.props?.items.map((item: any) => item.id)).toEqual([
            'hover_web_hidden_mobile',
            'hover_web_always_mobile',
            'always',
            'never',
        ]);

        let current = dropdown?.parent;
        let groupTitle: unknown;
        while (current) {
            if ((current.type as unknown) === 'ItemGroup') {
                groupTitle = current.props?.title;
                break;
            }
            current = current.parent;
        }
        expect(groupTitle).toBe('settingsSession.transcript.layoutTitle');

        dropdown?.props?.onSelect?.('always');

        expect(setTranscriptMessageTimestampDisplayMode).toHaveBeenCalledWith('always');
    });
});
