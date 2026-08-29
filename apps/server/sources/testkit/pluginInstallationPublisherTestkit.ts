import { createHash } from "node:crypto";
import tweetnacl from "tweetnacl";
import {
    createPluginInstallationManifestPublisherSigningInputV1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";

/**
 * Shared integration fixtures for machine-installation publisher proofs.
 * They mirror the canonical `verifyPluginInstallationPublisherHeader`
 * contract — canonical body hash, publisher signing input, and the trusted
 * machine installation public key — so route fixtures cannot drift from the
 * publisher-proof owner the way per-spec local builders did.
 */

export function encodePluginInstallationPublisherHeader(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createSignedPluginInstallationPublisherHeader(params: Readonly<{
    keyPair: tweetnacl.SignKeyPair;
    machineId: string;
    installationId: string;
    path: string;
    body?: unknown;
    issuedAt?: number;
    nonce?: string;
}>): string {
    const proof = {
        v: 1 as const,
        alg: "ed25519-machine-installation-v1" as const,
        machineId: params.machineId,
        installationId: params.installationId,
        issuedAt: params.issuedAt ?? Date.now(),
        nonce: params.nonce ?? "nonce-1",
        method: "POST" as const,
        path: params.path,
        bodySha256Base64Url: createHash("sha256")
            .update(stringifyPluginInstallationManifestCanonicalJsonV1(params.body ?? null))
            .digest("base64url"),
        signatureBase64Url: "",
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
    return encodePluginInstallationPublisherHeader({
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(
                tweetnacl.sign.detached(signingInput, params.keyPair.secretKey),
            ).toString("base64url"),
        },
    });
}

export async function createTrustedMachineInstallation(params: Readonly<{
    accountId: string;
    machineId: string;
    installationId: string;
    keyPair: tweetnacl.SignKeyPair;
}>): Promise<void> {
    const installationPublicKey = new Uint8Array(tweetnacl.sign.publicKeyLength);
    installationPublicKey.set(params.keyPair.publicKey);
    await db.machine.create({
        data: {
            id: params.machineId,
            accountId: params.accountId,
            metadata: "{}",
            installationId: params.installationId,
            installationPublicKey,
        },
    });
}
