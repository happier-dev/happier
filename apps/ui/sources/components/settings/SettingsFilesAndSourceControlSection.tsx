import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';

type SettingsFilesAndSourceControlSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'router'
    | 'theme'
>>;

export function SettingsFilesAndSourceControlSection({
    router,
    theme,
}: SettingsFilesAndSourceControlSectionProps) {
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupFilesAndSourceControl"
            router={router}
            theme={theme}
        />
    );
}
