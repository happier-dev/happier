import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';

import {
    HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY,
    createFileHomeConnectionDescriptorContinuityStore,
    createHomeConnectionDescriptorContentKey,
    createSimpleCacheHomeConnectionDescriptorContinuityStore,
    createHomeConnectionDescriptorContinuityStoreForServer,
    readHomeConnectionDescriptorContinuity,
    writeHomeConnectionDescriptorContinuity,
} from './homeConnectionDescriptorContinuity';

const fixtures: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Home connection descriptor continuity', () => {
    it('persists a strict bounded fingerprint that fits the MySQL SimpleCache value', async () => {
        const values = new Map<string, string>();
        const store = createSimpleCacheHomeConnectionDescriptorContinuityStore({
            readSimpleCache: async (key) => values.get(key) ?? null,
            compareAndSetSimpleCache: async (key, expectedValue, nextValue) => {
                if ((values.get(key) ?? null) !== expectedValue) return false;
                values.set(key, nextValue);
                return true;
            },
        });
        const contentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: `https://${'home'.repeat(30)}.example.test`,
            endpoints: [{
                kind: 'iroh',
                endpointId: 'a'.repeat(64),
                relayUrls: Array.from({ length: 8 }, (_, index) => `https://relay-${index}.${'x'.repeat(48)}.example.test`),
                directAddresses: Array.from({ length: 8 }, (_, index) => `192.0.2.${index + 1}:4242`),
            }],
        });

        await store.write({
            revision: 8,
            contentKey,
            irohEndpointId: 'a'.repeat(64),
        });

        const serialized = values.get(HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY);
        expect(serialized?.length).toBeLessThanOrEqual(191);
        expect(serialized).toMatch(/^\{"revision":8,"contentKey":"v1:i:[0-9a-f]{64}","irohEndpointId":"a{64}"\}$/);
        await expect(store.read()).resolves.toEqual({
            revision: 8,
            contentKey,
            irohEndpointId: 'a'.repeat(64),
        });
    });

    it('enriches an outer continuity record with the published EndpointId without advancing its revision', async () => {
        const values = new Map<string, string>();
        const store = createSimpleCacheHomeConnectionDescriptorContinuityStore({
            readSimpleCache: async (key) => values.get(key) ?? null,
            compareAndSetSimpleCache: async (key, expectedValue, nextValue) => {
                if ((values.get(key) ?? null) !== expectedValue) return false;
                values.set(key, nextValue);
                return true;
            },
        });
        const contentKey = `v1:i:${'a'.repeat(64)}`;

        await store.write({ revision: 4, contentKey });
        await expect(store.write({
            revision: 4,
            contentKey,
            irohEndpointId: 'b'.repeat(64),
        })).resolves.toEqual({
            status: 'committed',
            continuity: { revision: 4, contentKey, irohEndpointId: 'b'.repeat(64) },
        });
        await expect(store.write({
            revision: 4,
            contentKey,
            irohEndpointId: 'c'.repeat(64),
        })).resolves.toEqual({
            status: 'superseded',
            continuity: { revision: 4, contentKey, irohEndpointId: 'b'.repeat(64) },
        });
    });

    it('rejects arbitrary nonempty continuity keys instead of treating them as endpoint history', async () => {
        const store = createSimpleCacheHomeConnectionDescriptorContinuityStore({
            readSimpleCache: async () => JSON.stringify({ revision: 8, contentKey: 'junk' }),
            compareAndSetSimpleCache: async () => true,
        });

        await expect(store.read()).rejects.toThrow('Home connection descriptor continuity is malformed');
    });

    it('rejects a persisted revision beyond Number.MAX_SAFE_INTEGER', async () => {
        const contentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        });
        const store = createSimpleCacheHomeConnectionDescriptorContinuityStore({
            readSimpleCache: async () => JSON.stringify({
                revision: Number.MAX_SAFE_INTEGER + 1,
                contentKey,
            }),
            compareAndSetSimpleCache: async () => true,
        });

        await expect(store.read()).rejects.toThrow('Home connection descriptor continuity is malformed');
    });

    it('prevents an equal-revision candidate from overwriting a concurrently committed value', async () => {
        let value: string | null = null;
        const compareCalls: Array<{
            expectedValue: string | null;
            nextValue: string;
            release: () => void;
        }> = [];
        const makeStore = () => createSimpleCacheHomeConnectionDescriptorContinuityStore({
            readSimpleCache: async () => value,
            compareAndSetSimpleCache: async (_key, expectedValue, nextValue) => {
                await new Promise<void>((resolve) => {
                    compareCalls.push({ expectedValue, nextValue, release: resolve });
                });
                if (value !== expectedValue) return false;
                value = nextValue;
                return true;
            },
        });
        const firstStore = makeStore();
        const secondStore = makeStore();
        const first = {
            revision: 8,
            contentKey: createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: 'srv_home',
                canonicalServerUrl: 'https://home.example.test',
                endpoints: [{ kind: 'https' as const, url: 'https://first.example.test' }],
            }),
        };
        const second = {
            revision: 8,
            contentKey: createHomeConnectionDescriptorContentKey({
                homeServerIdentityId: 'srv_home',
                canonicalServerUrl: 'https://home.example.test',
                endpoints: [{ kind: 'https' as const, url: 'https://second.example.test' }],
            }),
        };

        const firstWrite = firstStore.write(first);
        const secondWrite = secondStore.write(second);
        await vi.waitFor(() => expect(compareCalls).toHaveLength(2));

        // Both independent publishers observed an absent row. Land the later
        // candidate first, then let the stale candidate lose its exact-value
        // compare-and-set and reconcile to the winner.
        compareCalls[1].release();
        const committed = await secondWrite;
        compareCalls[0].release();
        const superseded = await firstWrite;

        expect(committed).toEqual({ status: 'committed', continuity: second });
        expect(superseded).toEqual({ status: 'superseded', continuity: second });
        await expect(firstStore.read()).resolves.toEqual(second);
    });

    it('uses the existing simple-cache owner for a full PostgreSQL server', async () => {
        const values = new Map<string, string>();
        const store = createHomeConnectionDescriptorContinuityStoreForServer({
            DATABASE_URL: 'postgresql://relay.example.test/happier',
            HAPPIER_DB_PROVIDER: 'postgres',
            HAPPIER_SERVER_FLAVOR: 'full',
        }, {
            readSimpleCache: async (key) => values.get(key) ?? null,
            compareAndSetSimpleCache: async (key, expectedValue, value) => {
                if ((values.get(key) ?? null) !== expectedValue) return false;
                values.set(key, value);
                return true;
            },
        });

        expect(store).not.toBeNull();
        await expect(store!.read()).resolves.toBeNull();
        const contentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        });
        await store!.write({ revision: 8, contentKey });
        expect([...values.keys()]).toEqual([HOME_CONNECTION_DESCRIPTOR_CONTINUITY_CACHE_KEY]);
        await expect(store!.read()).resolves.toEqual({ revision: 8, contentKey });

        const malformed = createHomeConnectionDescriptorContinuityStoreForServer({
            HAPPIER_DB_PROVIDER: 'mysql',
        }, {
            readSimpleCache: async () => '{not-json',
            compareAndSetSimpleCache: async () => true,
        });
        await expect(malformed!.read()).rejects.toThrow();
    });

    it('keeps shared-DB consumers private across reloads without changing the source continuity', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'home-descriptor-shared-db-'));
        fixtures.push(fixture);
        const values = new Map<string, string>();
        // The shared database is the system boundary; both consumers use real file storage.
        const dependencies = {
            readSimpleCache: async (key: string) => values.get(key) ?? null,
            compareAndSetSimpleCache: async (key: string, expectedValue: string | null, value: string) => {
                if ((values.get(key) ?? null) !== expectedValue) return false;
                values.set(key, value);
                return true;
            },
        };
        const source = createHomeConnectionDescriptorContinuityStoreForServer({
            HAPPIER_DB_PROVIDER: 'postgres',
            HAPPIER_SERVER_LIGHT_DATA_DIR: join(fixture, 'source'),
        }, dependencies)!;
        const sourceContinuity = { revision: 8, contentKey: `v1:n:${'a'.repeat(64)}` };
        await source.write(sourceContinuity);
        const consumerEnv = (name: string) => ({
            HAPPIER_DB_PROVIDER: 'postgres',
            HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev',
            HAPPIER_SERVER_LIGHT_DATA_DIR: join(fixture, name),
        });
        const first = createHomeConnectionDescriptorContinuityStoreForServer(consumerEnv('first'), dependencies)!;
        const second = createHomeConnectionDescriptorContinuityStoreForServer(consumerEnv('second'), dependencies)!;
        await expect(first.read()).resolves.toBeNull();
        await expect(second.read()).resolves.toBeNull();
        const firstContinuity = { revision: 1, contentKey: `v1:n:${'b'.repeat(64)}` };
        const secondContinuity = { revision: 1, contentKey: `v1:n:${'c'.repeat(64)}` };
        await expect(first.write(firstContinuity)).resolves.toMatchObject({ status: 'committed' });
        await expect(second.write(secondContinuity)).resolves.toMatchObject({ status: 'committed' });
        await expect(createHomeConnectionDescriptorContinuityStoreForServer(consumerEnv('first'), dependencies)!.read())
            .resolves.toEqual(firstContinuity);
        await expect(createHomeConnectionDescriptorContinuityStoreForServer(consumerEnv('second'), dependencies)!.read())
            .resolves.toEqual(secondContinuity);
        await expect(source.read()).resolves.toEqual(sourceContinuity);
        expect(createHomeConnectionDescriptorContinuityStoreForServer({
            HAPPIER_DB_PROVIDER: 'postgres',
            HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev',
        }, dependencies)).toBeNull();
    });

    it('uses existing file-backed state for general and managed Personal Homes', () => {
        expect(createHomeConnectionDescriptorContinuityStoreForServer({
            HAPPIER_DB_PROVIDER: 'sqlite',
            HAPPIER_SERVER_LIGHT_DATA_DIR: '/var/lib/happier',
        })).not.toBeNull();
        expect(createHomeConnectionDescriptorContinuityStoreForServer({
            HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home',
            HAPPIER_DB_PROVIDER: 'sqlite',
            HAPPIER_SERVER_LIGHT_DATA_DIR: '/var/lib/personal-home',
            DATABASE_URL: 'file:/var/lib/personal-home/happier.sqlite',
        })).not.toBeNull();
    });

    it('round-trips the durable outer revision and distinguishes an absent owner', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'home-descriptor-continuity-'));
        fixtures.push(fixture);
        const path = join(fixture, 'nested', 'home.descriptor.json');

        await expect(readHomeConnectionDescriptorContinuity(path)).resolves.toBeNull();
        const contentKey = createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        });
        await writeHomeConnectionDescriptorContinuity(path, { revision: 8, contentKey });
        await expect(readHomeConnectionDescriptorContinuity(path)).resolves.toEqual({
            revision: 8,
            contentKey,
        });
    });

    it('fails closed when persisted continuity is malformed', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'home-descriptor-continuity-'));
        fixtures.push(fixture);
        const path = join(fixture, 'home.descriptor.json');
        await writeFile(path, '{"revision":0,"contentKey":""}\n', 'utf8');

        await expect(readHomeConnectionDescriptorContinuity(path)).rejects.toThrow(
            'Home connection descriptor continuity is malformed',
        );
    });

    it('does not commit when replacement bytes cannot be synchronized and remains retryable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'home-descriptor-durable-'));
        fixtures.push(root);
        const continuityPath = join(root, 'runtime', 'home.descriptor.json');
        const probe = await open(join(root, 'probe'), 'w');
        const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
        await probe.close();
        let syncCalls = 0;
        const sync = vi.spyOn(fileHandlePrototype, 'sync').mockImplementation(async () => {
            syncCalls += 1;
            if (syncCalls === 1) throw Object.assign(new Error('file sync failed'), { code: 'EIO' });
        });
        const continuity = { revision: 1, contentKey: `v1:n:${'a'.repeat(64)}` };
        const store = createFileHomeConnectionDescriptorContinuityStore(continuityPath);

        await expect(store.write(continuity)).rejects.toMatchObject({ code: 'EIO' });
        await expect(readFile(continuityPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        await expect(store.write(continuity)).resolves.toEqual({ status: 'committed', continuity });
        expect(sync).toHaveBeenCalledTimes(3);
        expect(JSON.parse(await readFile(continuityPath, 'utf8'))).toEqual(continuity);
    });


    it('computes the identical contentKey for raw composed endpoints and Zod-parsed Iroh descriptors', () => {
        const rawEndpoints = [
            { kind: 'https' as const, url: 'https://ingress.example.test' },
            {
                kind: 'iroh' as const,
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay.example.test'],
                directAddresses: ['192.168.1.10:4242'],
            },
        ];
        const parsed = HomeConnectionDescriptorV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            revision: 1,
            endpoints: rawEndpoints,
        });
        expect(createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            endpoints: parsed.endpoints,
        })).toBe(createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            endpoints: rawEndpoints,
        }));
    });

    it('keeps identical contentKey when machineRelayUrls is absent or empty, and changes canonically when configured', () => {
        const base = {
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example.test',
            endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }],
        };
        const absentKey = createHomeConnectionDescriptorContentKey(base);
        const undefinedKey = createHomeConnectionDescriptorContentKey({ ...base, machineRelayUrls: undefined });
        const emptyKey = createHomeConnectionDescriptorContentKey({ ...base, machineRelayUrls: [] });
        expect(undefinedKey).toBe(absentKey);
        expect(emptyKey).toBe(absentKey);

        const withRelays = createHomeConnectionDescriptorContentKey({
            ...base,
            machineRelayUrls: ['https://relay-b.example.test', 'https://relay-a.example.test'],
        });
        const withRelaysSorted = createHomeConnectionDescriptorContentKey({
            ...base,
            machineRelayUrls: ['https://relay-a.example.test', 'https://relay-b.example.test'],
        });
        expect(withRelays).not.toBe(absentKey);
        expect(withRelays).toBe(withRelaysSorted);

        const changedRelays = createHomeConnectionDescriptorContentKey({
            ...base,
            machineRelayUrls: ['https://relay-c.example.test'],
        });
        expect(changedRelays).not.toBe(withRelays);
    });
});
