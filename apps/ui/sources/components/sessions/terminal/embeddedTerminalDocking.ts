import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { t } from '@/text';

export type EmbeddedTerminalDockLocation = 'sidebar' | 'details' | 'bottom';

export const SESSION_DETAILS_TERMINAL_TAB_KEY = 'terminal:embedded';

export function createSessionDetailsTerminalTab() {
    return {
        key: SESSION_DETAILS_TERMINAL_TAB_KEY,
        kind: 'terminal',
        title: t('settings.terminal'),
        resource: { kind: 'terminal' },
    } as const;
}

export function closeEmbeddedTerminalOutsideDockLocation(params: Readonly<{
    pane: AppPaneScopeApi;
    dockLocation: EmbeddedTerminalDockLocation;
}>): void {
    const scopeState = params.pane.scopeState;

    const rightTerminalActive = Boolean(scopeState?.right.isOpen) && scopeState?.right.activeTabId === 'terminal';
    const bottomTerminalActive = Boolean(scopeState?.bottom?.isOpen) && scopeState?.bottom?.activeTabId === 'terminal';
    const detailsHasTerminalTab = Boolean(scopeState?.details.tabs?.some((tab) => tab.key === SESSION_DETAILS_TERMINAL_TAB_KEY));

    if (params.dockLocation !== 'sidebar' && rightTerminalActive) {
        params.pane.closeRight();
    }
    if (params.dockLocation !== 'bottom' && bottomTerminalActive) {
        params.pane.closeBottom();
    }
    if (params.dockLocation !== 'details' && detailsHasTerminalTab) {
        params.pane.closeDetailsTab(SESSION_DETAILS_TERMINAL_TAB_KEY);
    }
}

export function openEmbeddedTerminalInDockLocation(params: Readonly<{
    pane: AppPaneScopeApi;
    dockLocation: EmbeddedTerminalDockLocation;
}>): void {
    if (params.dockLocation === 'bottom') {
        params.pane.openBottom({ tabId: 'terminal' });
        params.pane.setBottomTab('terminal');
        return;
    }

    if (params.dockLocation === 'details') {
        params.pane.openDetailsTab(createSessionDetailsTerminalTab(), { intent: 'pinned' });
        return;
    }

    params.pane.openRight({ tabId: 'terminal' });
    params.pane.setRightTab('terminal');
}
