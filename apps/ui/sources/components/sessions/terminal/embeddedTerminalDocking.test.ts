import { describe, expect, it, vi } from 'vitest';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'terminal-instance-1',
}));

describe('embeddedTerminalDocking', () => {
    it('creates a new details terminal tab with a generated terminal instance id by default', async () => {
        const { createSessionDetailsTerminalTab } = await import('./embeddedTerminalDocking');

        expect(createSessionDetailsTerminalTab()).toEqual({
            key: 'terminal:terminal-instance-1',
            kind: 'terminal',
            title: 'settings.terminal',
            resource: { kind: 'terminal', terminalInstanceId: 'terminal-instance-1', cwd: null },
        });
    });

    it('creates an explicitly keyed details terminal tab when a terminal instance id is provided', async () => {
        const { createSessionDetailsTerminalTab } = await import('./embeddedTerminalDocking');

        expect(createSessionDetailsTerminalTab({ terminalInstanceId: 'term-2' })).toEqual({
            key: 'terminal:term-2',
            kind: 'terminal',
            title: 'settings.terminal',
            resource: { kind: 'terminal', terminalInstanceId: 'term-2', cwd: null },
        });
    });

    it('closes every details terminal tab when switching the embedded terminal away from the details dock', async () => {
        const { closeEmbeddedTerminalOutsideDockLocation } = await import('./embeddedTerminalDocking');

        const pane: AppPaneScopeApi = {
            scopeId: 'session:s1',
            scopeState: {
                right: { isOpen: false, activeTabId: null, tabState: {} },
                bottom: { isOpen: false, activeTabId: null, tabState: {} },
                details: {
                    isOpen: true,
                    activeTabKey: 'file:README.md',
                    tabState: {},
                    tabs: [
                        {
                            key: 'terminal:embedded',
                            kind: 'terminal',
                            title: 'Terminal',
                            isPinned: true,
                            isPreview: false,
                            resource: { kind: 'terminal', terminalInstanceId: 'embedded', cwd: null },
                        },
                        {
                            key: 'terminal:term-2',
                            kind: 'terminal',
                            title: 'Terminal 2',
                            isPinned: true,
                            isPreview: false,
                            resource: { kind: 'terminal', terminalInstanceId: 'term-2', cwd: null },
                        },
                        {
                            key: 'file:README.md',
                            kind: 'file',
                            title: 'README.md',
                            isPinned: true,
                            isPreview: false,
                            resource: { kind: 'file', path: 'README.md' },
                        },
                    ],
                },
            },
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            setRightTabState: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            setBottomTabState: vi.fn(),
            openDetailsTab: vi.fn(),
            replaceDetailsTab: vi.fn(),
            setDetailsTabState: vi.fn(),
            pinDetailsTab: vi.fn(),
            unpinDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
            closeDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
        };

        closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'bottom' });

        expect(pane.closeDetailsTab).toHaveBeenCalledTimes(2);
        expect(pane.closeDetailsTab).toHaveBeenNthCalledWith(1, 'terminal:embedded');
        expect(pane.closeDetailsTab).toHaveBeenNthCalledWith(2, 'terminal:term-2');
    });
});
