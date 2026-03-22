import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
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
                                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useLocalSetting: (key: string) => {
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
    useLocalSettingMutable: () => [false, vi.fn()],
});
});

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
