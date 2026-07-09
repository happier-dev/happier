import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
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
    Typography: {
        default: () => ({}),
        rowTitle: () => ({}),
        rowMeta: () => ({}),
        pillLabel: () => ({}),
    },
}));

const terminalViewSpy = vi.fn();
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: (props: any) => {
        terminalViewSpy(props);
        return React.createElement('SessionEmbeddedTerminalPane');
    },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
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

describe('SessionDetailsPanel (terminal resource)', () => {
    it('renders SessionEmbeddedTerminalPane for terminal tabs', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
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
