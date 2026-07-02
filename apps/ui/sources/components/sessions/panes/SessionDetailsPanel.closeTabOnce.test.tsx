import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { pressTestInstanceAsync } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: createThemeFixture(),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('./SessionDetailsPanelDetailViews', () => ({
    SessionCommitDetailsViewForPanel: (props: any) => React.createElement('SessionCommitDetailsViewForPanel', props),
    SessionFileDetailsViewForPanel: (props: any) => React.createElement('SessionFileDetailsViewForPanel', props),
    SessionScmReviewDetailsViewForPanel: (props: any) => React.createElement('SessionScmReviewDetailsViewForPanel', props),
    SessionScmStashDetailsViewForPanel: (props: any) => React.createElement('SessionScmStashDetailsViewForPanel', props),
    SessionSubagentDetailsViewForPanel: (props: any) => React.createElement('SessionSubagentDetailsViewForPanel', props),
}));

let mockAppPaneScope: any = null;
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => mockAppPaneScope,
}));

describe('SessionDetailsPanel (close tab)', () => {
    it('closes a tab exactly once when clicking its close button', async () => {
        const closeDetailsTabSpy = vi.fn();

        mockAppPaneScope = {
            closeDetails: vi.fn(),
            closeDetailsTab: closeDetailsTabSpy,
            pinDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
            scopeState: {
                details: {
                    isOpen: true,
                    activeTabKey: 'file:a',
                    tabs: [
                        { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
                    ],
                },
            },
        };

        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });
        const closeButton = tree!.root.findByProps({ testID: 'session-details-tab-close-file_a' });
        await pressTestInstanceAsync(closeButton, 'session-details-tab-close-file_a');

        expect(closeDetailsTabSpy).toHaveBeenCalledTimes(1);
        expect(closeDetailsTabSpy).toHaveBeenCalledWith('file:a');

        await act(async () => {
            tree!.unmount();
        });
    });
});
