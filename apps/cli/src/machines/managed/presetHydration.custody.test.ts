import fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createAccountScopedCryptoMaterialSnapshotV1, resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedMachinePresetForRecipientV1, transitionManagedMachinePresetContentEncryptionModeV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createManagedPresetHydrator } from './presetHydration';

async function withCustody(mode: 'plain' | 'e2ee', run: (fixture: Readonly<{
    hydrator: ReturnType<typeof createManagedPresetHydrator>;
    preset: ReturnType<typeof ManagedMachinePresetV1Schema.parse>;
    refuseCurrentness: (reason: 'unauthorized' | 'different-key') => void;
}>) => Promise<void>) {
    const app = fastify();
    const accountId = 'preset-owner';
    const serverUrl = 'http://preset-custody.test';
    const secret = new Uint8Array(32).fill(7);
    const crypto = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(crypto.contentPublicKeyFingerprint);
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
        encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret }, credentialProvenance: 'stored_session' as const };
    let refusal: 'unauthorized' | 'different-key' | undefined;
    app.get('/v1/account/encryption/currentness', async (_request, reply) => {
        if (refusal === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });
        return { mode: 'e2ee', version: 1, settingsVersion: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: refusal === 'different-key' ? `aemk1_${'A'.repeat(43)}` : fingerprint, updatedAt: 1 };
    });
    const plain = ManagedMachinePresetV1Schema.parse({ id: 'preset', homeId: 'srv_home', revision: 5,
        owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain', recipients: [], content: { t: 'plain', v: {
            v: 1, name: 'Kept image', launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
                schemaVersion: 1, name: 'Kept image', choices: {} },
        } } });
    const sealed = mode === 'e2ee' ? transitionManagedMachinePresetContentEncryptionModeV1({ presetId: plain.id,
        fromMode: 'plain', toMode: 'e2ee', source: projectManagedMachinePresetForRecipientV1({ ...plain, recipientAccountId: accountId }),
        accountId, targetContentPublicKey: libsodiumPublicKeyFromSecretKey(resolveAccountContentSecretKey(crypto.material)), randomBytes }) : null;
    if (mode === 'e2ee' && !sealed) throw new Error('Expected encrypted preset fixture');
    const preset = sealed ? ManagedMachinePresetV1Schema.parse({ ...plain, ...sealed, contentEncryptionMode: 'e2ee' }) : plain;
    // HTTP is the boundary; Account currentness, encryption and custody remain real.
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    try {
        await run({ hydrator: createManagedPresetHydrator({ credentials, serverUrl }), preset,
            refuseCurrentness: reason => { refusal = reason; } });
    } finally { restore(); await app.close(); secret.fill(0); }
}

it.each(['plain', 'e2ee'] as const)('preserves the typed operational failure after opening a preset (%s)', async mode => {
    await withCustody(mode, async ({ hydrator, preset }) => {
        // Same operational refusal as Archive's missing original executor guard.
        const failure = createActionExecuteFailureError({ ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' });
        let opened = false;
        await expect(hydrator.withPresetDefinition(preset, async content => {
            opened = content.name === 'Kept image';
            throw failure;
        })).rejects.toBe(failure);
        expect(opened).toBe(true);
    });
});

it('zeroes the ephemeral Account key when an admitted operation fails', async () => {
    await withCustody('e2ee', async ({ hydrator }) => {
        const failure = createActionExecuteFailureError({ ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' });
        let heldKey: Uint8Array | undefined;
        let keyWasAvailable = false;
        await expect(hydrator.withE2eeAccountKey(async ({ accountKey }) => {
            heldKey = accountKey;
            keyWasAvailable = accountKey.some(byte => byte !== 0);
            throw failure;
        })).rejects.toBe(failure);
        expect(keyWasAvailable).toBe(true);
        expect(heldKey).toEqual(new Uint8Array(32));
    });
});

it.each(['unauthorized', 'different-key'] as const)('refuses Account custody before entering the operation (%s)', async reason => {
    await withCustody('e2ee', async ({ hydrator, refuseCurrentness }) => {
        refuseCurrentness(reason);
        let entered = false;
        await expect(hydrator.withE2eeAccountKey(async () => { entered = true; })).rejects.toMatchObject({ code: 'credential_unavailable' });
        expect(entered).toBe(false);
    });
});
