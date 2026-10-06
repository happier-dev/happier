import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { findTestInstanceByTypeWithProps, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


let initialTabId = 'git';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                    options?.ios ?? options?.native ?? options?.default ?? options?.web ?? options?.android,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
            translateLoose: (key) => key,
            getPreferredLanguage: () => 'en',
        });
    },
});



// Native safe-area measurements are the platform boundary; chrome merging stays real.
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 17, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));






function getStyleValue(node: renderer.ReactTestInstance, key: string): unknown {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}


import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
const runtime = installSessionPaneRuntimeTestHarness();
async function renderScreen(element: React.ReactElement) {
    const screen = await renderPanelScreen(<runtime.Wrapper>{element}</runtime.Wrapper>);
    await act(async () => runtime.pane.openRight({ tabId: initialTabId }));
    return screen;
}

describe('SessionRightPanel (mobile screen chrome)', () => {
    beforeEach(() => {
        initialTabId = 'git';
        vi.clearAllMocks();
    });

    it('omits redundant header controls when the pane has an external action rail', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { PaneActionRailContext } = await import('@/components/appShell/panes/PaneActionRailContext');
        const screen = await renderScreen(
            <PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1000 }}>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </PaneActionRailContext.Provider>,
        );
        expect(screen.findByTestId('session-rightpanel-close')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:git')).toBeNull();
    });

    it('keeps the active pane header reachable on a screen without the action rail', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(
            <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );
        expect(screen.findHostByTestId('session-rightpanel-header')).not.toBeNull();
    });

    it('renders the screen close affordance as a leading back button on native', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(
            <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );

        const closeButton = screen.findHostByTestId('session-rightpanel-close');
        if (!closeButton) {
            throw new Error('Expected close button to render');
        }
        expect(closeButton.props.accessibilityLabel).toBe('common.back');
        expect(getStyleValue(closeButton, 'borderWidth')).toBeUndefined();
        expect(getStyleValue(closeButton, 'backgroundColor')).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(closeButton, 'Icon', {
            name: 'caret-left',
            size: 24,
        })).toBeTruthy();

        let header = closeButton.parent;
        while (header && getStyleValue(header, 'paddingTop') === undefined) {
            header = header.parent;
        }
        if (!header) {
            throw new Error('Expected close button to be inside the header');
        }
        expect(header.findAll((node) => typeof node.type === 'string' && node.props.testID === 'session-rightpanel-close')[0]).toBe(closeButton);
        expect(header.findAll((node) => typeof node.type === 'string' && node.props.testID?.startsWith('session-rightpanel-tab:')).every((tab) => header!.findAll(() => true).indexOf(closeButton) < header!.findAll(() => true).indexOf(tab))).toBe(true);
    });
});
