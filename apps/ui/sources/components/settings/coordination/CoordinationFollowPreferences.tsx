import * as React from 'react';
import type { ScrollView } from 'react-native';
import { DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, type SessionFollowCreationPoliciesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionAutoFollowPreferences } from '@/components/sessions/follow/useSessionAutoFollowPreferences';
import { SessionAutoFollowPreferencesSection } from '@/components/sessions/follow/SessionAutoFollowPreferencesSection';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { COORDINATION_SETTINGS } from './coordinationSettings';
import { showCoordinationLevelsSheet } from './CoordinationLevelsSheet';

type CreationLevelField = keyof SessionFollowCreationPoliciesV1;
const LEVEL_FIELDS = Object.keys(DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1) as CreationLevelField[];
const LEVEL_HINTS = {
    everything: 'settingsCoordination.levelEverythingHint',
    important: 'settingsCoordination.levelImportantHint',
    quiet: 'settingsCoordination.levelQuietHint',
} as const;
type LevelPreset = keyof typeof LEVEL_HINTS;
const LEVEL_PRESETS = Object.keys(LEVEL_HINTS) as readonly LevelPreset[];

/** Both sections edit one Home payload: one acquisition, baseline, mutation gate and retry intent. */
export function CoordinationFollowPreferences(props: Readonly<{ popoverBoundaryRef: React.RefObject<ScrollView | null> }>) {
    const activeServer = useActiveServerSnapshot();
    return <HomeFollowPreferences key={activeServer.serverId} serverId={activeServer.serverId} {...props} />;
}

function HomeFollowPreferences(props: Readonly<{
    serverId: string;
    popoverBoundaryRef: React.RefObject<ScrollView | null>;
}>) {
    const preferences = useSessionAutoFollowPreferences(props.serverId);
    return <>
        <DefaultLevelsGroup preferences={preferences} popoverBoundaryRef={props.popoverBoundaryRef} />
        <SessionAutoFollowPreferencesSection preferences={preferences} />
    </>;
}

function DefaultLevelsGroup(props: Readonly<{
    preferences: ReturnType<typeof useSessionAutoFollowPreferences>;
    popoverBoundaryRef: React.RefObject<ScrollView | null>;
}>) {
    const { enabled, displayed, confirmed, failed, online, saving, error, save, retry } = props.preferences;
    const failedField = LEVEL_FIELDS.find(field => failed?.patch[field] !== undefined);
    const sectionError = error && (!failed || failedField !== undefined);
    const [openField, setOpenField] = React.useState<CreationLevelField | null>(null);
    if (!enabled) return null;
    return <SettingSection section={COORDINATION_SETTINGS.sectionRefs.defaultLevels}>
        <ItemGroup title={t('settingsCoordination.defaultLevelsTitle')} description={t('settingsCoordination.defaultLevelsDescription')}>
            {displayed ? LEVEL_FIELDS.map((field) => {
                const setting = COORDINATION_SETTINGS.settings[field];
                const policy = displayed[field] ?? DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1[field];
                const items: DropdownMenuItem[] = [
                    ...LEVEL_PRESETS.map((preset) => ({ id: preset, title: t(`session.follow.policy.${preset}`), subtitle: t(LEVEL_HINTS[preset]) })),
                    ...(policy.preset === 'custom' ? [{ id: 'custom', title: t('session.follow.policy.custom'), disabled: true }] : []),
                ];
                return <SettingAnchor key={field} setting={setting}>
                    <DropdownMenu
                        testID={`settings-coordination-level-${field}`}
                        open={openField === field}
                        onOpenChange={(next) => setOpenField(next ? field : null)}
                        variant="selectable"
                        search={false}
                        selectedId={policy.preset}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={props.popoverBoundaryRef}
                        itemTrigger={{
                            title: t(setting.titleKey),
                            subtitle: setting.descriptionKey ? t(setting.descriptionKey) : undefined,
                            showSelectedSubtitle: false,
                            itemProps: { subtitleLines: 0, disabled: !online || saving },
                        }}
                        items={items}
                        onSelect={(id) => {
                            setOpenField(null);
                            if (id === policy.preset || !LEVEL_PRESETS.includes(id as LevelPreset)) return;
                            void save({ patch: { [field]: { preset: id as LevelPreset } } });
                        }}
                    />
                </SettingAnchor>;
            }) : <Item title={t('common.loading')} loading={!error && online} mode="info" />}
            <Item
                testID="settings-coordination-level-meaning"
                title={t('settingsCoordination.levelMeaning')}
                subtitle={t('settingsCoordination.levelImportantHint')}
                subtitleLines={0}
                showChevron
                onPress={showCoordinationLevelsSheet}
            />
            {!online || sectionError ? <Item
                testID="settings-coordination-levels-error"
                title={!online ? t('session.follow.offline') : failedField && confirmed
                    ? t('settingsCoordination.followDefaultSaveFailed', { field: t(COORDINATION_SETTINGS.settings[failedField].titleKey),
                        value: t(`session.follow.policy.${(confirmed[failedField] ?? DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1[failedField]).preset}`) })
                    : t('errors.unknownError')}
                titleLines={0}
                mode="info"
                accessibilityLiveRegion="polite"
            /> : null}
            {online && sectionError ? <Item
                testID="settings-coordination-levels-retry"
                title={t('common.retry')}
                onPress={retry}
                showChevron={false}
            /> : null}
        </ItemGroup>
    </SettingSection>;
}
