import * as React from 'react';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
  notificationSoundLibrary,
  type NotificationSoundInfo,
} from '@/activity/notifications/sounds/notificationSoundLibrary';
import type {
  NotificationPluginSound,
  NotificationSoundSources,
} from './notificationSoundChoices';

const NO_PERSONAL_SOUNDS: readonly NotificationSoundInfo[] = Object.freeze([]);

const selectSoundsById = (value: AppShellPluginUiProjectionValue) =>
  value.pluginUiProjection?.soundsById;
const selectInstalledPackagesById = (value: AppShellPluginUiProjectionValue) =>
  value.pluginUiProjection?.installedPackagesById;

/**
 * The sounds the pickers offer beyond Happier's own: the committed plugin contributions and the ones
 * people added on this device. `reloadPersonal` re-reads the device store after an add.
 */
export function useNotificationSoundSources(): NotificationSoundSources &
  Readonly<{ reloadPersonal: () => Promise<void> }> {
  const soundsById = useAppShellPluginUiProjection(selectSoundsById);
  const packagesById = useAppShellPluginUiProjection(
    selectInstalledPackagesById,
  );
  const plugins = React.useMemo<readonly NotificationPluginSound[]>(
    () =>
      Object.values(soundsById ?? {}).map((entry) => ({
        id: entry.id,
        label: entry.definition.label,
        pluginId: entry.pluginId,
        pluginName:
          packagesById?.[entry.pluginId]?.displayName ?? entry.pluginId,
      })),
    [packagesById, soundsById],
  );

  const [personal, setPersonal] =
    React.useState<readonly NotificationSoundInfo[]>(NO_PERSONAL_SOUNDS);
  const reloadPersonal = React.useCallback(async () => {
    // The device store also caches downloaded plugin sounds; only people's own are listed as theirs.
    const next = (
      await notificationSoundLibrary.list().catch(() => NO_PERSONAL_SOUNDS)
    ).filter((sound) => sound.kind === 'user');
    setPersonal(next.length === 0 ? NO_PERSONAL_SOUNDS : next);
  }, []);
  React.useEffect(() => {
    void reloadPersonal();
  }, [reloadPersonal]);

  return { plugins, personal, reloadPersonal };
}
