import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindToHostedSessionScope,
  runAddedHostedSession,
} from '@/agent/runtime/lifecycle/hostedSessionScope';
import { configuration } from '@/configuration';
import type { TokenOnlyCredentials } from '@/persistence';

import {
  applyAccountSettingsV2Update,
  bootstrapAccountSettingsContext,
  resetInMemoryAccountSettingsContextForTests,
} from './bootstrapAccountSettingsContext';
import {
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
});
