import * as React from 'react';
import { useOpenAppSection } from '@/components/appShell/workspace/destinationRoute';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';

type SettingsSessionsBehaviorSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'automationsNeedLocalEnablement'
    | 'onNavigate'
    | 'router'
    | 'showAutomations'
>>;

export const SettingsSessionsBehaviorSection = React.memo(function SettingsSessionsBehaviorSection({
    automationsNeedLocalEnablement,
    onNavigate,
    router,
    showAutomations,
}: SettingsSessionsBehaviorSectionProps) {
    const openSection = useOpenAppSection();
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupSessionsBehavior"
            onNavigate={onNavigate}
            router={router}
            append={showAutomations ? (
                <Item
                    testID="settings-workflow-run-settings"
                    title={t('workflows.destination.runSettingsPage.title')}
                    icon={<Icon name="tree-structure" />}
                    subtitle={automationsNeedLocalEnablement
                        ? t('settingsFeatures.expAutomationsSubtitle')
                        : t('workflows.destination.runSettingsPage.description')}
                    // Workflow run settings live under the Workflows destination (FIN 04 §3.5); while
                    // Automations is off on this device the row leads to the switch that turns it on.
                    onPress={() => automationsNeedLocalEnablement
                        ? router.push(SETTINGS_ROUTES.features)
                        : openSection('/workflows/settings')}
                />
            ) : null}
        />
    );
});
