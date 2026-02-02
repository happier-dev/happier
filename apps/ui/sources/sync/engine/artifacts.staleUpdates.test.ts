import { describe, expect, it, vi } from 'vitest'

const decryptHeader = vi.fn(async (_value: string) => ({ title: 't', sessions: [], draft: false }))
const decryptBody = vi.fn(async (_value: string) => ({ body: 'b' }))

vi.mock('../encryption/artifactEncryption', () => ({
    ArtifactEncryption: class ArtifactEncryptionMock {
        public constructor(_key: Uint8Array) {}

        public decryptHeader(value: string) {
            return decryptHeader(value)
        }

        public decryptBody(value: string) {
            return decryptBody(value)
        }
    },
}))

import { applySocketArtifactUpdate } from './artifacts'

describe('applySocketArtifactUpdate stale guards', () => {
    it('returns existing artifact unchanged when both updates are stale', async () => {
        const existingArtifact: any = {
            id: 'a1',
            title: 'old',
            sessions: [],
            draft: false,
            body: 'old-body',
            headerVersion: 10,
            bodyVersion: 20,
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            isDecrypted: true,
        }

        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 999,
            dataEncryptionKey: new Uint8Array([1]),
            header: { version: 10, value: 'h' },
            body: { version: 19, value: 'b' },
        })

        expect(res).toBe(existingArtifact)
        expect(decryptHeader).not.toHaveBeenCalled()
        expect(decryptBody).not.toHaveBeenCalled()
    })

    it('decrypts only newer fields and does not regress versions', async () => {
        decryptHeader.mockClear()
        decryptBody.mockClear()

        const existingArtifact: any = {
            id: 'a1',
            title: 'old',
            sessions: [],
            draft: false,
            body: 'old-body',
            headerVersion: 10,
            bodyVersion: 20,
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            isDecrypted: true,
        }

        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 999,
            dataEncryptionKey: new Uint8Array([1]),
            header: { version: 11, value: 'h-new' },
            body: { version: 20, value: 'b-stale' },
        })

        expect(res).not.toBe(existingArtifact)
        expect(decryptHeader).toHaveBeenCalledTimes(1)
        expect(decryptBody).not.toHaveBeenCalled()
        expect(res.headerVersion).toBe(11)
        expect(res.bodyVersion).toBe(20)
        expect(res.updatedAt).toBe(999)
    })
})
