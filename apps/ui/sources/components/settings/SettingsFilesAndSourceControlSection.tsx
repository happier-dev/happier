import * as React from 'react';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';

type SettingsFilesAndSourceControlSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'attachmentsUploadsEnabled'
    | 'router'
    | 'sourceControlEnabled'
    | 'theme'
>>;

export const SettingsFilesAndSourceControlSection = React.memo(function SettingsFilesAndSourceControlSection({
    attachmentsUploadsEnabled,
    router,
    sourceControlEnabled,
    theme,
}: SettingsFilesAndSourceControlSectionProps) {
    return (
        <ItemGroup title={t('settings.filesAndSourceControl')}>
            {sourceControlEnabled ? (
                <Item
                    title={t('settings.filesSourceControl')}
                    subtitle={t('settings.filesSourceControlSubtitle')}
                    icon={<SafeIonicons name="git-branch-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push(SETTINGS_ROUTES.sourceControl)}
                />
            ) : null}
            {attachmentsUploadsEnabled ? (
                <Item
                    title={t('settings.attachments')}
                    subtitle={t('settings.attachmentsSubtitle')}
                    icon={<SafeIonicons name="attach-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push(SETTINGS_ROUTES.attachments)}
                />
            ) : null}
        </ItemGroup>
    );
});
