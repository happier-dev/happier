import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent,
    encodeBase64,
} from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { Encryption } from '@/sync/encryption/encryption';
import { createDeferred } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

import { buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './syncMachines';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchAndApplyMachines plaintext account storage', () => {
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
    it('projects retained decrypted warm content through the same stored publication reader', async () => {
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const fixture = createMachineFixture({ id: 'warm', storageMode: 'e2ee', availability: { kind: 'available' },
            daemonState: { status: 'running' }, daemonStateVersion: 1 });
        await encryption.initializeMachines(new Map([[fixture.id, null]]));
        const encryptedMetadata = await encryption.getMachineEncryption(fixture.id)!.encryptMetadata(fixture.metadata!);
        const retainedMetadata = { ...fixture.metadata!, privateSessionPaths: ['/private/work'] };
        const retainedDaemonState = { status: 'running', privateSessionIds: ['private-session'] };
        const retainedMachine = { ...fixture, metadata: retainedMetadata, daemonState: retainedDaemonState };
        let applied: Machine[] = [];
        await fetchAndApplyMachines({
            credentials: { token: 'header.eyJzdWIiOiJib2IifQ==.signature', secret: encodeBase64(secret, 'base64url') },
            sourceServerId: 'home', expectedAccountMode: 'e2ee', encryption, machineDataKeys: new Map(),
            getExistingMachine: () => retainedMachine,
            request: async () => Response.json([{ ...fixture, dataEncryptionKey: null, metadata: encryptedMetadata,
                daemonState: 'retained-ciphertext' }]),
            applyMachineDisplayEntries: () => {}, applyMachines: (machines) => { applied = machines; },
        });
        expect(applied[0]?.metadata).toEqual(fixture.metadata);
        expect(applied[0]?.daemonState).toEqual({ status: 'running' });
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
        await hydrate({ sessionSpawnPlacementOrigin: { protocolVersions: [2] } }, 3);
        expect(appliedMachines[0]).toMatchObject({
            operationProtocolCapabilities: null, operationProtocolCapabilitiesRevision: null,
        });
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
        ], true);
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
                daemonStateVersion: 13,
                storageMode: 'plain',
                availability: {
                    kind: 'locked',
                    reason: 'content_unreadable',
                },
            }),
        ], true);
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
                daemonStateVersion: 7,
                storageMode: 'plain',
                availability: {
                    kind: 'locked',
                    reason: 'content_unreadable',
                },
            }),
        ], true);
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
