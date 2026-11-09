import * as React from 'react';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { hasInAppResourceHandler } from '@/utils/url/openResource';

import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';

/** The existing Remote section stays available for link preferences without SCM write operations. */
export function ResourceOpenLocationSetting({ children }: React.PropsWithChildren) {
    const available = useAppShellPluginUiProjection(value => hasInAppResourceHandler(value.pluginUiProjection));
    const location = useSetting('scmResourceOpenLocation');
    const { setSetting } = useSettingActionFeedback();
    if (!available && !children) return null;

    const setting = SOURCE_CONTROL_SETTINGS.settings.resourceOpenLocation;
    return (
        <ItemGroup
            title={children ? t('settingsSourceControl.page.remote.title') : undefined}
            description={children ? t('settingsSourceControl.page.remote.description') : undefined}
        >
            {children}
            {available ? (
                <SettingAnchor setting={setting}>
                    <SegmentedChoiceItem<'happier' | 'github'>
                        title={t(setting.titleKey)}
                        subtitle={t('sessionGitPullRequest.settings.resourceOpenDescription')}
                        subtitleLines={0}
                        testIDPrefix="settings.sourceControl.resourceOpenLocation"
                        options={[
                            { id: 'happier', label: t('sessionGitPullRequest.settings.inHappier') },
                            { id: 'github', label: t('sessionGitPullRequest.settings.onGitHub') },
                        ]}
                        value={location}
                        onChange={next => { void setSetting(setting, next); }}
                    />
                </SettingAnchor>
            ) : null}
        </ItemGroup>
    );
}
