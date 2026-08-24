import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: ((key: string) => {
                    return null;
                }) as any,
                useLocalSettingMutable: (() => [false, vi.fn()]) as any,
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/agents/registry/sessionSubagentUiBehavior', () => ({
    renderProviderSessionDetailsTab: () => null,
    resolveProviderSessionDetailsTabIconName: () => null,
}));

vi.mock('@/components/sessions/runs/launcher/SessionExecutionRunLauncherView', () => ({
    SessionExecutionRunLauncherView: 'SessionExecutionRunLauncherView',
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivityIndicator' }));
vi.mock('@/components/ui/scroll/useWebScrollLockBypass', () => ({ useWebScrollLockBypass: () => {} }));
vi.mock('@/components/ui/scroll/resolveWebScrollableElement', () => ({ resolveWebScrollableElementWithin: () => null }));
vi.mock('@/utils/platform/deferOnWeb', () => ({ deferOnWeb: (fn: () => void) => fn() }));
vi.mock('@/components/ui/buttons/IconAction', () => ({
    IconAction: (props: any) => React.createElement('IconAction', props, props.children),
}));
vi.mock('@/components/navigation/shell/SidebarIcons', () => ({
    SidebarCollapseIcon: 'SidebarCollapseIcon',
    SidebarExpandIcon: 'SidebarExpandIcon',
}));
vi.mock('../shell/sessionScreenTestIds', () => ({
    resolveOptionalSessionScreenTestId: () => undefined,
    useSessionScreenTestIdsEnabled: () => false,
}));
vi.mock('@/components/appShell/panes/focusMode/usePaneFocusMode', () => ({
    usePaneFocusMode: () => ({ active: false, toggle: vi.fn() }),
}));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/components/sessions/shell/sessionPinIcons', () => ({
    PinIcon: 'PinIcon',
    PinSlashIcon: 'PinSlashIcon',
}));
vi.mock('./details/sessionTranscriptDetailsResource', () => ({
    isSessionTranscriptDetailsResource: () => false,
}));

const terminalViewSpy = vi.fn();
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: (props: any) => {
        terminalViewSpy(props);
        return React.createElement('SessionEmbeddedTerminalPane');
    },
}));

vi.mock('./SessionDetailsPanelDetailViews', () => ({
    SessionCommitDetailsViewForPanel: () => React.createElement('SessionCommitDetailsView'),
    SessionFileDetailsViewForPanel: () => React.createElement('SessionFileDetailsView'),
    SessionScmReviewDetailsViewForPanel: () => React.createElement('SessionScmReviewDetailsView'),
    SessionScmStashDetailsViewForPanel: () => React.createElement('SessionScmStashDetailsView'),
    SessionSubagentDetailsViewForPanel: () => React.createElement('SessionSubagentDetailsView'),
    SessionTranscriptDetailsViewForPanel: () => React.createElement('SessionTranscriptDetailsView'),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'terminal:embedded',
                tabs: [
                    {
                        key: 'terminal:embedded',
                        kind: 'terminal',
                        title: 'Terminal',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'terminal' },
                    },
                ],
            },
        },
    }),
}));

const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

afterEach(async () => {
    await standardCleanup();
});

describe('SessionDetailsPanel (terminal resource)', () => {
    it('renders SessionEmbeddedTerminalPane for terminal tabs', async () => {
        terminalViewSpy.mockClear();

        const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(terminalViewSpy).toHaveBeenCalledTimes(1);
        expect(terminalViewSpy.mock.calls[0]?.[0]?.sessionId).toBe('s1');
        expect(terminalViewSpy.mock.calls[0]?.[0]?.currentDockLocation).toBe('details');
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });
});
