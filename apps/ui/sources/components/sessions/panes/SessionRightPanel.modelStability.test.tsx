import { act } from 'react-test-renderer';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
const runtime = installSessionPaneRuntimeTestHarness();
const { SessionRightSidebarProvider, useSessionRightSidebarPresentation } = await import('./SessionRightPanel');

describe('Session right sidebar model', () => {
    it('keeps one model for unchanged inputs so its consumers do not re-render when the provider re-renders', async () => {
        let consumerRenders = 0;
        function Consumer() {
            consumerRenders += 1;
            useSessionRightSidebarPresentation();
            return null;
        }
        // One element identity: React skips the consumer unless the published model changes.
        const consumer = <Consumer />;
        const tree = () => (
            <runtime.Wrapper>
                <SessionRightSidebarProvider sessionId="s1" scopeId="session:s1">{consumer}</SessionRightSidebarProvider>
            </runtime.Wrapper>
        );
        const screen = await renderPanelScreen(tree());
        await act(async () => runtime.pane.openRight({ tabId: 'git' }));
        const settled = consumerRenders;
        await screen.update(tree());
        await screen.update(tree());
        expect(consumerRenders).toBe(settled);
        await screen.unmount();
    });
});
