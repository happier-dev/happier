import * as React from 'react';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type SettingsSessionsBehaviorSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'automationsNeedLocalEnablement'
    | 'executionRunsEnabled'
    | 'router'
    | 'showAutomations'
    | 'terminalUseTmux'
    | 'theme'
>>;

export const SettingsSessionsBehaviorSection = React.memo(function SettingsSessionsBehaviorSection({
    automationsNeedLocalEnablement,
    executionRunsEnabled,
    router,
    showAutomations,
    terminalUseTmux,
    theme,
}: SettingsSessionsBehaviorSectionProps) {
    return (
        <ItemGroup title={t('settings.sessionsBehavior')}>
            <Item
                title={t('settings.sessions')}
                subtitle={terminalUseTmux ? t('settings.sessionSubtitleTmuxEnabled') : t('settings.sessionSubtitleMessageSendingAndTmux')}
                icon={<SafeIonicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/(app)/settings/session')}
            />
            <Item
                title={t('common.actions')}
                subtitle={t('settings.actionsSubtitle')}
                icon={<SafeIonicons name="flash-outline" size={29} color={theme.colors.accent.orange} />}
                onPress={() => router.push('/(app)/settings/actions')}
            />
            <Item
                title={t('settings.transcript')}
                subtitle={t('settings.transcriptSubtitle')}
                icon={<SafeIonicons name="chatbubbles-outline" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/(app)/settings/session/transcript')}
            />
            <Item
                title={t('settings.permissions')}
                subtitle={t('settings.permissionsSubtitle')}
                icon={<SafeIonicons name="shield-outline" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/(app)/settings/session/permissions')}
            />
            {showAutomations ? (
                <Item
                    title={t('settings.automations')}
                    subtitle={automationsNeedLocalEnablement
                        ? t('settingsFeatures.expAutomationsSubtitle')
                        : t('settings.automationsSubtitle')}
                    icon={<SafeIonicons name="timer-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push(automationsNeedLocalEnablement ? '/(app)/settings/features' : '/automations')}
                />
            ) : null}
            {executionRunsEnabled ? (
                <Item
                    title={t('runs.title')}
                    subtitle={t('settings.executionRunsSubtitle')}
                    icon={<SafeIonicons name="play-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/runs')}
                />
            ) : null}
        </ItemGroup>
    );
});
