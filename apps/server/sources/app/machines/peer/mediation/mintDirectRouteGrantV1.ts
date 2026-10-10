import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import {
    DirectRouteGrantScopeV1Schema,
    DirectRouteGrantScopeV2Schema,
    DirectRouteGrantPayloadV1Schema,
    DirectRouteGrantPayloadV2Schema,
    PEER_MEDIATION_RECEIPTS,
    createDirectRouteGrantSigningInputV1,
    createDirectRouteGrantSigningInputV2,
    validateMachineRpcGrantAllowedMethods,
    type AuthorizedPeerEndpointRouteKindV1,
    type DirectRouteGrantPayloadV1,
    type DirectRouteGrantSignatureV1,
    type DirectRouteGrantPayloadV2,
    type DirectRouteGrantScopeV1,
    type DirectRouteGrantScopeV2,
    type IrohPeerRouteBindingV2,
    type PeerFlowKindV1,
    type SignedDirectRouteGrantV1,
    type SignedDirectRouteGrantV2,
} from "@happier-dev/protocol";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';
import {
    createEd25519PublicKeyId,
    createEd25519SigningKeyPairFromSeed,
    deriveEd25519SigningSeed,
} from "@/app/crypto/derivedEd25519SigningKey";

const PEER_MEDIATION_ROUTE_GRANT_SIGNING_DOMAIN = "happier.machine-route-grant.v1";

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
        reasonCode:
        | "missing_key_id"
        | "missing_private_key"
        | "invalid_private_key"
        | "invalid_public_key"
        | "invalid_expiry"
        | "signing_key_expired";
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
        | "invalid_iroh_binding"
        | "iroh_requires_v2"
        | "signing_key_expired"
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
        expiresAt?: number | null;
    }>;
}>;

export type MintDirectRouteGrantV2Input = Omit<MintDirectRouteGrantV1Input, "scope" | "ttlMs"> & Readonly<{
    callerAuthority?: "present_user" | "account_automation";
    scope: DirectRouteGrantScopeV2;
    ttlMs: number | null;
    /** Required for `iroh_peer` grants: the signed machine/1 initiator/target relationship. */
    iroh?: IrohPeerRouteBindingV2;
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
        return createEd25519SigningKeyPairFromSeed(decoded).secretKey;
    }
    if (decoded.length === tweetnacl.sign.secretKeyLength) {
        return decoded;
    }
    return null;
}

function parseOptionalPositiveInt(raw: string | undefined):
    | Readonly<{ ok: true; value: number | null }>
    | Readonly<{ ok: false }> {
    if (typeof raw !== "string" || raw.trim().length === 0) return { ok: true, value: null };
    const parsed = Number(raw.trim());
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false };
    return { ok: true, value: parsed };
}

export function resolvePeerMediationGrantSigningConfig(
    env: NodeJS.ProcessEnv,
    nowMs: number = Date.now(),
): PeerMediationGrantSigningConfig {
    const explicitFields = [
        env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId],
        env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey],
        env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPublicKey],
        env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningExpiresAt],
    ];
    if (explicitFields.every((value) => value === undefined)
        && isPersonalHomeRuntimePurpose(env.HAPPIER_MANAGED_RELAY_PURPOSE)) {
        const masterSecret = (env.HANDY_MASTER_SECRET ?? "").trim();
        if (masterSecret) {
            const keyPair = createEd25519SigningKeyPairFromSeed(
                deriveEd25519SigningSeed(masterSecret, PEER_MEDIATION_ROUTE_GRANT_SIGNING_DOMAIN),
            );
            const keyId = createEd25519PublicKeyId(keyPair.publicKey);
            return {
                ok: true,
                keyId,
                secretKey: keyPair.secretKey,
                capability: {
                    keyId,
                    publicKey: toBase64Url(keyPair.publicKey),
                    expiresAt: null,
                },
            };
        }
    }

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
    const expiresAt = parseOptionalPositiveInt(env[FEATURE_ENV_KEYS.peerMediationRouteGrantSigningExpiresAt]);
    if (!expiresAt.ok) return { ok: false, reasonCode: "invalid_expiry" };
    if (expiresAt.value !== null && nowMs >= expiresAt.value) {
        return { ok: false, reasonCode: "signing_key_expired" };
    }

    return {
        ok: true,
        keyId,
        secretKey,
        capability: {
            keyId,
            publicKey: publicKeyBase64Url,
            expiresAt: expiresAt.value,
        },
    };
}

type MintDirectRouteGrantFailure = Extract<MintDirectRouteGrantV1Result, Readonly<{ ok: false }>>;

function rejectMint(reasonCode: MintDirectRouteGrantFailure["reasonCode"]): MintDirectRouteGrantFailure {
    return {
        ok: false,
        reasonCode,
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
    };
}

function validateDirectRouteGrantMintEnvelope(input: Omit<MintDirectRouteGrantV1Input, "scope">):
    | Readonly<{ ok: true; grantExpiresAt: number }>
    | MintDirectRouteGrantFailure {
    if (!input.serverGateEnabled) {
        return rejectMint("blocked_by_server_policy");
    }
    if (input.routeKind === "server_relay") {
        return rejectMint("server_relay_not_grantable");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        return rejectMint("invalid_ttl");
    }
    const requestedGrantExpiresAt = input.nowMs + input.ttlMs;
    if (!Number.isSafeInteger(requestedGrantExpiresAt)) {
        return rejectMint("invalid_ttl");
    }
    if (input.signingKey.expiresAt != null && input.nowMs >= input.signingKey.expiresAt) {
        return rejectMint("signing_key_expired");
    }
    const grantExpiresAt = input.signingKey.expiresAt == null
        ? requestedGrantExpiresAt
        : Math.min(requestedGrantExpiresAt, input.signingKey.expiresAt);

    return { ok: true, grantExpiresAt };
}

function validateDirectRouteGrantMintInput(input: MintDirectRouteGrantV1Input):
    | Readonly<{ ok: true; scope: DirectRouteGrantScopeV1; grantExpiresAt: number }>
    | MintDirectRouteGrantFailure {
    const envelope = validateDirectRouteGrantMintEnvelope(input);
    if (!envelope.ok) return envelope;
    const scope = DirectRouteGrantScopeV1Schema.safeParse(input.scope);
    if (!scope.success || scope.data.kind !== input.flowKind) {
        return rejectMint("invalid_scope");
    }
    if (scope.data.kind === "machine_rpc") {
        const methods = validateMachineRpcGrantAllowedMethods(scope.data.allowedMethods);
        if (!methods.ok) {
            return rejectMint(methods.reasonCode);
        }
    }
    return { ok: true, scope: scope.data, grantExpiresAt: envelope.grantExpiresAt };
}

function validateDirectRouteGrantV2MintInput(input: MintDirectRouteGrantV2Input):
    | Readonly<{ ok: true; scope: DirectRouteGrantScopeV2; grantExpiresAt: number | null }>
    | MintDirectRouteGrantFailure {
    const scope = DirectRouteGrantScopeV2Schema.safeParse(input.scope);
    if (!scope.success || scope.data.kind !== input.flowKind) {
        return rejectMint("invalid_scope");
    }
    if (input.ttlMs === null) {
        if (scope.data.kind !== 'tcp_tunnel' || !scope.data.preview || input.routeKind !== 'iroh_peer') return rejectMint('invalid_ttl');
        if (!input.serverGateEnabled) return rejectMint('blocked_by_server_policy');
        if (input.signingKey.expiresAt != null && input.nowMs >= input.signingKey.expiresAt) return rejectMint('signing_key_expired');
        return { ok: true, scope: scope.data, grantExpiresAt: null };
    }
    const envelope = validateDirectRouteGrantMintEnvelope({ ...input, ttlMs: input.ttlMs });
    if (!envelope.ok) return envelope;
    if (scope.data.kind === "machine_rpc") {
        const methods = validateMachineRpcGrantAllowedMethods(scope.data.allowedMethods);
        if (!methods.ok) {
            return rejectMint(methods.reasonCode);
        }
    }
    return { ok: true, scope: scope.data, grantExpiresAt: envelope.grantExpiresAt };
}

/** Neutral signing primitive. Key custody and public-root projection remain in
 * resolvePeerMediationGrantSigningConfig; application owners validate payloads.
 */
export function signRouteGrantPayload(input: Readonly<{
    signingInput: string;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
}>): DirectRouteGrantSignatureV1 {
    return {
        keyId: input.signingKey.keyId,
        alg: "Ed25519",
        valueBase64Url: toBase64Url(tweetnacl.sign.detached(Buffer.from(input.signingInput, "utf8"), input.signingKey.secretKey)),
    };
}

export function mintDirectRouteGrantV1(input: MintDirectRouteGrantV1Input): MintDirectRouteGrantV1Result {
    const validated = validateDirectRouteGrantMintInput(input);
    if (!validated.ok) return validated;
    if (input.routeKind === "server_relay") return rejectMint("server_relay_not_grantable");
    if (input.routeKind === "iroh_peer") {
        return rejectMint("iroh_requires_v2");
    }

    const payload: DirectRouteGrantPayloadV1 = {
        v: 1,
        grantId: `grant_${randomUUID()}`,
        grantFamilyId: `grant_family_${randomUUID()}`,
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: input.flowKind,
        routeKind: input.routeKind,
        scope: validated.scope,
        iat: input.nowMs,
        exp: validated.grantExpiresAt,
        aud: "happier-daemon-route-grant",
        ...(input.endpointFingerprint ? { endpointFingerprint: input.endpointFingerprint } : {}),
    };
    const payloadValidation = DirectRouteGrantPayloadV1Schema.safeParse(payload);
    if (!payloadValidation.success) {
        return {
            ok: false,
            reasonCode: "invalid_iroh_binding",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }

    return {
        ok: true,
        grant: {
            payload,
            signature: signRouteGrantPayload({ signingInput: createDirectRouteGrantSigningInputV1(payloadValidation.data), signingKey: input.signingKey }),
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}

export function mintDirectRouteGrantV2(input: MintDirectRouteGrantV2Input): MintDirectRouteGrantV2Result {
    const validated = validateDirectRouteGrantV2MintInput(input);
    if (!validated.ok) return validated;
    if (input.routeKind === "server_relay") return rejectMint("server_relay_not_grantable");

    const candidate: DirectRouteGrantPayloadV2 = {
        v: 2,
        grantId: `grant_${randomUUID()}`,
        grantFamilyId: `grant_family_${randomUUID()}`,
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: input.flowKind,
        routeKind: input.routeKind,
        scope: validated.scope,
        ...(input.callerAuthority ? { callerAuthority: input.callerAuthority } : {}),
        iat: input.nowMs,
        exp: validated.grantExpiresAt,
        aud: "happier-daemon-route-grant",
        ...(input.endpointFingerprint ? { endpointFingerprint: input.endpointFingerprint } : {}),
        ...(input.iroh ? { iroh: input.iroh } : {}),
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
    return {
        ok: true,
        grant: {
            payload: parsed.data,
            signature: signRouteGrantPayload({ signingInput: createDirectRouteGrantSigningInputV2(parsed.data), signingKey: input.signingKey }),
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}
