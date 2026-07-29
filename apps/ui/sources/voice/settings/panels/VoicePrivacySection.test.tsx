import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.rightElement),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));

describe('VoicePrivacySection', () => {
  it('names every privacy switch and updates the canonical privacy setting', async () => {
    const setVoice = vi.fn();
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    const screen = await renderScreen(React.createElement(VoicePrivacySection, {
      voice: voiceSettingsDefaults,
      setVoice,
    }));

    const expectedLabels = [
      t('settingsVoice.privacy.shareSessionSummary'),
      t('settingsVoice.privacy.shareRecentMessages'),
      t('settingsVoice.privacy.shareToolNames'),
      t('settingsVoice.privacy.shareDeviceInventory'),
      t('settingsVoice.privacy.sharePermissionRequests'),
    ];
    const switches = screen.tree.root.findAllByType('Switch' as any);
    expect(switches.map((control) => control.props.accessibilityLabel)).toEqual(expectedLabels);

    switches[0]?.props.onValueChange(!voiceSettingsDefaults.privacy.shareSessionSummary);
    expect(setVoice).toHaveBeenCalledWith({
      ...voiceSettingsDefaults,
      privacy: {
        ...voiceSettingsDefaults.privacy,
        shareSessionSummary: !voiceSettingsDefaults.privacy.shareSessionSummary,
      },
    });
  });
});
