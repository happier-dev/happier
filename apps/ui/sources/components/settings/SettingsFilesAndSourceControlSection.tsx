import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';

type SettingsFilesAndSourceControlSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'onNavigate'
    | 'router'
    | 'theme'
>>;

export function SettingsFilesAndSourceControlSection({
    onNavigate,
    router,
    theme,
}: SettingsFilesAndSourceControlSectionProps) {
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupFilesAndSourceControl"
            onNavigate={onNavigate}
            router={router}
            theme={theme}
        />
    );
}
