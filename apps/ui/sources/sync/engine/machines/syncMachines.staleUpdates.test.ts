import { describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/sync/domains/state/storageTypes'

import { buildUpdatedMachineFromSocketUpdate } from './syncMachines'
import { Encryption } from '@/sync/encryption/encryption'
import * as platformCrypto from 'rn-encryption'
import { createDeferred, createMachineFixture } from '@/dev/testkit'
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent'

type MachineUpdate = {
    machineId: string
    metadata?: { value: string; version: number }
    daemonState?: { value: string; version: number }
    active?: boolean
    activeAt?: number
    revokedAt?: number | null
}

function buildMachine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: 'm1',
        seq: 0,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 2,
        revokedAt: null,
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            homeDir: '/Users/tester',
            happyHomeDir: '/Users/tester/.happier',
            happyCliVersion: '0.0.0-test',
        } as Machine['metadata'],
        metadataVersion: 5,
        daemonState: { existing: true },
        daemonStateVersion: 7,
        ...overrides,
    }
}

describe('buildUpdatedMachineFromSocketUpdate stale guards', () => {
    it('projects the admitted child fact independently of rewritten metadata and clears a retired fact', async () => {
        const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
            parentMachineId: 'physical-parent' }, observation: { nativeResourceId: 'native-child', user: 'custom-user',
            workspaceFolder: '/work/custom', storage: { kind: 'child' as const, childPath: '/work/custom' } } }
        const existing = createMachineFixture({ storageMode: 'plain', metadataVersion: 1 })
        const renamed = { ...existing.metadata!, displayName: 'Renamed by predecessor' }
        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: { machineId: existing.id, metadata: { version: 2, value: encodePlainMachineStoredContent(renamed) },
                devcontainerChild: projection }, updateSeq: 2, updateCreatedAt: 2, existingMachine: existing,
            getMachineEncryption: () => null,
        })
        expect(updated?.metadata).toMatchObject({ displayName: renamed.displayName, devcontainerChild: projection })
        const replacement = { ...projection, observation: { ...projection.observation, nativeResourceId: 'replacement-native' } }
        // A successful local CAS acknowledgement may already advance the blob
        // version before the authoritative socket echo arrives.
        const echoed = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: { machineId: existing.id, metadata: { version: 2, value: encodePlainMachineStoredContent(renamed) },
                devcontainerChild: replacement }, updateSeq: 3, updateCreatedAt: 3, existingMachine: updated!,
            getMachineEncryption: () => null,
        })
        expect(echoed?.metadata?.devcontainerChild).toEqual(replacement)
        const retired = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: { machineId: existing.id, devcontainerChild: null }, updateSeq: 3, updateCreatedAt: 3,
            existingMachine: echoed!, getMachineEncryption: () => null,
        })
        expect(retired?.metadata?.devcontainerChild).toBeUndefined()
    })
    it('retains the exact shared published context through a content-only update', async () => {
        const machine = createMachineFixture({
            id: 'shared', metadataVersion: 1, dataEncryptionKey: 'recipient-envelope', isShared: true,
            keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 0 },
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'e2ee', accessState: 'ready' },
        })
        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: { machineId: machine.id, active: true },
            updateSeq: 2, updateCreatedAt: 2, existingMachine: machine, getMachineEncryption: () => null,
        })
        expect(updated?.access).toBe(machine.access)
        expect(updated?.keyBasis).toBe(machine.keyBasis)
        expect(updated?.keyBasis?.dataEncryptionKey).toBeNull()
        expect(updated?.dataEncryptionKey).toBe('recipient-envelope')
        expect(updated?.isShared).toBe(true)
    })
    it('does not return a socket snapshot decrypted by a retired Machine context', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1))
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } })
        await encryption.initializeMachines(new Map([['m1', new Uint8Array(32).fill(2)]]))
        const before = encryption.getMachineEncryption('m1')!
        const ciphertext = await before.encryptMetadata({ ...createMachineFixture().metadata!, displayName: 'Old update' })
        const started = createDeferred<void>()
        const release = createDeferred<void>()
        const originalDecrypt = platformCrypto.decryptAsyncAES
        const spy = vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
            const plaintext = await originalDecrypt(...args)
            started.resolve()
            await release.promise
            return plaintext
        })
        const pending = buildUpdatedMachineFromSocketUpdate({
            machineUpdate: { machineId: 'm1', metadata: { version: 6, value: ciphertext } },
            updateSeq: 10, updateCreatedAt: 10, existingMachine: createMachineFixture({ id: 'm1', metadataVersion: 5 }),
            getMachineEncryption: (id) => encryption.getMachineEncryption(id),
        })
        try {
            await started.promise
            await encryption.initializeMachines(new Map([['m1', new Uint8Array(32).fill(3)]]))
            release.resolve()
            expect(await pending).toBeNull()
        } finally {
            release.resolve()
            spy.mockRestore()
            await pending
        }
    })
    it('ignores stale metadata updates and still applies newer daemonState updates', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))
        const cipher = { decryptMetadata, decryptDaemonState }

        const existingMachine = buildMachine()

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                metadata: { value: 'meta', version: 5 },
                daemonState: { value: 'state', version: 8 },
            } as MachineUpdate,
            updateSeq: 999,
            updateCreatedAt: 100,
            existingMachine,
            getMachineEncryption: () => cipher,
        })

        expect(updated).not.toBeNull()
        expect(decryptMetadata).not.toHaveBeenCalled()
        expect(decryptDaemonState).toHaveBeenCalledTimes(1)
        expect(updated?.metadataVersion).toBe(5)
        expect(updated?.metadata).toEqual({
            host: 'localhost',
            platform: 'darwin',
            homeDir: '/Users/tester',
            happyHomeDir: '/Users/tester/.happier',
            happyCliVersion: '0.0.0-test',
        })
        expect(updated?.daemonStateVersion).toBe(8)
        expect(updated?.daemonState).toEqual({ d: true })
    })

    it('applies metadata updates when version increases', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))
        const cipher = { decryptMetadata, decryptDaemonState }

        const existingMachine = buildMachine({
            daemonState: null,
            daemonStateVersion: 0,
        })

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                metadata: { value: 'meta', version: 6 },
            } as MachineUpdate,
            updateSeq: 999,
            updateCreatedAt: 100,
            existingMachine,
            getMachineEncryption: () => cipher,
        })

        expect(updated).not.toBeNull()
        expect(decryptMetadata).toHaveBeenCalledTimes(1)
        expect(updated?.metadataVersion).toBe(6)
        expect(updated?.metadata).toEqual({ m: true })
    })

    it('preserves freshness fields even when machine encryption is unavailable', async () => {
        const existingMachine = buildMachine({
            active: false,
            activeAt: 10,
            metadataVersion: 5,
            daemonStateVersion: 7,
        })

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                active: true,
                activeAt: 100,
                revokedAt: null,
            } as MachineUpdate,
            updateSeq: 5,
            updateCreatedAt: 100,
            existingMachine,
            getMachineEncryption: () => null,
        })

        expect(updated).not.toBeNull()
        expect(updated?.active).toBe(true)
        expect(updated?.activeAt).toBe(100)
        expect(updated?.metadataVersion).toBe(existingMachine.metadataVersion)
        expect(updated?.metadata).toEqual(existingMachine.metadata)
        expect(updated?.daemonStateVersion).toBe(existingMachine.daemonStateVersion)
        expect(updated?.daemonState).toEqual(existingMachine.daemonState)
    })

    it('preserves an existing locked availability during freshness-only socket updates', async () => {
        const existingMachine = buildMachine({
            active: false,
            activeAt: 10,
            metadata: null,
            daemonState: null,
            storageMode: 'e2ee',
            availability: {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            },
        })

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                active: true,
                activeAt: 100,
            } as MachineUpdate,
            updateSeq: 5,
            updateCreatedAt: 100,
            existingMachine,
            getMachineEncryption: () => null,
        })

        expect(updated).toMatchObject({
            active: true,
            activeAt: 100,
            storageMode: 'e2ee',
            availability: {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            },
        })
    })

    it('preserves replacement metadata when socket updates only carry freshness fields', async () => {
        const existingMachine = buildMachine({
            replacedByMachineId: 'm-current',
            replacedAt: 50,
            replacementReason: 'reauth',
            replacementSource: 'automatic',
            replacementActorUserId: 'user-1',
            installationId: 'installation-1',
            contentPublicKeyFingerprint: 'content-key-1',
        })

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                active: false,
                activeAt: 100,
            } as MachineUpdate,
            updateSeq: 5,
            updateCreatedAt: 100,
            existingMachine,
            getMachineEncryption: () => null,
        })

        expect(updated).not.toBeNull()
        expect(updated).toMatchObject({
            replacedByMachineId: 'm-current',
            replacedAt: 50,
            replacementReason: 'reauth',
            replacementSource: 'automatic',
            replacementActorUserId: 'user-1',
            installationId: 'installation-1',
            contentPublicKeyFingerprint: 'content-key-1',
        })
    })

    it('applies revoke updates from the socket payload', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))
        const cipher = { decryptMetadata, decryptDaemonState }

        const existingMachine = buildMachine({ active: true, revokedAt: null })

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                active: false,
                revokedAt: 123,
            } as MachineUpdate,
            updateSeq: 999,
            updateCreatedAt: 500,
            existingMachine,
            getMachineEncryption: () => cipher,
        })

        expect(updated).not.toBeNull()
        expect(updated?.active).toBe(false)
        expect(updated?.revokedAt).toBe(123)
    })

    it('keeps existing values when both metadata and daemonState updates are stale', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))
        const cipher = { decryptMetadata, decryptDaemonState }
        const existingMachine = buildMachine()

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                metadata: { value: 'meta', version: 5 },
                daemonState: { value: 'state', version: 7 },
            } as MachineUpdate,
            updateSeq: 999,
            updateCreatedAt: 200,
            existingMachine,
            getMachineEncryption: () => cipher,
        })

        expect(updated).not.toBeNull()
        expect(decryptMetadata).not.toHaveBeenCalled()
        expect(decryptDaemonState).not.toHaveBeenCalled()
        expect(updated?.metadataVersion).toBe(5)
        expect(updated?.daemonStateVersion).toBe(7)
        expect(updated?.metadata).toEqual(existingMachine.metadata)
        expect(updated?.daemonState).toEqual(existingMachine.daemonState)
    })

    it('preserves existing metadata when metadata decryption fails', async () => {
        const decryptMetadata = vi.fn(async () => {
            throw new Error('metadata decrypt failed')
        })
        const decryptDaemonState = vi.fn(async () => ({ d: true }))
        const cipher = { decryptMetadata, decryptDaemonState }
        const existingMachine = buildMachine()
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                metadata: { value: 'meta', version: 6 },
            } as MachineUpdate,
            updateSeq: 999,
            updateCreatedAt: 300,
            existingMachine,
            getMachineEncryption: () => cipher,
        })

        expect(updated).not.toBeNull()
        expect(decryptMetadata).toHaveBeenCalledTimes(1)
        expect(updated?.metadataVersion).toBe(5)
        expect(updated?.metadata).toEqual(existingMachine.metadata)
        errorSpy.mockRestore()
    })

    it('preserves existing daemonState when daemonState decryption fails', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => {
            throw new Error('daemonState decrypt failed')
        })
        const cipher = { decryptMetadata, decryptDaemonState }
        const existingMachine = buildMachine()
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                daemonState: { value: 'state', version: 8 },
            } as MachineUpdate,
            updateSeq: 999,
            updateCreatedAt: 400,
            existingMachine,
            getMachineEncryption: () => cipher,
        })

        expect(updated).not.toBeNull()
        expect(decryptDaemonState).toHaveBeenCalledTimes(1)
        expect(updated?.daemonStateVersion).toBe(7)
        expect(updated?.daemonState).toEqual(existingMachine.daemonState)
        errorSpy.mockRestore()
    })
})
