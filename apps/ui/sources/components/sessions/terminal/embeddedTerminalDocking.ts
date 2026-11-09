import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildTerminalDetailsTabKey, createTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
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
    pane: Pick<AppPaneScopeApi, 'openDetailsTab'>,
    terminalInstanceId: string,
): void {
    pane.openDetailsTab(createSessionDetailsTerminalTab({ terminalInstanceId }), { intent: 'pinned' });
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
