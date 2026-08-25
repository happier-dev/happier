import { describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import {
    createDirectRouteGrantSigningInputV1,
    createDirectRouteGrantSigningInputV2,
} from "@happier-dev/protocol";

import {
    mintDirectRouteGrantV1,
    mintDirectRouteGrantV2,
    resolvePeerMediationGrantSigningConfig,
} from "./mintDirectRouteGrantV1";

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

const seed = new Uint8Array(32).fill(4);
const keyPair = tweetnacl.sign.keyPair.fromSeed(seed);

describe("mintDirectRouteGrantV1", () => {
    it("mints a strict V2 grant binding the caller ephemeral public key", () => {
        const ephemeralKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const minted = mintDirectRouteGrantV2({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "machine_rpc",
            routeKind: "loopback_direct",
            scope: {
                kind: "machine_rpc",
                rpcScopeId: "rpc_1",
                allowedMethods: ["daemon.memory.status"],
                maxCalls: 1,
                maxIdleMs: 1_000,
            },
            endpointFingerprint: "endpoint_1",
            ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
            nowMs: 1_000,
            ttlMs: 60_000,
            serverGateEnabled: true,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey },
        });

        expect(minted).toMatchObject({
            ok: true,
            grant: {
                payload: {
                    v: 2,
                    proofKind: "ephemeral_ed25519",
                    ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
                },
            },
        });
        if (!minted.ok) throw new Error("expected V2 grant");
        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createDirectRouteGrantSigningInputV2(minted.grant.payload), "utf8"),
            Buffer.from(minted.grant.signature.valueBase64Url, "base64url"),
            keyPair.publicKey,
        )).toBe(true);
    });

    it("mints a signed bounded-transfer grant only when server policy allows direct route use", () => {
        const minted = mintDirectRouteGrantV1({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "bounded_transfer",
            routeKind: "loopback_direct",
            scope: {
                kind: "bounded_transfer",
                mode: "single",
                transferId: "transfer_1",
                maxBytes: 1024,
            },
            endpointFingerprint: "endpoint_1",
            nowMs: 1_000,
            ttlMs: 600_000,
            serverGateEnabled: true,
            signingKey: {
                keyId: "key_1",
                secretKey: keyPair.secretKey,
            },
        });

        expect(minted).toEqual(expect.objectContaining({
            ok: true,
            receipt: "peer.route_grant.minted",
        }));
        if (!minted.ok) throw new Error("expected grant");
        const signingInput = Buffer.from(createDirectRouteGrantSigningInputV1(minted.grant.payload), "utf8");
        expect(tweetnacl.sign.detached.verify(
            signingInput,
            Buffer.from(minted.grant.signature.valueBase64Url, "base64url"),
            keyPair.publicKey,
        )).toBe(true);
    });

    it("rejects disabled server policy, server relay, and production machine RPC grants", () => {
        const base = {
            accountId: "account_1",
            machineId: "machine_1",
            scope: {
                kind: "bounded_transfer",
                mode: "single",
                transferId: "transfer_1",
                maxBytes: 1024,
            },
            nowMs: 1_000,
            ttlMs: 600_000,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey },
        } as const;

        expect(mintDirectRouteGrantV1({
            ...base,
            flowKind: "bounded_transfer",
            routeKind: "loopback_direct",
            serverGateEnabled: false,
        })).toEqual({ ok: false, reasonCode: "blocked_by_server_policy", receipt: "peer.route_grant.rejected" });

        expect(mintDirectRouteGrantV1({
            ...base,
            flowKind: "bounded_transfer",
            routeKind: "server_relay",
            serverGateEnabled: true,
        })).toEqual({ ok: false, reasonCode: "server_relay_not_grantable", receipt: "peer.route_grant.rejected" });

        expect(mintDirectRouteGrantV1({
            ...base,
            flowKind: "machine_rpc",
            routeKind: "loopback_direct",
            scope: {
                kind: "machine_rpc",
                rpcScopeId: "rpc_1",
                allowedMethods: ["session.write"],
                maxCalls: 1,
                maxIdleMs: 1000,
            },
            serverGateEnabled: true,
        })).toEqual({ ok: false, reasonCode: "machine_rpc_requires_pms5_classification", receipt: "peer.route_grant.rejected" });
    });

    it("rejects non-positive route grant TTLs", () => {
        expect(mintDirectRouteGrantV1({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "bounded_transfer",
            routeKind: "loopback_direct",
            scope: {
                kind: "bounded_transfer",
                mode: "single",
                transferId: "transfer_1",
                maxBytes: 1024,
            },
            nowMs: 1_000,
            ttlMs: 0,
            serverGateEnabled: true,
            signingKey: {
                keyId: "key_1",
                secretKey: keyPair.secretKey,
            },
        })).toEqual({ ok: false, reasonCode: "invalid_ttl", receipt: "peer.route_grant.rejected" });
    });

    it("resolves signing config from env without generating production keys", () => {
        const resolved = resolvePeerMediationGrantSigningConfig({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(seed),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: "1900000000000",
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual(expect.objectContaining({
            ok: true,
            keyId: "key_1",
            capability: {
                keyId: "key_1",
                publicKey: toBase64Url(keyPair.publicKey),
                expiresAt: 1_900_000_000_000,
            },
        }));
    });

    it("rejects malformed base64url private keys that Node would otherwise decode permissively", () => {
        const resolved = resolvePeerMediationGrantSigningConfig({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: `${"A".repeat(43)}$`,
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual({
            ok: false,
            reasonCode: "invalid_private_key",
        });
    });

    it("rejects configured public keys that do not match the derived signing public key", () => {
        const resolved = resolvePeerMediationGrantSigningConfig({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(seed),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(new Uint8Array(32).fill(7)),
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual({
            ok: false,
            reasonCode: "invalid_public_key",
        });
    });
});
