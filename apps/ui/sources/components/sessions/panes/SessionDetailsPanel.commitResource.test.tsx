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
                return null;
            },
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
        eyebrow: () => ({}),
        keyHint: () => ({}),
    },
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
});
