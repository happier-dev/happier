import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent} from '@happier-dev/protocol/machines/machineStoredContent';
import {
    encodeBase64,
} from '@happier-dev/protocol/crypto/base64';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { Encryption } from '@/sync/encryption/encryption';
import { createDeferred } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './syncMachines';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchAndApplyMachines plaintext account storage', () => {
    it('preserves a published Plain content refusal in the actual Machine row without key advice', async () => {
        const row = createPlainMachineRowFixture({ id: 'plain-unpublished', accountId: 'alice' });
        const applied: Machine[] = [];
        await fetchAndApplyMachines({
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature' },
            encryption: null, machineDataKeys: new Map(),
            request: async () => Response.json([{ ...row, metadata: null, daemonState: null,
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
                    resourceMode: 'plain', accessState: 'refused', reason: 'content_unpublished' } }]),
            applyMachines: machines => { applied.splice(0, applied.length, ...machines); },
        });
        expect(applied).toMatchObject([{ id: row.id, storageMode: 'plain', metadata: null,
            access: { accessState: 'refused', reason: 'content_unpublished' },
            availability: { kind: 'locked', reason: 'content_unpublished' } }]);
    });
    it('keeps an equal-clock offline transition across a held census and admits a newer recovery heartbeat', async () => {
        const initialState = storage.getState();
        storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: {},
            machinePresenceById: {}, machinePresenceByServerId: {} });
        const fixture = createMachineFixture({ id: 'held-presence', activeAt: Date.now() });
        const row = createPlainMachineRowFixture({ id: fixture.id, accountId: 'bob', machine: fixture });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const params: Parameters<typeof fetchAndApplyMachines>[0] = {
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature' },
            encryption: null, machineDataKeys: new Map(), replace: true,
            getMachineSnapshot: () => storage.getState().machines,
            getExistingMachine: id => storage.getState().machines[id],
            request: async () => Response.json([row]),
            applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines, options),
            applyMachines: (machines, replace, publishedRows) => storage.getState().applyMachines(machines, replace, {
                activityUpdates: publishedRows.map(({ id, active, activeAt }) => ({ id, active, activeAt })),
            }),
        };
        try {
            await fetchAndApplyMachines(params);
            const pending = fetchAndApplyMachines({ ...params, request: async () => {
                entered.resolve(); await release.promise; return Response.json([row]);
            } });
            await entered.promise;
            storage.getState().applyMachineActivityUpdates([{ id: row.id, active: false, activeAt: row.activeAt }]);
            release.resolve(); await pending;
            expect(readMachineActivity(storage.getState().machines[row.id])).toMatchObject({ active: false, activeAt: row.activeAt });
            storage.getState().applyMachines([{ ...storage.getState().machines[row.id]!, active: true, activeAt: row.activeAt + 1 }]);
            expect(readMachineActivity(storage.getState().machines[row.id])).toMatchObject({ active: true, activeAt: row.activeAt + 1 });
        } finally { release.resolve(); storage.setState(initialState, true); }
    });

    it('keeps a same-content live census root quiet while admitting its newer activity and real content changes', async () => {
        const initialState = storage.getState();
        storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: {} });
        const fixture = createMachineFixture({ id: 'census-activity', activeAt: Date.now() });
        let row = createPlainMachineRowFixture({ id: fixture.id, accountId: 'bob', machine: fixture });
        const params: Parameters<typeof fetchAndApplyMachines>[0] = {
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature' },
            encryption: null, machineDataKeys: new Map(), replace: true,
            getMachineSnapshot: () => storage.getState().machines,
            getExistingMachine: (id) => storage.getState().machines[id],
            request: async () => Response.json([row]),
            applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines, options),
            applyMachines: (machines, replace, publishedRows) => storage.getState().applyMachines(machines, replace, {
                activityUpdates: publishedRows.map(({ id, active, activeAt }) => ({ id, active, activeAt })),
            }),
        };
        let unsubscribe = () => {};
        try {
            await fetchAndApplyMachines(params);
            const retained = storage.getState().machines[fixture.id]!;
            const snapshot = storage.getState();
            let publications = 0;
            unsubscribe = storage.subscribe(() => { publications += 1; });
            const parse = vi.spyOn(StoredMachinePublishedMetadataV1Schema, 'safeParse');
            // Server presence persistence also advances updatedAt, without a
            // content/version change. Neither timestamp is an inventory fact.
            for (let arrival = 1; arrival <= 20; arrival += 1) {
                row = { ...row, activeAt: fixture.activeAt + Math.ceil(arrival / 2),
                    updatedAt: fixture.updatedAt + arrival };
                await fetchAndApplyMachines(params);
            }
            expect(publications).toBe(0);
            expect(storage.getState()).toBe(snapshot);
            expect(storage.getState().machines[fixture.id]).toBe(retained);
            expect(retained.activeAt).toBe(fixture.activeAt);
            expect(readMachineActivity(retained).activeAt).toBe(row.activeAt);
            expect(parse).not.toHaveBeenCalled();

            // HTTP and socket observations may carry differently ordered
            // persistence timestamps; payload revisions remain the fence.
            row = { ...row, updatedAt: fixture.updatedAt - 1 };
            await fetchAndApplyMachines(params);
            expect(publications).toBe(0);
            expect(storage.getState()).toBe(snapshot);

            row = { ...row, metadata: encodePlainMachineStoredContent({ ...fixture.metadata!, host: 'changed-host' }),
                metadataVersion: row.metadataVersion + 1, updatedAt: row.updatedAt + 1 };
            await fetchAndApplyMachines(params);
            expect(publications).toBeGreaterThan(0);
            expect(storage.getState().machines[fixture.id]?.metadata?.host).toBe('changed-host');
            expect(parse).toHaveBeenCalled();
        } finally { unsubscribe(); storage.setState(initialState, true); }
    });

    it('admits a newly discovered Plain Machine when the snapshot and exact reader both lack its row', async () => {
        const initialState = storage.getState();
        storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: {} });
        const row = createPlainMachineRowFixture({ id: 'newly-discovered', accountId: 'bob' });
        try {
            await fetchAndApplyMachines({
                credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature' },
                encryption: null, machineDataKeys: new Map(), replace: true,
                getMachineSnapshot: () => storage.getState().machines,
                getExistingMachine: (id) => storage.getState().machines[id] ?? null,
                request: async () => Response.json([row]),
                applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines, options),
                applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace),
            });
            expect(storage.getState().machines[row.id]).toMatchObject({ id: row.id,
                storageMode: 'plain', availability: { kind: 'available' }, metadata: { host: 'tester.local' } });
            expect(storage.getState().machineDisplayById[row.id]?.metadata?.host).toBe('tester.local');
        } finally { storage.setState(initialState, true); }
    });
    it('does not reinstall keyless ready access withdrawn during post-response custody lookup', async () => {
        const initialState = storage.getState();
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const };
        const shared = createMachineFixture({ id: 'post-response-plain', storageMode: 'plain', dataEncryptionKey: null,
            keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 1 }, isShared: true, access });
        const retained = createMachineFixture({ id: 'post-response-unaffected', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
        storage.getState().applyMachines([shared, retained]);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const secureStore = await import('expo-secure-store');
        const { resetRunnerCreatorMachineContentKeyTrustProjectionForTests } = await import('@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust');
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        // Device-local custody is an OS storage boundary, not a mocked trust decision.
        vi.spyOn(secureStore, 'getItemAsync').mockImplementation(async () => {
            entered.resolve(); await release.promise; return null;
        });
        try {
            const pending = fetchAndApplyMachines({
                credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature' }, sourceServerId: 'post-response-home',
                encryption: null, machineDataKeys: new Map(), replace: true,
                getMachineSnapshot: () => storage.getState().machines,
                getExistingMachine: (id) => storage.getState().machines[id],
                request: async () => Response.json([shared, retained].map((machine) => ({
                    ...machine, metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: null,
                }))),
                applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace),
            });
            await entered.promise;
            storage.getState().applyMachines([{ ...shared, metadata: null, access: { ...access, accessState: 'refused' },
                availability: { kind: 'locked', reason: 'recipient_access_refused' } }]);
            const withdrawn = storage.getState().machines[shared.id];
            release.resolve(); await pending;
            expect(storage.getState().machines[shared.id]).toBe(withdrawn);
            expect(storage.getState().machines[retained.id]).toMatchObject({ metadata: retained.metadata });
        } finally {
            release.resolve(); storage.setState(initialState, true);
            resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        }
    });
    it('does not reinstall ready access from a held keyless list after access is withdrawn', async () => {
        const initialState = storage.getState();
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const };
        const shared = createMachineFixture({ id: 'held-plain', storageMode: 'plain', dataEncryptionKey: null,
            keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 1 }, isShared: true, access });
        const retained = createMachineFixture({ id: 'unaffected-plain', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
        storage.getState().applyMachines([shared, retained]);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        try {
            const pending = fetchAndApplyMachines({
                credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature' }, encryption: null, machineDataKeys: new Map(), replace: true,
                getMachineSnapshot: () => storage.getState().machines,
                getExistingMachine: (id) => storage.getState().machines[id],
                request: async () => {
                    entered.resolve(); await release.promise;
                    return Response.json([shared, retained].map((machine) => ({ ...machine, metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: null })));
                },
                applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace),
            });
            await entered.promise;
            storage.getState().applyMachines([{ ...shared, metadata: null, access: { ...access, accessState: 'refused' },
                availability: { kind: 'locked', reason: 'recipient_access_refused' } }]);
            const withdrawn = storage.getState().machines[shared.id];
            release.resolve(); await pending;
            expect(storage.getState().machines[shared.id]).toBe(withdrawn);
            expect(storage.getState().machines[shared.id]?.access?.accessState).toBe('refused');
            expect(storage.getState().machines[retained.id]).toMatchObject({ metadata: retained.metadata });
        } finally {
            release.resolve(); storage.setState(initialState, true);
        }
    });
    it('admits legacy encrypted fields at ingress and retains their parsed warm identities', async () => {
        const initialState = storage.getState();
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const fixture = createMachineFixture({ id: 'warm', storageMode: 'e2ee', availability: { kind: 'available' },
            daemonState: { status: 'running' }, daemonStateVersion: 1 });
        await encryption.initializeMachines(new Map([[fixture.id, null]]));
        const cipher = encryption.getMachineEncryption(fixture.id)!;
        // Legacy stored ciphertext is the real boundary. Do not seed private
        // fields into an already-admitted typed row and revalidate it per fetch.
        const encryptedMetadata = await cipher.encryptRaw({ ...fixture.metadata!, privateSessionPaths: ['/private/work'] });
        const encryptedDaemonState = await cipher.encryptRaw({ status: 'running', privateSessionIds: ['private-session'] });
        storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: {} });
        const params = {
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature', secret: encodeBase64(secret, 'base64url') },
            sourceServerId: 'home', expectedAccountMode: 'e2ee' as const, encryption, machineDataKeys: new Map(),
            getExistingMachine: (id: string) => storage.getState().machines[id],
            getMachineSnapshot: () => storage.getState().machines,
            request: async () => Response.json([{ ...fixture, dataEncryptionKey: null, metadata: encryptedMetadata,
                daemonState: encryptedDaemonState }]),
            applyMachineDisplayEntries: (machines: Parameters<typeof initialState.replaceMachineDisplays>[0], options: Parameters<typeof initialState.replaceMachineDisplays>[1]) =>
                storage.getState().replaceMachineDisplays(machines, options),
            applyMachines: (machines: Machine[], replace: boolean) => storage.getState().applyMachines(machines, replace),
        };
        try {
            await fetchAndApplyMachines(params);
            const retained = storage.getState().machines[fixture.id]!;
            expect(retained.metadata).toEqual(fixture.metadata);
            expect(retained.daemonState).toEqual({ status: 'running' });
            await fetchAndApplyMachines(params);
            expect(storage.getState().machines[fixture.id]).toBe(retained);
            expect(storage.getState().machines[fixture.id]?.metadata).toBe(retained.metadata);
            expect(storage.getState().machines[fixture.id]?.daemonState).toBe(retained.daemonState);
        } finally { storage.setState(initialState, true); }
    });
    it('refuses a Home-reported Plain own Machine row while this device holds active Account keys', async () => {
        // An own row's mode is the Account mode: the same admission as the Account
        // reader, so a hostile Home cannot select plaintext Machine writes per row.
        const owned = createPlainMachineRowFixture({ id: 'own-plain', accountId: 'bob' });
        const { access: _access, ...unscoped } = createPlainMachineRowFixture({ id: 'own-unscoped', accountId: 'bob' });
        const hydrate = async (custody?: 'historical') => {
            let applied: Machine[] = [];
            await fetchAndApplyMachines({
                credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature', secret: 'viewer-secret', ...(custody ? { custody } : {}) },
                encryption: null, machineDataKeys: new Map(), expectedAccountMode: 'e2ee',
                request: async () => Response.json([owned, { ...unscoped, storageMode: 'plain', dataEncryptionKey: null }]),
                applyMachines: (machines) => { applied = machines; },
            });
            return applied;
        };
        expect(await hydrate()).toMatchObject([
            { id: owned.id, metadata: null, availability: { kind: 'locked' } },
            { id: 'own-unscoped', metadata: null, availability: { kind: 'locked' } },
        ]);
        expect(await hydrate('historical')).toMatchObject([
            { id: owned.id, storageMode: 'plain', availability: { kind: 'available' } },
            { id: 'own-unscoped', storageMode: 'plain', availability: { kind: 'available' } },
        ]);
    });
    it('opens a shared Plain resource for an E2EE viewer without Account or Machine keys', async () => {
        let applied: Machine[] = [];
        // RFC 8032 public test vector, in the ordinary Machine row's standard-base64 encoding.
        const installationPublicKey = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'use', resourceMode: 'plain', accessState: 'ready' };
        await fetchAndApplyMachines({
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature', secret: 'viewer-secret' },
            encryption: null, machineDataKeys: new Map(),
            request: async () => Response.json([{
                id: 'shared-plain', metadata: encodePlainMachineStoredContent({ ...createMachineFixture().metadata, host: 'shared-host' }),
                metadataVersion: 1, dataEncryptionKey: null, access,
                installationId: 'installation', installationPublicKey,
                seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
            }]),
            applyMachines: (machines) => { applied = machines; },
        });
        expect(applied[0]).toMatchObject({ metadata: { host: 'shared-host' }, storageMode: 'plain',
            availability: { kind: 'available' }, isShared: true, access, installationId: 'installation', installationPublicKey });
        const socketUpdated = await buildUpdatedMachineFromSocketUpdate({ machineUpdate: { machineId: 'shared-plain', activeAt: 2 },
            updateSeq: 2, updateCreatedAt: 2, existingMachine: applied[0], getMachineEncryption: () => null });
        expect(socketUpdated).toMatchObject({ installationId: 'installation', installationPublicKey });
    });

    it.each(['key_pending', 'refused'] as const)('withdraws cached shared content and keys when access is %s', async (accessState) => {
        let applied: Machine[] = [];
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>([['shared', {
            envelope: 'previous-envelope', dataKey: new Uint8Array(32),
        }]]);
        await fetchAndApplyMachines({
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature', secret: 'viewer-secret' },
            encryption: null, machineDataKeys,
            request: async () => Response.json([{
                id: 'shared', metadata: null, metadataVersion: 1, dataEncryptionKey: null,
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
                    resourceMode: 'e2ee', accessState },
                seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
            }]),
            applyMachines: (machines) => { applied = machines; },
        });
        expect(applied[0]).toMatchObject({ metadata: null, daemonState: null, isShared: true,
            availability: { kind: 'locked', reason: accessState === 'key_pending'
                ? 'recipient_key_pending' : 'recipient_access_refused' } });
        expect(machineDataKeys.has('shared')).toBe(false);
    });
    it('refreshes and withdraws the accepted Machine operation projection without depending on encrypted content changes', async () => {
        let appliedMachines: Machine[] = [];
        const hydrate = async (capabilities: unknown, revision: number) => fetchAndApplyMachines({
            credentials: { token: 'token-only' }, encryption: null, machineDataKeys: new Map(),
            request: async () => Response.json([{
                id: 'machine-projection', metadata: encodePlainMachineStoredContent({ ...createMachineFixture().metadata, host: 'host' }),
                metadataVersion: 1, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: revision,
            }]),
            applyMachines: (machines) => {
                appliedMachines = machines;
            },
        });
        const supported = { sessionSpawnPlacementOrigin: { protocolVersions: [1] } };
        await hydrate({
            sessionSpawnPlacementOrigin: { protocolVersions: [1], future: true },
            futureCapability: { protocolVersions: [1] },
        }, 1);
        expect(appliedMachines[0]).toMatchObject({
            operationProtocolCapabilities: supported, operationProtocolCapabilitiesRevision: 1,
        });
        expect(appliedMachines[0]?.operationProtocolCapabilities).toEqual(supported);
        await hydrate({}, 2);
        expect(appliedMachines[0]).toMatchObject({
            operationProtocolCapabilities: {}, operationProtocolCapabilitiesRevision: 2,
        });
        await hydrate({ sessionSpawnPlacementOrigin: { protocolVersions: [2] },
            sessionSpawn: { protocolVersions: [1] } }, 3);
        expect(appliedMachines[0]).toMatchObject({
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 3,
        });
        // The canonical stored reader withdraws the invalid optional leaf only.
        expect(appliedMachines[0]?.operationProtocolCapabilities?.sessionSpawnPlacementOrigin).toBeUndefined();
    });

    it('hydrates machine metadata and daemon state without account encryption material', async () => {
        const applyMachines = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 'token-only' },
            encryption: null,
            machineDataKeys: new Map(),
            request: vi.fn(async () => new Response(JSON.stringify([
                {
                    id: 'machine-plain-1',
                    metadata: encodePlainMachineStoredContent({
                        ...createMachineFixture().metadata,
                        displayName: 'Plain machine',
                        host: 'plain-host',
                        homeDir: '/home/plain',
                    }),
                    metadataVersion: 2,
                    daemonState: encodePlainMachineStoredContent({
                        status: 'running',
                    }),
                    daemonStateVersion: 3,
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    seq: 4,
                    active: true,
                    activeAt: 5,
                    createdAt: 1,
                    updatedAt: 6,
                },
            ]), { status: 200 })),
            applyMachines,
            replace: true,
        });

        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'machine-plain-1',
                metadata: expect.objectContaining({ displayName: 'Plain machine' }),
                daemonState: expect.objectContaining({ status: 'running' }),
                storageMode: 'plain',
            }),
        ], true, expect.any(Array));
    });

    it('applies plain machine socket fields without constructing machine encryption', async () => {
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'use', resourceMode: 'plain', accessState: 'ready' } as const;
        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'machine-plain-1',
                metadata: {
                    version: 3,
                    value: encodePlainMachineStoredContent({
                        displayName: 'Updated plain machine',
                        host: 'plain-host',
                        platform: 'linux',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/home/plain/.happier',
                        homeDir: '/home/plain',
                        privateSessionPaths: ['/private/work'],
                    }),
                },
                daemonState: {
                    version: 4,
                    value: encodePlainMachineStoredContent({
                        status: 'shutting-down',
                        privateSessionIds: ['private-session'],
                    }),
                },
            },
            updateSeq: 7,
            updateCreatedAt: 8,
            existingMachine: {
                id: 'machine-plain-1',
                seq: 4,
                createdAt: 1,
                updatedAt: 6,
                active: true,
                activeAt: 5,
                metadata: {
                    displayName: 'Plain machine',
                    host: 'plain-host',
                    platform: 'linux',
                    happyCliVersion: '0.0.0-test',
                    happyHomeDir: '/home/plain/.happier',
                    homeDir: '/home/plain',
                },
                metadataVersion: 2,
                daemonState: { status: 'running' },
                daemonStateVersion: 3,
                storageMode: 'plain',
                access,
                isShared: true,
            },
            getMachineEncryption: () => {
                throw new Error('plain machine must not consult machine encryption');
            },
        });

        expect(updated).toMatchObject({
            metadata: { displayName: 'Updated plain machine' },
            metadataVersion: 3,
            daemonState: { status: 'shutting-down' },
            daemonStateVersion: 4,
            storageMode: 'plain',
            access,
            isShared: true,
        });
        expect(updated?.metadata).not.toHaveProperty('privateSessionPaths');
        expect(updated?.daemonState).not.toHaveProperty('privateSessionIds');
    });

    it('keeps a malformed plain Machine row explicitly unavailable during replacing list sync', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const applyMachines = vi.fn();
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const request = vi.fn(async (_path: string, _init: RequestInit) =>
            new Response(JSON.stringify([
                {
                    id: 'machine-plain-malformed-list',
                    metadata: 'not-a-plain-machine-envelope',
                    metadataVersion: 8,
                    daemonState: encodePlainMachineStoredContent({ status: 'running' }),
                    daemonStateVersion: 13,
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    seq: 21,
                    active: true,
                    activeAt: 34,
                    createdAt: 1,
                    updatedAt: 55,
                },
            ]), { status: 200 }),
        );

        await fetchAndApplyMachines({
            credentials: { token: 'token-only' },
            encryption: null,
            machineDataKeys,
            request,
            applyMachines,
            replace: true,
        });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[1]?.method).toBeUndefined();
        expect(machineDataKeys).toEqual(new Map());
        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'machine-plain-malformed-list',
                metadata: null,
                metadataVersion: 8,
                daemonState: null,
                daemonStateVersion: 0,
                storageMode: 'plain',
                availability: {
                    kind: 'locked',
                    reason: 'content_unreadable',
                },
            }),
        ], true, expect.any(Array));
    });

    it('marks a malformed plain Machine unavailable in the immediate warm-display state', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 'token-only' },
            encryption: null,
            machineDataKeys: new Map(),
            request: vi.fn(async () => new Response(JSON.stringify([
                {
                    id: 'machine-plain-malformed-display',
                    metadata: 'not-a-plain-machine-envelope',
                    metadataVersion: 5,
                    daemonState: encodePlainMachineStoredContent({ status: 'running' }),
                    daemonStateVersion: 7,
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    seq: 11,
                    active: true,
                    activeAt: 13,
                    createdAt: 1,
                    updatedAt: 17,
                },
            ]), { status: 200 })),
            applyMachines,
            applyMachineDisplayEntries,
            replace: true,
        });

        expect(applyMachineDisplayEntries).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'machine-plain-malformed-display' }),
        ], { replace: true });
        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'machine-plain-malformed-display',
                metadata: null,
                metadataVersion: 5,
                daemonState: null,
                daemonStateVersion: 0,
                storageMode: 'plain',
                availability: {
                    kind: 'locked',
                    reason: 'content_unreadable',
                },
            }),
        ], true, expect.any(Array));
    });

    it('keeps prior plain Machine fields and reports unavailable when a socket envelope is malformed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const existingMachine: Machine = {
            id: 'machine-plain-socket',
            seq: 2,
            createdAt: 1,
            updatedAt: 3,
            active: true,
            activeAt: 3,
            metadata: {
                displayName: 'Last known machine',
                host: 'plain-host',
                platform: 'linux',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/home/plain/.happier',
                homeDir: '/home/plain',
            },
            metadataVersion: 4,
            daemonState: { status: 'running' },
            daemonStateVersion: 6,
            storageMode: 'plain',
            availability: { kind: 'available' },
        };

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: existingMachine.id,
                metadata: {
                    version: 5,
                    value: 'not-a-plain-machine-envelope',
                },
                daemonState: {
                    version: 7,
                    value: encodePlainMachineStoredContent({ status: 'shutting-down' }),
                },
            },
            updateSeq: 8,
            updateCreatedAt: 9,
            existingMachine,
            getMachineEncryption: () => {
                throw new Error('plain machine must not consult machine encryption');
            },
        });

        expect(updated).toMatchObject({
            metadata: existingMachine.metadata,
            metadataVersion: 4,
            daemonState: { status: 'shutting-down' },
            daemonStateVersion: 7,
            storageMode: 'plain',
            availability: {
                kind: 'locked',
                reason: 'content_unreadable',
            },
        });
    });
});
