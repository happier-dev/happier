import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import { COORDINATION_SETTINGS } from '@/components/settings/coordination/coordinationSettings';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import type { useSessionAutoFollowPreferences } from './useSessionAutoFollowPreferences';

const FIELDS = ['assigned', 'direct', 'team', 'group'] as const;
const FIELD_SETTINGS = {
    assigned: COORDINATION_SETTINGS.settings.autoFollowAssigned,
    direct: COORDINATION_SETTINGS.settings.autoFollowDirect,
    team: COORDINATION_SETTINGS.settings.autoFollowTeam,
    group: COORDINATION_SETTINGS.settings.autoFollowGroup,
};
type AutoFollowLevel = 'important' | 'off';

/**
 * Follow automatically (Settings → Coordination, lab P5): each default rule is a level — Important follows
 * the matching sessions, Off does not. The Home's four `follow.preferences` switches stay the stored value.
 */
export function SessionAutoFollowPreferencesSection({ preferences }: Readonly<{
    preferences: ReturnType<typeof useSessionAutoFollowPreferences>;
}>) {
    const { enabled, displayed, confirmed, failed, online, saving, error, save, retry } = preferences;
    const failedField = FIELDS.find(field => failed && Object.hasOwn(failed.patch, field));
    const sectionError = error && (!failed || failedField !== undefined);
    if (!enabled) return null;
    const levels = [
        { id: 'important' as const, label: t('session.follow.policy.important') },
        { id: 'off' as const, label: t('common.off') },
    ];
    return <SettingSection section={COORDINATION_SETTINGS.sectionRefs.autoFollow}>
        <ItemGroup title={t('session.follow.preferences.title')} description={t('session.follow.preferences.help')}>
        {displayed ? FIELDS.map((field) => <SettingAnchor key={field} setting={FIELD_SETTINGS[field]}>
            <SegmentedChoiceItem<AutoFollowLevel>
                testIDPrefix={`session-auto-follow-${field}`}
                title={t(FIELD_SETTINGS[field].titleKey)}
                titleLines={0}
                options={levels}
                value={displayed[field] ? 'important' : 'off'}
                disabled={!online || saving}
                onChange={(level) => { void save({ patch: { [field]: level === 'important' } }); }}
            />
        </SettingAnchor>) : <Item title={t('common.loading')} loading={!error && online} mode="info" />}
        {!online || sectionError ? <Item
            testID="session-auto-follow-error"
            title={!online ? t('session.follow.offline') : failedField && confirmed
                ? t('settingsCoordination.followDefaultSaveFailed', { field: t(FIELD_SETTINGS[failedField].titleKey),
                    value: confirmed[failedField] ? t('session.follow.policy.important') : t('common.off') })
                : t('errors.unknownError')}
            titleLines={0}
            mode="info"
            accessibilityLiveRegion="polite"
        /> : null}
        {online && sectionError ? <Item
            testID="session-auto-follow-retry"
            title={t('common.retry')}
            onPress={retry}
            showChevron={false}
        /> : null}
    </ItemGroup>
    </SettingSection>;
}
