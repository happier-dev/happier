import tweetnacl from 'tweetnacl';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { StoredCredentials } from '@/persistence';

/** Canonical wire producers for the Home material boundary, including real E2EE envelopes. */
export function createSecretUseMaterialFixture(mode: 'plain' | 'e2ee', input: Readonly<{
    accountId: string; resourceId: string; value: string; revision: number; keyless?: boolean; use?: boolean;
}>) {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: input.accountId })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const resourceDataKey = new Uint8Array(32).fill(11);
    const credentials: StoredCredentials = { token,
        encryption: mode === 'plain' || input.keyless ? null : { type: 'dataKey', machineKey, publicKey } };
    const content = { v: 1 as const, name: 'Provider token', kind: 'token' as const, value: input.value };
    const storedContent = mode === 'plain'
        ? sealSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'plain', content })
        : sealSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'e2ee', content, resourceDataKey,
            randomBytes: length => new Uint8Array(length).fill(12) });
    const ref = `happier:shared-secret:v1:${input.resourceId}`;
    const resources = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId: input.resourceId, encryptionMode: mode, storedContent,
        recipientEnvelope: mode === 'plain' ? null : {
            encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey, recipientPublicKey: publicKey,
                randomBytes: length => new Uint8Array(length).fill(13) })).toString('base64'),
            recipientContentPublicKeyFingerprint: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                material: { type: 'dataKey', machineKey }, dataKeyPublicKey: publicKey }).contentPublicKeyFingerprint,
        }, entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: input.accountId, name: content.name, kind: 'token',
            revision: input.revision, materialStatus: 'ready', capabilities: { use: input.use ?? true, rename: true, rotate: true, manageAccess: true, delete: true } } }] });
    return { credentials, content, resources, accountMaterial: { type: 'dataKey' as const, machineKey, publicKey } };
}
