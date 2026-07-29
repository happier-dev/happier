import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks();

const detailsSurfaceHostSpy = vi.hoisted(() => vi.fn((props: unknown) => React.createElement('DetailsSurfaceHostMock', { props })));

vi.mock('@/components/appShell/panes/details/surfaces', () => ({
    DetailsSurfaceHost: (props: unknown) => detailsSurfaceHostSpy(props),
    createDetailsSurfacePaneCallbacks: (callbacks: unknown) => callbacks,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return {
        ...actual,
        Typography: {
            ...actual.Typography,
            default: () => ({}),
        },
    };
});

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('./SessionDetailsPanelDetailViews', () => ({
    SessionCommitDetailsViewForPanel: () => React.createElement('SessionCommitDetailsViewForPanel'),
    SessionFileDetailsViewForPanel: () => React.createElement('SessionFileDetailsViewForPanel'),
    SessionScmReviewDetailsViewForPanel: () => React.createElement('SessionScmReviewDetailsViewForPanel'),
    SessionScmStashDetailsViewForPanel: () => React.createElement('SessionScmStashDetailsViewForPanel'),
    SessionSubagentDetailsViewForPanel: () => React.createElement('SessionSubagentDetailsViewForPanel'),
}));

vi.mock('@/components/sessions/runs/launcher/SessionExecutionRunLauncherView', () => ({
    SessionExecutionRunLauncherView: () => React.createElement('SessionExecutionRunLauncherView'),
}));

vi.mock('@/agents/registry/sessionSubagentUiBehavior', () => ({
    renderProviderSessionDetailsTab: () => null,
    resolveProviderSessionDetailsTabIconName: () => null,
}));

vi.mock('./registry/sessionSurfaces', () => ({
    renderSessionSurfaceTab: () => null,
    resolveSessionSurfaceTabIconName: () => null,
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

describe('SessionDetailsPanel generic details surface host adapter', () => {
    it('routes session detail tabs through the app-shell details surface host', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        detailsSurfaceHostSpy.mockClear();

        await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);

        expect(detailsSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({ kind: 'session', sessionId: 's1' }),
            region: 'details',
            tab: expect.objectContaining({ key: 'terminal:term-1' }),
        }));
    });
});
