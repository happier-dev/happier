import { createHash } from "node:crypto";
import {
    createPluginInstallationManifestPublisherSigningInputV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    PluginInstallationManifestPublisherHeaderV1Schema,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    type PluginInstallationManifestPublisherHeaderV1,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";

const DEFAULT_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS = 60_000;

export class PluginInstallationPublisherProofError extends Error {
    readonly code:
        | "required"
        | "invalid"
        | "expired";

    constructor(code: PluginInstallationPublisherProofError["code"], message: string) {
        super(message);
        this.name = "PluginInstallationPublisherProofError";
        this.code = code;
    }
}

export type VerifiedPluginInstallationPublisher = Readonly<{
    machineId: string;
    installationId: string;
}>;

export function readPluginInstallationPublisherHeaderValue(
    headers: Record<string, string | string[] | undefined> | undefined,
): string | null {
    const value = headers?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]
        ?? headers?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0] ?? null;
    }
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readPluginInstallationPublisherHeader(
    headers: Record<string, string | string[] | undefined> | undefined,
): PluginInstallationManifestPublisherHeaderV1 | null {
    const raw = readPluginInstallationPublisherHeaderValue(headers);
    if (!raw) return null;
    try {
        const decoded = Buffer.from(raw, "base64url").toString("utf8");
        return PluginInstallationManifestPublisherHeaderV1Schema.parse(JSON.parse(decoded));
    } catch {
        throw new PluginInstallationPublisherProofError(
            "invalid",
            "Invalid plugin installation publisher proof",
        );
    }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createPublisherBodyHash(body: unknown): string {
    return createHash("sha256")
        .update(stringifyPluginInstallationManifestCanonicalJsonV1(body ?? null))
        .digest("base64url");
}

function assertPublisherProofFresh(proof: PluginInstallationManifestPublisherHeaderV1["proof"]): void {
    const now = Date.now();
    const maxAgeMs = readPositiveIntegerEnv(
        "HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS",
        DEFAULT_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS,
    );
    const clockSkewMs = readPositiveIntegerEnv(
        "HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS",
        DEFAULT_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS,
    );
    if (proof.issuedAt > now + clockSkewMs || now - proof.issuedAt > maxAgeMs) {
        throw new PluginInstallationPublisherProofError(
            "expired",
            "Plugin installation publisher proof is expired",
        );
    }
}

export async function verifyPluginInstallationPublisherHeader(params: Readonly<{
    accountId: string;
    request: Readonly<{
        method?: string;
        headers?: Record<string, string | string[] | undefined>;
        body?: unknown;
    }>;
    path: string;
    required?: boolean;
}>): Promise<VerifiedPluginInstallationPublisher | null> {
    const header = readPluginInstallationPublisherHeader(params.request.headers);
    if (!header) {
        if (params.required) {
            throw new PluginInstallationPublisherProofError(
                "required",
                "Plugin installation publisher proof is required",
            );
        }
        return null;
    }
    const { proof } = header;
    assertPublisherProofFresh(proof);
    if (proof.method !== "POST" || params.request.method !== "POST" || proof.path !== params.path) {
        throw new PluginInstallationPublisherProofError(
            "invalid",
            "Plugin installation publisher proof request binding is invalid",
        );
    }
    if (proof.bodySha256Base64Url !== createPublisherBodyHash(params.request.body ?? null)) {
        throw new PluginInstallationPublisherProofError(
            "invalid",
            "Plugin installation publisher proof body binding is invalid",
        );
    }
    const machine = await db.machine.findFirst({
        where: {
            accountId: params.accountId,
            id: proof.machineId,
        },
        select: {
            installationId: true,
            installationPublicKey: true,
            replacedByMachineId: true,
            revokedAt: true,
        },
    });
    if (
        !machine
        || machine.revokedAt
        || machine.replacedByMachineId
        || machine.installationId !== proof.installationId
        || !machine.installationPublicKey
    ) {
        throw new PluginInstallationPublisherProofError(
            "invalid",
            "Plugin installation publisher proof machine is not trusted",
        );
    }
    const publicKey = new Uint8Array(machine.installationPublicKey);
    const signature = Buffer.from(proof.signatureBase64Url, "base64url");
    if (
        publicKey.length !== tweetnacl.sign.publicKeyLength
        || signature.length !== tweetnacl.sign.signatureLength
    ) {
        throw new PluginInstallationPublisherProofError(
            "invalid",
            "Plugin installation publisher proof signature is invalid",
        );
    }
    const verified = tweetnacl.sign.detached.verify(
        createPluginInstallationManifestPublisherSigningInputV1({
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
        }),
        new Uint8Array(signature),
        publicKey,
    );
    if (!verified) {
        throw new PluginInstallationPublisherProofError(
            "invalid",
            "Plugin installation publisher proof signature is invalid",
        );
    }
    return {
        machineId: proof.machineId,
        installationId: proof.installationId,
    };
}
