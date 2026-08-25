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

// `@/constants/Typography` is pure style math with no font-loading side
// effect, and `Text` is already stubbed, so the real module is used here. A
// hand-listed stub of it only re-breaks whenever the rendered graph reaches
// one more helper (`mono`, `eyebrow`, `FontWeights`, …).

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
// Only the component is stubbed. `ICON_SIZE` from this same module is read at
// module scope by the shared item-density metrics, so a replace-everything
// factory makes the whole panel graph fail to load.
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: 'Icon',
}));
vi.mock('@/components/sessions/shell/sessionPinIcons', () => ({
    PinIcon: 'PinIcon',
    PinSlashIcon: 'PinSlashIcon',
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
                activeTabKey: 'terminal:term-1',
                tabs: [
                    {
                        key: 'terminal:term-1',
                        kind: 'terminal',
                        title: 'Terminal',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'terminal', terminalInstanceId: 'term-1' },
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

        expect(terminalViewSpy.mock.calls.length).toBeGreaterThan(0);
        const lastCallProps = terminalViewSpy.mock.calls.at(-1)?.[0];
        expect(lastCallProps?.sessionId).toBe('s1');
        expect(lastCallProps?.terminalInstanceId).toBe('term-1');
        expect(lastCallProps?.currentDockLocation).toBe('details');
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });
});
