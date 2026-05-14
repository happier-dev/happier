import { timingSafeEqual } from "node:crypto";
import tweetnacl from "tweetnacl";
import {
    ContentPublicKeyFingerprintSchema,
    computeContentPublicKeyFingerprint as computeProtocolContentPublicKeyFingerprint,
    decodeBase64,
    MachineInstallationProofV1Schema,
    MachineInstallationPublicKeySchema,
    MachineReplacementReasonSchema,
    verifyMachineInstallationProof,
    type MachineInstallationProofPayloadV1,
} from "@happier-dev/protocol";

export type VerifiedMachineInstallationIdentity = Readonly<{
    installationId: string;
    installationPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeyFingerprint: string | null;
    replacesMachineId: string | null;
}>;

export function computeContentPublicKeyFingerprint(contentPublicKey: Uint8Array): string {
    return computeProtocolContentPublicKeyFingerprint(contentPublicKey);
}

export function normalizeContentPublicKeyFingerprint(value: string | null): string | null {
    if (!value) return null;
    const parsed = ContentPublicKeyFingerprintSchema.safeParse(value.trim());
    return parsed.success ? parsed.data : null;
}

function decodeBase64UrlField(value: string, expectedLength: number): Uint8Array<ArrayBuffer> | null {
    try {
        const decoded = decodeBase64(value, "base64url");
        if (decoded.length !== expectedLength) return null;
        const bytes = new Uint8Array(decoded.byteLength);
        bytes.set(decoded);
        return bytes;
    } catch {
        return null;
    }
}

export function verifyMachineInstallationRegistration(params: Readonly<{
    accountId: string;
    machineId: string;
    installationId: string | null | undefined;
    installationPublicKey: string | null | undefined;
    installationProof: unknown;
    replacesMachineId: string | null | undefined;
    replacementReason: string | null | undefined;
    contentPublicKeyFingerprint: string | null;
}>): { ok: true; identity: VerifiedMachineInstallationIdentity | null } | { ok: false; reason: string } {
    const hasInstallationInput = Boolean(params.installationId || params.installationPublicKey || params.installationProof);
    if (!hasInstallationInput) {
        return { ok: true, identity: null };
    }

    const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
    const installationPublicKeyInput = typeof params.installationPublicKey === "string" ? params.installationPublicKey.trim() : "";
    if (!installationId || !installationPublicKeyInput) {
        return { ok: false, reason: "installation_identity_required" };
    }

    const parsedInstallationPublicKey = MachineInstallationPublicKeySchema.safeParse(installationPublicKeyInput);
    if (!parsedInstallationPublicKey.success) {
        return { ok: false, reason: "installation_public_key_invalid" };
    }

    const installationPublicKey = decodeBase64UrlField(parsedInstallationPublicKey.data, tweetnacl.sign.publicKeyLength);
    if (!installationPublicKey) {
        return { ok: false, reason: "installation_public_key_invalid" };
    }

    const parsedProof = MachineInstallationProofV1Schema.safeParse(params.installationProof);
    if (!parsedProof.success) {
        return { ok: false, reason: "installation_proof_invalid" };
    }

    const replacesMachineId = typeof params.replacesMachineId === "string" && params.replacesMachineId.trim()
        ? params.replacesMachineId.trim()
        : null;
    const replacementReason = typeof params.replacementReason === "string" && params.replacementReason.trim()
        ? params.replacementReason.trim()
        : null;
    if (replacesMachineId) {
        const parsedReason = MachineReplacementReasonSchema.safeParse(replacementReason);
        if (!parsedReason.success) {
            return { ok: false, reason: "replacement_reason_invalid" };
        }
    }
    const contentPublicKeyFingerprint = normalizeContentPublicKeyFingerprint(params.contentPublicKeyFingerprint);
    if (params.contentPublicKeyFingerprint && !contentPublicKeyFingerprint) {
        return { ok: false, reason: "content_public_key_fingerprint_invalid" };
    }

    const payload: MachineInstallationProofPayloadV1 = {
        version: 1,
        installationId,
        machineId: params.machineId,
        ...(replacesMachineId ? { replacesMachineId } : null),
        ...(replacesMachineId && replacementReason ? { replacementReason } : null),
        ...(contentPublicKeyFingerprint ? { contentPublicKeyFingerprint } : null),
        accountId: params.accountId,
    };

    const verified = verifyMachineInstallationProof({
        payload,
        proof: parsedProof.data,
        publicKey: parsedInstallationPublicKey.data,
    });
    if (!verified) {
        return { ok: false, reason: "installation_proof_invalid" };
    }

    return {
        ok: true,
        identity: {
            installationId,
            installationPublicKey,
            contentPublicKeyFingerprint,
            replacesMachineId,
        },
    };
}

export function machineInstallationPublicKeysEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
    if (!a || !b) return false;
    if (a.byteLength !== b.byteLength) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
