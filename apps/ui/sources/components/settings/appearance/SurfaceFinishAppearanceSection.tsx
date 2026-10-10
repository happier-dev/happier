import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { THEME_SURFACE_FINISH_ROLES, type ThemeSurfaceFinish } from '@/theme/themeStyleScales';

import { APPEARANCE_SETTINGS } from './appearanceSettings';
import { resolveSurfaceFinishOverrideDelta, type SurfaceFinishChoice } from './surfaceFinishSettingBindings';

function finishLabel(finish: ThemeSurfaceFinish): string {
    return t(finish === 'flat' ? 'settingsAppearance.surfaceFinish.flat' : 'settingsAppearance.surfaceFinish.soft');
}

const roleSettings = {
    card: APPEARANCE_SETTINGS.settings.surfaceFinishCard,
    floating: APPEARANCE_SETTINGS.settings.surfaceFinishFloating,
    composer: APPEARANCE_SETTINGS.settings.surfaceFinishComposer,
    primaryButton: APPEARANCE_SETTINGS.settings.surfaceFinishPrimaryButton,
    secondaryButton: APPEARANCE_SETTINGS.settings.surfaceFinishSecondaryButton,
} as const;

/** The real card previews the effective card finish, including a deliberate role override. */
export function SurfaceFinishAppearanceSection() {
    const { theme } = useUnistyles();
    const [storedFinish, setFinish] = useLocalSettingMutable('uiSurfaceFinish');
    const [storedOverrides, setOverrides] = useLocalSettingMutable('uiSurfaceFinishOverrides');
    const finish = storedFinish ?? 'soft';
    const overrides = storedOverrides ?? {};
    const [expanded, setExpanded] = React.useState(false);
    const settings = APPEARANCE_SETTINGS.settings;
    const choices = ([ 'flat', 'soft' ] as const).map(id => ({ id, label: finishLabel(id) }));
    const roleChoices: ReadonlyArray<{ id: SurfaceFinishChoice; label: string }> = [{ id: 'auto', label: t('settingsAppearance.surfaceFinish.auto') }, ...choices];
    return <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.surfaceFinish}>
        <ItemGroup title={t('settingsAppearance.surfaceFinish.title')} description={t('settingsAppearance.surfaceFinish.description')}>
            <SectionContentRow testID="settings-appearance-finish-preview">
                <SurfaceCard testID="settings-appearance-finish-preview-card" padding="md">
                    <View style={styles.previewContent}>
                        <Text style={styles.previewTitle}>{t('settingsAppearance.surfaceFinish.card')}</Text>
                        <Text style={styles.previewValue}>{finishLabel(overrides.card ?? finish)}</Text>
                    </View>
                </SurfaceCard>
            </SectionContentRow>
            <SettingAnchor setting={settings.surfaceFinish}>
                <SegmentedChoiceItem title={t(settings.surfaceFinish.titleKey)} testIDPrefix="settings-appearance-finish" options={choices} value={finish} onChange={setFinish} />
            </SettingAnchor>
            <SettingAnchor settings={[settings.surfaceFinishCustomize, ...Object.values(roleSettings)]}>
                <ExpandableItem expanded={expanded} onExpandedChange={setExpanded} header={({ headerProps, expanded: open }) => <Item {...headerProps}
                    title={t(settings.surfaceFinishCustomize.titleKey)} testID="settings-appearance-finish-customize" showChevron={false}
                    detail={open ? undefined : finishLabel(finish)}
                    rightElement={<Icon name={open ? 'caret-up' : 'caret-down'} color={theme.colors.text.secondary} size={theme.iconSize.medium} />}
                />}>
                    {THEME_SURFACE_FINISH_ROLES.map(role => <SettingAnchor key={role} setting={roleSettings[role]}>
                        <SegmentedChoiceItem
                            title={t(roleSettings[role].titleKey)} subtitle={finishLabel(overrides[role] ?? finish)}
                            testIDPrefix={`settings-appearance-finish-${role}`} options={roleChoices} value={overrides[role] ?? 'auto'}
                            onChange={value => setOverrides(resolveSurfaceFinishOverrideDelta({ uiSurfaceFinishOverrides: overrides }, role, value).uiSurfaceFinishOverrides)}
                        />
                    </SettingAnchor>)}
                </ExpandableItem>
            </SettingAnchor>
        </ItemGroup>
    </SettingSection>;
}

const styles = StyleSheet.create(theme => ({
    previewContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.margins.md },
    previewTitle: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    previewValue: { ...Typography.default(), color: theme.colors.text.secondary },
}));
