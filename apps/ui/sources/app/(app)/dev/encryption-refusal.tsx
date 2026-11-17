import * as React from 'react';

import { AccountSecuritySettingsScreen } from '@/components/settings/account/AccountSecuritySettingsScreen';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Dev-only: the Account's Sign-in & security page as a person sees it right after an encryption conversion
 * was refused because the Account holds plugin data. The page is the real one and the Account's mode is never
 * touched; the alert is the section's own refusal presentation (`Modal.alertAsync` with the message
 * `apiAccountEncryptionMigrate` maps from the Home's `plugin_collections_not_empty` refusal). A real refusal
 * needs an Account with plugin data, and conversion stages files before the Home refuses, so no live attempt is made.
 */
export default function EncryptionRefusalDevScreen() {
  React.useEffect(() => {
    void Modal.alertAsync(
      t('settingsAccount.encryptionPluginDataBlocksTitle'),
      t('settingsAccount.encryptionPluginDataBlocks'),
    );
  }, []);
  return <AccountSecuritySettingsScreen />;
}
