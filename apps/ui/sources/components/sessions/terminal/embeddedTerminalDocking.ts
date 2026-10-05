import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildTerminalDetailsTabKey, createTerminalDetailsTab, isTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
import { t } from '@/text';

export type EmbeddedTerminalDockLocation = 'sidebar' | 'details' | 'bottom';

export const SESSION_PRIMARY_TERMINAL_INSTANCE_ID = 'embedded';
export const SESSION_DETAILS_TERMINAL_TAB_KEY = buildTerminalDetailsTabKey(SESSION_PRIMARY_TERMINAL_INSTANCE_ID);

export function createSessionDetailsTerminalTab(params: Readonly<{
    terminalInstanceId: string;
}>) {
    return createTerminalDetailsTab({
        title: t('settings.terminal'),
        terminalInstanceId: params.terminalInstanceId,
    });
}

export function createPrimarySessionDetailsTerminalTab() {
    return createTerminalDetailsTab({
        title: t('settings.terminal'),
        terminalInstanceId: SESSION_PRIMARY_TERMINAL_INSTANCE_ID,
    });
}

/** Move an existing terminal's view, never its PTY, into pinned Details. */
export function openSessionTerminalInDetails(
    pane: Pick<AppPaneScopeApi, 'openDetailsTab' | 'closeBottom'>,
    terminalInstanceId: string,
): void {
    pane.openDetailsTab(createSessionDetailsTerminalTab({ terminalInstanceId }), { intent: 'pinned' });
    pane.closeBottom();
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
    dockLocation: 'sidebar' | 'bottom';
}>): void {
    if (params.dockLocation === 'bottom') {
        params.pane.openBottom({ tabId: 'terminal' });
        params.pane.setBottomTab('terminal');
        return;
    }

    params.pane.openRight({ tabId: 'terminal' });
    params.pane.setRightTab('terminal');
}
