import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { NotificationChannelRecordV1Schema, readLegacyNotificationChannelInventoryV1, type NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import type { AccountSettings, NotificationChannelV1 } from '@happier-dev/protocol';
import { createSavedSecretMaterializerV1, type SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';
import { deriveExpoPushNotificationChannelFromLegacySettings } from '@happier-dev/protocol/account/settings/notificationChannels';

const authoredChannelsBySettings = new WeakMap<AccountSettings, readonly NotificationChannelV1[]>();

/** Existing policy fixtures author channel entities separately from Account preferences. */
export function notificationSettingsFixture(raw: Readonly<Record<string, unknown>>): AccountSettings {
  const settings = accountSettingsParse(raw);
  const inventory = readLegacyNotificationChannelInventoryV1(raw);
  if (inventory.status !== 'ready') throw new Error('Invalid notification fixture');
  authoredChannelsBySettings.set(settings, [...inventory.channels]);
  return settings;
}

export function notificationCatalogFixture(settings: AccountSettings, keys: readonly (Uint8Array | null | undefined)[] = []) {
  const authored = authoredChannelsBySettings.get(settings) ?? [];
  const resources: SavedSecretCatalogResourceInputV1[] = [];
  const configured = [...authored];
  // The former runtime suites test push policy alongside authored webhooks.
  // Make that entity explicit now that policy no longer manufactures it.
  if (configured.length > 0 && !configured.some(channel => channel.kind === 'expo_push')) {
    configured.unshift(deriveExpoPushNotificationChannelFromLegacySettings(settings.notificationsSettingsV1));
  }
  const channels = configured.map(channel => {
    if (channel.kind === 'expo_push') return NotificationChannelRecordV1Schema.parse(channel);
    const { signingSecret, ...endpoint } = channel;
    const value = signingSecret ? decryptSecretValueWithKeysV1(signingSecret, keys) : null;
    if (value !== null && value !== undefined) {
      resources.push({ resourceId: channel.id, ownerAccountId: 'fixture-account', displayName: 'Signing', kind: 'other', revision: 1,
        encryptionMode: 'plain', materialStatus: 'ready', storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId: channel.id, mode: 'plain', content: { v: 1, name: 'Signing', kind: 'other', value },
        }) });
    }
    return NotificationChannelRecordV1Schema.parse({ ...endpoint, signingSecretRef: signingSecret
      ? `happier:shared-secret:v1:${channel.id}` : null });
  });
  return { notificationChannelCatalog: { status: 'ready', channels, revision: 1, diagnostics: [] } satisfies NotificationChannelCatalogSnapshotV1,
    savedSecretMaterializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources,
      resourceCatalogState: 'ready' }) };
}
