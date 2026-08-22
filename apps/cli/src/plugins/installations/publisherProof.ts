import { createHash, randomUUID } from 'node:crypto';

import tweetnacl from 'tweetnacl';

import {
    createPluginInstallationManifestPublisherSigningInputV1,
    decodeBase64,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    type MachineInstallationIdentityV1,
} from '@happier-dev/protocol';

import { readCurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';

export type CreatePluginInstallationPublisherHeader = (request: Readonly<{
    method: 'POST';
    path: string;
    body: unknown;
}>) => Promise<string | null> | string | null;

function encodePublisherHeader(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signPluginInstallationPublisherHeader(params: Readonly<{
    identity: MachineInstallationIdentityV1;
    machineId: string;
    path: string;
    body: unknown;
}>): string {
    const proof = {
        v: 1 as const,
        alg: 'ed25519-machine-installation-v1' as const,
        machineId: params.machineId,
        installationId: params.identity.installationId,
        issuedAt: Date.now(),
        nonce: randomUUID(),
        method: 'POST' as const,
        path: params.path,
        bodySha256Base64Url: createHash('sha256')
            .update(stringifyPluginInstallationManifestCanonicalJsonV1(params.body ?? null))
            .digest('base64url'),
        signatureBase64Url: '',
    };
    const signingInput = createPluginInstallationManifestPublisherSigningInputV1({
        proof: {
            v: proof.v,
            alg: proof.alg,
            machineId: proof.machineId,
            installationId: proof.installationId,
            issuedAt: proof.issuedAt,
            nonce: proof.nonce,
            method: proof.method,
            path: proof.path,
            bodySha256Base64Url: proof.bodySha256Base64Url,
        },
    });
    const privateKey = decodeBase64(params.identity.privateKey, 'base64url');
    if (privateKey.length !== tweetnacl.sign.secretKeyLength) {
        throw new Error(`Invalid plugin installation publisher private key length: expected ${tweetnacl.sign.secretKeyLength} bytes`);
    }
    return encodePublisherHeader({
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(tweetnacl.sign.detached(signingInput, privateKey)).toString('base64url'),
        },
    });
}

export async function createDefaultPluginInstallationPublisherHeader(
    request: Parameters<CreatePluginInstallationPublisherHeader>[0],
): Promise<string | null> {
    const current = await readCurrentMachineInstallation();
    if (!current) {
        return null;
    }
    return signPluginInstallationPublisherHeader({
        identity: current.identity,
        machineId: current.machineId,
        path: request.path,
        body: request.body,
    });
}
