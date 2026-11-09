import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetScopedMachineTransportCacheForTests,
    resolveScopedMachineTransport,
} from './serverScopedRpcPool';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import tweetnacl from 'tweetnacl';
import { Encryption } from '@/sync/encryption/encryption';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { createDeferred } from '@/dev/testkit';
import {
    computeRunnerMachineContentKeyFingerprintV1,
    signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';
import {
    encodeBase64} from '@happier-dev/protocol/crypto/base64';

function readAuthorizationHeader(headers: RequestInit['headers']): string {
    if (!headers) return '';
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get('Authorization') ?? '';
    }
    if (Array.isArray(headers)) {
        const entry = headers.find(([name]) => String(name).toLowerCase() === 'authorization');
        return entry ? String(entry[1] ?? '') : '';
    }
    const record = headers as Record<string, string>;
    return String(record.Authorization ?? record.authorization ?? '');
}

describe('resolveScopedMachineTransport', () => {
    it('opens each distinct Machine key once for 821 concurrent demanded transports and admits a rotated key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(71));
        const worker = createFakeCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let opens = 0;
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                opens += request.items.length;
                entered.resolve();
                await release.promise;
                return worker.decryptDataKeyEnvelopeV1(request);
            },
        }, routing: { mode: 'require', minPayloadBytes: 0 } });
        const keys = [72, 73, 74].map(value => new Uint8Array(32).fill(value));
        const envelopes = await Promise.all(keys.map(async key => encodeBase64(await encryption.encryptEncryptionKey(key))));
        let reads = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (!new URL(url).pathname.startsWith('/v1/machines/')) return Response.json({});
            reads += 1;
            const id = new URL(url).pathname.split('/').at(-1)!;
            return Response.json({ machine: { id, dataEncryptionKey: envelopes[Number(id.at(-1))],
                metadataVersion: 1, daemonStateVersion: 1 } });
        }));
        const controllers = Array.from({ length: 821 }, () => new AbortController());
        let logicalOpens = 0;
        const read = (index: number) => resolveScopedMachineTransport({
            serverId: 'dek-count-home', serverUrl: 'https://dek-count.example.test', token: 'dek-count-token',
            machineId: `dek-machine-${index % keys.length}`, encryption, expectedAccountMode: 'e2ee',
            signal: controllers[index]!.signal,
            decryptEncryptionKey: value => {
                logicalOpens += 1;
                return encryption.decryptEncryptionKey(value, { signal: controllers[index]!.signal, workClass: 'interactive' });
            },
        });
        const pending = controllers.map((_, index) => read(index));
        try {
            await entered.promise;
            await vi.waitFor(() => expect(logicalOpens).toBe(821));
            release.resolve();
            const results = await Promise.all(pending);
            expect(results.every((result, index) => result?.mode === 'e2ee'
                && result.dataKey?.every((byte, position) => byte === keys[index % keys.length]![position]))).toBe(true);
            expect(reads).toBe(3);
            expect(opens).toBe(3);
            // Later independent demand retains fresh row admission without reopening unchanged material.
            expect((await read(0))?.mode).toBe('e2ee');
            expect(reads).toBe(4);
            expect(opens).toBe(3);
            const rotatedKey = new Uint8Array(32).fill(75);
            envelopes[0] = encodeBase64(await encryption.encryptEncryptionKey(rotatedKey));
            const rotated = await read(0);
            expect(rotated?.mode === 'e2ee' && rotated.dataKey?.every((byte, index) => byte === rotatedKey[index])).toBe(true);
            expect(opens).toBe(4);
            // The existing generation boundary must discard completed pure work as well.
            encryption.configureNativeCryptoWorker({ scope: { accountId: 'local', serverId: null, generation: 1 } });
            expect((await read(0))?.mode).toBe('e2ee');
            expect(opens).toBe(5);
        } finally {
            release.resolve();
            controllers.forEach(controller => controller.abort());
            await Promise.allSettled(pending);
            encryption.retireAccountMaterial();
        }
    });
    it('keeps unchanged Machine evidence current when unrelated Machines are read', async () => {
        let originalKey: string = MACHINE_PLAIN_DATA_KEY_MARKER;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ machine: {
            id: decodeURIComponent(new URL(url).pathname.split('/').at(-1)!),
            dataEncryptionKey: url.endsWith('/original') ? originalKey : MACHINE_PLAIN_DATA_KEY_MARKER,
        } })));
        const scope = { serverId: 'many-machines', serverUrl: 'https://many-machines.example.test',
            token: 'many-machines-token', expectedAccountMode: 'plain' as const };
        const original = await resolveScopedMachineTransport({ ...scope, machineId: 'original' });
        expect(original?.context?.isCurrent()).toBe(true);
        // Inventory size is not a revocation or key-change witness.
        for (let index = 0; index < 256; index += 1) {
            await resolveScopedMachineTransport({ ...scope, machineId: `other-${index}`, token: `other-token-${index}` });
        }
        expect(original?.context?.isCurrent()).toBe(true);
        // The original credential must still address the same evidence owner
        // after unrelated credentials have been seen. A real key change retires it.
        originalKey = 'changed-published-key';
        await resolveScopedMachineTransport({ ...scope, machineId: 'original' });
        expect(original?.context?.isCurrent()).toBe(false);
    });

    it('keeps concurrent openings of the same authenticated Machine key available across scoped crypto instances', async () => {
        const first = await Encryption.create(new Uint8Array(32).fill(17));
        const second = await Encryption.create(new Uint8Array(32).fill(17));
        const dataKey = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await first.encryptEncryptionKey(dataKey), 'base64');
        const opening = createDeferred<void>();
        const release = createDeferred<void>();
        let metadataVersion = 1;
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ machine: {
            id: 'same-key-machine', dataEncryptionKey: envelope, metadataVersion,
        } })));
        const scope = { serverId: 'same-key-home', serverUrl: 'https://same-key.example.test',
            token: 'same-key-token', machineId: 'same-key-machine' };
        const pending = resolveScopedMachineTransport({ ...scope, encryption: first,
            // Hold the device crypto boundary after the authenticated row arrives.
            decryptEncryptionKey: async (value) => {
                const key = await first.decryptEncryptionKey(value);
                opening.resolve(); await release.promise; return key;
            },
        });
        try {
            await opening.promise;
            metadataVersion = 2;
            // Separate callers reach row setup with independently reduced budgets.
            const next = await resolveScopedMachineTransport({ ...scope, encryption: second, timeoutMs: 29_999,
                decryptEncryptionKey: second.decryptEncryptionKey.bind(second) });
            expect(next).toMatchObject({ mode: 'e2ee', dataKey });
            release.resolve();
            const original = await pending;
            expect(original).toMatchObject({ mode: 'e2ee', dataKey });
            expect(original?.context?.isCurrent()).toBe(true);
            expect(next?.context?.isCurrent()).toBe(true);
            metadataVersion = 1;
            expect(await resolveScopedMachineTransport({ ...scope, encryption: second,
                decryptEncryptionKey: second.decryptEncryptionKey.bind(second) })).toBeNull();
        } finally { release.resolve(); await pending; }
    });
    it('preserves a Machine-row transport failure instead of reporting missing encryption', async () => {
        const failure = new TypeError('Failed to fetch');
        const homeCarrier = {
            endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async () => { throw failure; },
            createWebSocket: () => { throw new Error('No socket needed'); },
        };
        await expect(resolveScopedMachineTransport({
            serverId: 'home-fetch-failure', serverUrl: 'https://home-fetch-failure.example.test',
            token: 'token', machineId: 'machine', homeCarrier,
        })).rejects.toBe(failure);
    });

    it('reports the expired Machine-row request budget as a transport timeout', async () => {
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const homeCarrier = {
            endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async (_url: string, init: RequestInit) => {
                entered.resolve();
                await new Promise<void>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
                return Response.json({});
            },
            createWebSocket: () => { throw new Error('No socket needed'); },
        };
        try {
            const outcome = resolveScopedMachineTransport({
                serverId: 'home-row-timeout', serverUrl: 'https://home-row-timeout.example.test',
                token: 'token', machineId: 'machine', homeCarrier, timeoutMs: 100,
            }).then(value => ({ value }), error => ({ error: error as unknown }));
            await entered.promise;
            await vi.advanceTimersByTimeAsync(100);
            expect(await outcome).toMatchObject({ error: { rpcErrorCode: 'MACHINE_RPC_TIMEOUT' } });
        } finally { vi.useRealTimers(); }
    });

    it('keeps a Home HTTP failure distinct from a missing Machine row', async () => {
        let status = 503;
        const homeCarrier = {
            endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async () => Response.json({}, { status }),
            createWebSocket: () => { throw new Error('No socket needed'); },
        };
        const input = { serverId: 'home-http-failure', serverUrl: 'https://home-http-failure.example.test',
            token: 'token', machineId: 'machine', homeCarrier };
        await expect(resolveScopedMachineTransport(input)).rejects.toMatchObject({ status: 503, kind: 'server' });
        status = 404;
        await expect(resolveScopedMachineTransport(input)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    });
    it('preserves the opaque selected-Machine access refusal without attempting a key opening', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(19));
        await encryption.initializeMachines(new Map([['foreign-machine', null]]));
        expect(encryption.getMachineEncryption('foreign-machine')).not.toBeNull();
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array(32));
        await expect(resolveScopedMachineTransport({
            serverId: 'refused-home', serverUrl: 'https://refused.example.test', token: 'requester-token', machineId: 'foreign-machine',
            encryption, decryptEncryptionKey,
            readTransport: { key: 'refused-home-read', read: async (_path, init, _options, consume) =>
                consume(createMachineReadBatchResponseFixture(init?.body, () => null)) },
        })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expect(encryption.getMachineEncryption('foreign-machine')).toBeNull();
    });
    it('shares a pending authenticated row across independently constructed RPC deadlines and refreshes after settlement', async () => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let machineReads = 0;
        let withdrawn = false;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (!url.includes('/v1/machines/')) return Response.json({});
            machineReads++;
            if (withdrawn) return new Response(null, { status: 403 });
            entered.resolve();
            await release.promise;
            return Response.json({ machine: { id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }));
        const scope = { serverId: 'home-budget', serverUrl: 'https://home-budget.example.test', token: 'budget-token',
            machineId: 'machine-plain', expectedAccountMode: 'plain' as const };
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            const first = resolveScopedMachineTransport({ ...scope, timeoutMs: 5_000 });
            await entered.promise;
            // Each RPC constructs its own deadline before asynchronous context/trust
            // setup. Calls started 1/2/3 ms later reach this owner 100 ms later.
            clock.mockReturnValue(now + 100);
            const joined = [4_901, 4_902, 4_903].map(timeoutMs => resolveScopedMachineTransport({ ...scope, timeoutMs }));
            await Promise.resolve();
            release.resolve();
            for (const result of await Promise.all([first, ...joined])) expect(result).toMatchObject({ mode: 'plain' });
            expect(machineReads).toBe(1);
            withdrawn = true;
            await expect(resolveScopedMachineTransport({ ...scope, timeoutMs: 4_996 })).rejects.toMatchObject({ status: 403 });
            expect(machineReads).toBe(2);
        } finally { release.resolve(); clock.mockRestore(); }
    });

    it('lets a shorter-budget joiner time out without aborting the shared row read', async () => {
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let machineReads = 0;
        const homeCarrier = {
            endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async (_url: string, init: RequestInit) => {
                machineReads++;
                entered.resolve();
                await new Promise<void>((resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    void release.promise.then(resolve);
                });
                return Response.json({ machine: { id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            },
            createWebSocket: () => { throw new Error('No socket needed'); },
        };
        const scope = { serverId: 'home-budget-timeout', serverUrl: 'https://home-budget-timeout.example.test', token: 'budget-token',
            machineId: 'machine-plain', expectedAccountMode: 'plain' as const, homeCarrier };
        try {
            const first = resolveScopedMachineTransport({ ...scope, timeoutMs: 5_000 });
            await entered.promise;
            const joined = resolveScopedMachineTransport({ ...scope, timeoutMs: 100 })
                .then(value => ({ value }), error => ({ error: error as unknown }));
            await vi.advanceTimersByTimeAsync(100);
            expect(await joined).toMatchObject({ error: { rpcErrorCode: 'MACHINE_RPC_TIMEOUT' } });
            release.resolve();
            expect(await first).toMatchObject({ mode: 'plain' });
            expect(machineReads).toBe(1);
        } finally { release.resolve(); vi.useRealTimers(); }
    });

    it('keeps a joined caller newer canonical selection when another owner holds the HTTP read', async () => {
        const first = await Encryption.create(new Uint8Array(32).fill(17));
        const joined = await Encryption.create(new Uint8Array(32).fill(17));
        const oldEnvelope = encodeBase64(await first.encryptEncryptionKey(new Uint8Array(32).fill(23)), 'base64');
        const nextEnvelope = encodeBase64(await first.encryptEncryptionKey(new Uint8Array(32).fill(24)), 'base64');
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        vi.stubGlobal('fetch', vi.fn(async () => {
            entered.resolve(); await release.promise;
            return Response.json({ machine: { id: 'machine-1', dataEncryptionKey: oldEnvelope } });
        }));
        const scope = { serverId: 'home-1', serverUrl: 'https://home-1.example.test', token: 'token-1', machineId: 'machine-1' };
        const firstRead = resolveScopedMachineTransport({ ...scope, encryption: first, decryptEncryptionKey: first.decryptEncryptionKey.bind(first) });
        await entered.promise;
        const joinedRead = resolveScopedMachineTransport({ ...scope, encryption: joined, decryptEncryptionKey: joined.decryptEncryptionKey.bind(joined) });
        joined.captureMachineEncryptionContext('machine-1', { dataEncryptionKey: nextEnvelope, expectedDataEncryptionKey: nextEnvelope });
        await joined.initializeMachines(new Map([['machine-1', new Uint8Array(32).fill(24)]]));
        const cipher = joined.getMachineEncryption('machine-1');
        release.resolve();
        expect(await firstRead).toMatchObject({ mode: 'e2ee' });
        expect(await joinedRead).toBeNull();
        expect(joined.getMachineEncryption('machine-1')).toBe(cipher);
    });
    it('does not let a held old HTTP row retire a newer canonical context', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const oldKey = new Uint8Array(32).fill(23);
        const nextKey = new Uint8Array(32).fill(24);
        const oldEnvelope = encodeBase64(await encryption.encryptEncryptionKey(oldKey), 'base64');
        const nextEnvelope = encodeBase64(await encryption.encryptEncryptionKey(nextKey), 'base64');
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        vi.stubGlobal('fetch', vi.fn(async () => {
            entered.resolve(); await release.promise;
            return Response.json({ machine: { id: 'machine-1', dataEncryptionKey: oldEnvelope } });
        }));
        const pending = resolveScopedMachineTransport({
            serverId: 'home-1', serverUrl: 'https://home-1.example.test', token: 'token-1',
            machineId: 'machine-1', encryption,
            decryptEncryptionKey: encryption.decryptEncryptionKey.bind(encryption),
        });
        await entered.promise;
        encryption.captureMachineEncryptionContext('machine-1', { dataEncryptionKey: nextEnvelope, expectedDataEncryptionKey: nextEnvelope });
        await encryption.initializeMachines(new Map([['machine-1', nextKey]]));
        const currentCipher = encryption.getMachineEncryption('machine-1');
        release.resolve();
        expect(await pending).toBeNull();
        expect(encryption.getMachineDataEncryptionKey('machine-1')).toBe(nextEnvelope);
        expect(encryption.getMachineEncryption('machine-1')).toBe(currentCipher);
    });
    it('does not publish a pending old open after same-key access facts are withdrawn', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(23)), 'base64');
        const opened = createDeferred<void>();
        const release = createDeferred<void>();
        let accessState: 'ready' | 'key_pending' = 'ready';
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ machine: {
            id: 'machine-1', dataEncryptionKey: envelope,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'e2ee', accessState },
        } })));
        const scope = { serverId: 'home-1', serverUrl: 'https://home-1.example.test', token: 'token-1', machineId: 'machine-1', accountId: 'viewer', encryption };
        const pending = resolveScopedMachineTransport({ ...scope, timeoutMs: 1_000,
            decryptEncryptionKey: async (value) => {
                const key = await encryption.decryptEncryptionKey(value);
                opened.resolve(); await release.promise; return key;
            },
        });
        await opened.promise;
        accessState = 'key_pending';
        expect(await resolveScopedMachineTransport({ ...scope, timeoutMs: 5_000,
            decryptEncryptionKey: encryption.decryptEncryptionKey.bind(encryption),
        })).toBeNull();
        release.resolve();
        expect(await pending).toBeNull();
        expect(encryption.getMachineEncryption('machine-1')).toBeNull();
    });
    it('refuses a Home-reported plain row for an own-Account Machine while this device holds active E2EE custody', async () => {
        const access = (accountId: string) => ({ custodian: { accountId, displayName: '' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' });
        let custodian = 'viewer';
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ machine: {
            id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, access: access(custodian),
        } })));
        const scope = { serverId: 'secondary-home', serverUrl: 'https://secondary-home.example.test', token: 'token-1',
            machineId: 'machine-1', accountId: 'viewer' };
        // Downgrade pin (admitMachineRowPlainMode): own-Account row + active custody never resolves plain.
        expect(await resolveScopedMachineTransport({ ...scope, accountE2eeCustody: 'active' })).toBeNull();
        // Owner-positive controls: a plain Account and another custodian's plain Machine stay reachable.
        expect(await resolveScopedMachineTransport({ ...scope, accountE2eeCustody: 'absent' })).toMatchObject({ mode: 'plain' });
        custodian = 'other-account';
        expect(await resolveScopedMachineTransport({ ...scope, accountE2eeCustody: 'active' })).toMatchObject({ mode: 'plain' });
    });
    it('refreshes a scoped row across distinct crypto instances and retires its old request context', async () => {
        const firstEncryption = await Encryption.create(new Uint8Array(32).fill(17));
        const nextEncryption = await Encryption.create(new Uint8Array(32).fill(17));
        const oldKey = new Uint8Array(32).fill(23);
        const nextKey = new Uint8Array(32).fill(24);
        const oldEnvelope = encodeBase64(await firstEncryption.encryptEncryptionKey(oldKey), 'base64');
        const nextEnvelope = encodeBase64(await firstEncryption.encryptEncryptionKey(nextKey), 'base64');
        let envelope = oldEnvelope;
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ machine: { id: 'machine-1', dataEncryptionKey: envelope } })));
        const scope = { serverId: 'home-1', serverUrl: 'https://home-1.example.test', token: 'token-1', machineId: 'machine-1' };
        const old = await resolveScopedMachineTransport({ ...scope, encryption: firstEncryption,
            decryptEncryptionKey: firstEncryption.decryptEncryptionKey.bind(firstEncryption) });
        expect(old?.context?.isCurrent()).toBe(true);
        envelope = nextEnvelope;
        const next = await resolveScopedMachineTransport({ ...scope, encryption: nextEncryption,
            decryptEncryptionKey: nextEncryption.decryptEncryptionKey.bind(nextEncryption) });
        expect(next).toMatchObject({ mode: 'e2ee', dataKey: nextKey });
        expect(old?.context?.isCurrent()).toBe(false);
        expect(next?.context?.isCurrent()).toBe(true);
    });
    it('rejects an old in-flight envelope opening after the canonical Machine context changes', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const oldKey = new Uint8Array(32).fill(23);
        const newKey = new Uint8Array(32).fill(24);
        const oldEnvelope = encodeBase64(await encryption.encryptEncryptionKey(oldKey), 'base64');
        const newEnvelope = encodeBase64(await encryption.encryptEncryptionKey(newKey), 'base64');
        const opened = createDeferred<void>();
        const release = createDeferred<void>();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            machine: { id: 'machine-1', dataEncryptionKey: oldEnvelope },
        })));
        const pending = resolveScopedMachineTransport({
            serverId: 'home-1', serverUrl: 'https://home-1.example.test', token: 'token-1',
            machineId: 'machine-1', encryption,
            decryptEncryptionKey: async (value) => {
                const key = await encryption.decryptEncryptionKey(value);
                opened.resolve();
                await release.promise;
                return key;
            },
        });
        await opened.promise;
        encryption.captureMachineEncryptionContext('machine-1', { dataEncryptionKey: newEnvelope, expectedDataEncryptionKey: newEnvelope });
        await encryption.initializeMachines(new Map([['machine-1', newKey]]));
        release.resolve();
        expect(await pending).toBeNull();
        expect(encryption.getMachineDataEncryptionKey('machine-1')).toBe(newEnvelope);
        expect(await encryption.getMachineEncryption('machine-1')!.decryptRaw(
            await encryption.getMachineEncryption('machine-1')!.encryptRaw({ current: true }),
        )).toEqual({ current: true });
    });
    it.each([
        { firstBudget: 1_000, nextBudget: 5_000, elapsed: 0 },
        { firstBudget: 5_000, nextBudget: 2_000, elapsed: 4_000 },
    ])('does not let a read with less remaining time decide a later caller ($firstBudget/$nextBudget/$elapsed)', async ({ firstBudget, nextBudget, elapsed }) => {
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        let machineReads = 0;
        const homeCarrier = {
            endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async (_url: string, init: RequestInit) => {
                machineReads++;
                if (machineReads === 1) {
                    entered.resolve();
                    await new Promise<void>((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    });
                }
                return Response.json({ machine: { id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            },
            createWebSocket: () => { throw new Error('No socket needed'); },
        };
        const input = {
            serverId: 'server-b', serverUrl: 'https://server-b.example.test',
            token: 'token-b', machineId: 'machine-plain', expectedAccountMode: 'plain' as const,
            homeCarrier,
        };
        try {
            const short = resolveScopedMachineTransport({ ...input, timeoutMs: firstBudget })
                .then(value => ({ value }), error => ({ error: error as unknown }));
            await entered.promise;
            await vi.advanceTimersByTimeAsync(elapsed);
            const long = resolveScopedMachineTransport({ ...input, timeoutMs: nextBudget });
            await vi.advanceTimersByTimeAsync(firstBudget - elapsed);
            expect(await short).toMatchObject({ error: { rpcErrorCode: 'MACHINE_RPC_TIMEOUT' } });
            await expect(long).resolves.toMatchObject({ mode: 'plain' });
            expect(machineReads).toBe(2);
        } finally { vi.useRealTimers(); }
    });

    it('does not reuse a cached Plain decision for an E2EE caller', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            machine: { id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
        })));
        const input = {
            serverId: 'server-b', serverUrl: 'https://server-b.example.test', token: 'token-b', machineId: 'machine-plain',
        };
        await expect(resolveScopedMachineTransport({ ...input, expectedAccountMode: 'plain' }))
            .resolves.toMatchObject({ mode: 'plain' });
        await expect(resolveScopedMachineTransport({ ...input, expectedAccountMode: 'e2ee' }))
            .resolves.toBeNull();
    });

    it.each(['cached', 'in-flight'] as const)('rechecks current Runner trust for a %s Machine key', async (state) => {
        let release!: () => void;
        const opened = new Promise<void>((resolve) => { release = resolve; });
        const dataKey = new Uint8Array(32).fill(23);
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            machine: { id: 'runner-1', kind: 'persistent', dataEncryptionKey: 'envelope' },
        })));
        const input = {
            serverId: 'server-b', serverUrl: 'https://server-b.example.test', token: 'token-b', machineId: 'runner-1',
            decryptEncryptionKey: async () => { await opened; return dataKey; },
        };
        const first = resolveScopedMachineTransport(input);
        if (state === 'cached') {
            release();
            await expect(first).resolves.toMatchObject({ mode: 'e2ee', dataKey });
        }
        const trusted = resolveScopedMachineTransport({ ...input, trustedMachineKind: 'ephemeral_session_runner' });
        release();
        await expect(first).resolves.toMatchObject({ mode: 'e2ee', dataKey });
        await expect(trusted).resolves.toBeNull();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        resetScopedMachineTransportCacheForTests();
        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }
    });

    it('rejects a Runner transport whose creator proof does not match the exact installation', async () => {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
        const dataKey = new Uint8Array(32).fill(23);
        const binding = signRunnerMachineContentKeyBindingV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-runner.machine-content-key',
                homeServerIdentityId: 'server-b',
                activationId: '11111111-1111-4111-8111-111111111111',
                creatorAccountId: 'account-b',
                machineId: 'runner-1',
                installationId: 'installation-1',
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
            },
            activationSigningSecretKey: signing.secretKey,
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    machine: {
                        id: 'runner-1', kind: 'ephemeral_session_runner',
                        installationId: 'substituted-installation', dataEncryptionKey: 'runner-envelope',
                        runnerContentKeyBinding: binding,
                    },
                }),
            };
        }));

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b', serverUrl: 'https://server-b.example.test',
            token: 'token-b', accountId: 'account-b', machineId: 'runner-1',
            decryptEncryptionKey: async () => dataKey,
            expectedRunnerBinding: {
                homeServerIdentityId: 'server-b',
                creatorAccountId: 'account-b',
                machineId: 'runner-1',
                accountSigningPublicKeyBase64Url: encodeBase64(signing.publicKey, 'base64url'),
            },
        })).resolves.toBeNull();
    });

    it('rejects a Home-published plaintext Runner marker for an E2EE Account', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    machine: {
                        id: 'runner-1',
                        kind: 'ephemeral_session_runner',
                        installationId: 'installation-1',
                        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                        runnerContentKeyBinding: null,
                    },
                }),
            };
        }));

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            accountId: 'account-b',
            machineId: 'runner-1',
            expectedAccountMode: 'e2ee',
        })).resolves.toBeNull();
    });

    it('resolves one exact machine without enumerating the account machine list', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (url.endsWith('/v1/machines/machine-exact')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        machine: {
                            id: 'machine-exact',
                            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                        },
                    }),
                };
            }
            throw new Error(`unexpected machine lookup: ${url}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-exact',
        })).resolves.toMatchObject({ mode: 'plain' });

        expect(fetchSpy.mock.calls.some(([url]) =>
            String(url).endsWith('/v1/machines/machine-exact'),
        )).toBe(true);
        expect(fetchSpy.mock.calls.some(([url]) =>
            String(url).endsWith('/v1/machines'),
        )).toBe(false);
    });

    it('uses the verified runtime origin for the machine lookup while retaining the canonical reachability identity', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (url === 'http://127.0.0.1:43111/v1/machines/machine-iroh') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        machine: {
                            id: 'machine-iroh',
                            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                        },
                    }),
                };
            }
            throw new Error(`unexpected machine lookup: ${url}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'http://127.0.0.1:3010',
            runtimeOrigin: 'http://127.0.0.1:43111',
            token: 'token-b',
            machineId: 'machine-iroh',
        })).resolves.toMatchObject({ mode: 'plain' });

        expect(fetchSpy).toHaveBeenCalledWith(
            'http://127.0.0.1:43111/v1/machines/machine-iroh',
            expect.anything(),
        );
        expect(fetchSpy.mock.calls.some(([url]) =>
            String(url) === 'http://127.0.0.1:3010/v1/machines/machine-iroh',
        )).toBe(false);
    });

    it('loads the exact Machine row through a selected semantic Home carrier', async () => {
        const canonicalUrl = 'https://ingressless.happier.invalid';
        const token = 'machine-scope-token';
        const carried: Array<{ url: string; init: RequestInit }> = [];
        const networkFetch = vi.fn(async () => {
            throw new Error('the canonical Home URL has no public ingress');
        });
        vi.stubGlobal('fetch', networkFetch);
        const homeCarrier = {
            endpointId: 'a'.repeat(64),
            readObservedPath: () => 'relay' as const,
            request: async (url: string, init: RequestInit) => {
                carried.push({ url, init });
                return Response.json({
                    machine: {
                        id: 'machine-exact',
                        kind: 'persistent',
                        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    },
                });
            },
            createWebSocket: () => {
                throw new Error('Machine key discovery must not open a socket');
            },
        };

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: canonicalUrl,
            runtimeOrigin: canonicalUrl,
            homeCarrier,
            token,
            machineId: 'machine-exact',
            expectedAccountMode: 'plain',
            timeoutMs: 100,
        })).resolves.toMatchObject({ mode: 'plain' });

        expect(networkFetch).not.toHaveBeenCalled();
        expect(carried).toHaveLength(1);
        expect(carried[0]?.url).toBe(`${canonicalUrl}/v1/machines/machine-exact`);
        expect(new Headers(carried[0]?.init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    });

    // Row-path contract: secondary Homes and unprojected Machines (absent, Runner). The bound
    // active Home reads no row (serverScopedMachineRpc.projection.composed.test.ts).
    it('refreshes each secondary-Home Machine row while reusing its unchanged opened key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const dataKey = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
        const worker = createFakeCryptoWorker();
        const openedEnvelopes: string[] = [];
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                openedEnvelopes.push(...request.items.map(item => item.envelopeBase64));
                return worker.decryptDataKeyEnvelopeV1(request);
            },
        }, routing: { mode: 'auto', minPayloadBytes: 0 } });
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    machine: { id: 'machine-1', dataEncryptionKey: envelope },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const first = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            encryption,
            decryptEncryptionKey: value => encryption.decryptEncryptionKey(value),
        });
        const second = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            encryption,
            decryptEncryptionKey: value => encryption.decryptEncryptionKey(value),
        });

        expect(first).toMatchObject({ mode: 'e2ee', dataKey });
        expect(second).toMatchObject({ mode: 'e2ee', dataKey });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(openedEnvelopes).toEqual([envelope]);
    });

    it('resolves and caches plaintext transport without requesting account key decryption', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    machine: {
                        id: 'machine-plain',
                        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchSpy);
        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        const first = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-plain',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-plain',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toMatchObject({ mode: 'plain' });
        expect(second).toMatchObject({ mode: 'plain' });
        expect(decryptSpy).not.toHaveBeenCalled();
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines'))).toHaveLength(2);
    });

    it('does not reuse cached machine key when auth token changes', async () => {
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
            if (String(_url).endsWith('/health') || String(_url).endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            // `runtimeFetchWithServerReachability` normalizes init.headers into a Headers
            // instance, so reading an own `Authorization` property finds nothing and this
            // case silently stops discriminating between tokens.
            const auth = readAuthorizationHeader(init?.headers);
            const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
            const dataEncryptionKey = token === 'Aa' ? 'encrypted-key-1' : token === 'BB' ? 'encrypted-key-2' : 'encrypted-key-unknown';
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    machine: { id: 'machine-1', dataEncryptionKey },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async (value: string) => {
            if (value === 'encrypted-key-1') return new Uint8Array([4, 5, 6]);
            if (value === 'encrypted-key-2') return new Uint8Array([7, 8, 9]);
            return new Uint8Array([0]);
        });

        // NOTE: these tokens intentionally collide under the legacy 31-based 32-bit hash:
        // "Aa" and "BB" yield the same hash, which would cause incorrect cache reuse.
        const first = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'Aa',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'BB',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(first).toMatchObject({ mode: 'e2ee', dataKey: new Uint8Array([4, 5, 6]) });
        expect(second).toMatchObject({ mode: 'e2ee', dataKey: new Uint8Array([7, 8, 9]) });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(decryptSpy).toHaveBeenCalledTimes(2);
    });

    it('passes an abort signal to fetch for timeout enforcement', async () => {
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
            if (String(_url).endsWith('/health') || String(_url).endsWith('/v1/auth/ping')) {
                return Response.json({});
            }
            if (String(_url).includes('/v1/machines')) {
                expect(init && 'signal' in init).toBe(true);
            }
            return Response.json([], { status: 503 });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        const result = resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 1_000,
        });

        await expect(result).rejects.toMatchObject({ status: 503, kind: 'server' });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(1);
    });

    it('retries machine key fetch when the first lookup returns no key', async () => {
        let machineCalls = 0;
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (!url.includes('/v1/machines')) {
                return { ok: false, status: 404, json: async () => ({}) };
            }
            machineCalls += 1;
            if (machineCalls === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        machine: { id: 'machine-1', dataEncryptionKey: null },
                    }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    machine: { id: 'machine-1', dataEncryptionKey: 'encrypted-key' },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([9, 9, 9]));

        const first = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });
        const second = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        // A released persistent Machine with no published envelope still uses
        // the Account-derived legacy key. The unresolved result is deliberately
        // not cached, so a later published envelope is fetched and opened.
        expect(first).toMatchObject({ mode: 'e2ee', dataKey: null });
        expect(second).toMatchObject({ mode: 'e2ee', dataKey: new Uint8Array([9, 9, 9]) });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(decryptSpy).toHaveBeenCalledTimes(1);
    });

    it('does not attempt the machine list request when reachability probes fail (offline)', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.endsWith('/v1/auth/ping')) {
                throw new TypeError('Network request failed');
            }
            if (href.includes('/v1/machines')) {
                throw new Error('unexpected machine list request');
            }
            throw new Error(`unexpected fetch url: ${href}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 50,
        })).rejects.toMatchObject({ rpcErrorCode: 'MACHINE_RPC_TIMEOUT' });

        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(0);
        expect(decryptSpy).not.toHaveBeenCalled();
    });

    it('throws terminal auth instead of returning null for scoped machine-key 403 responses', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            const href = String(url ?? '');
            if (href.endsWith('/health') || href.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (href.includes('/v1/machines')) {
                return { ok: false, status: 403, json: async () => ({}) };
            }
            throw new Error(`unexpected fetch url: ${href}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        await expect(resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 50,
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(decryptSpy).not.toHaveBeenCalled();
    });
});
