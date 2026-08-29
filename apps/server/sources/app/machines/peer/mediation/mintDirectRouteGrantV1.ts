import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import {
    DirectRouteGrantScopeV1Schema,
    DirectRouteGrantPayloadV2Schema,
    PEER_MEDIATION_RECEIPTS,
    createDirectRouteGrantSigningInputV1,
    createDirectRouteGrantSigningInputV2,
    validateMachineRpcGrantAllowedMethods,
    type AuthorizedPeerEndpointRouteKindV1,
    type DirectRouteGrantPayloadV1,
    type DirectRouteGrantPayloadV2,
    type DirectRouteGrantScopeV1,
    type PeerFlowKindV1,
    type SignedDirectRouteGrantV1,
    type SignedDirectRouteGrantV2,
} from "@happier-dev/protocol";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";

export type PeerMediationGrantSigningConfig =
    | Readonly<{
        ok: true;
        keyId: string;
        secretKey: Uint8Array;
        capability: Readonly<{
            keyId: string;
            publicKey: string;
            expiresAt: number | null;
        }>;
    }>
    | Readonly<{
        ok: false;
        reasonCode: "missing_key_id" | "missing_private_key" | "invalid_private_key" | "invalid_public_key";
    }>;

export type MintDirectRouteGrantV1Result =
    | Readonly<{
        ok: true;
        grant: SignedDirectRouteGrantV1;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantMinted;
    }>
    | Readonly<{
        ok: false;
        reasonCode:
        | "blocked_by_server_policy"
        | "server_relay_not_grantable"
        | "machine_rpc_requires_pms5_classification"
        | "machine_rpc_method_server_required"
        | "invalid_scope"
        | "invalid_ttl";
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantRejected;
    }>;

export type MintDirectRouteGrantV1Input = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: AuthorizedPeerEndpointRouteKindV1 | "server_relay";
    scope: DirectRouteGrantScopeV1;
    endpointFingerprint?: string;
    nowMs: number;
    ttlMs: number;
    serverGateEnabled: boolean;
    signingKey: Readonly<{
        keyId: string;
        secretKey: Uint8Array;
    }>;
}>;

export type MintDirectRouteGrantV2Input = MintDirectRouteGrantV1Input & Readonly<{
    ephemeralPublicKeyBase64Url: string;
}>;

export type MintDirectRouteGrantV2Result =
    | Readonly<{
        ok: true;
        grant: SignedDirectRouteGrantV2;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantMinted;
    }>
    | Readonly<{
        ok: false;
        reasonCode: Extract<MintDirectRouteGrantV1Result, Readonly<{ ok: false }>>["reasonCode"];
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantRejected;
    }>;

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
        return null;
    }
    try {
        const decoded = Buffer.from(value, "base64url");
        return Buffer.from(decoded).toString("base64url") === value ? decoded : null;
    } catch {
        return null;
    }
}

function normalizeSigningSecretKey(privateKeyBase64Url: string): Uint8Array | null {
    const decoded = decodeBase64Url(privateKeyBase64Url);
    if (!decoded) return null;
    if (decoded.length === tweetnacl.sign.seedLength) {
        return tweetnacl.sign.keyPair.fromSeed(decoded).secretKey;
    }
    if (decoded.length === tweetnacl.sign.secretKeyLength) {
        return decoded;
    }
    return null;
}

function parseOptionalPositiveInt(raw: string | undefined): number | null {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed)) return null;
    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : null;
}

export function resolvePeerMediationGrantSigningConfig(
    env: NodeJS.ProcessEnv,
): PeerMediationGrantSigningConfig {
    const keyId = env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]?.trim() ?? "";
    if (!keyId) return { ok: false, reasonCode: "missing_key_id" };

    const privateKey = env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]?.trim() ?? "";
    if (!privateKey) return { ok: false, reasonCode: "missing_private_key" };

    const secretKey = normalizeSigningSecretKey(privateKey);
    if (!secretKey) return { ok: false, reasonCode: "invalid_private_key" };

    const publicKey = tweetnacl.sign.keyPair.fromSecretKey(secretKey).publicKey;
    const publicKeyBase64Url = toBase64Url(publicKey);
    const configuredPublicKey = env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPublicKey]?.trim() ?? "";
    if (configuredPublicKey) {
        const decodedPublicKey = decodeBase64Url(configuredPublicKey);
        if (!decodedPublicKey || decodedPublicKey.length !== tweetnacl.sign.publicKeyLength) {
            return { ok: false, reasonCode: "invalid_public_key" };
        }
        if (toBase64Url(decodedPublicKey) !== publicKeyBase64Url) {
            return { ok: false, reasonCode: "invalid_public_key" };
        }
    }

    return {
        ok: true,
        keyId,
        secretKey,
        capability: {
            keyId,
            publicKey: publicKeyBase64Url,
            expiresAt: parseOptionalPositiveInt(env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningExpiresAt]),
        },
    };
}

export function mintDirectRouteGrantV1(input: MintDirectRouteGrantV1Input): MintDirectRouteGrantV1Result {
    if (!input.serverGateEnabled) {
        return {
            ok: false,
            reasonCode: "blocked_by_server_policy",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (input.routeKind === "server_relay") {
        return {
            ok: false,
            reasonCode: "server_relay_not_grantable",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        return {
            ok: false,
            reasonCode: "invalid_ttl",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }

    const scope = DirectRouteGrantScopeV1Schema.safeParse(input.scope);
    if (!scope.success || scope.data.kind !== input.flowKind) {
        return {
            ok: false,
            reasonCode: "invalid_scope",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (scope.data.kind === "machine_rpc") {
        const methods = validateMachineRpcGrantAllowedMethods(scope.data.allowedMethods);
        if (!methods.ok) {
            return {
                ok: false,
                reasonCode: methods.reasonCode,
                receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
            };
        }
    }

    const payload: DirectRouteGrantPayloadV1 = {
        v: 1,
        grantId: `grant_${randomUUID()}`,
        grantFamilyId: `grant_family_${randomUUID()}`,
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: input.flowKind,
        routeKind: input.routeKind,
        scope: scope.data,
        iat: input.nowMs,
        exp: input.nowMs + input.ttlMs,
        aud: "happier-daemon-route-grant",
        ...(input.endpointFingerprint ? { endpointFingerprint: input.endpointFingerprint } : {}),
    };
    const signingInput = Buffer.from(createDirectRouteGrantSigningInputV1(payload), "utf8");
    const signature = tweetnacl.sign.detached(signingInput, input.signingKey.secretKey);

    return {
        ok: true,
        grant: {
            payload,
            signature: {
                keyId: input.signingKey.keyId,
                alg: "Ed25519",
                valueBase64Url: toBase64Url(signature),
            },
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}

export function mintDirectRouteGrantV2(input: MintDirectRouteGrantV2Input): MintDirectRouteGrantV2Result {
    const validated = mintDirectRouteGrantV1(input);
    if (!validated.ok) return validated;

    const candidate: DirectRouteGrantPayloadV2 = {
        ...validated.grant.payload,
        v: 2,
        proofKind: "ephemeral_ed25519",
        ephemeralPublicKeyBase64Url: input.ephemeralPublicKeyBase64Url,
    };
    const parsed = DirectRouteGrantPayloadV2Schema.safeParse(candidate);
    if (!parsed.success) {
        return {
            ok: false,
            reasonCode: "invalid_scope",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    const signature = tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV2(parsed.data), "utf8"),
        input.signingKey.secretKey,
    );
    return {
        ok: true,
        grant: {
            payload: parsed.data,
            signature: {
                keyId: input.signingKey.keyId,
                alg: "Ed25519",
                valueBase64Url: toBase64Url(signature),
            },
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}
