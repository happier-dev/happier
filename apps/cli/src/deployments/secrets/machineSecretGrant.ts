import { randomBytes } from 'node:crypto';
import { z } from 'zod/mini';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { sealMachineSecretGrantEnvelopeV1 } from '@happier-dev/deployments';
import {
    DeploymentNonSecretVariableBindingSourceV1Schema,
    MachineSecretGrantSubjectV1Schema, MachineSecretGrantV1Schema, machineSecretGrantSubjectKey,
    type MachineSecretGrantSubjectV1, type MachineSecretGrantV1,
} from '@happier-dev/deployment-protocol';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxPublicKeyFromEd25519PublicKey, deriveBoxSecretKeyFromSeed,
    openBoxBundleWithSecretKey, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';

const contentSchema = z.discriminatedUnion('kind', [
    // Retained development ciphertext may carry its historical uses list.
    // Drop those fields here; current binding admission owns use permissions.
    z.object({ kind: z.literal('secret'), value: z.string() }),
    z.strictObject({ kind: z.literal('environmentValues'), definition: DeploymentNonSecretVariableBindingSourceV1Schema }),
    z.strictObject({ kind: z.literal('connectorToken'), token: z.string().check(z.minLength(1)) }),
]);
export type MachineSecretGrantContentV1 = z.infer<typeof contentSchema>;
const envelopeSchema = z.strictObject({ subject: MachineSecretGrantSubjectV1Schema, content: contentSchema });

/** Uses the installed signing identity's established box conversion, never another keypair. */
export function sealMachineSecretGrant(input: Readonly<{
    subject: MachineSecretGrantSubjectV1;
    installationPublicKey: Uint8Array;
    content: MachineSecretGrantContentV1;
}>): MachineSecretGrantV1 {
    const admitted = envelopeSchema.safeParse({ subject: input.subject, content: input.content });
    if (!admitted.success || admitted.data.subject.kind !== admitted.data.content.kind) {
        throw new PluginError({ code: 'secret_missing', message: 'Installation grant subject is unavailable' });
    }
    return sealMachineSecretGrantEnvelopeV1({ ...admitted.data, seal: plaintext => {
        const recipientPublicKey = deriveBoxPublicKeyFromEd25519PublicKey(input.installationPublicKey);
        return encodeBase64(sealBoxBundle({ plaintext, recipientPublicKey,
            randomBytes: length => new Uint8Array(randomBytes(length)) }));
    } });
}

/** The exact subject is authenticated inside the sealed plaintext. */
export function openMachineSecretGrant(input: Readonly<{
    grant: MachineSecretGrantV1;
    machineId: string;
    installationId: string;
    installationPrivateSeed: Uint8Array;
}>): MachineSecretGrantContentV1 | null {
    let plaintext: Uint8Array | null = null;
    let recipientSecretKey: Uint8Array | undefined;
    try {
        const parsed = MachineSecretGrantV1Schema.safeParse(input.grant);
        if (!parsed.success || input.installationPrivateSeed.length !== 32
            || parsed.data.machineId !== input.machineId || parsed.data.installationId !== input.installationId) return null;
        recipientSecretKey = deriveBoxSecretKeyFromSeed(input.installationPrivateSeed);
        plaintext = openBoxBundleWithSecretKey({ bundle: decodeBase64(parsed.data.sealedContent), recipientSecretKey });
        if (!plaintext) return null;
        const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
        const opened = envelopeSchema.safeParse(decoded);
        if (!opened.success || machineSecretGrantSubjectKey(opened.data.subject) !== machineSecretGrantSubjectKey(parsed.data)
            || opened.data.subject.kind !== opened.data.content.kind) return null;
        return opened.data.content;
    } catch {
        // Neither parser errors nor authenticated private plaintext are outward diagnostics.
        return null;
    } finally {
        plaintext?.fill(0);
        recipientSecretKey?.fill(0);
    }
}
