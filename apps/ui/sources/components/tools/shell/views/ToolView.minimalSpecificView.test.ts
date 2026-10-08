import React from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    renderWithSessionTranscriptSource,
    standardCleanup,
} from '@/dev/testkit';
import {
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installToolShellCommonModuleMocks({
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            NativeModules: {},
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

describe('ToolView (minimal tools)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a specific tool view even when the tool is marked minimal', async () => {
        const previousSettings = getStorage().getState().settings;
        getStorage().setState({ settings: { ...settingsDefaults,
            toolViewDetailLevelDefault: 'summary', toolViewDetailLevelDefaultLocalControl: 'title',
            toolViewDetailLevelByToolName: {}, toolViewShowDebugByDefault: false,
        } });
        onTestFinished(() => getStorage().setState({ settings: previousSettings }));
        const { ToolView } = await import('./ToolView');
        const { BashView } = await import('@/components/tools/renderers/core/_registry');
        const { CommandView } = await import('@/components/sessions/transcript/CommandView');

        const tool = makeToolCall({
            name: 'Bash',
            input: { command: 'echo hello' },
            result: { stdout: 'hello\n', stderr: '' },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(screen.findAllByType(BashView)).toHaveLength(1);
        expect(screen.findByType(CommandView).props).toMatchObject({ command: 'echo hello', stdout: 'hello\n' });
    });
});
