import * as React from 'react';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SettingRow,
  SettingSection,
} from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';
import { t } from '@/text';
import { DESKTOP_SETTINGS } from './desktopSettings';

/** Settings → Desktop app → Windows (lab `ntset-A`): only where this computer opens Session windows. */
export const DesktopWindowsSettingsSection = React.memo(
  function DesktopWindowsSettingsSection() {
    const windows = useDesktopHostRoleAvailability('windows');
    if (windows?.kind !== 'available') return null;
    return (
      <SettingSection section={DESKTOP_SETTINGS.sectionRefs.windows}>
        <ItemGroup title={t('settingsDesktop.windows.title')}>
          <WindowBotRailRow />
        </ItemGroup>
      </SettingSection>
    );
  },
);

function WindowBotRailRow() {
  const enabled = useLocalSetting('desktopWindowBotRailEnabled');
  const { setSetting } = useSettingActionFeedback();
  return (
    <SettingRow
      setting={DESKTOP_SETTINGS.settings.windowBotRail}
      showChevron={false}
      rightElement={
        <Switch
          testID="settings-desktop-window-bot-rail"
          value={enabled}
          accessibilityLabel={t('settingsDesktop.windows.botRailTitle')}
          onValueChange={(value) =>
            setSetting(DESKTOP_SETTINGS.settings.windowBotRail, value)
          }
        />
      }
    />
  );
}
