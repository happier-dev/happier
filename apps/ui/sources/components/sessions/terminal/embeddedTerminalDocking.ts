import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildTerminalDetailsTabKey, createTerminalDetailsTab, isTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
import { t } from '@/text';

export type EmbeddedTerminalDockLocation = 'sidebar' | 'details' | 'bottom';

export const SESSION_PRIMARY_TERMINAL_INSTANCE_ID = 'embedded';
export const SESSION_DETAILS_TERMINAL_TAB_KEY = buildTerminalDetailsTabKey(SESSION_PRIMARY_TERMINAL_INSTANCE_ID);

export function createSessionDetailsTerminalTab(params?: Readonly<{
    terminalInstanceId?: string | null;
}>) {
    return createTerminalDetailsTab({
        title: t('settings.terminal'),
        terminalInstanceId: params?.terminalInstanceId ?? undefined,
    });
}

export function createPrimarySessionDetailsTerminalTab() {
    return createTerminalDetailsTab({
        title: t('settings.terminal'),
        terminalInstanceId: SESSION_PRIMARY_TERMINAL_INSTANCE_ID,
    });
}

export function openNewSessionDetailsTerminalTab(pane: AppPaneScopeApi): void {
    pane.openDetailsTab(
        createSessionDetailsTerminalTab(),
        { intent: 'pinned' },
    );
}

export function closeEmbeddedTerminalOutsideDockLocation(params: Readonly<{
    pane: AppPaneScopeApi;
    dockLocation: EmbeddedTerminalDockLocation;
}>): void {
    const scopeState = params.pane.scopeState;

    const rightTerminalActive = Boolean(scopeState?.right.isOpen) && scopeState?.right.activeTabId === 'terminal';
    const bottomTerminalActive = Boolean(scopeState?.bottom?.isOpen) && scopeState?.bottom?.activeTabId === 'terminal';
    const detailsTerminalTabKeys = (scopeState?.details.tabs ?? [])
        .filter((tab) => isTerminalDetailsTab({
            resource: tab.resource,
            tabKey: tab.key,
        }))
        .map((tab) => tab.key);

    if (params.dockLocation !== 'sidebar' && rightTerminalActive) {
        params.pane.closeRight();
    }
    if (params.dockLocation !== 'bottom' && bottomTerminalActive) {
        params.pane.closeBottom();
    }
    if (params.dockLocation !== 'details') {
        for (const tabKey of detailsTerminalTabKeys) {
            params.pane.closeDetailsTab(tabKey);
        }
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
        params.pane.openDetailsTab(createPrimarySessionDetailsTerminalTab(), { intent: 'pinned' });
        return;
    }

    params.pane.openRight({ tabId: 'terminal' });
    params.pane.setRightTab('terminal');
}
