import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createDataKeyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSocketAccountEncryptionObservation } from '@/sync/api/account/apiAccountEncryptionMode';
import { createApiAuthoringMemoryTransport } from '@/sync/api/account/apiAuthoringMemory';
import { bindAccountEncryptionObservation } from '@/sync/http/accountEncryptionObservationBinding';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { createAuthoringMemorySync, importLegacyAuthoringMemory } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import type { ServerFetch } from '@/sync/http/client';
import type { AuthoringMemory } from '@/sync/store/domains/authoringMemory';
import { readAccountSettingsBaseline } from './accountSettingsBaseline';
import { readCurrentAccountSettingsRawSnapshot, resetAccountSettingsRawSnapshotsForTests, retainAccountSettingsRawSnapshot } from './accountSettingsRawSnapshot';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { retireLegacyAuthoringMemoryKey } = await import('./syncSettings');
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(homes); });
afterEach(() => resetAccountSettingsRawSnapshotsForTests());
afterAll(async () => { await homes.reset(); });

it.each([
    { mode: 'plain', scenario: 'stale-socket' }, { mode: 'e2ee', scenario: 'stale-socket' },
    { mode: 'plain', scenario: 'write-conflict' }, { mode: 'e2ee', scenario: 'write-conflict' },
] as const)('converges $scenario retirement in $mode without repeated source reads', async ({ mode, scenario }) => {
        const machineKey = new Uint8Array(32).fill(54);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const token = createAccountTokenForTests(`retirement-${mode}-${scenario}`);
        const credentials: AuthCredentials = mode === 'plain' ? { token } : { token, encryption: {
            machineKey: encodeBase64(machineKey, 'base64'), publicKey: encodeBase64(publicKey, 'base64'),
        } };
        const serverUrl = 'https://settings-conflict.example.test';
        const serverId = await homes.addHome({ name: 'Settings conflict', serverUrl, accountId: `retirement-${mode}-${scenario}`, credentials });
        const scope = { serverId, accountId: `retirement-${mode}-${scenario}` };
        const encryption = mode === 'plain' ? null : await Encryption.createFromContentKeyPair({ machineKey, publicKey });
        const material = { type: 'dataKey' as const, machineKey };
        const recentMachinePaths = [{ machineId: 'machine-one', path: '/repo' }];
        let raw: Record<string, unknown> = { recentMachinePaths, futureSibling: { source: 'http' } };
        let version = scenario === 'stale-socket' ? 3 : 1;
        const stored = () => mode === 'plain' ? { t: 'plain' as const, v: raw }
            : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
                payload: raw, randomBytes: length => new Uint8Array(length).fill(8) }) };
        const memory = createAuthoringMemoryHttpBoundary();
        const requests: string[] = [];
        let settingsReads = 0;
        let posts = 0;
        // Only HTTP is replaced: the cache, import, CAS and encryption owners remain real.
        const request: ServerFetch = async (path, init) => {
            requests.push(`${init?.method ?? 'GET'} ${path}`);
            if (path === '/v1/account/encryption/currentness') return Response.json(mode === 'plain'
                ? createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version })
                : { ...createDataKeyAccountEncryptionCurrentnessFixture({ machineKey, publicKey }), settingsVersion: version });
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                settingsReads += 1;
                // Two retirement attempts need two baselines. Fail a third request
                // here so the old microtask loop produces RED rather than hanging.
                if (settingsReads > 2) throw new Error('Retirement reused stale Settings instead of converging');
                return Response.json({ content: stored(), version });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const body = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                posts += 1;
                if (scenario === 'write-conflict' && posts === 1) {
                    raw = { ...raw, futureSibling: { source: 'concurrent-device' } };
                    version += 1;
                    return Response.json({ success: false, error: 'version-mismatch', currentVersion: version,
                        currentContent: stored() }, { status: 409 });
                }
                expect(body.expectedVersion).toBe(version);
                if (!body.content) throw new Error('Expected Settings retirement content');
                const opened = body.content.t === 'plain' ? body.content.v : openAccountScopedBlobCiphertext({
                    kind: 'account_settings', material, ciphertext: body.content.c })?.value;
                if (!opened || typeof opened !== 'object' || Array.isArray(opened)) throw new Error('Invalid retired Settings');
                raw = Object.fromEntries(Object.entries(opened));
                version += 1;
                return Response.json({ success: true, version });
            }
            const response = await memory.handle(serverUrl + path, init);
            if (response) return response;
            throw new Error('Unexpected conflict test route: ' + path);
        };
        const observation = createSocketAccountEncryptionObservation({ credentials, serverId, endpointUrl: serverUrl,
            runtimeOrigin: serverUrl, homeCarrierEndpointId: null, isCurrent: () => true, request });
        bindAccountEncryptionObservation(request, observation.binding);
        observation.connected();
        await observation.binding.read();
        requests.length = 0;
        retainAccountSettingsRawSnapshot(scope, 1, { recentMachinePaths, futureSibling: { source: 'socket' } });
        const read = () => readCurrentAccountSettingsRawSnapshot(scope, { credentials, request, readBaseline: async () => {
            const baseline = await readAccountSettingsBaseline({ credentials, encryption, accountMode: mode, request });
            return { raw: baseline.raw ?? {}, version: baseline.version };
        } });
        let projection: Partial<AuthoringMemory> = {};
        const owner = createAuthoringMemorySync({ transport: createApiAuthoringMemoryTransport({ request }),
            cipher: createAuthoringMemoryCipher({ mode, material: mode === 'e2ee' ? material : null,
                randomBytes: length => new Uint8Array(length).fill(4) }),
            isCurrent: () => true, apply: delta => { projection = { ...projection, ...delta }; } });
        try {
            await owner.bootstrap();
            await importLegacyAuthoringMemory({ owner, settings: { read, remove: async (key, expectedVersion) => {
                const legacyKey = LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS.find(candidate => candidate === key);
                if (!legacyKey) throw new Error('Unexpected retirement key');
                return (await retireLegacyAuthoringMemoryKey({ credentials, encryption, accountMode: mode, settingsScope: scope,
                    requestContext: { scope, endpointUrl: serverUrl, request }, key: legacyKey,
                    expectedSettingsVersion: expectedVersion })).status;
            } } });
            expect(projection.recentMachinePaths).toEqual(recentMachinePaths);
            expect(raw).toEqual({ futureSibling: { source: scenario === 'write-conflict' ? 'concurrent-device' : 'http' } });
            expect(await read()).toMatchObject({ raw, version });
            expect(settingsReads).toBe(2);
            expect(posts).toBe(scenario === 'stale-socket' ? 1 : 2);
            expect(requests.filter(value => value === 'GET /v1/account/authoring-memory/recentMachinePaths')).toHaveLength(2);
            expect(requests.filter(value => value === 'POST /v1/account/authoring-memory/recentMachinePaths')).toHaveLength(1);
        } finally { observation.dispose(); }
});
