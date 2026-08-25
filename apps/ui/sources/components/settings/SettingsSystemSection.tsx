import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

type SettingsSystemSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'handleReportIssue'
    | 'onNavigate'
    | 'router'
    | 'theme'
>>;

export function SettingsSystemSection({ handleReportIssue, onNavigate, router, theme }: SettingsSystemSectionProps) {
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupSystem"
            router={router}
            theme={theme}
            onNavigate={(route) => {
                if (route === SETTINGS_ROUTES.reportIssue) {
                    void handleReportIssue();
                    return;
                }
                if (onNavigate) {
                    void onNavigate(route);
                    return;
                }
                router.push(route as never);
            }}
        />
    );
}
