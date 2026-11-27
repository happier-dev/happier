import { beforeEach, describe, expect, it, vi } from 'vitest';

// PostHog is the third-party SDK boundary; the fake records what our consent owner asks of it.
const posthog = vi.hoisted(() => ({
    options: null as Record<string, unknown> | null,
    calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock('posthog-react-native', () => ({
    default: class PostHogFake {
        constructor(_apiKey: string, options: Record<string, unknown>) {
            posthog.options = options;
        }
        optIn() { posthog.calls.push(['optIn']); }
        optOut() { posthog.calls.push(['optOut']); }
        identify(...args: unknown[]) { posthog.calls.push(['identify', ...args]); }
        register(...args: unknown[]) { posthog.calls.push(['register', ...args]); }
        reset(...args: unknown[]) { posthog.calls.push(['reset', ...args]); }
        capture(...args: unknown[]) { posthog.calls.push(['capture', ...args]); }
    },
}));

vi.mock('@/config', () => ({
    config: { postHogKey: 'ph_test_key' },
}));

function callsNamed(name: string) {
    return posthog.calls.filter(([method]) => method === name);
}

async function loadWithActiveServer(serverUrl: string) {
    const servers = await import('@/sync/domains/server/serverProfiles');
    const profile = servers.upsertServerProfile({ serverUrl, name: 'Active', source: 'manual' });
    servers.setActiveServerId(profile.id, { scope: 'device' });
    const track = await import('./index');
    return { servers, track };
}

describe('analytics consent owner', () => {
    beforeEach(() => {
        vi.resetModules();
        posthog.options = null;
        posthog.calls = [];
    });

    it('starts PostHog opted out, without lifecycle events (they carry the launch URL) or flag/config fetches', async () => {
        await import('./tracking');
        // Every launch starts opted out, even when a previous launch had opted in.
        expect(posthog.calls).toEqual([['optOut']]);
        expect(posthog.options).toEqual(expect.objectContaining({
            captureAppLifecycleEvents: false,
            defaultOptIn: false,
            preloadFeatureFlags: false,
            disableRemoteConfig: true,
        }));
    });

    it('sends $screen events without person processing, and leaves every other event to the SDK', async () => {
        await import('./tracking');
        const beforeSend = posthog.options?.before_send as (event: { event: string; properties: Record<string, unknown> }) => unknown;

        expect(beforeSend({ event: '$screen', properties: { $screen_name: 'settings', $process_person_profile: true } })).toEqual({
            event: '$screen',
            properties: { $screen_name: 'settings', $process_person_profile: false },
        });
        const other = { event: 'message_sent', properties: { $process_person_profile: true } };
        expect(beforeSend(other)).toEqual(other);
    });

    it('does not identify or register anything before the analytics setting is applied', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');

        expect(callsNamed('identify')).toEqual([]);
        expect(callsNamed('register')).toEqual([]);
        expect(track.getTrackingAnonymousUserId()).toBeNull();
    });

    it('opts in, identifies and registers server_kind=cloud once analytics is allowed on Happier Cloud', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.applyAnalyticsOptOut(false);

        expect(callsNamed('optIn')).toHaveLength(1);
        expect(callsNamed('identify')).toEqual([['identify', 'anon-1', { name: 'anon-1' }]]);
        expect(callsNamed('register')).toEqual([['register', { server_kind: 'cloud' }]]);
        expect(track.getTrackingAnonymousUserId()).toBe('anon-1');
    });

    it('registers server_kind=self_hosted for any other server and never the URL', async () => {
        const { track } = await loadWithActiveServer('https://relay.example.test:8443');
        track.applyAnalyticsOptOut(false);

        expect(callsNamed('register')).toEqual([['register', { server_kind: 'self_hosted' }]]);
        expect(JSON.stringify(posthog.calls)).not.toContain('relay.example.test');
    });

    it('re-registers server_kind when the active server changes while allowed', async () => {
        const { servers, track } = await loadWithActiveServer('https://api.happier.dev');
        track.applyAnalyticsOptOut(false);
        const other = servers.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Other', source: 'manual' });
        servers.setActiveServerId(other.id, { scope: 'device' });

        expect(callsNamed('register').at(-1)).toEqual(['register', { server_kind: 'self_hosted' }]);
    });

    it('registers and identifies nothing while opted out, including after a server change', async () => {
        const { servers, track } = await loadWithActiveServer('https://api.happier.dev');
        posthog.calls = [];
        track.initializeTracking('anon-1');
        track.applyAnalyticsOptOut(true);
        const other = servers.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Other', source: 'manual' });
        servers.setActiveServerId(other.id, { scope: 'device' });

        expect(callsNamed('optOut')).toHaveLength(1);
        expect(callsNamed('optIn')).toEqual([]);
        expect(callsNamed('identify')).toEqual([]);
        expect(callsNamed('register')).toEqual([]);
        expect(track.getTrackingAnonymousUserId()).toBeNull();
    });

    it('identifies once per allowed anon id, not on every repeated settings apply', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.applyAnalyticsOptOut(false);
        track.applyAnalyticsOptOut(false);

        expect(callsNamed('identify')).toHaveLength(1);
    });

    it('returns to the opted-out state after logout until the setting is applied again', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.applyAnalyticsOptOut(false);
        track.trackLogout();
        posthog.calls = [];
        track.initializeTracking('anon-2');

        expect(callsNamed('identify')).toEqual([]);
        expect(callsNamed('register')).toEqual([]);
        track.applyAnalyticsOptOut(false);
        expect(callsNamed('identify')).toEqual([['identify', 'anon-2', { name: 'anon-2' }]]);
    });

    it('forgets which person and group properties were sent when logout resets PostHog', async () => {
        const persistence = await import('@/sync/domains/state/persistence');
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.applyAnalyticsOptOut(false);
        persistence.saveAnalyticsPropertiesSent('person', { subject: 'anon-1', fullSentAtMs: 1, properties: { a: 1 } });
        persistence.saveAnalyticsPropertiesSent('device_user', { subject: 'anon-1:d', fullSentAtMs: 1, properties: { b: 2 } });

        track.trackLogout();

        expect(persistence.loadAnalyticsPropertiesSent('person')).toBeNull();
        expect(persistence.loadAnalyticsPropertiesSent('device_user')).toBeNull();
    });
});

describe('account events around consent', () => {
    beforeEach(() => {
        vi.resetModules();
        posthog.calls = [];
    });

    it('holds account_created until the setting is applied, then sends it once after identify', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.trackAccountCreated();
        expect(callsNamed('capture')).toEqual([]);

        track.applyAnalyticsOptOut(false);
        track.applyAnalyticsOptOut(false);

        expect(posthog.calls.filter(([m]) => m === 'identify' || m === 'capture')).toEqual([
            ['identify', 'anon-1', { name: 'anon-1' }],
            ['capture', 'account_created'],
        ]);
    });

    it('drops a held account event when the setting turns analytics off', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.trackAccountRestored();
        track.applyAnalyticsOptOut(true);
        track.applyAnalyticsOptOut(false);

        expect(callsNamed('capture')).toEqual([]);
    });

    it('opts out when another account signs in, until that account\'s setting is applied', async () => {
        const { track } = await loadWithActiveServer('https://api.happier.dev');
        track.initializeTracking('anon-1');
        track.applyAnalyticsOptOut(false);
        posthog.calls = [];

        track.initializeTracking('anon-2');

        expect(callsNamed('optOut')).toHaveLength(1);
        expect(callsNamed('identify')).toEqual([]);
        expect(track.getTrackingAnonymousUserId()).toBeNull();
        track.applyAnalyticsOptOut(false);
        expect(callsNamed('identify')).toEqual([['identify', 'anon-2', { name: 'anon-2' }]]);
    });
});

describe('voice session events', () => {
    beforeEach(() => {
        vi.resetModules();
        posthog.calls = [];
    });

    it('carry the voice provider only: no session id and no error text', async () => {
        const track = await import('./index');
        track.trackVoiceSessionToggled('realtime');
        track.trackVoiceSessionError('realtime');

        expect(callsNamed('capture')).toEqual([
            ['capture', 'voice_session_toggled', { providerId: 'realtime' }],
            ['capture', 'voice_session_error', { providerId: 'realtime' }],
        ]);
    });
});
