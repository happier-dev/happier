import { describe, expect, it } from 'vitest'
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes'
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption'
import { Encryption } from '@/sync/encryption/encryption'
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope'
import { decodeBase64 } from '@/encryption/base64'
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol'
import tweetnacl from 'tweetnacl'
import { buildNewArtifactUpdate, buildUpdateArtifactUpdate } from '../../../../../server/sources/app/events/artifactEventPayloadBuilders'
const key = new Uint8Array(32).fill(1)
const codec = new ArtifactEncryption(key)

import { applySocketArtifactUpdate, decryptSocketNewArtifactUpdate, handleUpdateArtifactSocketUpdate, type ArtifactDataKeyCache } from './syncArtifacts'

function buildArtifact(
    overrides: Partial<Extract<DecryptedArtifact, { isDecrypted: true }>> = {},
): DecryptedArtifact {
    return {
        id: 'a1',
        title: 'old',
        header: { title: 'old' },
        rawHeader: { title: 'old' },
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
    it('opens production new and body-update events on a second device with independent private custody', async () => {
        const recipient = tweetnacl.box.keyPair()
        const encryption = await Encryption.createFromContentKeyPair({ publicKey: recipient.publicKey, machineKey: recipient.secretKey })
        const privateKey = tweetnacl.randomBytes(32)
        const wrap = (dataKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: recipient.publicKey, randomBytes: tweetnacl.randomBytes,
        }))
        const actor = { savedBy: { kind: 'person' as const, accountId: 'owner' } }
        const artifact = { id: 'a1', seq: 1, header: decodeBase64(await codec.encryptHeader({ title: 'Shared' }), 'base64'),
            headerVersion: 1, body: decodeBase64(await codec.encryptBody({ body: 'First' }), 'base64'), bodyVersion: 1,
            dataEncryptionKey: wrap(key), provenance: decodeBase64(await sealArtifactPrivateRevisionMetadata({
                mode: 'e2ee', artifactId: 'a1', bodyVersion: 1, provenance: actor, dataKey: privateKey,
            }), 'base64'), provenanceDataEncryptionKey: wrap(privateKey), createdAt: new Date(1), updatedAt: new Date(2) }
        const created = buildNewArtifactUpdate(artifact, 1, 'created')
        if (created.body.t !== 'new-artifact') throw new Error('Expected Artifact create event')
        const artifactDataKeys: ArtifactDataKeyCache = new Map()
        let loaded = await decryptSocketNewArtifactUpdate({ ...created.body, encryption, artifactDataKeys })
        expect(loaded?.provenance).toEqual(actor)
        // The next event must deliver usable custody, not rely on a private-key cache.
        artifactDataKeys.set('a1', { dataKey: key, envelope: created.body.dataEncryptionKey })

        const nextActor = { savedBy: { kind: 'agent' as const, accountId: 'editor', sessionId: 'session-agent' } }
        const provenance = await sealArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId: 'a1', bodyVersion: 2,
            provenance: nextActor, dataKey: privateKey })
        const updated = buildUpdateArtifactUpdate('a1', 2, 'updated', undefined,
            { value: await codec.encryptBody({ body: 'Second' }), version: 2 },
            { provenance: decodeBase64(provenance, 'base64'), provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey })
        if (updated.body.t !== 'update-artifact') throw new Error('Expected Artifact body event')
        await handleUpdateArtifactSocketUpdate({ ...updated.body, createdAt: updated.createdAt, encryption, artifactDataKeys,
            getExistingArtifact: () => loaded ?? undefined, updateArtifact: value => { loaded = value },
            invalidateArtifactsSync: () => { throw new Error('Readable event must apply without refresh') }, log: { log: () => {} } })
        expect(loaded).toMatchObject({ body: 'Second', bodyVersion: 2, provenance: nextActor, isDecrypted: true })
    })

    it('returns existing artifact unchanged when both updates are stale', async () => {
        const existingArtifact = buildArtifact()

        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 999,
            dataEncryptionKey: key,
            header: { version: 10, value: 'h' },
            body: { version: 19, value: 'b' },
        })

        expect(res).toBe(existingArtifact)
    })

    it('decrypts only newer fields and does not regress versions', async () => {
        const existingArtifact = buildArtifact()

        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 999,
            dataEncryptionKey: key,
            header: { version: 11, value: await codec.encryptHeader({ title: 'new' }) },
            body: { version: 20, value: 'b-stale' },
        })

        expect(res).not.toBe(existingArtifact)
        expect(res.title).toBe('new')
        expect(res.rawHeader).toEqual({ title: 'new' })
        expect(res.body).toBe('old-body')
        expect(res.headerVersion).toBe(11)
        expect(res.bodyVersion).toBe(20)
        expect(res.updatedAt).toBe(999)
    })

    it('applies a newer body update when header is stale and leaves header fields unchanged', async () => {
        const existingArtifact = buildArtifact({ provenance: { savedBy: { kind: 'person', accountId: 'owner' } } })

        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 1000,
            dataEncryptionKey: key,
            header: { version: 10, value: 'header-stale' },
            body: { version: 21, value: await codec.encryptBody({ body: 'b' }) },
        })

        expect(res).not.toBe(existingArtifact)
        expect(res.rawHeader).toBe(existingArtifact.rawHeader)
        expect(res.title).toBe('old')
        expect(res.body).toBe('b')
        expect(res.headerVersion).toBe(10)
        expect(res.bodyVersion).toBe(21)
        expect(res.provenance).toBe(existingArtifact.provenance)
        const withoutPrivateCustody = await applySocketArtifactUpdate({ existingArtifact: res, createdAt: 1001,
            dataEncryptionKey: key, body: { version: 22, value: await codec.encryptBody({ body: 'c' }) }, provenance: null })
        expect(withoutPrivateCustody.provenance).toBe(existingArtifact.provenance)
    })

    it('returns existing artifact when no newer header/body fields are provided', async () => {
        const existingArtifact = buildArtifact()
        const res = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 5000,
            dataEncryptionKey: key,
            header: null,
            body: undefined,
        })

        expect(res).toBe(existingArtifact)
    })

    it('refuses an encrypted update without its resource key', async () => {
        const existingArtifact = buildArtifact()

        await expect(
            applySocketArtifactUpdate({
                existingArtifact,
                createdAt: 1001,
                dataEncryptionKey: null,
                header: { version: 11, value: await codec.encryptHeader({ title: 'new' }) },
                body: { version: 20, value: 'body-stale' },
            }),
        ).rejects.toThrow('Artifact encryption key is unavailable')
    })
})
