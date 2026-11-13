import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    resolveAssignableSessionRoleProfileV1,
    SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
} from '@happier-dev/protocol';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { Encryption } from '@/sync/encryption/encryption';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { savePendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';

import { syncSettings } from './syncSettings';

const boundary = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    fetchSessionOrganizationSnapshot: vi.fn(),
    importLegacySessionOrganization: vi.fn(),
}));
vi.mock('@/sync/http/client', () => ({ serverFetch: boundary.serverFetch }));
vi.mock('@/sync/api/session/sessionOrganizationApi', () => ({
    fetchSessionOrganizationSnapshot: boundary.fetchSessionOrganizationSnapshot,
}));
vi.mock('@/sync/ops/sessionOrganization/importLegacySessionOrganization', () => ({
    importLegacySessionOrganization: boundary.importLegacySessionOrganization,
}));

describe('fresh account Repo Admin role seed', () => {
    const credentials = { token: 'plain-token' };
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    const initialState = storage.getState();
    let serverRaw: Record<string, unknown>;
    let serverVersion: number;
    let postAttempts: number;
    let failAfterCommit: boolean;
    let failBeforeCommit: boolean;
    let serverContentAbsent: boolean;
    let versionMismatchBaseline: { raw: Record<string, unknown>; version: number } | null;
    let events: string[];

    async function run(
        settingsScope: typeof scope | null = scope,
        pendingSettings: Record<string, unknown> = {},
    ) {
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        return syncSettings({
            credentials,
            encryption,
            settingsScope,
            pendingSettings,
            clearPendingSettings: vi.fn(),
        });
    }

    beforeEach(() => {
        getPersistenceStorage().clearAll();
        invalidateAccountEncryptionModeCache();
        serverRaw = {};
        serverVersion = 4;
        postAttempts = 0;
        failAfterCommit = false;
        failBeforeCommit = false;
        serverContentAbsent = false;
        versionMismatchBaseline = null;
        events = [];
        boundary.serverFetch.mockReset();
        boundary.fetchSessionOrganizationSnapshot.mockReset();
        boundary.fetchSessionOrganizationSnapshot.mockResolvedValue({
            snapshot: {
                schemaVersion: 1,
                version: 0,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        });
        boundary.importLegacySessionOrganization.mockReset();
        boundary.importLegacySessionOrganization.mockImplementation(async () => {
            events.push('import');
        });
        storage.setState({
            settings: { ...settingsDefaults },
            settingsVersion: 0,
            settingsScope: scope,
            localSettings: { ...localSettingsDefaults },
        });
        savePendingAccountSettings(scope, {});
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                postAttempts += 1;
                events.push('post');
                if (failBeforeCommit) throw new Error('offline');
                const body = JSON.parse(String(init.body)) as {
                    content: { t: 'plain'; v: Record<string, unknown> };
                    expectedVersion: number;
                };
                expect(body.expectedVersion).toBe(serverVersion);
                if (versionMismatchBaseline) {
                    serverRaw = structuredClone(versionMismatchBaseline.raw);
                    serverVersion = versionMismatchBaseline.version;
                    versionMismatchBaseline = null;
                    return Response.json({
                        success: false,
                        error: 'version-mismatch',
                        currentVersion: serverVersion,
                        currentContent: { t: 'plain', v: structuredClone(serverRaw) },
                    }, { status: 409 });
                }
                serverRaw = structuredClone(body.content.v);
                serverContentAbsent = false;
                serverVersion += 1;
                if (failAfterCommit) throw new Error('response-lost');
                return Response.json({ success: true, version: serverVersion });
            }
            if (path === '/v2/account/settings') {
                return Response.json({
                    content: serverContentAbsent ? null : { t: 'plain', v: structuredClone(serverRaw) },
                    version: serverVersion,
                });
            }
            throw new Error(`Unexpected request: ${path}`);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        getPersistenceStorage().clearAll();
        storage.setState(initialState, true);
    });

    it('persists one stable Repo Admin before exposing it for assignment, then reloads without duplication', async () => {
        serverContentAbsent = true;

        await run();

        expect(postAttempts).toBe(1);
        expect(serverRaw.sessionRoleProfilesV1).toEqual({
            v: 1,
            instructionsByRole: {},
            customRoles: [SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1],
        });
        expect(resolveAssignableSessionRoleProfileV1(
            storage.getState().settings,
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
        )).toMatchObject(SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1);

        await run();
        expect(postAttempts).toBe(1);
        expect((serverRaw.sessionRoleProfilesV1 as { customRoles: unknown[] }).customRoles).toHaveLength(1);
    });

    it('fails closed without seed persistence when an encrypted settings document is unreadable', async () => {
        const encryption = {
            getContentPrivateKey: () => new Uint8Array(32).fill(7),
            decryptRaw: vi.fn(async () => null),
        } as unknown as Encryption;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                postAttempts += 1;
                return Response.json({ success: true, version: serverVersion + 1 });
            }
            if (path === '/v2/account/settings') {
                return Response.json({
                    content: { t: 'encrypted', c: 'unreadable-account-settings' },
                    version: serverVersion,
                });
            }
            throw new Error(`Unexpected request: ${path}`);
        });

        await expect(syncSettings({
            credentials,
            encryption,
            settingsScope: scope,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        })).rejects.toThrow('Failed to open encrypted account settings');

        expect(postAttempts).toBe(0);
        expect(resolveAssignableSessionRoleProfileV1(
            storage.getState().settings,
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
        )).toBeNull();
    });

    it.each([
        ['customized', {
            v: 1,
            instructionsByRole: {},
            customRoles: [{ ...SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1, name: 'Portfolio Lead' }],
        }],
        ['explicitly empty', { v: 1, instructionsByRole: {}, customRoles: [] }],
        ['template deleted', {
            v: 1,
            instructionsByRole: {},
            customRoles: [{
                id: 'custom:223e4567-e89b-12d3-a456-426614174000',
                name: 'Architect',
                instructions: 'Design.',
                color: '#123456',
            }],
        }],
        ['present but malformed', null],
    ])('preserves a %s raw role-profile field without seeding', async (_label, existing) => {
        serverRaw = { retained: true, sessionRoleProfilesV1: structuredClone(existing) };
        const before = structuredClone(serverRaw);

        await run();

        expect(postAttempts).toBe(0);
        expect(serverRaw).toEqual(before);
    });

    it('keeps the template unassignable when persistence fails', async () => {
        failBeforeCommit = true;

        await expect(run()).rejects.toThrow('offline');

        expect(postAttempts).toBe(1);
        expect(serverRaw).toEqual({});
        expect(resolveAssignableSessionRoleProfileV1(
            storage.getState().settings,
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
        )).toBeNull();
    });

    it('recovers a lost success response by rereading the persisted identity without a duplicate write', async () => {
        failAfterCommit = true;
        await expect(run()).rejects.toThrow('response-lost');
        expect(resolveAssignableSessionRoleProfileV1(
            storage.getState().settings,
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
        )).toBeNull();

        failAfterCommit = false;
        await run();

        expect(postAttempts).toBe(1);
        expect((serverRaw.sessionRoleProfilesV1 as { customRoles: unknown[] }).customRoles).toEqual([
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
        ]);
        expect(resolveAssignableSessionRoleProfileV1(
            storage.getState().settings,
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
        )).not.toBeNull();
    });

    it('imports pending legacy organization data before a seed-bearing settings write', async () => {
        serverRaw = { pinnedSessionKeysV1: ['server-a:legacy-session'] };

        await run(scope, { analyticsOptOut: true });

        expect(events).toEqual(['import', 'post']);
        expect(boundary.importLegacySessionOrganization).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                pins: [{ sessionId: 'legacy-session', sortKey: '00000001' }],
            }),
        }));
        expect(serverRaw).toMatchObject({
            analyticsOptOut: true,
            sessionRoleProfilesV1: {
                v: 1,
                instructionsByRole: {},
                customRoles: [SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1],
            },
        });
        expect(serverRaw).not.toHaveProperty('pinnedSessionKeysV1');
    });

    it('does not seed or remove legacy organization data when its canonical import fails', async () => {
        serverRaw = { pinnedSessionKeysV1: ['server-a:legacy-session'] };
        boundary.importLegacySessionOrganization.mockImplementationOnce(async () => {
            events.push('import');
            throw new Error('organization-import-offline');
        });

        await expect(run()).rejects.toThrow('organization-import-offline');

        expect(events).toEqual(['import']);
        expect(postAttempts).toBe(0);
        expect(serverRaw).toEqual({ pinnedSessionKeysV1: ['server-a:legacy-session'] });
        expect(serverRaw).not.toHaveProperty('sessionRoleProfilesV1');
    });

    it('imports the exact version-mismatch baseline before retrying a seed-bearing write', async () => {
        serverRaw = { pinnedSessionKeysV1: ['server-a:first-session'] };
        versionMismatchBaseline = {
            raw: { pinnedSessionKeysV1: ['server-a:latest-session'] },
            version: 9,
        };

        await run();

        expect(events).toEqual(['import', 'post', 'import', 'post']);
        expect(boundary.importLegacySessionOrganization).toHaveBeenCalledTimes(2);
        expect(boundary.importLegacySessionOrganization.mock.calls.map(([call]) => call.request.pins)).toEqual([
            [{ sessionId: 'first-session', sortKey: '00000001' }],
            [{ sessionId: 'latest-session', sortKey: '00000001' }],
        ]);
        expect(postAttempts).toBe(2);
        expect(serverRaw).not.toHaveProperty('pinnedSessionKeysV1');
        expect((serverRaw.sessionRoleProfilesV1 as { customRoles: unknown[] }).customRoles).toEqual([
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
        ]);
    });

    it('does not seed from an unscoped bootstrap sync', async () => {
        await run(null);
        expect(postAttempts).toBe(0);
        expect(serverRaw).toEqual({});
    });
});
