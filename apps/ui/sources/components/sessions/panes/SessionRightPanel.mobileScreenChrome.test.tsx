import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const closeRightSpy = vi.fn();
const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

let scopeState: {
    right: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
} = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
};

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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                if (key === 'embeddedTerminalDockLocation') return 'sidebar';
                return null;
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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 17, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
        closeRight: closeRightSpy,
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionBrowseFilesSurface', () => ({
    SessionBrowseFilesSurface: () => React.createElement('FilesSurface'),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionGitSurface', () => ({
    SessionGitSurface: () => React.createElement('GitSurface'),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionTerminalSurface', () => ({
    SessionTerminalSurface: () => React.createElement('TerminalSurface'),
}));

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: () => React.createElement('AgentsView'),
}));

function findParentContaining(
    root: renderer.ReactTestInstance,
    child: renderer.ReactTestInstance,
): renderer.ReactTestInstance | null {
    return root.findAll((node) => node.children.includes(child)).at(0) ?? null;
}

function getStyleValue(node: renderer.ReactTestInstance, key: string): unknown {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}

describe('SessionRightPanel (mobile screen chrome)', () => {
    beforeEach(() => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
        };
        closeRightSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        vi.clearAllMocks();
    });

    it('renders the screen close affordance as a leading back button on native', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(
            <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );

        const closeButton = screen.findByTestId('session-rightpanel-close');
        if (!closeButton) {
            throw new Error('Expected close button to render');
        }
        expect(closeButton.props.accessibilityLabel).toBe('common.back');
        expect(closeButton.props.hitSlop).toBe(15);
        expect(getStyleValue(closeButton, 'borderWidth')).toBeUndefined();
        expect(getStyleValue(closeButton, 'backgroundColor')).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(closeButton, 'Icon', {
            name: 'caret-left',
            size: 24,
            color: '#18171C',
        })).toBeTruthy();

        const header = findParentContaining(screen.tree.root, closeButton);
        if (!header) {
            throw new Error('Expected close button to be inside the header');
        }
        expect(header.children[0]).toBe(closeButton);
        expect(getStyleValue(header, 'paddingTop')).toBe(10);
    });
});
