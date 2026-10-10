import { createHash, createHmac } from "node:crypto";
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
import { resolveAccountDirectorySigningKeyPair } from "@/app/accountDirectory/accountDirectorySigner";

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
            callerAuthority: "present_user",
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
                    callerAuthority: "present_user",
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

    it("mints a V2 iroh_peer grant carrying the signed machine/1 endpoint-role binding and proof key", () => {
        const ephemeralKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const minted = mintDirectRouteGrantV2({
            accountId: "account_1",
            machineId: "machine_target",
            flowKind: "bounded_transfer",
            routeKind: "iroh_peer",
            scope: {
                kind: "bounded_transfer",
                mode: "carrier",
            },
            endpointFingerprint: "b".repeat(64),
            iroh: {
                initiator: {
                    kind: "account_client",
                    endpointId: "a".repeat(64),
                },
                target: {
                    machineId: "machine_target",
                    endpointId: "b".repeat(64),
                },
                operationKind: "finite_transfer",
            },
            ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
            nowMs: 1_000,
            ttlMs: 600_000,
            serverGateEnabled: true,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey },
        });

        expect(minted).toEqual(expect.objectContaining({ ok: true }));
        if (!minted.ok) throw new Error("expected grant");
        expect(minted.grant.payload.iroh).toEqual({
            initiator: {
                kind: "account_client",
                endpointId: "a".repeat(64),
            },
            target: {
                machineId: "machine_target",
                endpointId: "b".repeat(64),
            },
            operationKind: "finite_transfer",
        });
        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createDirectRouteGrantSigningInputV2(minted.grant.payload), "utf8"),
            Buffer.from(minted.grant.signature.valueBase64Url, "base64url"),
            keyPair.publicKey,
        )).toBe(true);
    });

    it("rejects every V1 iroh_peer grant because machine/1 requires V2 proof", () => {
        expect(mintDirectRouteGrantV1({
            accountId: "account_1",
            machineId: "machine_target",
            flowKind: "bounded_transfer",
            routeKind: "iroh_peer",
            scope: {
                kind: "bounded_transfer",
                mode: "single",
                transferId: "transfer_1",
                maxBytes: 1024,
            },
            endpointFingerprint: "b".repeat(64),
            nowMs: 1_000,
            ttlMs: 600_000,
            serverGateEnabled: true,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey },
        })).toEqual({
            ok: false,
            reasonCode: "iroh_requires_v2",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("rejects an Account-client workspace-sync V2 grant at the canonical mint boundary", () => {
        expect(mintDirectRouteGrantV2({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "machine_rpc",
            routeKind: "iroh_peer",
            scope: {
                kind: "machine_rpc",
                rpcScopeId: "workspace_sync_1",
                allowedMethods: ["daemon.memory.status"],
                maxCalls: 1,
                maxIdleMs: 1_000,
            },
            endpointFingerprint: "b".repeat(64),
            iroh: {
                initiator: { kind: "account_client", endpointId: "a".repeat(64) },
                target: { machineId: "machine_1", endpointId: "b".repeat(64) },
                operationKind: "workspace_sync",
            },
            ephemeralPublicKeyBase64Url: toBase64Url(
                tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
            ),
            nowMs: 1_000,
            ttlMs: 600_000,
            serverGateEnabled: true,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey },
        })).toEqual({
            ok: false,
            reasonCode: "invalid_scope",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("caps grants at the signing trust-root expiry and refuses an expired root", () => {
        const base = {
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "bounded_transfer" as const,
            routeKind: "loopback_direct" as const,
            scope: {
                kind: "bounded_transfer" as const,
                mode: "single" as const,
                transferId: "transfer_1",
                maxBytes: 1024,
            },
            nowMs: 1_000,
            ttlMs: 600,
            serverGateEnabled: true,
        };
        const cappedV1 = mintDirectRouteGrantV1({
            ...base,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey, expiresAt: 1_500 },
        });
        expect(cappedV1).toMatchObject({ ok: true, grant: { payload: { exp: 1_500 } } });
        expect(mintDirectRouteGrantV1({
            ...base,
            ttlMs: 1,
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey, expiresAt: 1_000 },
        })).toEqual({
            ok: false,
            reasonCode: "signing_key_expired",
            receipt: "peer.route_grant.rejected",
        });

        const cappedV2 = mintDirectRouteGrantV2({
            ...base,
            routeKind: "iroh_peer",
            scope: {
                kind: "bounded_transfer",
                mode: "carrier",
            },
            endpointFingerprint: "b".repeat(64),
            iroh: {
                initiator: {
                    kind: "machine",
                    machineId: "machine_source",
                    endpointId: "a".repeat(64),
                },
                target: {
                    machineId: "machine_1",
                    endpointId: "b".repeat(64),
                },
                operationKind: "finite_transfer",
            },
            ephemeralPublicKeyBase64Url: toBase64Url(
                tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
            ),
            signingKey: { keyId: "key_1", secretKey: keyPair.secretKey, expiresAt: 1_500 },
        });
        expect(cappedV2).toMatchObject({ ok: true, grant: { payload: { exp: 1_500 } } });
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

    it("derives a stable usable signer for a managed Personal Home from its persisted master secret", () => {
        const env = {
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HANDY_MASTER_SECRET: "personal-home-route-grant-master-secret",
        } as NodeJS.ProcessEnv;

        const first = resolvePeerMediationGrantSigningConfig(env);
        const restored = resolvePeerMediationGrantSigningConfig({ ...env });

        expect(first).toEqual(expect.objectContaining({ ok: true }));
        expect(restored).toEqual(expect.objectContaining({ ok: true }));
        if (!first.ok || !restored.ok) throw new Error("expected derived Personal Home signer");
        expect(restored.keyId).toBe(first.keyId);
        expect(restored.capability.publicKey).toBe(first.capability.publicKey);
        expect(restored.secretKey).toEqual(first.secretKey);

        const establishedSeed = createHmac("sha512", "happier.machine-route-grant.v1 Master Seed")
            .update(env.HANDY_MASTER_SECRET!, "utf8").digest().subarray(0, 32);
        expect(first.secretKey).toEqual(tweetnacl.sign.keyPair.fromSeed(establishedSeed).secretKey);

        const publicKey = tweetnacl.sign.keyPair.fromSecretKey(first.secretKey).publicKey;
        expect(first.keyId).toBe(createHash("sha256").update(publicKey).digest("hex"));
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
            nowMs: 1_000,
            ttlMs: 60_000,
            serverGateEnabled: true,
            signingKey: first,
        });
        expect(minted).toEqual(expect.objectContaining({ ok: true }));
        if (!minted.ok) throw new Error("expected derived signer to mint a route grant");
        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createDirectRouteGrantSigningInputV1(minted.grant.payload), "utf8"),
            Buffer.from(minted.grant.signature.valueBase64Url, "base64url"),
            publicKey,
        )).toBe(true);
    });

    it("uses a distinct derivation domain from the Account Directory signer", () => {
        const masterSecret = "shared-personal-home-master-secret";
        const routeGrantSigning = resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HANDY_MASTER_SECRET: masterSecret,
        } as NodeJS.ProcessEnv);

        expect(routeGrantSigning).toEqual(expect.objectContaining({ ok: true }));
        if (!routeGrantSigning.ok) throw new Error("expected derived Personal Home signer");
        const routeGrantPublicKey = tweetnacl.sign.keyPair.fromSecretKey(routeGrantSigning.secretKey).publicKey;
        const accountDirectoryPublicKey = resolveAccountDirectorySigningKeyPair({
            HANDY_MASTER_SECRET: masterSecret,
        } as NodeJS.ProcessEnv).publicKey;

        expect(routeGrantPublicKey).not.toEqual(accountDirectoryPublicKey);
    });

    it("keeps explicit route-grant signing config authoritative for a managed Personal Home", () => {
        const explicitSeed = new Uint8Array(32).fill(12);
        const explicitKeyPair = tweetnacl.sign.keyPair.fromSeed(explicitSeed);
        const resolved = resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HANDY_MASTER_SECRET: "personal-home-route-grant-master-secret",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "operator-key",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(explicitSeed),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(explicitKeyPair.publicKey),
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual(expect.objectContaining({
            ok: true,
            keyId: "operator-key",
            capability: expect.objectContaining({ publicKey: toBase64Url(explicitKeyPair.publicKey) }),
        }));
    });

    it("fails closed on partial explicit config instead of deriving a Personal Home signer", () => {
        const resolved = resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HANDY_MASTER_SECRET: "personal-home-route-grant-master-secret",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "operator-key",
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual({ ok: false, reasonCode: "missing_private_key" });
        expect(resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HANDY_MASTER_SECRET: "personal-home-route-grant-master-secret",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "operator-key",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: `${"A".repeat(43)}$`,
        } as NodeJS.ProcessEnv)).toEqual({ ok: false, reasonCode: "invalid_private_key" });
    });

    it("does not derive a signer outside the managed Personal Home runtime purpose", () => {
        expect(resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "generic",
            HANDY_MASTER_SECRET: "generic-home-master-secret",
        } as NodeJS.ProcessEnv)).toEqual({ ok: false, reasonCode: "missing_key_id" });
        expect(resolvePeerMediationGrantSigningConfig({
            HANDY_MASTER_SECRET: "unscoped-master-secret",
        } as NodeJS.ProcessEnv)).toEqual({ ok: false, reasonCode: "missing_key_id" });
        expect(resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "generic",
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            HANDY_MASTER_SECRET: "teams-shared-home-master-secret",
        } as NodeJS.ProcessEnv)).toEqual({ ok: false, reasonCode: "missing_key_id" });
    });

    it("keeps managed Personal Home signing unavailable without a valid master secret", () => {
        expect(resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
        } as NodeJS.ProcessEnv)).toEqual({ ok: false, reasonCode: "missing_key_id" });
        expect(resolvePeerMediationGrantSigningConfig({
            HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
            HANDY_MASTER_SECRET: "   ",
        } as NodeJS.ProcessEnv)).toEqual({ ok: false, reasonCode: "missing_key_id" });
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

    it("retains explicit 64-byte signing keys and their stored public-key comparison policy", () => {
        const env = {
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "explicit-key",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(keyPair.secretKey),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: toBase64Url(keyPair.publicKey),
        };
        const resolved = resolvePeerMediationGrantSigningConfig(env);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error("expected explicit signing key");
        expect(new Uint8Array(resolved.secretKey)).toEqual(keyPair.secretKey);

        // Existing 64-byte configuration uses its stored public half, rather
        // than deriving or silently repairing it from the seed half.
        const configuredSecretKey = new Uint8Array(keyPair.secretKey);
        const configuredPublicKey = new Uint8Array(32).fill(7);
        configuredSecretKey.set(configuredPublicKey, 32);
        env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = toBase64Url(configuredSecretKey);
        expect(resolvePeerMediationGrantSigningConfig(env)).toEqual({ ok: false, reasonCode: "invalid_public_key" });
        env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = toBase64Url(configuredPublicKey);
        const configured = resolvePeerMediationGrantSigningConfig(env);
        expect(configured).toMatchObject({
            ok: true,
            capability: { publicKey: toBase64Url(configuredPublicKey) },
        });
        if (!configured.ok) throw new Error("expected stored public half to match");
        expect(new Uint8Array(configured.secretKey)).toEqual(configuredSecretKey);
    });

    it("rejects an expired signing root at its exact expiry while retaining a usable root", () => {
        const env = {
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(seed),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: "2000",
        };
        expect(resolvePeerMediationGrantSigningConfig(env, 1999)).toMatchObject({ ok: true });
        expect(resolvePeerMediationGrantSigningConfig(env, 2000)).toEqual({
            ok: false, reasonCode: "signing_key_expired",
        });
    });

    it("rejects a configured signing expiry that cannot be enforced", () => {
        const resolved = resolvePeerMediationGrantSigningConfig({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "key_1",
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: toBase64Url(seed),
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: "not-a-timestamp",
        } as NodeJS.ProcessEnv);

        expect(resolved).toEqual({
            ok: false,
            reasonCode: "invalid_expiry",
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
