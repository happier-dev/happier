import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './syncMachines';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchAndApplyMachines plaintext account storage', () => {
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
                        displayName: 'Plain machine',
                        host: 'plain-host',
                        homeDir: '/home/plain',
                    }),
                    metadataVersion: 2,
                    daemonState: encodePlainMachineStoredContent({
                        daemonLastKnownStatus: 'running',
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
                daemonState: expect.objectContaining({ daemonLastKnownStatus: 'running' }),
                storageMode: 'plain',
            }),
        ], true);
    });

    it('applies plain machine socket fields without constructing machine encryption', async () => {
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
                    }),
                },
                daemonState: {
                    version: 4,
                    value: encodePlainMachineStoredContent({
                        daemonLastKnownStatus: 'shutting-down',
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
                daemonState: { daemonLastKnownStatus: 'running' },
                daemonStateVersion: 3,
                storageMode: 'plain',
            },
            getMachineEncryption: () => {
                throw new Error('plain machine must not consult machine encryption');
            },
        });

        expect(updated).toMatchObject({
            metadata: { displayName: 'Updated plain machine' },
            metadataVersion: 3,
            daemonState: { daemonLastKnownStatus: 'shutting-down' },
            daemonStateVersion: 4,
            storageMode: 'plain',
        });
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
