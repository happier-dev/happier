import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        });
    },
    icons: async () => ({
        Ionicons: 'Ionicons',
        Octicons: 'Octicons',
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => false,
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        eyebrow: () => ({}),
        keyHint: () => ({}),
    },
}));

vi.mock('@/components/ui/scroll/useWebScrollLockBypass', () => ({
    useWebScrollLockBypass: () => {},
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (cb: any) => cb(),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

const suspendPromise = new Promise<void>(() => {});
vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => {
        throw suspendPromise;
    },
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

const scopeState: any = {
    details: {
        isOpen: true,
        activeTabKey: 'commit:abc',
        tabs: [
            {
                key: 'commit:abc',
                kind: 'commit',
                title: 'Commit',
                resource: { kind: 'commit', sha: 'abc' },
                isPreview: false,
                isPinned: true,
            },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
    }),
}));

describe('SessionDetailsPanel (suspense fallback)', () => {
    it('renders a loading fallback when the active tab suspends', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        // When the active tab suspends, we should still render a visible loading indicator.
        const textNodes = tree!.findAllByType('Text' as any);
        const hasLoading = textNodes.some((n) => String(n.props.children).includes('common.loading'));
        expect(hasLoading).toBe(true);
    });
});
