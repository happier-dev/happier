import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { playSoundEffect } from '@/activity/sounds/playSoundEffect';
import { SOUND_EFFECT_IDS, type SoundEffectId } from '@/activity/sounds/soundEffectCatalog';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type SoundSettingKey =
    | 'soundEffectsErrorSound'
    | 'soundEffectsAttentionSound'
    | 'soundEffectsSuccessSound'
    | 'soundEffectsResumeSound';

// Each sound is listed by its file name without the extension.
const SOUND_MENU_ITEMS: ReadonlyArray<DropdownMenuItem> = SOUND_EFFECT_IDS.map((id) => ({ id, title: id }));

const SoundEffectPicker = React.memo(function SoundEffectPicker(props: Readonly<{
    settingKey: SoundSettingKey;
    title: string;
    subtitle: string;
    iconName: React.ComponentProps<typeof Icon>['name'];
    iconColor: string;
    disabled: boolean;
}>) {
    const [selected, setSelected] = useLocalSettingMutable(props.settingKey);
    const [open, setOpen] = React.useState(false);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={selected}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: props.title,
                subtitle: props.subtitle,
                showSelectedSubtitle: false,
                icon: <Icon name={props.iconName} size={29} color={props.iconColor} />,
                itemProps: { disabled: props.disabled },
            }}
            items={SOUND_MENU_ITEMS}
            onSelect={(itemId) => {
                const id = itemId as SoundEffectId;
                setSelected(id);
                setOpen(false);
                // Let people hear their choice.
                fireAndForget(playSoundEffect(id), { tag: 'SoundEffectsSettingsGroup.preview' });
            }}
        />
    );
});

/** Device-only sound effects for the red, yellow and green session states and usage-limit resumes. */
export const SoundEffectsSettingsGroup = React.memo(function SoundEffectsSettingsGroup() {
    const { theme } = useUnistyles();
    const [enabled, setEnabled] = useLocalSettingMutable('soundEffectsEnabled');

    return (
        <ItemGroup
            title={t('settingsNotifications.soundEffects.title')}
            footer={t('settingsNotifications.soundEffects.footer')}
        >
            <Item
                testID="settings-notifications-sound-effects-enabled"
                title={t('settingsNotifications.soundEffects.enabledTitle')}
                subtitle={t('settingsNotifications.soundEffects.enabledSubtitle')}
                icon={<Icon name="speaker-high" size={29} color={theme.colors.accent.blue} />}
                rightElement={<Switch value={enabled} onValueChange={(value) => setEnabled(Boolean(value))} />}
                showChevron={false}
            />
            <SoundEffectPicker
                settingKey="soundEffectsErrorSound"
                title={t('common.error')}
                subtitle={t('settingsNotifications.soundEffects.errorSubtitle')}
                iconName="x-circle"
                iconColor={theme.colors.status.error}
                disabled={!enabled}
            />
            <SoundEffectPicker
                settingKey="soundEffectsAttentionSound"
                title={t('settingsNotifications.soundEffects.attentionTitle')}
                subtitle={t('settingsNotifications.soundEffects.attentionSubtitle')}
                iconName="hand"
                iconColor={theme.colors.status.actionRequired}
                disabled={!enabled}
            />
            <SoundEffectPicker
                settingKey="soundEffectsSuccessSound"
                title={t('settingsNotifications.soundEffects.successTitle')}
                subtitle={t('settingsNotifications.soundEffects.successSubtitle')}
                iconName="check-circle"
                iconColor={theme.colors.status.connected}
                disabled={!enabled}
            />
            <SoundEffectPicker
                settingKey="soundEffectsResumeSound"
                title={t('settingsNotifications.soundEffects.resumeTitle')}
                subtitle={t('settingsNotifications.soundEffects.resumeSubtitle')}
                iconName="arrows-clockwise"
                iconColor={theme.colors.status.connecting}
                disabled={!enabled}
            />
        </ItemGroup>
    );
});
