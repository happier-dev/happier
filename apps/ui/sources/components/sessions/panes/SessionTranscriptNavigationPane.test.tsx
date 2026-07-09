import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { TranscriptNavigationEntry } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const entries: readonly TranscriptNavigationEntry[] = [
    {
        id: 'turn-1',
        sessionId: 's1',
        seq: 1,
        routeMessageId: 'server:u1',
        transcriptBlockIndex: 0,
        kind: 'user-turn',
        role: 'user',
        label: 'First prompt',
        promptPreview: 'First prompt',
        responsePreview: null,
        createdAtMs: 100,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
    },
];

describe('SessionTranscriptNavigationPane', () => {
    it('renders the transcript navigation panel inside the pane shell', async () => {
        standardCleanup();
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const screen = await renderScreen(
            <SessionTranscriptNavigationPane
                sessionId="s1"
                entries={entries}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="pane-nav"
            />,
        );

        expect(screen.findByTestId('pane-nav-pane')).toBeTruthy();
        expect(screen.findByTestId('pane-nav-entry:turn-1')).toBeTruthy();
    });

    it('passes close requests through to the pane owner', async () => {
        standardCleanup();
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <SessionTranscriptNavigationPane
                sessionId="s1"
                entries={entries}
                activeEntryId={null}
                onEntryPress={() => {}}
                onRequestClose={onRequestClose}
                testIDPrefix="pane-nav"
            />,
        );

        screen.pressByTestId('pane-nav-close');

        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });
});
