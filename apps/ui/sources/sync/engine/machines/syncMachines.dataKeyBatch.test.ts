import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { MachineDataKeyCacheEntry } from './syncMachines';
import tweetnacl from 'tweetnacl';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { Encryption } from '@/sync/encryption/encryption';
import {
    computeRunnerMachineContentKeyFingerprintV1,
    encodePlainMachineStoredContent,
    encodeBase64,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';

const legacyCredentials = {
    token: `e30.${btoa(JSON.stringify({ sub: 'account-1' }))}.signature`,
    secret: encodeBase64(new Uint8Array(32).fill(17), 'base64url'),
} satisfies AuthCredentials;

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

type RawMachine = {
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    kind?: 'persistent' | 'ephemeral_session_runner';
    installationId?: string | null;
    runnerContentKeyBinding?: unknown;
    seq: number;
    active: boolean;
    activeAt: number;
    revokedAt: number | null;
    createdAt: number;
    updatedAt: number;
};

function machineRow(id: string, dataEncryptionKey: string | null): RawMachine {
    return {
        id,
        metadata: `meta-${id}`,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey,
        seq: 1,
        active: true,
        activeAt: 10,
        revokedAt: null,
        createdAt: 1,
        updatedAt: 10,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function createEncryptionHarness(
    decrypt: (envelopes: readonly string[]) => Array<Uint8Array | null>,
) {
    const contextOwner = await Encryption.create(new Uint8Array(32).fill(17));
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) => decrypt(values));
    const initialized = new Set<string>();
    const initializeMachines = vi.fn(async (machineKeys: Map<string, Uint8Array | null>) => {
        for (const machineId of machineKeys.keys()) initialized.add(machineId);
    });
    const machineEncryption = {
        decryptMetadata: async (_version: number, value: string) => ({ decrypted: value }),
        decryptDaemonState: async (_version: number, value: string | null) =>
            value ? { decrypted: value } : null,
    };
    return {
        captureMachineEncryptionContext: contextOwner.captureMachineEncryptionContext.bind(contextOwner),
        captureMachineEncryptionContextRead: contextOwner.captureMachineEncryptionContextRead.bind(contextOwner),
        decryptEncryptionKeys,
        initializeMachines,
        getMachineEncryption: (machineId: string) => {
            if (!initialized.has(machineId)) return null;
            return machineEncryption;
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

beforeEach(async () => {
    vi.resetModules();
    const deviceLocalStorage = await import('@/auth/storage/deviceLocalStorage');
    vi.spyOn(deviceLocalStorage, 'readDeviceLocalStorageString').mockResolvedValue(null);
});

async function loadFetchAndApplyMachines() {
    const mod = await import('./syncMachines');
    return mod.fetchAndApplyMachines;
}

/**
 * Seeds the creator-local activation verifier for a Runner Machine, exactly as
 * the creating device retains it when it publishes the Machine-content-key
 * proof. Every other device resolves no verifier and the Runner stays locked.
 */
async function seedCreatorRunnerTrust(input: Readonly<{
    machineId: string;
    activationId: string;
    activationSigningPublicKey: string;
}>): Promise<void> {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    } });
    const trust = await import('@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust');
    await trust.retainRunnerCreatorMachineContentKeyTrust({
        scope: { homeServerIdentityId: 'home-1', creatorAccountId: 'account-1' },
        machineId: input.machineId,
        activationId: input.activationId,
        activationSigningPublicKey: input.activationSigningPublicKey,
    });
}

describe('fetchAndApplyMachines machine data-key unwrapping', () => {
    it('admits a Runner key only after its creator proof matches the exact row', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-1' })), 'base64url')}.signature`;
        const dataKey = new Uint8Array(32).fill(19);
        const binding = signRunnerMachineContentKeyBindingV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-runner.machine-content-key',
                homeServerIdentityId: 'home-1',
                activationId: '11111111-1111-4111-8111-111111111111',
                creatorAccountId: 'account-1',
                machineId: 'runner-1',
                installationId: 'installation-1',
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
            },
            activationSigningSecretKey: signing.secretKey,
        });
        await seedCreatorRunnerTrust({
            machineId: 'runner-1',
            activationId: '11111111-1111-4111-8111-111111111111',
            activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
        });
        const runner = {
            ...machineRow('runner-1', 'runner-envelope'),
            kind: 'ephemeral_session_runner' as const,
            installationId: 'installation-1',
            runnerContentKeyBinding: binding,
        };
        const initializeMachines = vi.fn(async (
            _keys: Map<string, Uint8Array | null>,
            _unavailable?: ReadonlySet<string>,
        ) => {});
        const encryption = {
            ...await createEncryptionHarness(() => [dataKey]),
            initializeMachines,
        };

        await fetchAndApplyMachines({
            credentials: { token, secret: encodeBase64(new Uint8Array(32).fill(17), 'base64') },
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([runner]),
            applyMachines: () => {},
            sourceServerId: 'home-1',
        });
        expect(initializeMachines.mock.calls[0]?.[0].get('runner-1')).toEqual(dataKey);

        await fetchAndApplyMachines({
            credentials: { token, secret: encodeBase64(new Uint8Array(32).fill(17), 'base64') },
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([{ ...runner, installationId: 'substituted' }]),
            applyMachines: () => {},
            sourceServerId: 'home-1',
        });
        expect(initializeMachines.mock.calls[1]?.[0]).toEqual(new Map());
        expect(initializeMachines.mock.calls[1]?.[1]).toEqual(new Set(['runner-1']));
    });

    it('keeps a Runner locked on a device without creator activation custody and without a creator-sealed verifier fact', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const signing = tweetnacl.sign.keyPair();
        const dataKey = new Uint8Array(32).fill(19);
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-1' })), 'base64url')}.signature`;
        const binding = signRunnerMachineContentKeyBindingV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-runner.machine-content-key',
                homeServerIdentityId: 'home-1',
                activationId: '11111111-1111-4111-8111-111111111111',
                creatorAccountId: 'account-1',
                machineId: 'runner-1',
                installationId: 'installation-1',
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
            },
            activationSigningSecretKey: signing.secretKey,
        });
        const initializeMachines = vi.fn(async (
            _keys: Map<string, Uint8Array | null>,
            _unavailable?: ReadonlySet<string>,
        ) => {});
        const encryption = {
            ...await createEncryptionHarness(() => [dataKey]),
            initializeMachines,
        };

        await fetchAndApplyMachines({
            credentials: {
                token,
                encryption: {
                    publicKey: encodeBase64(new Uint8Array(32).fill(1), 'base64'),
                    machineKey: encodeBase64(new Uint8Array(32).fill(2), 'base64'),
                },
            },
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([{
                ...machineRow('runner-1', 'runner-envelope'),
                kind: 'ephemeral_session_runner',
                installationId: 'installation-1',
                runnerContentKeyBinding: binding,
            }]),
            applyMachines: () => {},
            sourceServerId: 'home-1',
        });

        expect(initializeMachines.mock.calls[0]?.[0]).toEqual(new Map());
        expect(initializeMachines.mock.calls[0]?.[1]).toEqual(new Set(['runner-1']));
    });

    it('rejects a Home-published plain marker for an E2EE Machine even when Runner kind is omitted', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const initializeMachines = vi.fn(async (
            _keys: Map<string, Uint8Array | null>,
            _unavailable?: ReadonlySet<string>,
        ) => {});
        const encryption = {
            ...await createEncryptionHarness(() => []),
            initializeMachines,
        };
        const applied: import('@/sync/domains/state/storageTypes').Machine[][] = [];
        const substituted = {
            ...machineRow('machine-1', MACHINE_PLAIN_DATA_KEY_MARKER),
            metadata: encodePlainMachineStoredContent({
                host: 'home-readable-substitution',
                platform: 'linux',
                homeDir: '/tmp',
                happyCliVersion: 'test',
                happyHomeDir: '/tmp/.happier',
            }),
        };

        await fetchAndApplyMachines({
            credentials: {
                token: legacyCredentials.token,
                encryption: {
                    publicKey: encodeBase64(new Uint8Array(32).fill(1), 'base64'),
                    machineKey: encodeBase64(new Uint8Array(32).fill(2), 'base64'),
                },
            },
            encryption,
            machineDataKeys: new Map(),
            sourceServerId: 'home-1',
            expectedAccountMode: 'e2ee',
            request: async () => jsonResponse([substituted]),
            applyMachines: (machines) => { applied.push(machines); },
        });

        expect(initializeMachines.mock.calls[0]?.[0]).toEqual(new Map());
        expect(initializeMachines.mock.calls[0]?.[1]).toEqual(new Set(['machine-1']));
        expect(applied.at(-1)?.[0]).toMatchObject({
            metadata: null,
            storageMode: 'e2ee',
            availability: { kind: 'locked' },
        });
    });

    it('opens every machine envelope in one batch instead of one call per machine', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
            machineRow('m3', null),
            machineRow('m4', 'env-4'),
        ]));
        const encryption = await createEncryptionHarness((values) => values.map((_, index) => new Uint8Array([index + 1])));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        // One batched open for all envelope-bearing machines. Per-machine calls put a
        // single ~505-byte payload under the native worker routing threshold on every
        // machine, forcing curve25519 onto the JS thread N times.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(encryption.decryptEncryptionKeys.mock.calls[0]![0]).toEqual(['env-1', 'env-2', 'env-4']);
        expect([...machineDataKeys.keys()].sort()).toEqual(['m1', 'm2', 'm4']);
        expect(machineDataKeys.get('m2')).toEqual({ envelope: 'env-2', dataKey: new Uint8Array([2]) });
    });

    it('does not re-open an envelope whose unwrapped key is already cached', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
        ]));
        const encryption = await createEncryptionHarness((values) =>
            values.map((value) => new Uint8Array([value === 'env-1' ? 1 : 2])));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const initializedKeys: Array<Map<string, Uint8Array | null>> = [];
        encryption.initializeMachines.mockImplementation(async (machineKeys) => {
            initializedKeys.push(new Map(machineKeys));
        });

        const call = async () => fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        await call();
        await call();

        // The second refresh sees the same wrapped envelopes it already unwrapped, so it
        // must not run a single asymmetric open — machine refreshes fire on every screen
        // focus and every foreground.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(initializedKeys[1]?.get('m1')).toEqual(new Uint8Array([1]));
        expect(initializedKeys[1]?.get('m2')).toEqual(new Uint8Array([2]));
    });

    it('re-opens only the machine whose envelope rotated', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        let rotated = false;
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', rotated ? 'env-2-rotated' : 'env-2'),
        ]));
        const keyByEnvelope: Record<string, Uint8Array> = {
            'env-1': new Uint8Array([1]),
            'env-2': new Uint8Array([2]),
            'env-2-rotated': new Uint8Array([22]),
        };
        const encryption = await createEncryptionHarness((values) => values.map((value) => keyByEnvelope[value] ?? null));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const initializedKeys: Array<Map<string, Uint8Array | null>> = [];
        encryption.initializeMachines.mockImplementation(async (machineKeys) => {
            initializedKeys.push(new Map(machineKeys));
        });

        const call = async () => fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        await call();
        rotated = true;
        await call();

        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(2);
        expect(encryption.decryptEncryptionKeys.mock.calls[1]![0]).toEqual(['env-2-rotated']);
        expect(initializedKeys[1]?.get('m1')).toEqual(new Uint8Array([1]));
        expect(initializedKeys[1]?.get('m2')).toEqual(new Uint8Array([22]));
        expect(machineDataKeys.get('m2')).toEqual({ envelope: 'env-2-rotated', dataKey: new Uint8Array([22]) });
    });


});


describe('fetchAndApplyMachines real selected-envelope hydration', () => {
    it('does not let an older snapshot retire an already committed current cipher', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const currentKey = new Uint8Array(32).fill(30);
        const currentEnvelope = encodeBase64(await encryption.encryptEncryptionKey(currentKey), 'base64');
        const oldEnvelope = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(29)), 'base64');
        encryption.captureMachineEncryptionContext('machine-1', { dataEncryptionKey: currentEnvelope, expectedDataEncryptionKey: currentEnvelope });
        await encryption.initializeMachines(new Map([['machine-1', currentKey]]));
        const currentCipher = encryption.getMachineEncryption('machine-1');
        const current = createMachineFixture({ id: 'machine-1', dataEncryptionKey: currentEnvelope, metadataVersion: 2 });
        const applied = vi.fn();
        const { fetchAndApplyMachines } = await import('./syncMachines');
        await fetchAndApplyMachines({ credentials: legacyCredentials, sourceServerId: 'home-1', encryption,
            machineDataKeys: new Map(), request: async () => jsonResponse([machineRow('machine-1', oldEnvelope)]),
            getExistingMachine: () => current, applyMachines: applied, replace: true });
        expect(encryption.getMachineEncryption('machine-1')).toBe(currentCipher);
        expect(applied).toHaveBeenCalledWith([], false);
    });
    it('does not let delayed hydration overwrite the current Machine context and snapshot', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { fetchAndApplyMachines } = await import('./syncMachines');
        const encryption = await Encryption.create(new Uint8Array(32).fill(11));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const metadata = createMachineFixture().metadata!;
        const rowFor = async (keyByte: number, name: string) => {
            const key = new Uint8Array(32).fill(keyByte);
            const cipher = await encryption.openEncryption(key);
            const envelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
            return { ...machineRow('scoped', envelope), metadata: encodeBase64((await cipher.encrypt([{ ...metadata, displayName: name }]))[0]!, 'base64') };
        };
        const oldRow = await rowFor(29, 'Old');
        const newRow = await rowFor(30, 'Current');
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const platformCrypto = await import('rn-encryption');
        const originalDecrypt = platformCrypto.decryptAsyncAES;
        const spy = vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
            const plaintext = await originalDecrypt(...args);
            started.resolve();
            await release.promise;
            return plaintext;
        });
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        let applied: import('@/sync/domains/state/storageTypes').Machine[] = [];
        const hydrate = (row: RawMachine) => fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption, machineDataKeys,
            request: async () => jsonResponse([row]), applyMachines: (machines) => { if (machines.length) applied = machines; },
        });
        const pending = hydrate(oldRow);
        try {
            await started.promise;
            await hydrate(newRow);
            release.resolve();
            await pending;
            expect(applied[0]?.metadata?.displayName).toBe('Current');
            expect(machineDataKeys.get('scoped')?.envelope).toBe(newRow.dataEncryptionKey);
            expect(await encryption.getMachineEncryption('scoped')!.decryptMetadata(1, newRow.metadata)).toMatchObject({ displayName: 'Current' });
        } finally {
            release.resolve();
            spy.mockRestore();
            await pending;
        }
    });
    it('opens fresh scoped metadata, then locks and removes its cipher on a failed envelope replacement', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { fetchAndApplyMachines } = await import('./syncMachines');
        const encryption = await Encryption.create(new Uint8Array(32).fill(11));
        const scopedKey = new Uint8Array(32).fill(29);
        const metadata = {
            host: 'temporary-host', platform: 'linux', homeDir: '/tmp/runner',
            happyCliVersion: 'test', happyHomeDir: '/tmp/runner/.happier',
        };
        const scopedCipher = await encryption.openEncryption(scopedKey);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(scopedKey), 'base64');
        const scopedMetadata = encodeBase64((await scopedCipher.encrypt([metadata]))[0]!, 'base64');
        const row = { ...machineRow('scoped', envelope), metadata: scopedMetadata };
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const applied: import('@/sync/domains/state/storageTypes').Machine[][] = [];
        const fetchRow = async () => fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption, machineDataKeys,
            request: async () => jsonResponse([row]),
            applyMachines: (machines) => { applied.push(machines); },
        });
        await fetchRow();
        expect(applied.at(-1)?.[0]).toMatchObject({ metadata, availability: { kind: 'available' } });

        // Authenticated Account-fallback content must not be disclosed once the
        // selected present envelope cannot be opened, even after prior hydration.
        row.dataEncryptionKey = 'not-an-envelope';
        row.metadata = await encryption.encryptRaw({ ...metadata, host: 'fallback-host' });
        row.metadataVersion = 2;
        await fetchRow();
        expect(applied.at(-1)?.[0]).toMatchObject({ metadata: null, availability: { kind: 'locked' } });
        expect(encryption.getMachineEncryption('scoped')).toBeNull();
        expect(machineDataKeys.has('scoped')).toBe(false);

        // An exact later successful retry restores the real scoped cipher.
        row.dataEncryptionKey = envelope;
        row.metadata = scopedMetadata;
        row.metadataVersion = 1;
        await fetchRow();
        expect(applied.at(-1)?.[0]).toMatchObject({ metadata, availability: { kind: 'available' } });
    });
});
