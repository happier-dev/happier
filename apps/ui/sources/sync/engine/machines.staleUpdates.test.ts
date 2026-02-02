import { describe, expect, it, vi } from 'vitest'

import { buildUpdatedMachineFromSocketUpdate } from './machines'

describe('buildUpdatedMachineFromSocketUpdate stale guards', () => {
    it('ignores stale metadata updates and still applies newer daemonState updates', async () => {
        const decryptMetadata = vi.fn(async () => ({ m: true }))
        const decryptDaemonState = vi.fn(async () => ({ d: true }))

        const existingMachine: any = {
            id: 'm1',
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: { existing: true },
            metadataVersion: 5,
            daemonState: { existing: true },
            daemonStateVersion: 7,
        }

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                metadata: { value: 'meta', version: 5 },
                daemonState: { value: 'state', version: 8 },
            },
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

        const existingMachine: any = {
            id: 'm1',
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: { existing: true },
            metadataVersion: 5,
            daemonState: null,
            daemonStateVersion: 0,
        }

        const updated = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate: {
                machineId: 'm1',
                metadata: { value: 'meta', version: 6 },
            },
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
})

