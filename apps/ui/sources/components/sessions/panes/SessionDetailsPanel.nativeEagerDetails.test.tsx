import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: any) => spec?.ios ?? spec?.default,
            },
            View: 'View',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    },
    icons: () => ({
        Octicons: 'Octicons',
        Ionicons: 'Ionicons',
    }),
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
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/components/ui/scroll/useWebScrollLockBypass', () => ({
    useWebScrollLockBypass: () => {},
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

vi.mock('./SessionDetailsPanelDetailViews', async () => await import('./SessionDetailsPanelDetailViews.native'));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
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

describe('SessionDetailsPanel (native details loading)', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders native file details in the first committed tree without waiting on a lazy import', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        let tree: renderer.ReactTestRenderer | null = null;

        act(() => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(tree!.root.findAllByType('SessionFileDetailsView' as any)).toHaveLength(1);
        const textNodes = tree!.root.findAllByType('Text' as any);
        const loadingFallbacks = textNodes.filter((node) => String(node.props.children).includes('common.loading'));
        expect(loadingFallbacks).toHaveLength(0);

        act(() => {
            tree!.unmount();
        });
    });
});
