import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { buildProfileSaveSettingsDelta } from '@/sync/domains/profiles/profileMutations';
import { storage } from '@/sync/domains/state/storage';
import { savePendingSettings } from '@/sync/domains/state/persistence';
import { syncSettings } from './syncSettings';

const boundary = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock('@/sync/http/client', () => ({ serverFetch: boundary.serverFetch }));

describe('syncSettings without account encryption material', () => {
    const credentials = { token: 'plain-token' };
    const initialState = storage.getState();
    const secret = {
        id: 'secret-a', name: 'API key', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'plain-secret' },
        createdAt: 1, updatedAt: 1,
    } as const;

    beforeEach(() => {
        invalidateAccountEncryptionModeCache();
        boundary.serverFetch.mockReset();
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0 });
        savePendingSettings({});
    });

    afterEach(() => {
        storage.setState(initialState, true);
    });

    function serve(content: unknown, mode: 'plain' | 'e2ee' = 'plain') {
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                return Response.json({ success: true, version: 5 });
            }
            if (path === '/v2/account/settings') return Response.json({ content, version: 4 });
            throw new Error(`Unexpected request: ${path}`);
        });
    }

    it('refreshes plain settings and secrets without requesting a content key', async () => {
        serve({ t: 'plain', v: { analyticsOptOut: true, secrets: [secret] } });
        const encryption = await createEncryptionFromAuthCredentials(credentials);

        await syncSettings({ credentials, encryption, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(storage.getState().settings).toMatchObject({ analyticsOptOut: true, secrets: [secret] });
        expect(storage.getState().settingsVersion).toBe(4);
        expect(boundary.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    });

    it('writes pending plain settings and preserves newer lineage preset/toggle keys through the released 0.2.21 raw-baseline merge', async () => {
        const retained = {
            secrets: [secret],
            featureToggles: { 'sessions.lineageAppearancePresets': true },
            sessionLineageAppearancePresetsV1: { future: 'keep', parent: { density: 'cozy' } },
        };
        serve({ t: 'plain', v: { analyticsOptOut: false, ...retained } });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const pendingSettings: Partial<Settings> = { analyticsOptOut: true };
        savePendingSettings(pendingSettings);
        const clearPendingSettings = vi.fn(savePendingSettings);

        await syncSettings({ credentials, encryption, pendingSettings, clearPendingSettings });

        const post = boundary.serverFetch.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(JSON.parse(String(post?.[1]?.body))).toEqual({
            content: { t: 'plain', v: { analyticsOptOut: true, ...retained } },
            expectedVersion: 4,
        });
        expect(storage.getState().settings).toMatchObject({ analyticsOptOut: true, ...retained });
        expect(storage.getState().settingsVersion).toBe(5);
        expect(clearPendingSettings).toHaveBeenCalledWith({});
    });

    it('fails explicitly before opening encrypted settings without material', async () => {
        serve({ t: 'encrypted', c: 'ciphertext' }, 'e2ee');
        const encryption = await createEncryptionFromAuthCredentials(credentials);

        await expect(syncSettings({ credentials, encryption, pendingSettings: {}, clearPendingSettings: vi.fn() }))
            .rejects.toMatchObject({ code: 'encryption_material_unavailable' });
        expect(storage.getState().settingsVersion).toBe(0);
    });

    it('preserves unreadable profiles and bindings when a readable profile is saved', async () => {
        const profile = AIBackendProfileSchema.parse({ id: 'visible', name: 'Visible' });
        const unreadable = { id: 'unreadable', name: 'x'.repeat(101), futureField: true };
        const bindings = { unreadable: { API_KEY: 'future-secret' } };
        const raw = { profiles: [profile, unreadable], secretBindingsByProfileId: bindings };
        serve({ t: 'plain', v: raw });
        const view = settingsParse(raw);
        const updated = { ...profile, name: 'Edited' };
        const pendingSettings = buildProfileSaveSettingsDelta({
            profiles: view.profiles,
            secretBindingsByProfileId: view.secretBindingsByProfileId,
            profile: updated,
            profileSecretBindings: {},
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);

        await syncSettings({ credentials, encryption, pendingSettings, clearPendingSettings: vi.fn() });

        const post = boundary.serverFetch.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(JSON.parse(String(post?.[1]?.body))).toEqual({
            content: { t: 'plain', v: { profiles: [updated, unreadable], secretBindingsByProfileId: bindings } },
            expectedVersion: 4,
        });
        expect(storage.getState().settings.profiles).toEqual([updated]);
    });
});
