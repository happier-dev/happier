import { HAPPIER_NOTIFICATION_SOUNDS_BY_EVENT } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import {
  PUSH_NOTIFICATION_BUNDLED_SOUND_FILES,
  PUSH_NOTIFICATION_SOUND_IDS,
  isPushNotificationBundledSoundId,
  type PushNotificationBundledSoundId,
} from '@happier-dev/protocol/push/pushNotificationActions';
import type { NotificationSoundInfo } from '@/activity/notifications/sounds/notificationSoundLibrary';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import type { NotificationSoundEvent } from './notificationPreferences';

/** One contributed sound the picker offers, grouped under the plugin that contributes it. */
export type NotificationPluginSound = Readonly<{
  id: string;
  label: string;
  pluginId: string;
  pluginName: string;
}>;

export type NotificationSoundSources = Readonly<{
  plugins: readonly NotificationPluginSound[];
  personal: readonly NotificationSoundInfo[];
}>;

export const ADD_NOTIFICATION_SOUND_ITEM_ID = 'add-sound';

const PERSONAL_SOUND_PREFIX = 'local/';
const BUNDLED_SOUND_IDS = Object.keys(
  PUSH_NOTIFICATION_BUNDLED_SOUND_FILES,
) as PushNotificationBundledSoundId[];

export function bundledNotificationSoundLabel(
  id: PushNotificationBundledSoundId,
): string {
  return t(`settingsNotifications.sounds.names.${id}`);
}

export function happierFallbackSound(
  event: NotificationSoundEvent,
): PushNotificationBundledSoundId {
  return HAPPIER_NOTIFICATION_SOUNDS_BY_EVENT[event];
}

/** What a row says about its current sound: the value it shows and, when phone alerts play another, the one line that says so. */
export type NotificationSoundRowPresentation = Readonly<{
  label: string;
  line: string | null;
}>;

export function describeNotificationSoundChoice(
  soundId: string,
  event: NotificationSoundEvent,
  sources: NotificationSoundSources,
): NotificationSoundRowPresentation {
  if (soundId === PUSH_NOTIFICATION_SOUND_IDS.none)
    return { label: t('settingsNotifications.sounds.none'), line: null };
  if (soundId === PUSH_NOTIFICATION_SOUND_IDS.systemDefault)
    return {
      label: t('settingsNotifications.sounds.accountDefaultTitle'),
      line: null,
    };
  if (isPushNotificationBundledSoundId(soundId))
    return { label: bundledNotificationSoundLabel(soundId), line: null };
  const sound = bundledNotificationSoundLabel(happierFallbackSound(event));
  if (soundId.startsWith(PERSONAL_SOUND_PREFIX)) {
    const personal = sources.personal.find((entry) => entry.id === soundId);
    return personal
      ? {
          label: personal.label,
          line: t('settingsNotifications.sounds.rowYours', { sound }),
        }
      : {
          label: t('settingsNotifications.sounds.yoursUnknown'),
          line: t('settingsNotifications.sounds.rowYoursElsewhere', { sound }),
        };
  }
  const plugin = sources.plugins.find((entry) => entry.id === soundId);
  return plugin
    ? {
        label: plugin.label,
        line: t('settingsNotifications.sounds.rowPlugin', {
          plugin: plugin.pluginName,
          sound,
        }),
      }
    : {
        label: t('settingsNotifications.sounds.pluginUnknown'),
        line: t('settingsNotifications.sounds.rowPluginOff', { sound }),
      };
}

const FIXED_CATEGORY = 'fixed';
const HAPPIER_CATEGORY = 'happier';
const YOURS_CATEGORY = 'yours';
const pluginCategory = (pluginId: string) => `plugin:${pluginId}`;

export type NotificationSoundMenu = Readonly<{
  items: readonly DropdownMenuItem[];
  categoryTitles: Readonly<Record<string, string>>;
  categoryDecorations: Readonly<Record<string, Readonly<{ note: string }>>>;
}>;

/**
 * The per-event picker: None and System default, Happier's bundled sounds, one group per plugin, then
 * this device's own sounds and Add a sound…. The row's current choice always has an option, so a
 * choice this device cannot resolve still reads as selected.
 */
export function buildNotificationSoundMenu(
  event: NotificationSoundEvent,
  selectedId: string,
  sources: NotificationSoundSources,
): NotificationSoundMenu {
  const sound = bundledNotificationSoundLabel(happierFallbackSound(event));
  const items: DropdownMenuItem[] = [
    {
      id: PUSH_NOTIFICATION_SOUND_IDS.none,
      title: t('settingsNotifications.sounds.none'),
      category: FIXED_CATEGORY,
    },
    {
      id: PUSH_NOTIFICATION_SOUND_IDS.systemDefault,
      title: t('settingsNotifications.sounds.accountDefaultTitle'),
      category: FIXED_CATEGORY,
    },
    ...BUNDLED_SOUND_IDS.map((id) => ({
      id,
      title: bundledNotificationSoundLabel(id),
      category: HAPPIER_CATEGORY,
    })),
  ];
  const categoryTitles: Record<string, string> = {
    [HAPPIER_CATEGORY]: t('settingsNotifications.sounds.groupHappier'),
    [YOURS_CATEGORY]: t('settingsNotifications.sounds.groupYours'),
  };
  const categoryDecorations: Record<string, { note: string }> = {};
  for (const plugin of sources.plugins) {
    const category = pluginCategory(plugin.pluginId);
    categoryTitles[category] = plugin.pluginName;
    categoryDecorations[plugin.pluginName] = {
      note: t('settingsNotifications.sounds.pluginNote', { sound }),
    };
    items.push({ id: plugin.id, title: plugin.label, category });
  }
  const known = new Set(items.map((item) => item.id));
  for (const personal of sources.personal) {
    items.push({
      id: personal.id,
      title: personal.label,
      category: YOURS_CATEGORY,
    });
    known.add(personal.id);
  }
  if (!known.has(selectedId)) {
    const current = describeNotificationSoundChoice(selectedId, event, sources);
    items.push({
      id: selectedId,
      title: current.label,
      category: selectedId.startsWith(PERSONAL_SOUND_PREFIX)
        ? YOURS_CATEGORY
        : 'unavailable',
    });
  }
  items.push({
    id: ADD_NOTIFICATION_SOUND_ITEM_ID,
    title: t('settingsNotifications.sounds.addSound'),
    category: YOURS_CATEGORY,
  });
  categoryDecorations[categoryTitles[YOURS_CATEGORY]] = {
    note: t('settingsNotifications.sounds.yoursNote', { sound }),
  };
  return {
    items: items.map((item) => ({ ...item, checked: item.id === selectedId })),
    categoryTitles,
    categoryDecorations,
  };
}
