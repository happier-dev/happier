import * as React from 'react';

import type { PluginUpdateReviewModeV1 } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useSettingMutable } from '@/sync/store/hooks';
import { t } from '@/text';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { PLUGINS_SETTINGS } from '@/components/settings/plugins/pluginsSettings';

/**
 * The Account preference the daemon applies to every managed plugin update: ask before an update
 * widens the access the user granted, or apply it automatically. Contributions of already-trusted
 * code never ask, and development plugins never ask on change.
 */
export const PluginUpdateReviewSettingsEntry = React.memo(function PluginUpdateReviewSettingsEntry() {
    const [mode, setMode] = useSettingMutable('pluginUpdateReviewModeV1');
    const options = React.useMemo(() => [
        { id: 'confirmAccessChanges' as const, label: t('settingsPlugins.updateReview.confirmOption') },
        { id: 'autoApply' as const, label: t('settingsPlugins.updateReview.autoApplyOption') },
    ], []);
    return (
        <ItemGroup title={t('settingsPlugins.surfaces.updatesTitle')}>
            <SettingAnchor setting={PLUGINS_SETTINGS.settings.updateReview}>
                <SegmentedChoiceItem<PluginUpdateReviewModeV1>
                    testID="settings.plugins.updateReview"
                    testIDPrefix="settings.plugins.updateReview"
                    title={t(PLUGINS_SETTINGS.settings.updateReview.titleKey)}
                    subtitle={mode === 'autoApply'
                        ? t('settingsPlugins.updateReview.autoApplySubtitle')
                        : t('settingsPlugins.updateReview.confirmSubtitle')}
                    options={options}
                    value={mode}
                    onChange={setMode}
                />
            </SettingAnchor>
        </ItemGroup>
    );
});
