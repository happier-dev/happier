import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  notificationSoundLibrary,
  type NotificationSoundInfo,
} from '@/activity/notifications/sounds/notificationSoundLibrary';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { fireAndForget } from '@/utils/system/fireAndForget';

type AddNotificationSoundRequest = Readonly<{
  /** The row it was opened from, in a sentence ("action requests"). */
  eventTitle: string;
  /** The Happier sound phone alerts and other devices play instead. */
  fallbackLabel: string;
  onAdded: (sound: NotificationSoundInfo) => void;
}>;

type PickedSound =
  | Readonly<{
      kind: 'added';
      fileName: string;
      sound: NotificationSoundInfo;
      truncated: boolean;
    }>
  | Readonly<{ kind: 'unreadable'; fileName: string }>;

function baseName(fileName: string): string {
  const name = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : fileName;
}

/**
 * Picks a file and keeps it on this device straight away (decoded, levelled, at most 30 s), so the
 * dialog states the truth about it; Cancel removes it again and Add names and chooses it.
 */
async function pickNotificationSound(): Promise<PickedSound | null> {
  const [picked] = await nativePickFiles({ multiple: false, type: 'audio/*' });
  if (!picked) return null;
  const fileName = picked.kind === 'web' ? picked.file.name : picked.name;
  try {
    const bytes =
      picked.kind === 'web'
        ? await picked.file.arrayBuffer()
        : await (await fetch(picked.uri)).arrayBuffer();
    const { sound, truncated } = await notificationSoundLibrary.put(
      baseName(fileName),
      bytes,
    );
    return { kind: 'added', fileName, sound, truncated };
  } catch {
    return { kind: 'unreadable', fileName };
  }
}

export async function addNotificationSound(
  request: AddNotificationSoundRequest,
): Promise<void> {
  const picked = await pickNotificationSound();
  if (!picked) return;
  // Leaving without Add (Cancel, close, Escape) leaves nothing behind on this device.
  const discard = () => {
    if (picked.kind === 'added') {
      fireAndForget(notificationSoundLibrary.remove(picked.sound.id), {
        tag: 'AddNotificationSoundDialog.discard',
      });
    }
  };
  Modal.show({
    component: AddNotificationSoundDialog,
    props: { ...request, picked, discard },
    closeOnBackdrop: false,
    // Close, Escape and the backdrop are shared dismissals; Add and Cancel close through the dialog itself.
    onDismissRequest: (reason) => {
      if (reason === 'shared') discard();
    },
  });
}

function AddNotificationSoundDialog(
  props: AddNotificationSoundRequest &
    Readonly<{ picked: PickedSound; discard: () => void }> &
    CustomModalInjectedProps,
) {
  const { theme } = useUnistyles();
  const { picked, onClose, onAdded, eventTitle, fallbackLabel } = props;
  const [name, setName] = React.useState(
    picked.kind === 'added' ? picked.sound.label : '',
  );
  const [saving, setSaving] = React.useState(false);
  const added = picked.kind === 'added' ? picked.sound : null;
  const { discard } = props;
  const cancel = React.useCallback(() => {
    discard();
    onClose();
  }, [discard, onClose]);

  const add = React.useCallback(async () => {
    if (!added) return;
    setSaving(true);
    const label = name.trim() || added.label;
    const renamed =
      label === added.label
        ? added
        : ((await notificationSoundLibrary.rename(added.id, label)) ?? added);
    onAdded(renamed);
    onClose();
  }, [added, name, onAdded, onClose]);

  const chooseAnother = React.useCallback(() => {
    onClose();
    fireAndForget(
      addNotificationSound({ eventTitle, fallbackLabel, onAdded }),
      { tag: 'AddNotificationSoundDialog.chooseAnother' },
    );
  }, [eventTitle, fallbackLabel, onAdded, onClose]);

  const footer = React.useMemo(
    () => (
      <ModalCardFooterActions
        cancel={{ onPress: cancel, testID: 'notification-sound-add.cancel' }}
      >
        {added ? (
          <RoundButton
            testID="notification-sound-add.submit"
            title={t('settingsNotifications.sounds.addAction')}
            loading={saving}
            disabled={saving}
            onPress={() =>
              fireAndForget(add(), { tag: 'AddNotificationSoundDialog.add' })
            }
          />
        ) : (
          <RoundButton
            testID="notification-sound-add.choose-another"
            title={t('settingsNotifications.sounds.chooseAnother')}
            onPress={chooseAnother}
          />
        )}
      </ModalCardFooterActions>
    ),
    [add, added, cancel, chooseAnother, saving],
  );

  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: t('settingsNotifications.sounds.addTitle'),
      subtitle: added
        ? t('settingsNotifications.sounds.addSubtitle', {
            event: eventTitle,
            file: picked.fileName,
          })
        : picked.fileName,
      footer,
      phonePresentation: 'sheet' as const,
      dimensions: { size: 'md' as const },
    }),
    [added, footer, picked.fileName, eventTitle],
  );
  useModalCardChrome(props.setChrome, chrome);

  if (!added) {
    return (
      <View
        testID="notification-sound-add"
        style={{ padding: theme.space.s16 }}
      >
        <SurfaceStateCard
          size="line"
          kind="error"
          title={t('settingsNotifications.sounds.unreadableTitle')}
          reason={t('settingsNotifications.sounds.unreadableBody')}
        />
      </View>
    );
  }
  const durationSeconds = Math.round(added.durationSeconds * 10) / 10;
  return (
    <View
      testID="notification-sound-add"
      style={{ padding: theme.space.s16, gap: theme.space.s16 }}
    >
      <FieldItem label={t('settingsNotifications.sounds.nameLabel')}>
        <FieldTextInput
          testID="notification-sound-add.name"
          accessibilityLabel={t('settingsNotifications.sounds.nameLabel')}
          autoFocus
          selectTextOnFocus
          value={name}
          onChangeText={setName}
          onSubmitEditing={() =>
            fireAndForget(add(), { tag: 'AddNotificationSoundDialog.submit' })
          }
        />
      </FieldItem>
      <View style={{ gap: theme.space.s6 }}>
        <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
          {picked.truncated
            ? t('settingsNotifications.sounds.addTruncated')
            : t('settingsNotifications.sounds.addLength', {
                seconds: durationSeconds,
              })}
        </Text>
        <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
          {t('settingsNotifications.sounds.addWhere', {
            sound: fallbackLabel,
          })}
        </Text>
      </View>
    </View>
  );
}
