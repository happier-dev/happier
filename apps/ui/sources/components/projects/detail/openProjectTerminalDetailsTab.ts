import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { t } from '@/text';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

export function openProjectTerminalDetailsTab(pane: AppPaneScopeApi): void {
    deferOnWeb(() => {
        pane.openDetailsTab(
            {
                key: 'terminal',
                kind: 'terminal',
                title: t('settings.terminal'),
                resource: { kind: 'terminal' },
            },
            { intent: 'pinned' },
        );
    });
}
