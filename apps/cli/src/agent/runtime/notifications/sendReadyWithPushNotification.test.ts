import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sendReadyWithPushNotification } from './sendReadyWithPushNotification';
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot';
import { createReadyNotificationDispatcher } from './createReadyNotificationDispatcher';
import type { SessionPersonalFollowCommit } from '@/api/session/sessionClientPort';
import axios from 'axios';
import * as persistence from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { logger } from '@/ui/logger';
import { sendAgentRequestPushNotificationAsync } from '@/settings/notifications/permissionRequestPush';

describe('ready notification Account catalog admission', () => {
  it.each(['interrupt', 'important', 'retired', 'credentials-retired', 'unreachable', 'request'] as const)(
    'demands the runner Account channel row without borrowing another lifetime (%s)', async outcome => {
    resetActiveAccountSettingsSnapshotForTests();
    const home = 'https://runner-ready-catalog.example';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'runner-ready-account' })).toString('base64url')}.signature`, encryption: null };
    await runWithServerHttpBaseUrl(home, async () => {
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
      setActiveAccountSettingsSnapshot(snapshot); // A fresh runner has preferences, not the daemon's row catalog.
      let catalogReads = 0;
      let settled = false;
      const sent: unknown[][] = [];
      const receipt = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
      const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(outcome === 'credentials-retired'
        ? { ...credentials, token: 'another-account' } : credentials);
      const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
        const url = new URL(String(input));
        expect(url.origin).toBe(home);
        if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.pathname === '/v1/account/entity-rows/notification-channels') {
          catalogReads += 1;
          if (outcome === 'retired') setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'another-account' });
          return outcome === 'unreachable' ? { status: 503, data: {} } : { status: 200, data: {
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, channels: [
              NotificationChannelRecordV1Schema.parse({ v: 1, id: 'runner-push', kind: 'expo_push', topics: {} }),
            ] } } } };
        }
        if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
        if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        if (url.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
        const empty = emptyAccountSettingsHistoryCaptureResponse(url.pathname);
        if (empty) return empty;
        throw new Error(`Unexpected notification HTTP boundary: ${url.pathname}`);
      });
      try {
        const pushSender = {
            fetchSessionNotificationContext: async (id: string) => {
              const session = createSessionNotificationContextFixture(id);
              return { ...session, viewer: { ...session.viewer!, follow: { ...session.viewer!.follow,
                policy: { preset: outcome === 'important' ? 'important' as const : 'everything' as const } } } };
            },
            readAccountSessionDeliveryMutedScopes: async () => [],
            sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
          };
        if (outcome === 'request') {
          await expect(sendAgentRequestPushNotificationAsync({ pushSender, settings: snapshot.settings,
            sessionId: 'cold-request', requestId: 'cold-question', toolName: 'AskUserQuestion', kind: 'user_action',
          })).resolves.toEqual({ status: 'delivered' });
        } else {
          await sendReadyWithPushNotification({ session: { sessionId: `cold-ready-${outcome}`,
            enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true, localId: `original-${outcome}`, committedSequence: 5 }) },
            pushSender, waitingForCommandLabel: 'Agent', logPrefix: '[cold-ready]', loggerDebug: () => { settled = true; } });
        }
        await vi.waitFor(() => expect(receipt.mock.calls.filter(([message]) => message === '[activityNotifications] Dispatch outcome')).toHaveLength(1));
        const delivered = outcome === 'interrupt' || outcome === 'request';
        expect(catalogReads).toBe(outcome === 'credentials-retired' ? 0 : 1);
        if (delivered) await vi.waitFor(() => expect(sent).toHaveLength(1));
        else if (outcome !== 'important') await vi.waitFor(() => expect(settled).toBe(true));
        expect(sent).toHaveLength(delivered ? 1 : 0);
        const result = receipt.mock.calls.find(([message]) => message === '[activityNotifications] Dispatch outcome')?.[1];
        expect(result).toMatchObject({ attemptedChannels: delivered ? 1 : 0,
          deliveredChannels: delivered ? 1 : 0, failedChannels: 0 });
        if (delivered || outcome === 'important') expect(result).not.toHaveProperty('cause');
        else expect(result).toHaveProperty('cause.errorCode', 'notification_channel_catalog_unavailable');
      } finally { receipt.mockRestore(); get.mockRestore(); readCredentials.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
    });
  });
  it('[p03redesign.F1] Turn ends on an Account with no channels read the channel row once and no Settings source or history', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const home = 'https://runner-turn-end.example';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'runner-turn-end-account' })).toString('base64url')}.signature`, encryption: null };
    await runWithServerHttpBaseUrl(home, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const receipt = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
      const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      const reads: string[] = [];
      // Home HTTP is the only substituted boundary; the channel row is present and empty.
      const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
        const url = new URL(String(input));
        reads.push(url.pathname);
        if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.pathname === '/v1/account/entity-rows/notification-channels') return { status: 200, data: {
          status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, channels: [] } } } };
        if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
        if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 6 }] } };
        if (url.pathname === '/v2/account/settings/history/6') return { status: 200, data: { version: 6, content: { t: 'plain', v: {} } } };
        if (url.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
        const empty = emptyAccountSettingsHistoryCaptureResponse(url.pathname);
        if (empty) return empty;
        throw new Error(`Unexpected notification HTTP boundary: ${url.pathname}`);
      });
      try {
        for (let turn = 1; turn <= 3; turn += 1) {
          await sendReadyWithPushNotification({ session: { sessionId: 'turn-end-source',
            enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true, localId: `ready-${turn}`, committedSequence: turn,
              personalFollow: { sourceSessionId: 'turn-end-source', sourceMessage: { localId: `ready-${turn}`, seq: turn,
                policies: [{ preset: 'everything' as const }] } } }) },
            completedTurn: { turnId: `turn-${turn}` }, waitingForCommandLabel: 'Agent', logPrefix: '[turn-end]',
            pushSender: { fetchSessionNotificationContext: async (id: string) => createSessionNotificationContextFixture(id),
              readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync: async () => true } });
          await vi.waitFor(() => expect(receipt.mock.calls.filter(([message]) => message === '[activityNotifications] Dispatch outcome')).toHaveLength(turn));
        }
        const count = (match: (path: string) => boolean) => reads.filter(match).length;
        expect({
          settingsSourceAndHistory: count(path => path.startsWith('/v2/account/settings')),
          savedSecrets: count(path => path.startsWith('/v1/account/saved-secrets')),
          otherCatalogRows: count(path => path.startsWith('/v1/account/entity-rows/') && path !== '/v1/account/entity-rows/notification-channels'),
          channelRow: count(path => path === '/v1/account/entity-rows/notification-channels'),
        }).toEqual({ settingsSourceAndHistory: 0, savedSecrets: 0, otherCatalogRows: 0, channelRow: 1 });
      } finally { receipt.mockRestore(); get.mockRestore(); readCredentials.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
    });
  });
  it('does not send a late rich ready after its terminal Turn personal effect was accepted', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    const sent: unknown[][] = [];
    const personalFollow = { sourceSessionId: 'ready-source', accepted: true as const,
      sourceMessage: { localId: 'late-ready', seq: 41, policies: [{ preset: 'everything' as const }] } };
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'ready-source', enqueueSessionEventCommitted: async () => ({
        persisted: true, delivered: true, localId: 'late-ready', committedSequence: 41, personalFollow,
      }) }, completedTurn: { turnId: 'host-turn' }, pushSender: {
        fetchSessionNotificationContext: async id => createSessionNotificationContextFixture(id),
        readAccountSessionDeliveryMutedScopes: async () => [],
        sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
      }, waitingForCommandLabel: 'Agent', logPrefix: '[late-ready-test]' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sent).toEqual([]);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('does not mistake absent source-message evidence for an accepted ready original', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    const sent: unknown[][] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'no-message-original', enqueueSessionEventCommitted: async () => ({
        persisted: true, delivered: true, personalFollow: { sourceSessionId: 'no-message-original', accepted: true },
      }) }, pushSender: {
        fetchSessionNotificationContext: async id => {
          const session = createSessionNotificationContextFixture(id);
          return { ...session, viewer: { ...session.viewer!, follow: { ...session.viewer!.follow, policy: { preset: 'everything' as const } } } };
        },
        readAccountSessionDeliveryMutedScopes: async () => [],
        sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
      }, waitingForCommandLabel: 'Agent', logPrefix: '[absent-message-evidence]' });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it.each([false, true])('keeps durable publication independent of its original ACK and cancellation=%s', async cancelled => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    const pending = createDeferred<SessionPersonalFollowCommit | null>();
    const sent: unknown[][] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'pending-ready',
        enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false, localId: 'pending-original', whenCommitted: pending.promise }) },
        completedTurn: { turnId: 'pending-turn' }, pushSender: {
          fetchSessionNotificationContext: async id => {
            const session = createSessionNotificationContextFixture(id);
            return { ...session, viewer: { ...session.viewer!, follow: { follows: true, notificationLevel: 'important' as const,
              policy: { preset: 'quiet' as const } } } };
          },
          readAccountSessionDeliveryMutedScopes: async () => [],
          sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
        }, waitingForCommandLabel: 'Agent', logPrefix: '[pending-ready-test]' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sent).toEqual([]);
      pending.resolve(cancelled ? null : { localId: 'pending-original', committedSequence: 17,
        personalFollow: { sourceSessionId: 'pending-ready', sourceMessage: {
          localId: 'pending-original', seq: 17, policies: [{ preset: 'everything' }],
        } } });
      if (cancelled) {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sent).toEqual([]);
      } else {
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.[2]).toMatchObject({ activityEventLocalId: 'pending-original' });
      }
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([false, true])('joins a proven completion and private policy using the exact original (marker=%s)', async marker => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    const original = { localId: marker ? 'host-turn:task_complete' : 'ready-original', seq: 41 };
    const personalFollow = { sourceSessionId: 'ready-source', sourceMessage: { ...original, policies: [{ preset: 'everything' as const }] } };
    const events: unknown[] = [];
    const sent: unknown[][] = [];
    const dispatch = createReadyNotificationDispatcher({
      session: { sessionId: 'ready-source', enqueueSessionEventCommitted: async event => {
        events.push(event);
        return { persisted: true, delivered: true, localId: 'ready-original', committedSequence: 41, personalFollow };
      } },
      pushSender: {
        fetchSessionNotificationContext: async id => {
          const session = createSessionNotificationContextFixture(id);
          return { ...session, viewer: { ...session.viewer!, follow: { follows: true, notificationLevel: 'important' as const, policy: { preset: 'quiet' as const } } } };
        },
        readAccountSessionDeliveryMutedScopes: async () => [],
        sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
      }, waitingForCommandLabel: 'Agent', logPrefix: '[ready-source-test]',
    });
    try {
      await dispatch({ assistantPreviewText: 'Captured completed answer', completedTurn: { turnId: 'host-turn',
        ...(marker ? { original: { localId: original.localId, committedSequence: original.seq, personalFollow } } : {}) } });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(events).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender',
        ...(!marker ? { completedTurnId: 'host-turn' } : {}) }]);
      expect(sent[0]?.[2]).toMatchObject({ sessionId: 'ready-source', activityEventLocalId: original.localId });
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

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
          readAccountSessionDeliveryMutedScopes: async () => [],
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
          readAccountSessionDeliveryMutedScopes: async () => [],
          sendToAllDevices: title => { delivered.push(title); settled.resolve(); },
        }, waitingForCommandLabel: 'Codex', logPrefix: '[ready-catalog-test]',
        loggerDebug: () => settled.resolve() });
      await settled.promise;
      expect(delivered).toEqual([]);
      expect(committed).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender' }]);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
});
