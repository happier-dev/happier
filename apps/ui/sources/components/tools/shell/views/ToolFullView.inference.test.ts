import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

installToolShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: <K extends keyof typeof localSettingsDefaults>(name: K) => localSettingsDefaults[name],
                useSetting: <K extends keyof typeof settingsDefaults>(name: K) => settingsDefaults[name],
            },
        });
    },
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

const renderedFullViewSpy = vi.fn();
const renderedViewSpy = vi.fn();

const getToolViewComponentSpy = vi.fn((toolName: string) => {
    if (toolName === 'execute') {
        return (props: any) => {
            renderedFullViewSpy(props);
            return React.createElement('FullToolView', { name: toolName });
        };
    }
    if (toolName === 'Read') {
        return (props: any) => {
            renderedViewSpy(props);
            return React.createElement('ToolView', { name: toolName });
        };
    }
    return null;
});

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: getToolViewComponentSpy,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        execute: { title: 'Terminal' },
        Read: { title: 'Read' },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('ToolFullView (inference + view selection)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('uses tool.input._acp.kind to select a renderer and forces detailLevel=full', async () => {
        renderedFullViewSpy.mockReset();
        renderedViewSpy.mockReset();
        getToolViewComponentSpy.mockClear();
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'Run echo hello',
            input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
            result: { stdout: 'hello\n', stderr: '' },
            description: 'Run echo hello',
        });

        const screen = await renderScreen(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));

        expect(screen.findAllByType('FullToolView' as any)).toHaveLength(1);
        expect(renderedFullViewSpy).toHaveBeenCalled();
        expect(getToolViewComponentSpy).toHaveBeenCalledWith('execute');
        expect(renderedFullViewSpy).toHaveBeenCalledWith(expect.objectContaining({ detailLevel: 'full' }));
    });

    it('renders the normal tool view component and forces detailLevel=full', async () => {
        renderedFullViewSpy.mockReset();
        renderedViewSpy.mockReset();
        getToolViewComponentSpy.mockClear();
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { content: 'hello' },
        });

        const screen = await renderScreen(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));

        expect(screen.findAllByType('ToolView' as any)).toHaveLength(1);
        expect(renderedViewSpy).toHaveBeenCalled();
        expect(renderedFullViewSpy).not.toHaveBeenCalled();
        expect(getToolViewComponentSpy).toHaveBeenCalledWith('Read');
        expect(renderedViewSpy).toHaveBeenCalledWith(expect.objectContaining({ detailLevel: 'full' }));
    });
});
