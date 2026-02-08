import { describe, expect, it, vi } from 'vitest'
import type { Machine } from '../storageTypes'

import { buildUpdatedMachineFromSocketUpdate } from './machines'

type MachineUpdate = {
    machineId: string
    metadata?: { value: string; version: number }
    daemonState?: { value: string; version: number }
    active?: boolean
    activeAt?: number
}

function buildMachine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: 'm1',
        seq: 0,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 2,
        metadata: { existing: true } as Machine['metadata'],
        metadataVersion: 5,
        daemonState: { existing: true },
        daemonStateVersion: 7,
        ...overrides,
    }
}

describe('buildUpdatedMachineFromSocketUpdate stale guards', () => {
    it('ignores stale metadata updates and still applies newer daemonState updates', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))

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
            getMachineEncryption: () => ({
                decryptMetadata,
                decryptDaemonState,
            }),
        })

        expect(updated).not.toBeNull()
        expect(decryptMetadata).not.toHaveBeenCalled()
        expect(decryptDaemonState).toHaveBeenCalledTimes(1)
        expect(updated?.metadataVersion).toBe(5)
        expect(updated?.metadata).toEqual({ existing: true })
        expect(updated?.daemonStateVersion).toBe(8)
        expect(updated?.daemonState).toEqual({ d: true })
    })

    it('applies metadata updates when version increases', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))

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
            getMachineEncryption: () => ({
                decryptMetadata,
                decryptDaemonState,
            }),
        })

        expect(updated).not.toBeNull()
        expect(decryptMetadata).toHaveBeenCalledTimes(1)
        expect(updated?.metadataVersion).toBe(6)
        expect(updated?.metadata).toEqual({ m: true })
    })

    it('returns null when machine encryption is unavailable', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: { machineId: 'm1' } as MachineUpdate,
            updateSeq: 5,
            updateCreatedAt: 100,
            existingMachine: buildMachine(),
            getMachineEncryption: () => null,
        })

        expect(updated).toBeNull()
        errorSpy.mockRestore()
    })

    it('keeps existing values when both metadata and daemonState updates are stale', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))
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
            getMachineEncryption: () => ({
                decryptMetadata,
                decryptDaemonState,
            }),
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
            getMachineEncryption: () => ({
                decryptMetadata,
                decryptDaemonState,
            }),
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
            getMachineEncryption: () => ({
                decryptMetadata,
                decryptDaemonState,
            }),
        })

        expect(updated).not.toBeNull()
        expect(decryptDaemonState).toHaveBeenCalledTimes(1)
        expect(updated?.daemonStateVersion).toBe(7)
        expect(updated?.daemonState).toEqual(existingMachine.daemonState)
        errorSpy.mockRestore()
    })
})
