import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { createTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';
import { t } from '@/text';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

export function buildProjectTerminalDetailsInstanceId(workspaceRefId: string): string {
    const normalizedWorkspaceRefId = String(workspaceRefId ?? '').trim() || 'unknown';
    return `project:${normalizedWorkspaceRefId}:terminal`;
}

export function openProjectTerminalDetailsTab(params: Readonly<{
    openDetailsTab: AppPaneScopeApi['openDetailsTab'];
    cwd?: string | null;
    terminalInstanceId?: string | null;
}>): void {
    deferOnWeb(() => {
        const terminalInstanceId = params.terminalInstanceId?.trim() || null;
        params.openDetailsTab(
            createTerminalDetailsTab({
                title: t('settings.terminal'),
                terminalInstanceId,
                cwd: params.cwd ?? null,
            }),
            { intent: 'pinned' },
        );
    });
}
