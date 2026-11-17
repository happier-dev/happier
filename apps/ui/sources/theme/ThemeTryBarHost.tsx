import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readStoreOpenItem } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { ThemeTryBar } from '@/components/settings/appearance/themeProfiles/ThemeTryBar';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getThemeTryOnOwner } from './profiles/themeTryOnRuntime';
import { projectThemeLibraryEntry } from './profiles/themeProfilePresentation';
import { Modal } from '@/modal';
import { t } from '@/text';

const selectedStoreListing = (params: Readonly<Record<string, unknown>>) => readStoreOpenItem(params);

/** One shell host follows the current preview and the navigation owner's focused listing. */
export function ThemeTryBarHost() {
    const scope = useAccountSettingsScope();
    const { execute, ready } = useMountedActionExecution(scope);
    const owner = getThemeTryOnOwner();
    const selected = useDestinationGlobalParamsSelector(selectedStoreListing);
    const readPreview = React.useCallback(() => {
        const current = owner.read();
        const inListing = current?.origin.kind === 'store' && selected?.type === 'registryItem' && selected.kind === 'theme'
            && current.origin.listing.sourceId === selected.sourceId && current.origin.listing.itemId === selected.itemId;
        return inListing ? null : current;
    }, [owner, selected]);
    const preview = React.useSyncExternalStore(owner.subscribe, readPreview, readPreview);
    const [busy, setBusy] = React.useState<'install' | 'revert' | null>(null);
    const entry = React.useMemo(() => preview?.document ? projectThemeLibraryEntry(preview.document) : null, [preview?.document]);
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
    return <ThemeTryBar visible={Boolean(preview)} faceName={entry?.name ?? t('settingsAppearance.theme')}
        miniature={entry?.miniature ?? null} here={t('themeDevices.here')} busy={busy}
        disabled={!ready} origin={preview?.origin.kind ?? 'editor'}
        onInstall={() => settle('install')} onRevert={() => settle('revert')} testID="theme.tryBar" />;
}
