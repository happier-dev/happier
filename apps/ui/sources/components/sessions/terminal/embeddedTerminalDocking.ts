import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildTerminalDetailsTabKey, createTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
import { createBrowserLaunchpadDetailsTab } from '@/components/browser/surfaces';
import { t } from '@/text';

export type EmbeddedTerminalDockLocation = 'sidebar' | 'details' | 'bottom';
export type EmbeddedDockTool = 'terminal' | 'browser' | 'sidebar';

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

/** Canonical placement owner for tools launched from Session and Project rails. */
export function openEmbeddedToolInDockLocation(params: Readonly<{
    pane: Pick<AppPaneScopeApi, 'openDetailsTab' | 'openBottom' | 'setBottomTab' | 'openRight' | 'setRightTab'>;
    tool: EmbeddedDockTool;
}>): void {
    if (params.tool === 'browser') {
        params.pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
        return;
    }
    if (params.tool === 'terminal') {
        openEmbeddedTerminalInDockLocation({ pane: params.pane, dockLocation: 'bottom' });
        return;
    }
    openEmbeddedTerminalInDockLocation({ pane: params.pane, dockLocation: 'sidebar' });
}

/** Move an existing terminal's view, never its PTY, into pinned Details. */
export function openSessionTerminalInDetails(
    pane: Pick<AppPaneScopeApi, 'openDetailsTab'>,
    terminalInstanceId: string,
): void {
    pane.openDetailsTab(createSessionDetailsTerminalTab({ terminalInstanceId }), { intent: 'pinned' });
}

export function openEmbeddedTerminalInDockLocation(params: Readonly<{
    pane: Pick<AppPaneScopeApi, 'openBottom' | 'setBottomTab' | 'openRight' | 'setRightTab'>;
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

/** Toggle the embedded Terminal at the canonical Session/Project dock location. */
export function toggleEmbeddedTerminalInDockLocation(params: Readonly<{
    pane: Pick<AppPaneScopeApi, 'openBottom' | 'setBottomTab' | 'closeBottom' | 'openRight' | 'setRightTab' | 'closeRight' | 'closeDetails'>;
    dockLocation: 'sidebar' | 'bottom';
    bottomTerminalActive: boolean;
    rightTerminalActive: boolean;
    rightPaneHiddenByDetails: boolean;
}>): void {
    if (params.dockLocation === 'bottom') {
        if (params.bottomTerminalActive) {
            params.pane.closeBottom();
            return;
        }
        openEmbeddedTerminalInDockLocation({ pane: params.pane, dockLocation: 'bottom' });
        return;
    }

    if (params.rightTerminalActive && !params.rightPaneHiddenByDetails) {
        params.pane.closeRight();
        return;
    }
    if (params.rightPaneHiddenByDetails) params.pane.closeDetails();
    openEmbeddedTerminalInDockLocation({ pane: params.pane, dockLocation: 'sidebar' });
}
