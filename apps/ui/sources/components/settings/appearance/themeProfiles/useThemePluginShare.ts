import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import type { ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createThemePluginShareForm } from './themePluginShareForm';
import type { ThemeUiActionExecute } from './useThemeActionExecution';

/** Mounted editor and library menus reuse the same form, Machine picker and Action approval. */
export function useThemePluginShare(execute: ThemeUiActionExecute) {
    const scope = useAccountSettingsScope();
    const { binding } = useServerCredentialAccountScopeBinding(scope?.serverId);
    const form = React.useRef<ReturnType<typeof createThemePluginShareForm> | null>(null);
    React.useEffect(() => () => { form.current?.retire(); form.current = null; }, [binding]);
    return React.useCallback((refs: readonly ThemeReference[]) => {
        const labels = { share: t('settingsAppearance.themeProfiles.shareAsPlugin'),
            machine: t('settingsAppearance.themeProfiles.sharePluginMachine'),
            path: t('settingsAppearance.themeProfiles.sharePluginPath') };
        if (!binding) {
            Modal.alert(labels.share, t('common.unavailable'));
            return;
        }
        form.current?.retire();
        const next = createThemePluginShareForm({ refs: [...refs], serverId: binding.scope.serverId, labels,
            execute, accountLifetime: binding,
            onShared: result => Modal.alert(labels.share, [result.project, result.archive, result.digest].join('\n')),
        });
        form.current = next;
        presentActionInputForm({ form: next, actionId: THEME_ACTION_IDS.sharePlugin,
            pickerContext: { serverId: binding.scope.serverId, accountLifetime: binding } });
    }, [binding, execute]);
}
