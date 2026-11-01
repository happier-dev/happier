import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
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

    it('writes pending plain settings and preserves plain secrets through local projection', async () => {
        serve({ t: 'plain', v: { analyticsOptOut: false, secrets: [secret] } });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const pendingSettings: Partial<Settings> = { analyticsOptOut: true };
        savePendingSettings(pendingSettings);
        const clearPendingSettings = vi.fn(savePendingSettings);

        await syncSettings({ credentials, encryption, pendingSettings, clearPendingSettings });

        const post = boundary.serverFetch.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(JSON.parse(String(post?.[1]?.body))).toEqual({
            content: { t: 'plain', v: { analyticsOptOut: true, secrets: [secret] } },
            expectedVersion: 4,
        });
        expect(storage.getState().settings).toMatchObject({ analyticsOptOut: true, secrets: [secret] });
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
});
