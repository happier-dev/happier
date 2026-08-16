import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The details host an imported workflow-agent sidechain finally has — and the one open it refuses.
 *
 * This panel is scoped to ONE session; every neighbouring resource (file, commit, terminal,
 * subagent) resolves against `props.sessionId`. A transcript resource carries its own `sessionId`
 * because a transcript is meaningless without one, and carrying it is exactly what makes the
 * mismatch checkable instead of assumed. Rendering another session's conversation under this
 * session's chrome would be the quiet kind of wrong, so the refusal is explicit and asserted.
 */

const detailsTabs = vi.hoisted(() => ({ current: [] as any[] }));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (_: any) => 1 },
            AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
            ActivityIndicator: 'ActivityIndicator',
            View: 'View',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
        });
    },
    icons: () => ({ Octicons: 'Octicons', Ionicons: 'Ionicons' }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: detailsTabs.current[0]?.key ?? null,
                tabs: detailsTabs.current,
            },
        },
    }),
}));

const transcriptViewSpy = vi.fn();

vi.mock('@/components/sessions/panes/details/SessionTranscriptDetailsView', () => ({
    SessionTranscriptDetailsView: (props: any) => {
        transcriptViewSpy(props);
        return React.createElement('SessionTranscriptDetailsView');
    },
}));

vi.mock('@/components/sessions/agents/details/SessionSubagentDetailsView', () => ({
    SessionSubagentDetailsView: () => React.createElement('SessionSubagentDetailsView'),
}));
vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));
vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

let SessionDetailsPanel: typeof import('./SessionDetailsPanel').SessionDetailsPanel;

function transcriptTab(scope: unknown) {
    return {
        key: 'transcript:sidechain:wf/a1',
        kind: 'transcript',
        title: 'Reviewer',
        isPinned: false,
        isPreview: true,
        resource: { kind: 'transcript', scope },
    };
}

describe('SessionDetailsPanel (transcript resource)', () => {
    // Importing the panel pulls a large transform graph, and the 60s the sibling panel suites
    // budget for it is not enough on a loaded machine — `SessionDetailsPanel.subagent.test.tsx`
    // times out here at HEAD, unmodified, for exactly this reason. The cost is the harness's, not
    // the panel's, so the budget is raised rather than any assertion being softened.
    beforeAll(async () => {
        ({ SessionDetailsPanel } = await import('./SessionDetailsPanel'));
    }, 240_000);

    beforeEach(() => {
        transcriptViewSpy.mockClear();
    });

    it('renders the scoped transcript view for a same-session sidechain tab', async () => {
        detailsTabs.current = [transcriptTab({ kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' })];

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(transcriptViewSpy).toHaveBeenCalledTimes(1);
        expect(transcriptViewSpy.mock.calls[0]?.[0]).toMatchObject({
            scope: { kind: 'sidechain', sessionId: 's1', sidechainId: 'wf/a1' },
        });
        expect(screen.getTextContent()).toContain('Reviewer');
        await screen.unmount();
    });

    it('refuses a transcript from another session, aloud and without rendering it', async () => {
        detailsTabs.current = [transcriptTab({ kind: 'sidechain', sessionId: 'other', sidechainId: 'wf/a1' })];

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(transcriptViewSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-details-transcript-session-mismatch')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.detailsPanel.transcriptFromOtherSession');
        await screen.unmount();
    });

    it('falls through to the unsupported message when the scope is malformed', async () => {
        detailsTabs.current = [transcriptTab({ sessionId: 's1' })];

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(transcriptViewSpy).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('session.detailsPanel.unsupportedTab');
        await screen.unmount();
    });
});
