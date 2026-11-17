import * as React from 'react';
import type { ThemeLibraryEntry, ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createThemePluginShareForm } from './themePluginShareForm';
import type { ThemeUiActionExecute } from './useThemeActionExecution';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

const NO_THEMES: readonly ThemeLibraryEntry[] = [];

/** Mounted editor and library menus reuse the same form, Machine picker and Action approval. */
export function useThemePluginShare(execute: ThemeUiActionExecute, themes: readonly ThemeLibraryEntry[] = NO_THEMES) {
    const scope = useAccountSettingsScope();
    const { executeValue } = useMountedActionExecution(scope);
    const { binding } = useServerCredentialAccountScopeBinding(scope?.serverId);
    const form = React.useRef<ReturnType<typeof createThemePluginShareForm> | null>(null);
    React.useEffect(() => () => { form.current?.retire(); form.current = null; }, [binding]);
    return React.useCallback((refs: readonly ThemeReference[]) => {
        const labels = { share: t('settingsAppearance.themeProfiles.shareAsPlugin'),
            machine: t('settingsAppearance.themeProfiles.sharePluginMachine'),
            path: t('settingsAppearance.themeProfiles.sharePluginPath'),
            themes: t('settingsAppearance.themeProfiles.yourThemes'), retry: t('common.retry') };
        if (!binding) {
            Modal.alert(labels.share, t('common.unavailable'));
            return;
        }
        form.current?.retire();
        const next = createThemePluginShareForm({ refs: [...refs], ...(themes.length ? { themes } : {}), serverId: binding.scope.serverId, labels,
            execute, accountLifetime: binding,
            pack: (input, operation) => executeValue('plugins.pack', input, operation),
            onShared: result => Modal.alert(labels.share, [result.project, result.archive, result.digest].join('\n')),
        });
        form.current = next;
        presentActionInputForm({ form: next,
            pickerContext: { serverId: binding.scope.serverId, accountLifetime: binding } });
    }, [binding, execute, executeValue, themes]);
}
