import { describe, expect, it } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sendReadyWithPushNotification } from './sendReadyWithPushNotification';

describe('ready notification Account catalog admission', () => {
  it('retains committed ready custody without borrowing the Account activated during transcript commit', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const settings = accountSettingsParse({});
    const catalog = { status: 'ready' as const, revision: 1, diagnostics: [], channels: [
      NotificationChannelRecordV1Schema.parse({ v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: {} }),
    ] };
    const activate = (scopeKey: string) => setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey, notificationChannelCatalog: catalog });
    activate('ready-account-a');
    const settled = createDeferred<void>();
    const delivered: string[] = [];
    const committed: unknown[] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'ready-catalog-session',
        enqueueSessionEventCommitted: async event => {
          committed.push(event);
          // The durable transcript transport completes after another Account
          // activates. Reusing Settings bytes must not transfer the Session.
          activate('ready-account-b');
          return { persisted: true, delivered: true, localId: 'ready-catalog-event', committedSequence: 1 };
        } }, pushSender: {
          fetchSessionNotificationContext: async sessionId => createSessionNotificationContextFixture(sessionId),
          sendToAllDevices: title => { delivered.push(title); settled.resolve(); },
        }, waitingForCommandLabel: 'Codex', logPrefix: '[ready-catalog-test]',
        loggerDebug: () => settled.resolve() });
      await settled.promise;
      expect(delivered).toEqual([]);
      expect(committed).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender' }]);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('retains committed ready custody but never sends legacy push when its Account catalog is missing', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const settled = createDeferred<void>();
    const delivered: string[] = [];
    const committed: unknown[] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'ready-catalog-session',
        enqueueSessionEventCommitted: async event => {
          committed.push(event);
          return { persisted: true, delivered: true, localId: 'ready-catalog-event', committedSequence: 1 };
        } }, pushSender: {
          fetchSessionNotificationContext: async sessionId => createSessionNotificationContextFixture(sessionId),
          sendToAllDevices: title => { delivered.push(title); settled.resolve(); },
        }, waitingForCommandLabel: 'Codex', logPrefix: '[ready-catalog-test]',
        loggerDebug: () => settled.resolve() });
      await settled.promise;
      expect(delivered).toEqual([]);
      expect(committed).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender' }]);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
});
