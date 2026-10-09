import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetScopedMachineTransportCacheForTests,
    resolveScopedMachineTransport,
} from './serverScopedRpcPool';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { Encryption } from '@/sync/encryption/encryption';
import { createDeferred } from '@/dev/testkit';
import {
    computeRunnerMachineContentKeyFingerprintV1,
    encodeBase64,
    signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';

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
    it('does not let a short cold read decide a later caller with a longer budget', async () => {
        let releaseShortRead!: () => void;
        const shortReadPending = new Promise<void>((resolve) => { releaseShortRead = resolve; });
        let machineReads = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (!url.includes('/v1/machines/')) {
                return Response.json({});
            }
            machineReads += 1;
            if (machineReads === 1) {
                await shortReadPending;
                return new Response(null, { status: 500 });
            }
            return Response.json({
                machine: { id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
            });
        }));
        const input = {
            serverId: 'server-b', serverUrl: 'https://server-b.example.test',
            token: 'token-b', machineId: 'machine-plain', expectedAccountMode: 'plain' as const,
        };
        const short = resolveScopedMachineTransport({ ...input, timeoutMs: 1_000 });
        await vi.waitFor(() => expect(machineReads).toBe(1));
        const long = resolveScopedMachineTransport({ ...input, timeoutMs: 5_000 });
        releaseShortRead();
        await expect(short).resolves.toBeNull();
        await expect(long).resolves.toMatchObject({ mode: 'plain' });
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
        delete process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX;
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

    it('refreshes each Machine row while reusing its unchanged opened key', async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
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

        const decryptSpy = vi.fn(async () => new Uint8Array([1, 2, 3]));

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

        expect(first).toMatchObject({ mode: 'e2ee', dataKey: new Uint8Array([1, 2, 3]) });
        expect(second).toMatchObject({ mode: 'e2ee', dataKey: new Uint8Array([1, 2, 3]) });
        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(2);
        expect(decryptSpy).toHaveBeenCalledTimes(1);
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
                return { ok: true, status: 200, json: async () => ({}) };
            }
            if (String(_url).includes('/v1/machines')) {
                expect(init && 'signal' in init).toBe(true);
            }
            return {
                ok: false,
                status: 503,
                json: async () => [],
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async () => new Uint8Array([1]));

        const result = await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
            timeoutMs: 1_000,
        });

        expect(result).toBeNull();
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

    it('evicts oldest machine keys when cache exceeds EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX = '1';

        const fetchSpy = vi.fn(async (url: string) => {
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => {
                    const machineId = url.split('/').at(-1);
                    return {
                        machine: {
                            id: machineId,
                            dataEncryptionKey: machineId === 'machine-1'
                                ? 'encrypted-key-1'
                                : 'encrypted-key-2',
                        },
                    };
                },
            };
        });
        vi.stubGlobal('fetch', fetchSpy);

        const decryptSpy = vi.fn(async (value: string) => {
            if (value === 'encrypted-key-1') return new Uint8Array([1]);
            if (value === 'encrypted-key-2') return new Uint8Array([2]);
            return new Uint8Array([0]);
        });

        await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-2',
            decryptEncryptionKey: decryptSpy,
        });

        // machine-1 entry should have been evicted (max=1), causing a refetch.
        await resolveScopedMachineTransport({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            machineId: 'machine-1',
            decryptEncryptionKey: decryptSpy,
        });

        expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/machines')).length).toBe(3);
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
        })).resolves.toBeNull();

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
