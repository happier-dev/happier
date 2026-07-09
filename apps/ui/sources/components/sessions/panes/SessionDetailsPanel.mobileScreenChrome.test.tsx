import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const closeDetailsSpy = vi.fn();

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
                return null;
            },
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 19, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (cb: any) => cb(),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: (props: any) => React.createElement('SessionFileDetailsView', props),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: (props: any) => React.createElement('SessionCommitDetailsView', props),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: (props: any) => React.createElement('SessionScmReviewDetailsView', props),
}));

vi.mock('@/components/sessions/files/views/SessionScmStashDetailsView', () => ({
    SessionScmStashDetailsView: (props: any) => React.createElement('SessionScmStashDetailsView', props),
}));

vi.mock('@/components/sessions/agents/details/SessionSubagentDetailsView', () => ({
    SessionSubagentDetailsView: (props: any) => React.createElement('SessionSubagentDetailsView', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: closeDetailsSpy,
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'file:src/app.ts',
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'file', path: 'src/app.ts' },
                    },
                ],
            },
        },
    }),
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

describe('SessionDetailsPanel (mobile screen chrome)', () => {
    beforeEach(() => {
        closeDetailsSpy.mockClear();
        vi.clearAllMocks();
    });

    it('renders the screen close affordance as a leading back button on native', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const screen = await renderScreen(
            <SessionDetailsPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );

        const closeButton = screen.findByTestId('session-details-close');
        if (!closeButton) {
            throw new Error('Expected close button to render');
        }
        expect(closeButton.props.accessibilityLabel).toBe('common.back');
        expect(closeButton.props.hitSlop).toBe(15);
        expect(getStyleValue(closeButton, 'borderWidth')).toBeUndefined();
        expect(getStyleValue(closeButton, 'backgroundColor')).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(closeButton, 'Ionicons', {
            name: 'chevron-back',
            size: 24,
            color: '#18171C',
        })).toBeTruthy();

        const header = findParentContaining(screen.tree.root, closeButton);
        if (!header) {
            throw new Error('Expected close button to be inside the header');
        }
        expect(header.children[0]).toBe(closeButton);

        const rootWithSafeAreaPadding = screen.tree.root.findAll((node) => getStyleValue(node, 'paddingTop') === 19);
        expect(rootWithSafeAreaPadding).toHaveLength(0);
    });

    it('hides details header actions when embedded inside session cockpit chrome', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const screen = await renderScreen(
            <SessionDetailsPanel
                sessionId="s1"
                scopeId="session:s1"
                presentation="screen"
                showHeaderActions={false}
            />,
        );

        expect(screen.findByTestId('session-details-close')).toBeNull();
        expect(screen.findByTestId('session-details-focus-toggle')).toBeNull();
        expect(screen.findByTestId('session-details-open-browser')).not.toBeNull();
    });

    it('keeps the browser opener discoverable on native screen presentations', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const screen = await renderScreen(
            <SessionDetailsPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );

        expect(screen.findByTestId('session-details-open-browser')).not.toBeNull();
    });
});
