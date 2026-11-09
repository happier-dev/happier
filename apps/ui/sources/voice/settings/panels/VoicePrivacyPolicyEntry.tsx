import * as React from 'react';

import { HAPPIER_PRIVACY_POLICY_URL } from '@/constants/legalUrls';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * §2.8 / §7.3 — the compliance entry point for Voice.
 *
 * No active Voice surface carries a provider/data-disclosure affordance, so Voice
 * settings is the only in-app destination for the privacy story. The provider's
 * own processing disclosure already renders above, from its declaration; this row
 * is the *public policy*, and it sits at the bottom of the screen on purpose — it
 * is a place to go when you want it, not something to interrupt someone with.
 *
 * `SettingRow` shares its label and searchable anchor with the Action declaration.
 * Its `onPress` stays focusable, keyboard activatable and announced with a role.
 * `openExternalUrl` is the canonical opener
 * — hand-rolling `Linking` here would fork web (which needs `window.open` with
 * `noopener`) away from native.
 */
export function VoicePrivacyPolicyEntry(): React.ReactElement {
  return (
      <SettingRow
        setting={VOICE_PRIVACY_SETTINGS.settings.privacyPolicy}
        testID="settings.voice.privacyPolicy"
        icon={<Icon name="arrow-square-out" />}
        onPress={() => {
          fireAndForget(openExternalUrl(HAPPIER_PRIVACY_POLICY_URL));
        }}
      />
  );
}
