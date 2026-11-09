import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import {
    createAccountTokenForTests,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { createSocketAccountEncryptionObservation } from '@/sync/api/account/apiAccountEncryptionMode';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AccountSettingsStoredContentEnvelopeSchema } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { decryptSecretStringV1, deriveSettingsSecretsKeyV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';

const randomBytes = vi.hoisted(() => vi.fn((length: number) => new Uint8Array(length).fill(4)));
vi.mock('@/platform/cryptoRandom', () => ({ getRandomBytes: randomBytes }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { syncSettings, retireLegacyAuthoringMemoryKey } = await import('./syncSettings');
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(homes); randomBytes.mockClear(); });
afterAll(async () => { await homes.reset(); });

it.each(['e2ee', 'plain'] as const)('reads canonical %s Settings once without acquiring unused migration write material', async mode => {
    const secret = new Uint8Array(32).fill(51);
    const token = createAccountTokenForTests('read-only-settings-account');
    const credentials = mode === 'e2ee' ? { token, secret: encodeBase64(secret, 'base64url') } : { token };
    const serverUrl = 'https://settings-read-only.example.test';
    const serverId = await homes.addHome({ name: 'Read-only settings', serverUrl, accountId: 'read-only-settings-account', credentials });
    const currentness = mode === 'e2ee' ? createLegacyAccountEncryptionCurrentnessFixture({ secret })
        : createPlainAccountEncryptionCurrentnessFixture();
    const raw = { analyticsOptOut: true };
    const content = mode === 'plain' ? { t: 'plain' as const, v: raw }
        : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material: { type: 'legacy', secret }, payload: raw, randomBytes: length => new Uint8Array(length).fill(8) }) };
    const reads: string[] = [];
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
        reads.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (path === '/v2/account/settings' && init?.method !== 'POST') return Response.json({ content, version: 7 });
        throw new Error('Unexpected read-only Settings request');
    };
    const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
    const settingsScope = { serverId, accountId: 'read-only-settings-account' };
    storage.setState({ settingsScope, settings: settingsParse({}), settingsVersion: 0 });
    await syncSettings({ credentials, encryption, settingsScope, pendingSettings: {}, clearPendingSettings: () => {},
        requestContext: { scope: settingsScope, endpointUrl: serverUrl, request } });
    expect(storage.getState().settings.analyticsOptOut).toBe(true);
    expect(storage.getState().settingsVersion).toBe(7);
    expect(reads).toEqual(['GET /v1/account/encryption/currentness', 'GET /v2/account/settings']);
    expect(randomBytes).not.toHaveBeenCalled();
});

it.each(['matching', 'changed'] as const)('admits actual Settings migration at the write boundary with %s material', async scenario => {
    const secret = new Uint8Array(32).fill(52);
    const credentials = { token: createAccountTokenForTests('migration-settings-account'), secret: encodeBase64(secret, 'base64url') };
    const serverUrl = 'https://settings-migration.example.test';
    const serverId = await homes.addHome({ name: 'Migration settings', serverUrl, accountId: 'migration-settings-account', credentials });
    const encryption = await Encryption.create(secret);
    const legacyKey = deriveSettingsSecretsKeyV1(secret);
    const canonicalKey = deriveSettingsSecretsKeyV1(encryption.getContentPrivateKey());
    const raw = { secrets: [{ id: 'secret-1', name: 'Legacy secret', kind: 'apiKey', createdAt: 1, updatedAt: 1,
        encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1('legacy-value', legacyKey,
            length => new Uint8Array(length).fill(8)) } }] };
    const content = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret }, payload: raw, randomBytes: length => new Uint8Array(length).fill(8) }) };
    let currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const requests: string[] = [];
    let migratedValue: string | null = null;
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
        requests.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (path === '/v2/account/settings' && init?.method !== 'POST') {
            if (scenario === 'changed') currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(53) });
            return Response.json({ content, version: 7 });
        }
        if (path === '/v2/account/settings' && init?.method === 'POST') {
            const stored = AccountSettingsStoredContentEnvelopeSchema.parse(JSON.parse(String(init.body)).content);
            if (stored.t !== 'encrypted') throw new Error('Expected encrypted Settings migration');
            const opened = openAccountScopedBlobCiphertext({ kind: 'account_settings', material: { type: 'legacy', secret }, ciphertext: stored.c });
            const settings = settingsParse(opened?.value);
            const encryptedValue = settings.secrets[0].encryptedValue.encryptedValue;
            expect(encryptedValue).toBeDefined();
            migratedValue = decryptSecretStringV1(encryptedValue!, canonicalKey);
            return Response.json({ success: true, version: 8 });
        }
        throw new Error('Unexpected Settings migration request');
    };
    const settingsScope = { serverId, accountId: 'migration-settings-account' };
    storage.setState({ settingsScope, settings: settingsParse({}), settingsVersion: 0 });
    await syncSettings({ credentials, encryption, settingsScope, settingsSecretsKey: canonicalKey,
        settingsSecretsReadKeys: [canonicalKey, legacyKey], pendingSettings: {}, clearPendingSettings: () => {},
        requestContext: { scope: settingsScope, endpointUrl: serverUrl, request } });
    expect(requests).toEqual(['GET /v1/account/encryption/currentness', 'GET /v2/account/settings',
        'GET /v1/account/encryption/currentness', ...(scenario === 'matching' ? ['POST /v2/account/settings'] : [])]);
    expect(migratedValue).toBe(scenario === 'matching' ? 'legacy-value' : null);
    expect(storage.getState().settingsVersion).toBe(scenario === 'matching' ? 8 : 7);
});

it.each(['mismatched at entry', 'changed before entry', 'changed during baseline'] as const)(
    'refuses Settings sealing and writing with non-current Account material (%s)', async scenario => {
        const secret = new Uint8Array(32).fill(43);
        const credentials = { token: createAccountTokenForTests('material-settings-account'), secret: encodeBase64(secret, 'base64url') };
        const serverUrl = 'https://settings-material.example.test';
        const serverId = await homes.addHome({ name: 'Settings material', serverUrl, accountId: 'material-settings-account', credentials });
        const matching = createLegacyAccountEncryptionCurrentnessFixture({ secret });
        const changed = { ...createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(44) }), version: 2, updatedAt: 2 };
        let currentness = scenario === 'mismatched at entry' ? changed : matching;
        let posts = 0;
        let observation: ReturnType<typeof createSocketAccountEncryptionObservation> | undefined;
        const publishChange = () => {
            currentness = changed;
            observation?.update({ id: 'settings-key-change', seq: 2, createdAt: 2,
                body: { t: 'update-account', id: 'material-settings-account', encryptionCurrentness: changed } });
        };
        const fetchBoundary = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: currentness.updatedAt });
            if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') { posts += 1; return Response.json({ success: true, version: 1 }); }
                if (scenario === 'changed during baseline') publishChange();
                return Response.json({ content: null, version: 0 });
            }
            if (path === '/v1/push-tokens') return Response.json({ tokens: [] });
            throw new Error('Unexpected test route: ' + path);
        };
        setRuntimeFetch(fetchBoundary);
        // The first case deliberately retains standalone local material: final
        // sealing must validate it even when it did not come from the scoped owner.
        const encryption = scenario === 'mismatched at entry' ? await Encryption.create(secret)
            : await resolveScopedAccountEncryption({ serverId, serverUrl, credentials });
        if (!encryption) throw new Error('Expected local E2EE material');
        if (scenario !== 'mismatched at entry') {
            observation = createSocketAccountEncryptionObservation({ credentials, serverId, endpointUrl: serverUrl,
                runtimeOrigin: serverUrl, homeCarrierEndpointId: null, isCurrent: () => true,
                request: async () => Response.json(currentness) });
            observation.connected();
            await observation.binding.read();
        }
        if (scenario === 'changed before entry') publishChange();
        const settingsScope = { serverId, accountId: 'material-settings-account' };
        storage.setState({ settingsScope, settings: settingsParse({}), settingsVersion: 0 });
        randomBytes.mockClear();
        try {
            await expect(syncSettings({ credentials, encryption, settingsScope, pendingSettings: {}, clearPendingSettings: () => {},
                requestContext: { scope: settingsScope, endpointUrl: serverUrl,
                    request: async (path, init) => fetchBoundary(serverUrl + path, init) },
                oneShotServerSettingsMutation: { expectedSettingsVersion: 0,
                    mutate: raw => ({ settings: { ...raw, analyticsOptOut: true }, value: undefined }) },
            })).rejects.toMatchObject({ code: 'account_settings_encryption_material_unavailable' });
            expect(posts).toBe(0);
            expect(randomBytes).not.toHaveBeenCalled();
            expect(storage.getState().settingsVersion).toBe(0);
        } finally { observation?.dispose(); }
    },
);

it.each(['e2ee', 'plain'] as const)('keeps matching %s Settings writable through real material admission', async mode => {
    const secret = new Uint8Array(32).fill(47);
    const token = createAccountTokenForTests('matching-settings-account');
    const credentials = mode === 'e2ee' ? { token, secret: encodeBase64(secret, 'base64url') } : { token };
    const serverUrl = 'https://settings-matching.example.test';
    const serverId = await homes.addHome({ name: 'Matching settings', serverUrl, accountId: 'matching-settings-account', credentials });
    const currentness = mode === 'e2ee' ? createLegacyAccountEncryptionCurrentnessFixture({ secret })
        : createPlainAccountEncryptionCurrentnessFixture();
    let posts = 0;
    let writable = false;
    const fetchBoundary = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
        if (path === '/v2/account/settings') {
            if (init?.method !== 'POST') return Response.json({ content: null, version: 0 });
            const content = AccountSettingsStoredContentEnvelopeSchema.parse(JSON.parse(String(init.body)).content);
            const opened = content.t === 'plain' ? content.v
                : openAccountScopedBlobCiphertext({ kind: 'account_settings', material: { type: 'legacy', secret }, ciphertext: content.c })?.value;
            writable = Boolean(opened && typeof opened === 'object' && 'analyticsOptOut' in opened && opened.analyticsOptOut === true);
            posts += 1;
            return Response.json({ success: true, version: 1 });
        }
        if (path === '/v1/push-tokens') return Response.json({ tokens: [] });
        throw new Error('Unexpected test route: ' + path);
    };
    setRuntimeFetch(fetchBoundary);
    const encryption = await resolveScopedAccountEncryption({ serverId, serverUrl, credentials });
    expect(encryption === null).toBe(mode === 'plain');
    const settingsScope = { serverId, accountId: 'matching-settings-account' };
    storage.setState({ settingsScope, settings: settingsParse({}), settingsVersion: 0 });
    const result = await syncSettings({ credentials, encryption, settingsScope, pendingSettings: {}, clearPendingSettings: () => {},
        requestContext: { scope: settingsScope, endpointUrl: serverUrl, request: async (path, init) => fetchBoundary(serverUrl + path, init) },
        oneShotServerSettingsMutation: { expectedSettingsVersion: 0,
            mutate: raw => ({ settings: { ...raw, analyticsOptOut: true }, value: undefined }) },
    });
    expect(result).toMatchObject({ status: 'applied', settingsVersion: 1 });
    expect(posts).toBe(1);
    expect(writable).toBe(true);
});

it.each(['matching-e2ee', 'mismatched-e2ee', 'plain'] as const)(
    'uses the same material admission for exact legacy Settings retirement (%s)', async scenario => {
        const mode = scenario === 'plain' ? 'plain' : 'e2ee';
        const secret = new Uint8Array(32).fill(48);
        const credentials = mode === 'e2ee'
            ? { token: createAccountTokenForTests('retirement-account'), secret: encodeBase64(secret, 'base64url') }
            : { token: createAccountTokenForTests('retirement-account') };
        const serverUrl = 'https://settings-retirement.example.test';
        const serverId = await homes.addHome({ name: 'Settings retirement', serverUrl, accountId: 'retirement-account', credentials });
        const currentness = mode === 'plain' ? createPlainAccountEncryptionCurrentnessFixture()
            : createLegacyAccountEncryptionCurrentnessFixture({ secret: scenario === 'mismatched-e2ee' ? new Uint8Array(32).fill(49) : secret });
        const key = LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS[0];
        const raw = { [key]: ['legacy'], futureSibling: { retained: true } };
        const content = mode === 'plain' ? { t: 'plain' as const, v: raw }
            : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                material: { type: 'legacy', secret }, payload: raw, randomBytes: length => new Uint8Array(length).fill(8) }) };
        let posts = 0;
        let retainedSibling = false;
        const fetchBoundary = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
            if (path === '/v2/account/settings' && init?.method !== 'POST') return Response.json({ content, version: 0 });
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const next = AccountSettingsStoredContentEnvelopeSchema.parse(JSON.parse(String(init.body)).content);
                const opened = next.t === 'plain' ? next.v
                    : openAccountScopedBlobCiphertext({ kind: 'account_settings', material: { type: 'legacy', secret }, ciphertext: next.c })?.value;
                retainedSibling = Boolean(opened && typeof opened === 'object'
                    && !Object.hasOwn(opened, key) && 'futureSibling' in opened);
                posts += 1;
                return Response.json({ success: true, version: 1 });
            }
            throw new Error('Unexpected test route: ' + path);
        };
        setRuntimeFetch(fetchBoundary);
        const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
        const settingsScope = { serverId, accountId: 'retirement-account' };
        randomBytes.mockClear();
        const retiring = retireLegacyAuthoringMemoryKey({ credentials, encryption, accountMode: mode, settingsScope,
            requestContext: { scope: settingsScope, endpointUrl: serverUrl, request: async (path, init) => fetchBoundary(serverUrl + path, init) },
            key, expectedSettingsVersion: 0 });
        if (scenario === 'mismatched-e2ee') {
            await expect(retiring).rejects.toMatchObject({ code: 'account_settings_encryption_material_unavailable' });
            expect(posts).toBe(0);
            expect(randomBytes.mock.calls.length).toBe(0);
        } else {
            expect(await retiring).toMatchObject({ status: 'applied', settingsVersion: 1 });
            expect(posts).toBe(1);
            expect(retainedSibling).toBe(true);
        }
    },
);
