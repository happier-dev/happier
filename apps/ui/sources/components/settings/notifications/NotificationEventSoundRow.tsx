import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { NotificationSoundEvent } from './notificationPreferences';
import {
  ADD_NOTIFICATION_SOUND_ITEM_ID,
  buildNotificationSoundMenu,
  describeNotificationSoundChoice,
  type NotificationSoundSources,
} from './notificationSoundChoices';

type NotificationEventSoundRowProps = Readonly<{
  event: NotificationSoundEvent;
  title: string;
  soundId: string;
  sources: NotificationSoundSources;
  /** One write per pick; the row plays the pick once so the choice is heard as it is made. */
  chooseSound: (event: NotificationSoundEvent, soundId: string) => void;
  addSound: (event: NotificationSoundEvent) => void;
}>;

/** One event's sound: a field select whose options name every sound this device can offer. */
export const NotificationEventSoundRow = React.memo(
  function NotificationEventSoundRow({
    event,
    title,
    soundId,
    sources,
    chooseSound,
    addSound,
  }: NotificationEventSoundRowProps) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const current = describeNotificationSoundChoice(soundId, event, sources);
    // The option list is built only while the picker is open; the closed row needs its label and line.
    const menu = React.useMemo(
      () => {
        if (!open) return null;
        const built = buildNotificationSoundMenu(event, soundId, sources);
        const addIcon = <Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
        return { ...built, items: built.items.map(item => item.id === ADD_NOTIFICATION_SOUND_ITEM_ID ? { ...item, icon: addIcon } : item) };
      },
      [event, open, soundId, sources, theme.colors.text.secondary],
    );
    const items = menu?.items ?? [
      { id: soundId, title: current.label, checked: true },
    ];
    const testID = `settings-notifications-sounds-event-${event}`;

    return (
      <DropdownMenu
        testID={`${testID}-menu`}
        open={open}
        onOpenChange={setOpen}
        items={items}
        selectedId={soundId}
        // Each pick writes and plays once while the list stays open, so sounds can be compared by ear.
        closeOnSelect={false}
        onSelect={(itemId) => {
          if (itemId === ADD_NOTIFICATION_SOUND_ITEM_ID) {
            setOpen(false);
            addSound(event);
          } else chooseSound(event, itemId);
        }}
        itemTrigger={{
          title,
          subtitle: current.line ?? undefined,
          showSelectedSubtitle: false,
          itemProps: { testID, subtitleLines: 0 },
        }}
        categoryTitles={menu?.categoryTitles}
        categoryDecorations={menu?.categoryDecorations}
        popoverPhonePresentation="sheet"
        popoverAccessibilityLabel={title}
        popoverSheetSubtitle={t('settingsNotifications.sounds.pickerSubtitle')}
      />
    );
  },
);
