import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { savePendingSettings } from '@/sync/domains/state/persistence';
import { initializeTracking, trackAccountCreated, trackLogout } from '@/track';
import { applySettingsLocalDelta, applyStartupConsentSettings, syncSettings } from './syncSettings';

// PostHog is the SDK boundary. The fake drops events while opted out, like the SDK's enqueue gate.
const posthog = vi.hoisted(() => ({
    optedOut: true,
    sent: [] as Array<[string, ...unknown[]]>,
    consent: [] as string[],
}));
vi.mock('posthog-react-native', () => ({
    default: class PostHogFake {
        optIn() { posthog.optedOut = false; posthog.consent.push('optIn'); }
        optOut() { posthog.optedOut = true; posthog.consent.push('optOut'); }
        reset() { posthog.optedOut = true; }
        register() {}
        flush() {}
        identify(...args: unknown[]) { if (!posthog.optedOut) posthog.sent.push(['identify', ...args]); }
        group(...args: unknown[]) { if (!posthog.optedOut) posthog.sent.push(['group', ...args]); }
        capture(...args: unknown[]) { if (!posthog.optedOut) posthog.sent.push(['capture', ...args]); }
    },
}));
vi.mock('@/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/config')>();
    return { ...actual, config: { ...actual.config, postHogKey: 'ph_test_key' } };
});

const boundary = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock('@/sync/http/client', () => ({ serverFetch: boundary.serverFetch }));

describe('analytics consent from account settings', () => {
    const credentials = { token: 'plain-token' };
    const initialState = storage.getState();

    function serve(content: unknown) {
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings' && init?.method === 'POST') return Response.json({ success: true, version: 5 });
            if (path === '/v2/account/settings') return Response.json({ content, version: 4 });
            throw new Error(`Unexpected request: ${path}`);
        });
    }

    beforeEach(() => {
        invalidateAccountEncryptionModeCache();
        boundary.serverFetch.mockReset();
        trackLogout();
        posthog.sent = [];
        posthog.consent = [];
        savePendingSettings({});
        initializeTracking('anon-1');
    });

    afterEach(() => {
        storage.setState(initialState, true);
    });

    it('keeps analytics off at startup until settings have been read from the server once', () => {
        // A new device: the cached settings are defaults, not the account's choice.
        storage.setState({ settings: { ...settingsDefaults, analyticsOptOut: false }, settingsVersion: null });

        applyStartupConsentSettings();

        expect(posthog.consent).not.toContain('optIn');
        expect(posthog.sent).toEqual([]);
    });

    it('sends a sign-up event from before the first settings read once that read allows analytics', async () => {
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: null });
        applyStartupConsentSettings();
        trackAccountCreated();
        expect(posthog.sent).toEqual([]);

        serve({ t: 'plain', v: { analyticsOptOut: false } });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(posthog.sent).toContainEqual(['capture', 'account_created']);
    });

    it('applies the cached choice at startup once it came from the server', () => {
        storage.setState({ settings: { ...settingsDefaults, analyticsOptOut: false }, settingsVersion: 3 });

        applyStartupConsentSettings();

        expect(posthog.consent).toEqual(['optIn']);
        expect(posthog.sent).toEqual([['identify', 'anon-1', { name: 'anon-1' }]]);
    });

    it.each([
        [false, ['optIn']],
        [true, ['optOut']],
    ])('applies the server analyticsOptOut=%s after a settings read', async (analyticsOptOut, expected) => {
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: null });
        serve({ t: 'plain', v: { analyticsOptOut } });
        const encryption = await createEncryptionFromAuthCredentials(credentials);

        await syncSettings({ credentials, encryption, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(posthog.consent).toEqual(expected);
        if (analyticsOptOut) expect(posthog.sent).toEqual([]);
    });

    it('sends nothing at the moment a person opts out', () => {
        storage.setState({ settings: { ...settingsDefaults, analyticsOptOut: false }, settingsVersion: 3 });
        applyStartupConsentSettings();
        posthog.sent = [];
        let pendingSettings: Partial<Settings> = {};

        applySettingsLocalDelta({
            delta: { analyticsOptOut: true },
            settingsSecretsKey: null,
            getPendingSettings: () => pendingSettings,
            setPendingSettings: (next) => { pendingSettings = next; },
            schedulePendingSettingsFlush: () => {},
        });

        expect(posthog.consent.at(-1)).toBe('optOut');
        expect(posthog.sent).toEqual([]);
    });
});
