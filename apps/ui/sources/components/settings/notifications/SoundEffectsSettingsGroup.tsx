import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { playSoundEffect } from '@/activity/sounds/playSoundEffect';
import { NO_SOUND_EFFECT, SOUND_EFFECT_IDS, type SoundEffectChoice } from '@/activity/sounds/soundEffectCatalog';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { storage, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SoundEffectsVolumeSlider } from './SoundEffectsVolumeSlider';

type SoundSettingKey =
    | 'soundEffectsErrorSound'
    | 'soundEffectsAttentionSound'
    | 'soundEffectsSuccessSound'
    | 'soundEffectsResumeSound';

// Each sound is listed by its file name without the extension.
type SoundMenuItem = DropdownMenuItem & { id: SoundEffectChoice };
const SOUND_FILE_MENU_ITEMS: readonly SoundMenuItem[] = SOUND_EFFECT_IDS.map((id) => ({ id, title: id }));

const SoundEffectPicker = React.memo(function SoundEffectPicker(props: Readonly<{
    settingKey: SoundSettingKey;
    title: string;
    subtitle: string;
    iconName: React.ComponentProps<typeof Icon>['name'];
    iconColor: string;
    disabled: boolean;
    items: readonly SoundMenuItem[];
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
                itemProps: { testID: `settings-notifications-sound-effect:${props.settingKey}`, disabled: props.disabled },
            }}
            items={props.items}
            onSelect={(itemId) => {
                const id = props.items.find((item) => item.id === itemId)?.id;
                if (id === undefined) return;
                setSelected(id);
                setOpen(false);
                // Let people hear their choice.
                const { soundEffectsVolumePercent } = storage.getState().localSettings;
                fireAndForget(playSoundEffect(id, soundEffectsVolumePercent), { tag: 'SoundEffectsSettingsGroup.preview' });
            }}
        />
    );
});

function SoundEffectsVolumeRow({ disabled }: Readonly<{ disabled: boolean }>) {
    const [volume, setVolume] = useLocalSettingMutable('soundEffectsVolumePercent');
    const title = t('settingsNotifications.soundEffects.volumeTitle');
    return (
        <Item
            title={title}
            mode="info"
            subtitleAccessory={
                <SoundEffectsVolumeSlider label={title} value={volume} disabled={disabled} onValueChange={setVolume} />
            }
        />
    );
}

/** Device-only sound effects for the red, yellow and green session states and usage-limit resumes. */
export const SoundEffectsSettingsGroup = React.memo(function SoundEffectsSettingsGroup() {
    const { theme } = useUnistyles();
    const [enabled, setEnabled] = useLocalSettingMutable('soundEffectsEnabled');
    const noneTitle = t('settingsNotifications.soundEffects.none');
    const items = React.useMemo<readonly SoundMenuItem[]>(() => [
        { id: NO_SOUND_EFFECT, title: noneTitle },
        ...SOUND_FILE_MENU_ITEMS,
    ], [noneTitle]);

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
            <SoundEffectsVolumeRow disabled={!enabled} />
            <SoundEffectPicker
                items={items}
                settingKey="soundEffectsErrorSound"
                title={t('common.error')}
                subtitle={t('settingsNotifications.soundEffects.errorSubtitle')}
                iconName="x-circle"
                iconColor={theme.colors.status.error}
                disabled={!enabled}
            />
            <SoundEffectPicker
                items={items}
                settingKey="soundEffectsAttentionSound"
                title={t('settingsNotifications.soundEffects.attentionTitle')}
                subtitle={t('settingsNotifications.soundEffects.attentionSubtitle')}
                iconName="hand"
                iconColor={theme.colors.status.actionRequired}
                disabled={!enabled}
            />
            <SoundEffectPicker
                items={items}
                settingKey="soundEffectsSuccessSound"
                title={t('settingsNotifications.soundEffects.successTitle')}
                subtitle={t('settingsNotifications.soundEffects.successSubtitle')}
                iconName="check-circle"
                iconColor={theme.colors.status.connected}
                disabled={!enabled}
            />
            <SoundEffectPicker
                items={items}
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
