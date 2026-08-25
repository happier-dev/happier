import * as React from 'react';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';
import { Item } from '@/components/ui/lists/Item';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type SettingsSessionsBehaviorSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'automationsNeedLocalEnablement'
    | 'onNavigate'
    | 'router'
    | 'showAutomations'
    | 'terminalUseTmux'
    | 'theme'
>>;

export const SettingsSessionsBehaviorSection = React.memo(function SettingsSessionsBehaviorSection({
    automationsNeedLocalEnablement,
    onNavigate,
    router,
    showAutomations,
    terminalUseTmux,
    theme,
}: SettingsSessionsBehaviorSectionProps) {
    return (
        <SettingsCatalogOverviewGroup
            groupId="groupSessionsBehavior"
            onNavigate={onNavigate}
            router={router}
            theme={theme}
            resolveSubtitle={(page, defaultSubtitle) => (
                page.id === 'session'
                    ? terminalUseTmux
                        ? t('settings.sessionSubtitleTmuxEnabled')
                        : t('settings.sessionSubtitleMessageSendingAndTmux')
                    : defaultSubtitle
            )}
            append={showAutomations ? (
                <Item
                    title={t('settings.automations')}
                    subtitle={automationsNeedLocalEnablement
                        ? t('settingsFeatures.expAutomationsSubtitle')
                        : t('settings.automationsSubtitle')}
                    icon={<Icon name="timer" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push(automationsNeedLocalEnablement ? SETTINGS_ROUTES.features : '/automations')}
                />
            ) : null}
        />
    );
});
