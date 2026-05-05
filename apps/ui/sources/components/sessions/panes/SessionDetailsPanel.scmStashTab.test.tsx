import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: {
                    OS: 'web',
                },
                View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
                Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
            },
        );
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

const SessionScmStashDetailsViewMock = vi.fn((props: any) => React.createElement('SessionScmStashDetailsView', props));
vi.mock('@/components/sessions/files/views/SessionScmStashDetailsView', () => ({
    SessionScmStashDetailsView: (props: any) => SessionScmStashDetailsViewMock(props),
}));

const scopeState = {
    details: {
        isOpen: true,
        activeTabKey: 'scmStash',
        tabs: [
            { key: 'scmStash', kind: 'scmStash', title: 'Stashed changes', isPinned: true, isPreview: false, resource: { kind: 'scmStash' } },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        scopeState,
    }),
}));

describe('SessionDetailsPanel (scmStash)', () => {
    it('renders the stash details view when a scmStash tab is active', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(SessionScmStashDetailsViewMock).toHaveBeenCalledTimes(1);
        expect(SessionScmStashDetailsViewMock.mock.calls[0]?.[0]?.sessionId).toBe('s1');
    });
});
