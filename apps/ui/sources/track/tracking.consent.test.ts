import { beforeEach, describe, expect, it, vi } from 'vitest';

// posthog-react-native is the vendor boundary: record what reaches the SDK.
const posthog = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown> | undefined>,
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock('posthog-react-native', () => ({
  default: class PostHogMock {
    constructor(_apiKey: string, options?: Record<string, unknown>) {
      posthog.constructed.push(options);
    }
    capture(...args: unknown[]) {
      posthog.calls.push(['capture', ...args]);
    }
    screen(...args: unknown[]) {
      posthog.calls.push(['screen', ...args]);
    }
    identify(...args: unknown[]) {
      posthog.calls.push(['identify', ...args]);
    }
    group(...args: unknown[]) {
      posthog.calls.push(['group', ...args]);
    }
    reset() {
      posthog.calls.push(['reset']);
    }
    async flush() {
      posthog.calls.push(['flush']);
    }
    async optIn() {
      posthog.calls.push(['optIn']);
    }
    async optOut() {
      posthog.calls.push(['optOut']);
    }
  },
}));

vi.mock('@/config', () => ({
  config: {
    postHogKey: 'ph_test_key',
    postHogHost: 'https://example.posthog.test',
  },
}));

const sentEvents = () =>
  posthog.calls.filter(
    ([method]) =>
      method === 'capture' ||
      method === 'screen' ||
      method === 'identify' ||
      method === 'group',
  );

async function importTracking() {
  const mod = await import('./tracking');
  if (!mod.tracking) throw new Error('expected tracking to be enabled');
  return mod.tracking;
}

async function persistAcknowledgedAccountSettings(
  settings: Record<string, unknown>,
) {
  const { saveActiveAccountSettingsScope, saveAccountSettings } =
    await import('@/sync/domains/state/accountSettingsPersistence');
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const scope = { serverId: 'srv_consent', accountId: 'acct_consent' };
  saveActiveAccountSettingsScope(scope);
  saveAccountSettings(scope, settingsParse(settings), 3);
}

describe('tracking consent', () => {
  beforeEach(async () => {
    vi.resetModules();
    posthog.constructed.length = 0;
    posthog.calls.length = 0;
    process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
    const { getPersistenceStorage } =
      await import('@/sync/domains/state/persistenceStorage');
    getPersistenceStorage().clearAll();
  });

  it('sends screen views personless and leaves other events as the SDK built them', async () => {
    await importTracking();

    // The SDK's capture() sets $process_person_profile itself after the event properties, so
    // only its before_send hook, which runs last, can decide it for $screen.
    const beforeSend = (posthog.constructed[0] ?? {}).before_send as (
      event: { event: string; properties: Record<string, unknown> },
    ) => { event: string; properties: Record<string, unknown> } | null;
    expect(
      beforeSend({ event: '$screen', properties: { $screen_name: 'home', $process_person_profile: true } }),
    ).toEqual({ event: '$screen', properties: { $screen_name: 'home', $process_person_profile: false } });
    const appOpened = { event: 'app_opened', properties: { $process_person_profile: true } };
    expect(beforeSend(appOpened)).toBe(appOpened);
  });

  it('never asks PostHog for lifecycle events, remote config, flags or surveys', async () => {
    await importTracking();

    expect(posthog.constructed).toHaveLength(1);
    const options = posthog.constructed[0] ?? {};
    expect(options.captureAppLifecycleEvents).not.toBe(true);
    expect(options).toEqual(
      expect.objectContaining({
        disableRemoteConfig: true,
        preloadFeatureFlags: false,
        disableSurveys: true,
      }),
    );
  });

  it('holds events on a device that does not know the Account settings yet, then sends them once allowed', async () => {
    const tracking = await importTracking();

    tracking.capture('account_created');
    tracking.identify('anon-1', { acct_setting__analyticsOptOut: false });
    expect(sentEvents()).toEqual([]);

    tracking.optIn();

    expect(sentEvents().map(([method, name]) => [method, name])).toEqual([
      ['capture', 'app_opened'],
      ['capture', 'account_created'],
      ['identify', 'anon-1'],
    ]);
  });

  it('drops held events and sends nothing further once the Account is opted out', async () => {
    const tracking = await importTracking();

    tracking.capture('account_restored');
    tracking.optOut();
    tracking.capture('message_sent');
    tracking.screen('/settings');
    tracking.identify('anon-1', { acct_setting__sessionListDensity: 'cozy' });
    tracking.group('device_user', 'anon-1:device', {
      local_setting__themePreference: 'dark',
    });

    expect(sentEvents()).toEqual([]);
  });

  it('sends immediately when the active Account settings on this device are already known and allowed', async () => {
    await persistAcknowledgedAccountSettings({ analyticsOptOut: false });
    const tracking = await importTracking();

    tracking.capture('message_sent');

    expect(sentEvents().map(([, name]) => name)).toEqual([
      'app_opened',
      'message_sent',
    ]);
  });

  it('sends nothing at startup when the known Account settings opt out', async () => {
    await persistAcknowledgedAccountSettings({ analyticsOptOut: true });
    const tracking = await importTracking();

    tracking.capture('message_sent');
    tracking.identify('anon-1', {});

    expect(sentEvents()).toEqual([]);
  });

  it('returns to holding after logout until the next Account settings are known', async () => {
    await persistAcknowledgedAccountSettings({ analyticsOptOut: false });
    const tracking = await importTracking();

    tracking.reset();
    tracking.capture('account_restored');

    expect(sentEvents().map(([, name]) => name)).toEqual(['app_opened']);
    tracking.optOut();
    expect(sentEvents().map(([, name]) => name)).toEqual(['app_opened']);
  });

  describe('server_kind', () => {
    async function activateServer(serverUrl: string) {
      const { upsertServerProfile, setActiveServerId } =
        await import('@/sync/domains/server/serverProfiles');
      const profile = await upsertServerProfile({ serverUrl });
      await setActiveServerId(profile.id);
      return profile;
    }

    function capturedProperties(event: string) {
      return posthog.calls.find(
        ([method, name]) => method === 'capture' && name === event,
      )?.[2] as Record<string, unknown> | undefined;
    }

    it('marks events on the Happier Cloud server as cloud', async () => {
      await activateServer('https://api.happier.dev');
      const tracking = await importTracking();
      tracking.optIn();

      tracking.capture('message_sent');

      expect(capturedProperties('message_sent')).toEqual({
        server_kind: 'cloud',
      });
    });

    it('marks events on any other server as self_hosted without its URL', async () => {
      await activateServer('https://happier.example.internal');
      const tracking = await importTracking();
      tracking.optIn();

      tracking.capture('message_sent', { kind: 'x' });
      tracking.screen('/settings');

      expect(capturedProperties('message_sent')).toEqual({
        kind: 'x',
        server_kind: 'self_hosted',
      });
      const screen = posthog.calls.find(([method]) => method === 'screen');
      expect(screen?.[2]).toEqual({ server_kind: 'self_hosted' });
      expect(JSON.stringify(posthog.calls)).not.toContain('example.internal');
    });

    it('uses the server an event belongs to over the active server', async () => {
      const cloud = await activateServer('https://api.happier.dev');
      const selfHosted = await activateServer(
        'https://happier.example.internal',
      );
      const tracking = await importTracking();
      tracking.optIn();

      tracking.capture(
        'scm_status_sync_failed',
        { errorCode: 'COMMAND_FAILED' },
        { serverId: cloud.id },
      );

      expect(selfHosted.id).not.toBe(cloud.id);
      expect(capturedProperties('scm_status_sync_failed')).toEqual({
        errorCode: 'COMMAND_FAILED',
        server_kind: 'cloud',
      });
    });

    it('attaches nothing while analytics is opted out', async () => {
      await activateServer('https://api.happier.dev');
      const tracking = await importTracking();
      tracking.optOut();

      tracking.capture('message_sent');

      expect(sentEvents()).toEqual([]);
    });
  });
});
