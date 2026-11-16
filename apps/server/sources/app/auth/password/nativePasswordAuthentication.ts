import { createHmac } from "node:crypto";
import { AUTH_TOKEN_KIND_AUTHORITIES } from '@happier-dev/protocol/auth/authToken';
import { encodePasswordCredentialFieldV1, selectPasswordEnvelopeWriterProfileV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { type NativeEmailPasswordPreloginResponseV1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { acceptPasswordTextV1, parseAccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { issueKeyChallengeV2 } from "@/app/auth/keyChallengeV2";
import { ensureSameServiceHomeEntryInTx, prepareSameServiceHomeEntry } from "@/app/accountDirectory/accountDirectoryService";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { acquireAccountSessionOwnerMetadataFenceInTx, AccountSessionOwnerMetadataFenceAccountNotFoundError } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { assertAccountActive, InactiveAccountError } from "@/app/auth/accountStatus";
import { performDummyPasswordWork, verifyPasswordMaterial } from "./passwordMaterialVerifier";
import { isE2eePasswordCredentialBoundToAccount } from "./e2eePasswordCredentialAccountBinding";

/** Native identities alone locate logins; mailbox evidence is deliberately nonunique. */
export async function findNativePasswordAccount(email: string, reader: Pick<Tx, "accountIdentity"> = db) {
    const normalized = normalizeVerifiedEmail(email);
    if (!normalized) return null;
    const identity = await reader.accountIdentity.findUnique({
        where: { provider_providerUserId: { provider: "email", providerUserId: normalized.normalizedEmail } },
        select: { id: true, providerUserId: true, account: { select: {
            id: true, publicKey: true, encryptionMode: true, status: true,
            AccountPasswordCredential: { select: { credential: true, revision: true } },
        } } },
    });
    if (!identity?.account.AccountPasswordCredential) return null;
    const { account } = identity;
    const row = account.AccountPasswordCredential!;
    if (account.encryptionMode !== "plain" && account.encryptionMode !== "e2ee") return null;
    const parsed = parseAccountPasswordCredentialV1(account.encryptionMode, row.credential);
    if (!parsed.ok) return null;
    if (parsed.mode === "e2ee" && !isE2eePasswordCredentialBoundToAccount(
        parsed.credential,
        account.publicKey,
    )) return null;
    return { account, nativeIdentityId: identity.id, normalizedEmail: identity.providerUserId, revision: row.revision, parsed };
}

/** Verify outside locks, then fence credential currentness and ordinary token issuance together. */
export async function loginWithNativePlainPassword(params: Readonly<{
    email: string;
    password: string;
    env: NodeJS.ProcessEnv;
    /** Final persisted-policy admission in the token-writing transaction. */
    admitInTx: (tx: Tx) => Promise<boolean>;
    /**
     * `account_directory` mints the restricted account-service credential instead of an ordinary
     * Home one. The caller has already established that this server is an account service; the
     * same-service Home entry is ensured in the token transaction, exactly as the Key Challenge and
     * OAuth Directory finalizers do.
     */
    tokenKind?: "account" | "terminal" | "account_directory";
}>) {
    const tokenKind = params.tokenKind ?? "account";
    const candidate = await findNativePasswordAccount(params.email);
    const text = acceptPasswordTextV1(params.password);
    if (!candidate || candidate.parsed.mode !== "plain" || !text.accepted) {
        await performDummyPasswordWork();
        return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
    }
    if (!await verifyPasswordMaterial(candidate.parsed.credential.hash, text.utf8)) {
        return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
    }
    const eligible = await enforceLoginEligibility({ accountId: candidate.account.id, readEnv: async () => params.env });
    if (!eligible.ok) return eligible;
    const sameServicePreparation = tokenKind === "account_directory"
        ? await prepareSameServiceHomeEntry({ env: params.env })
        : null;
    if (sameServicePreparation?.status === "not_dual_role"
        && sameServicePreparation.reason === "server_identity_mismatch") {
        throw new Error("Same-service Home descriptor identity mismatch");
    }
    try {
        return await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, candidate.account.id,
                sameServicePreparation?.status === "ready" ? "exclusive" : "content");
            const current = await findNativePasswordAccount(candidate.normalizedEmail, tx);
            if (!current || current.account.id !== candidate.account.id || current.parsed.mode !== "plain"
                || current.nativeIdentityId !== candidate.nativeIdentityId || current.revision !== candidate.revision) {
                return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
            }
            if (!await params.admitInTx(tx)) {
                return { ok: false, statusCode: 403, error: "method_not_available" } as const;
            }
            if (sameServicePreparation) {
                await ensureSameServiceHomeEntryInTx(tx, {
                    accountId: candidate.account.id,
                    preparation: sameServicePreparation,
                    env: params.env,
                });
            }
            const token = await auth.createTokenInTx(tx, candidate.account.id, undefined, {
                kind: tokenKind, authority: AUTH_TOKEN_KIND_AUTHORITIES[tokenKind],
                authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
            });
            return { ok: true, token } as const;
        }, {
            // Directory writers reread the credential, Home policy and directory
            // under exclusive Account admission. Token-only snapshot selection
            // is unchanged here.
            isolationLevel: sameServicePreparation?.status === "ready" ? "ReadCommitted" : "Serializable",
        });
    } catch (error) {
        if (error instanceof InactiveAccountError) return { ok: false, statusCode: 403, error: "account-disabled" } as const;
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
        }
        throw error;
    }
}

/**
 * Derived-key proof releases only the exact current envelope; Key Challenge
 * still owns login.
 *
 * This is also the sole observer of a verified native password on the login
 * path, so it issues the Account-bound Key Challenge the client will redeem and
 * marks that exact row with server-owned `email_password` evidence. The
 * finalizer reads the mark to stamp truthful credential provenance; a
 * recovery-key login, which issues its own challenge, cannot borrow it.
 */
export async function unlockNativeE2eePassword(params: Readonly<{
    email: string;
    authKey: Uint8Array;
    env: NodeJS.ProcessEnv;
    /** Final persisted-policy admission in the challenge-writing transaction. */
    admitInTx: (tx: Tx) => Promise<boolean>;
}>) {
    const candidate = await findNativePasswordAccount(params.email);
    if (!candidate || candidate.parsed.mode !== "e2ee" || params.authKey.byteLength !== 32) {
        await performDummyPasswordWork();
        return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
    }
    if (!await verifyPasswordMaterial(candidate.parsed.credential.authVerifier.hash, params.authKey)) {
        return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
    }
    const eligible = await enforceLoginEligibility({ accountId: candidate.account.id, readEnv: async () => params.env });
    if (!eligible.ok) return eligible;
    try {
        const result = await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, candidate.account.id, "content");
            const current = await findNativePasswordAccount(candidate.normalizedEmail, tx);
            if (!current || current.account.id !== candidate.account.id || current.parsed.mode !== "e2ee"
                || current.nativeIdentityId !== candidate.nativeIdentityId || current.revision !== candidate.revision) {
                return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
            }
            assertAccountActive(current.account.status);
            if (!await params.admitInTx(tx)) {
                return { ok: false, statusCode: 403, error: "method_not_available" } as const;
            }
            const challenge = await issueKeyChallengeV2({
                purpose: "account",
                expectedAccountId: current.account.id,
                verifiedNativeMethodId: "email_password",
                verifiedNativePasswordEvidence: { nativeIdentityId: current.nativeIdentityId, credentialRevision: current.revision },
                env: params.env,
                writer: tx,
            });
            if (!challenge) return { ok: false, statusCode: 503, error: "challenge_unavailable" } as const;
            return {
                ok: true,
                envelope: current.parsed.credential.envelope,
                expectedAccountId: current.account.id,
                challenge,
            } as const;
        });
        if (!result.ok) return result;
        return result;
    } catch (error) {
        if (error instanceof InactiveAccountError) return { ok: false, statusCode: 403, error: "account-disabled" } as const;
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { ok: false, statusCode: 401, error: "authentication_failed" } as const;
        }
        throw error;
    }
}

/** Public routing exposes bounded KDF facts only; missing credentials get stable per-mailbox decoys. */
export async function preloginNativePassword(params: Readonly<{
    email: string; env: NodeJS.ProcessEnv;
}>): Promise<NativeEmailPasswordPreloginResponseV1> {
    const candidate = await findNativePasswordAccount(params.email);
    if (candidate?.parsed.mode === "plain") return { v: 1, kind: "plain_password" };
    if (candidate?.parsed.mode === "e2ee") {
        return { v: 1, kind: "e2ee_password_unlock", kdf: candidate.parsed.credential.envelope.kdf };
    }
    const masterSecret = params.env.HANDY_MASTER_SECRET?.trim();
    if (!masterSecret) throw new Error("HANDY_MASTER_SECRET is required");
    const normalized = normalizeVerifiedEmail(params.email)?.normalizedEmail ?? params.email.trim().toLowerCase();
    const decoy = createHmac("sha256", masterSecret)
        .update("happier.native-password.prelogin-decoy.v1\0").update(normalized).digest();
    if ((decoy[0]! & 1) === 0) return { v: 1, kind: "plain_password" };
    // The decoy must be drawn from the same distribution current writers use.
    // Deriving it from the schema's admission floor instead would make every
    // absent Account distinguishable from every enrolled one by parameters
    // alone, which is exactly the existence disclosure this endpoint avoids.
    return { v: 1, kind: "e2ee_password_unlock", kdf: {
        ...selectPasswordEnvelopeWriterProfileV1(decoy[17]!),
        salt: encodePasswordCredentialFieldV1(new Uint8Array(decoy.subarray(1, 17))),
    } };
}
