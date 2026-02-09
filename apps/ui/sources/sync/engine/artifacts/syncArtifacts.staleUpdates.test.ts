import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes'

const decryptHeader = vi.fn(async (_value: string) => ({ title: 't', sessions: [], draft: false }))
const decryptBody = vi.fn(async (_value: string) => ({ body: 'b' }))

vi.mock('@/sync/encryption/artifactEncryption', () => ({
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

import { applySocketArtifactUpdate } from './syncArtifacts'

function buildArtifact(overrides: Partial<DecryptedArtifact> = {}): DecryptedArtifact {
    return {
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
        ...overrides,
    }
}

describe('applySocketArtifactUpdate stale guards', () => {
    beforeEach(() => {
        decryptHeader.mockClear()
        decryptBody.mockClear()
        decryptHeader.mockImplementation(async (_value: string) => ({ title: 't', sessions: [], draft: false }))
        decryptBody.mockImplementation(async (_value: string) => ({ body: 'b' }))
    })

    it('returns existing artifact unchanged when both updates are stale', async () => {
        const existingArtifact = buildArtifact()

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
        const existingArtifact = buildArtifact()

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

    it('applies a newer body update when header is stale and leaves header fields unchanged', async () => {
        const existingArtifact = buildArtifact()

        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 1000,
            dataEncryptionKey: new Uint8Array([1]),
            header: { version: 10, value: 'header-stale' },
            body: { version: 21, value: 'body-new' },
        })

        expect(res).not.toBe(existingArtifact)
        expect(decryptHeader).not.toHaveBeenCalled()
        expect(decryptBody).toHaveBeenCalledTimes(1)
        expect(res.title).toBe('old')
        expect(res.body).toBe('b')
        expect(res.headerVersion).toBe(10)
        expect(res.bodyVersion).toBe(21)
    })

    it('returns existing artifact when no newer header/body fields are provided', async () => {
        const existingArtifact = buildArtifact()
        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 5000,
            dataEncryptionKey: new Uint8Array([1]),
            header: null,
            body: undefined,
        })

        expect(res).toBe(existingArtifact)
        expect(decryptHeader).not.toHaveBeenCalled()
        expect(decryptBody).not.toHaveBeenCalled()
    })

    it('propagates decryption failures for applicable newer fields', async () => {
        const existingArtifact = buildArtifact()
        decryptHeader.mockImplementation(async () => {
            throw new Error('decrypt header failed')
        })

        await expect(
            applySocketArtifactUpdate({
                existingArtifact,
                createdAt: 1001,
                dataEncryptionKey: new Uint8Array([1]),
                header: { version: 11, value: 'header-new' },
                body: { version: 20, value: 'body-stale' },
            }),
        ).rejects.toThrow('decrypt header failed')

        expect(decryptHeader).toHaveBeenCalledTimes(1)
        expect(decryptBody).not.toHaveBeenCalled()
    })
})
