import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
}));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (_: any) => 1,
            },
            ActivityIndicator: 'ActivityIndicator',
            View: 'View',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                if (key === 'editorFocusModeEnabled') return false;
                return null;
            },
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

const closeDetailsSpy = vi.fn();
const closeDetailsTabSpy = vi.fn();
const setActiveDetailsTabSpy = vi.fn();

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: closeDetailsSpy,
        closeDetailsTab: closeDetailsTabSpy,
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: setActiveDetailsTabSpy,
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'commit:abc',
                tabs: [
                    {
                        key: 'commit:abc',
                        kind: 'commit',
                        title: 'abc1234',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'commit', sha: 'abc1234' },
                    },
                ],
            },
        },
    }),
}));

const commitViewSpy = vi.fn();
vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: (props: any) => {
        commitViewSpy(props);
        return React.createElement('SessionCommitDetailsView');
    },
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

describe('SessionDetailsPanel (commit resource)', () => {
    it('renders SessionCommitDetailsView for commit tabs that store sha in resource', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        commitViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree).toBeTruthy();
        expect(commitViewSpy).toHaveBeenCalledTimes(1);
        expect(commitViewSpy.mock.calls[0]?.[0]?.sha).toBe('abc1234');
    });

    it('pads the panel root by the iOS safe-area inset at the top', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        const workspaceRoot = screen.findByTestId('session-details-panel-root');
        if (!workspaceRoot) {
            throw new Error('Expected the session details panel root to be rendered.');
        }
        const root = workspaceRoot.find((node) => (
            node !== workspaceRoot
            && typeof node.props?.onWheel === 'function'
            && typeof node.props?.onTouchMove === 'function'
        ));
        const rootStyle = Array.isArray(root.props.style)
            ? Object.assign({}, ...root.props.style.filter(Boolean))
            : root.props.style;
        expect(rootStyle.paddingTop).toBe(24);
    });
});
