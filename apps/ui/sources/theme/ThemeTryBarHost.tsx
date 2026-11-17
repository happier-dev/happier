import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ThemeTryBar } from '@/components/settings/appearance/themeProfiles/ThemeTryBar';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getThemeTryOnOwner } from './profiles/themeTryOnRuntime';
import { projectThemeMiniature } from './profiles/themeProfilePresentation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';

/** The shared preview owner hands controls here when its origin has no visible presenter. */
export function ThemeTryBarHost() {
    const scope = useAccountSettingsScope();
    const { execute, ready } = useMountedActionExecution(scope);
    const owner = getThemeTryOnOwner();
    const preview = React.useSyncExternalStore(owner.subscribe, owner.readGlobalPresentation, owner.readGlobalPresentation);
    const preference = useLocalSetting('themePreference', undefined, preview !== null);
    const [busy, setBusy] = React.useState<'install' | 'revert' | null>(null);
    const miniature = React.useMemo(() => preview?.document
        ? projectThemeMiniature(preview.document.profile, preview.mode) : null, [preview?.document, preview?.mode]);
    const settle = async (kind: 'install' | 'revert') => {
        if (!preview) return;
        setBusy(kind);
        try {
            const result = await execute(kind === 'install' ? THEME_ACTION_IDS.keep : THEME_ACTION_IDS.revert, { previewRef: preview.previewRef });
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.unknown'));
        } finally { setBusy(null); }
    };
    return <ThemeTryBar visible={preview !== null} faceName={preview?.document?.profile.name ?? t('settingsAppearance.themeProfiles.defaultTheme')}
        switchToMode={preview && preference !== 'adaptive' && preference !== preview.mode ? preview.mode : undefined}
        miniature={miniature} here={t('themeDevices.here')} busy={busy}
        disabled={!ready} origin={preview?.origin.kind ?? 'editor'}
        installLabel={preview?.selection?.kind === 'plugin' ? t('common.apply') : undefined}
        onInstall={() => settle('install')} onRevert={() => settle('revert')} testID="theme.tryBar" />;
}
