import { createHmac, timingSafeEqual } from "node:crypto";
import {
    AccountEncryptionMigrateRequestBindingDigestV1Schema,
    type AccountEncryptionMigrateRequestBindingDigestV1,
} from "@happier-dev/protocol";

const SERVER_REPLAY_BINDING_PATTERN =
    /^aemrsb1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SERVER_REPLAY_BINDING_PREFIX = "aemrsb1_";
const HMAC_DOMAIN =
    "happier.account-encryption-migration.replay-binding.v1";

function requireMasterSecret(env: NodeJS.ProcessEnv): string {
    const secret = (env.HANDY_MASTER_SECRET ?? "").toString().trim();
    if (!secret) {
        throw new Error(
            "HANDY_MASTER_SECRET is required for Account encryption migration replay binding",
        );
    }
    return secret;
}

function requireCanonicalAccountId(accountId: string): string {
    if (
        typeof accountId !== "string"
        || accountId.length === 0
        || accountId.trim() !== accountId
        || accountId.includes("\u0000")
    ) {
        throw new TypeError(
            "Account encryption migration replay binding requires a canonical account id",
        );
    }
    return accountId;
}

function requireProtocolRequestDigest(
    protocolRequestDigest: AccountEncryptionMigrateRequestBindingDigestV1,
): AccountEncryptionMigrateRequestBindingDigestV1 {
    const parsed =
        AccountEncryptionMigrateRequestBindingDigestV1Schema.safeParse(
            protocolRequestDigest,
        );
    if (!parsed.success) {
        throw new TypeError(
            "Account encryption migration replay binding requires a canonical aemrb1 Protocol request digest",
        );
    }
    return parsed.data;
}

export function createAccountEncryptionMigrationReplayBindingV1(
    input: Readonly<{
        accountId: string;
        protocolRequestDigest:
            AccountEncryptionMigrateRequestBindingDigestV1;
    }>,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const secret = requireMasterSecret(env);
    const accountId = requireCanonicalAccountId(input.accountId);
    const protocolRequestDigest = requireProtocolRequestDigest(
        input.protocolRequestDigest,
    );
    const digest = createHmac("sha256", secret)
        .update(HMAC_DOMAIN, "utf8")
        .update("\u0000account\u0000", "utf8")
        .update(accountId, "utf8")
        .update("\u0000protocol-request-digest\u0000", "utf8")
        .update(protocolRequestDigest, "utf8")
        .digest("base64url");
    return `${SERVER_REPLAY_BINDING_PREFIX}${digest}`;
}

export function accountEncryptionMigrationReplayBindingsEqualV1(
    left: string,
    right: string,
): boolean {
    if (
        typeof left !== "string"
        || typeof right !== "string"
        || !SERVER_REPLAY_BINDING_PATTERN.test(left)
        || !SERVER_REPLAY_BINDING_PATTERN.test(right)
    ) {
        return false;
    }

    return timingSafeEqual(
        Buffer.from(left, "utf8"),
        Buffer.from(right, "utf8"),
    );
}
