import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: { ...rn.Platform, OS: 'web' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
    useLocalSettingMutable: () => [false, vi.fn()],
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

        await act(async () => {
            renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(SessionScmStashDetailsViewMock).toHaveBeenCalledTimes(1);
        expect(SessionScmStashDetailsViewMock.mock.calls[0]?.[0]?.sessionId).toBe('s1');
    });
});

