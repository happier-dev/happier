import * as React from 'react';

import { HAPPIER_PRIVACY_POLICY_URL } from '@/constants/legalUrls';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

/**
 * §2.8 / §7.3 — the compliance entry point for Voice.
 *
 * No active Voice surface carries a provider/data-disclosure affordance, so Voice
 * settings is the only in-app destination for the privacy story. The provider's
 * own processing disclosure already renders above, from its declaration; this row
 * is the *public policy*, and it sits at the bottom of the screen on purpose — it
 * is a place to go when you want it, not something to interrupt someone with.
 *
 * `Item` with an `onPress` is what makes it a real button: focusable, keyboard
 * activatable and announced with a role. `openExternalUrl` is the canonical opener
 * — hand-rolling `Linking` here would fork web (which needs `window.open` with
 * `noopener`) away from native.
 */
export function VoicePrivacyPolicyEntry(): React.ReactElement {
  return (
    <ItemGroup>
      <Item
        testID="settings.voice.privacyPolicy"
        title={t('settings.privacyPolicy')}
        onPress={() => {
          fireAndForget(openExternalUrl(HAPPIER_PRIVACY_POLICY_URL));
        }}
      />
    </ItemGroup>
  );
}
