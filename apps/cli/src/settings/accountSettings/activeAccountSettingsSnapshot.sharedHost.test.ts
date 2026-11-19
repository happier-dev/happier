import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

import {
  bindToHostedSessionScope,
  runAddedHostedSession,
} from '@/agent/runtime/lifecycle/hostedSessionScope';
import { sendReadyWithPushNotification } from '@/agent/runtime/notifications/sendReadyWithPushNotification';
import { configuration } from '@/configuration';
import type { TokenOnlyCredentials } from '@/persistence';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { logger } from '@/ui/logger';

import {
  applyAccountSettingsV2Update,
  bootstrapAccountSettingsContext,
  resetInMemoryAccountSettingsContextForTests,
} from './bootstrapAccountSettingsContext';
import {
  commitActiveAccountSettingsSnapshot,
  commitActiveNotificationChannelCatalog,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent,
  subscribeActiveAccountSettingsKeys,
} from './activeAccountSettingsSnapshot';

type Timing = 'after_foreground_ready' | 'after_runtime_idle';
type HostedSession = Readonly<{
  /** The Account lifetime this Session opened with, captured as the Session runtime captures it. */
  open: Readonly<{ scopeKey: string; lifetimeToken: number }>;
  /** Run later work (a turn, a live update) inside this Session, as its own callbacks do. */
  run: <T>(work: () => T) => T;
}>;

const mutableConfiguration = configuration as unknown as {
  clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
};
const originalClientEncryptionRequirement =
  configuration.clientEncryptionRequirement;

function credentialsFor(token: string): TokenOnlyCredentials {
  return { token, encryption: null };
}

/**
 * One Session added to the shared session host: its own hosted scope and the real Account
 * Settings bootstrap at start. The Home read and the settings cache are the system boundaries.
 */
function startHostedSession(
  token: string,
  timing: Timing,
): Promise<HostedSession> {
  return runAddedHostedSession(
    {
      environment: { NODE_ENV: 'test' },
      workingDirectory: `/session/${token}`,
      end() {},
    },
    async () => {
      const context = await bootstrapAccountSettingsContext({
        credentials: credentialsFor(token),
        mode: 'blocking',
        refresh: 'force',
        honorAccountSettingsModeEnv: false,
        deps: {
          resolveCachePath: () => `/tmp/shared-host-${token}.cache`,
          readCache: async () => null,
          writeCache: async () => {},
          fetchFromServer: async () => ({
            settingsContent: {
              t: 'plain' as const,
              v: { sessionPendingQueueDeliveryTiming: timing },
            },
            settingsVersion: 1,
          }),
        },
      });
      const run = bindToHostedSessionScope((work: () => unknown) => work());
      return {
        open: {
          scopeKey: context.scopeKey!,
          lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        },
        run: run as HostedSession['run'],
      };
    },
  );
}

/** The Account read a turn makes: its Account lifetime fence and one per-turn preference. */
function readTurn(session: HostedSession) {
  return session.run(() => ({
    current: isActiveAccountSettingsSnapshotLifetimeCurrent(session.open),
    scopeKey: getActiveAccountSettingsSnapshot()?.scopeKey,
    timing:
      getActiveAccountSettingsSnapshot()?.settings
        .sessionPendingQueueDeliveryTiming,
  }));
}

function applyLiveUpdate(
  session: HostedSession,
  token: string,
  version: number,
  timing: Timing,
) {
  return session.run(() =>
    applyAccountSettingsV2Update({
      credentials: credentialsFor(token),
      update: {
        version,
        content: {
          t: 'plain',
          v: { sessionPendingQueueDeliveryTiming: timing },
        },
      },
      deps: { resolveCachePath: () => `/tmp/shared-host-${token}.cache` },
    }),
  );
}

describe('Account settings incumbent in a shared session host', () => {
  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    mutableConfiguration.clientEncryptionRequirement = 'follow_account';
  });
  afterEach(() => {
    mutableConfiguration.clientEncryptionRequirement =
      originalClientEncryptionRequirement;
    resetInMemoryAccountSettingsContextForTests();
  });

  it('keeps each Account Session on its own Account when another Account starts and changes Settings', async () => {
    const owner = await startHostedSession('owner-token', 'after_runtime_idle');
    const guest = await startHostedSession(
      'guest-token',
      'after_foreground_ready',
    );
    expect(owner.open.scopeKey).not.toBe(guest.open.scopeKey);

    // The owner's next turn after the guest's Session started: still its own, still current.
    expect(readTurn(owner)).toEqual({
      current: true,
      scopeKey: owner.open.scopeKey,
      timing: 'after_runtime_idle',
    });
    expect(readTurn(guest)).toEqual({
      current: true,
      scopeKey: guest.open.scopeKey,
      timing: 'after_foreground_ready',
    });

    const ownerSnapshot = owner.run(() => getActiveAccountSettingsSnapshot());
    const wakes: string[] = [];
    owner.run(() =>
      subscribeActiveAccountSettingsKeys(
        { settings: ['sessionPendingQueueDeliveryTiming'] },
        () => wakes.push('owner'),
      ),
    );
    guest.run(() =>
      subscribeActiveAccountSettingsKeys(
        { settings: ['sessionPendingQueueDeliveryTiming'] },
        () => wakes.push('guest'),
      ),
    );

    await applyLiveUpdate(guest, 'guest-token', 2, 'after_runtime_idle');

    expect(wakes).toEqual(['guest']);
    expect(owner.run(() => getActiveAccountSettingsSnapshot())).toBe(
      ownerSnapshot,
    );
    expect(readTurn(owner)).toEqual({
      current: true,
      scopeKey: owner.open.scopeKey,
      timing: 'after_runtime_idle',
    });
    expect(readTurn(guest)).toEqual({
      current: true,
      scopeKey: guest.open.scopeKey,
      timing: 'after_runtime_idle',
    });
  });

  it('shares one Account incumbent between Sessions of the same Account', async () => {
    const first = await startHostedSession(
      'member-token',
      'after_runtime_idle',
    );
    const second = await startHostedSession(
      'member-token',
      'after_runtime_idle',
    );
    expect(readTurn(first)).toMatchObject({
      current: true,
      scopeKey: first.open.scopeKey,
    });

    const wakes: string[] = [];
    first.run(() =>
      subscribeActiveAccountSettingsKeys(
        { settings: ['sessionPendingQueueDeliveryTiming'] },
        () => wakes.push('first'),
      ),
    );
    // The shared Account update connection may deliver in either Session's scope.
    await applyLiveUpdate(second, 'member-token', 2, 'after_foreground_ready');

    expect(wakes).toEqual(['first']);
    expect(readTurn(first)).toEqual({
      current: true,
      scopeKey: first.open.scopeKey,
      timing: 'after_foreground_ready',
    });
  });

  it('keeps a bound Session on its Account when another Account commits inside its scope', async () => {
    const owner = await startHostedSession('owner-token', 'after_runtime_idle');
    const guest = await startHostedSession('guest-token', 'after_foreground_ready');
    const guestSnapshot = guest.run(() => getActiveAccountSettingsSnapshot())!;

    owner.run(() => commitActiveAccountSettingsSnapshot({ ...guestSnapshot, settingsVersion: 2,
      settings: { ...guestSnapshot.settings, sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } }));

    expect(readTurn(owner)).toEqual({ current: true, scopeKey: owner.open.scopeKey, timing: 'after_runtime_idle' });
    expect(readTurn(guest)).toEqual({ current: true, scopeKey: guest.open.scopeKey, timing: 'after_runtime_idle' });
  });

  it("delivers an Account's ready notification only to that Account's channels", async () => {
    // Webhook delivery is real, to a loopback receiver; the Session client (transcript
    // commit, own push sender, Session read) is the stubbed boundary.
    const received: { path: string | undefined; body: string }[] = [];
    const receiver = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { received.push({ path: request.url, body }); response.writeHead(200).end(); });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const { port } = receiver.address() as AddressInfo;
    const outcomes = vi.spyOn(logger, 'infoFile');
    try {
      const withChannels = async (token: string, hookPath: string) => {
        const session = await startHostedSession(token, 'after_runtime_idle');
        expect(session.run(() => commitActiveNotificationChannelCatalog({ ...session.open, catalog: {
          status: 'ready', revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({ v: 1,
            id: `${token}-hook`, kind: 'webhook', enabled: true, topics: { ready: true },
            url: `http://127.0.0.1:${port}${hookPath}`, signingSecretRef: null })],
        } }))).toBe(true);
        return session;
      };
      const owner = await withChannels('owner-token', '/owner-hook');
      await withChannels('guest-token', '/guest-hook');
      const pushes: string[] = [];

      await owner.run(() => sendReadyWithPushNotification({
        session: { sessionId: 'owner-session',
          enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true, localId: 'ready-1', committedSequence: 1 }) },
        pushSender: {
          sendToAllDevicesAsync: async (title: string) => { pushes.push(title); return true; },
          fetchSessionNotificationContext: async (id: string) => {
            const record = createSessionNotificationContextFixture(id);
            return { ...record, viewer: { ...record.viewer!, follow: { ...record.viewer!.follow,
              policy: { preset: 'everything' as const } } } };
          },
          readAccountSessionDeliveryMutedScopes: async () => [],
        },
        waitingForCommandLabel: 'Agent', logPrefix: '[shared-host]',
        sessionTitle: 'Owner title', assistantPreviewText: 'Owner preview',
      }));
      await vi.waitFor(() => expect(outcomes.mock.calls.some(([message]) => message === '[activityNotifications] Dispatch outcome')).toBe(true));

      expect(received.map(({ path }) => path)).toEqual(['/owner-hook']);
      expect(JSON.parse(received[0]!.body)).toMatchObject({ topic: 'ready', session: { sessionId: 'owner-session' } });
    } finally {
      outcomes.mockRestore();
      await new Promise(resolve => receiver.close(resolve));
    }
  });
});
