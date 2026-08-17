import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';

type SettingsAiAndAgentsSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'router'
    | 'theme'
>>;

export function SettingsAiAndAgentsSection({
    router,
    theme,
}: SettingsAiAndAgentsSectionProps) {
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupAiAndAgents"
            router={router}
            theme={theme}
        />
    );
}
