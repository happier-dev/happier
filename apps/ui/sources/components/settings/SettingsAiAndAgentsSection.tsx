import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';

type SettingsAiAndAgentsSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'onNavigate'
    | 'router'
    | 'theme'
>>;

export function SettingsAiAndAgentsSection({
    onNavigate,
    router,
    theme,
}: SettingsAiAndAgentsSectionProps) {
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupAiAndAgents"
            onNavigate={onNavigate}
            router={router}
            theme={theme}
        />
    );
}
