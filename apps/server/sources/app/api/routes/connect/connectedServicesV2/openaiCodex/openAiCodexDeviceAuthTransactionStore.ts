import * as privacyKit from "privacy-kit";

import { decryptString, encryptString } from "@/modules/encrypt";
import { inTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

const TRANSACTION_KEY_PREFIX = "csda_";
const TRANSACTION_TTL_MS = 15 * 60_000;
const PROVIDER_POLL_LEASE_MS = 30_000;

type TransactionState = "pending" | "provider_polling" | "approved" | "token_exchanging" | "completed" | "expired";

type TransactionSecret = Readonly<{
    recipientPublicKeyB64Url: string;
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
    authorizationCode: string | null;
    codeVerifier: string | null;
    completionBundle: string | null;
}>;

type TransactionRecord = Readonly<{
    v: 1;
    accountId: string;
    state: TransactionState;
    version: number;
    nextPollAtMs: number;
    leaseId: string | null;
    leaseExpiresAtMs: number | null;
    secretEnc: string;
}>;

type StoredTransaction = Readonly<{
    key: string;
    value: string;
    expiresAtMs: number;
    record: TransactionRecord;
    secret: TransactionSecret;
}>;

export type OpenAiCodexDeviceAuthTransactionClaim = Readonly<{
    transactionId: string;
    expectedValue: string;
    leaseId: string;
}>;

export type OpenAiCodexDeviceAuthTransactionWork =
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "expired" }>
    | Readonly<{ kind: "pending"; retryAfterMs: number }>
    | Readonly<{ kind: "completed"; bundle: string }>
    | Readonly<{
        kind: "provider_poll";
        claim: OpenAiCodexDeviceAuthTransactionClaim;
        deviceAuthId: string;
        userCode: string;
        intervalMs: number;
    }>
    | Readonly<{
        kind: "token_exchange";
        claim: OpenAiCodexDeviceAuthTransactionClaim;
        authorizationCode: string;
        codeVerifier: string;
        recipientPublicKeyB64Url: string;
    }>;

function encryptionPath(transactionId: string): string[] {
    return ["connected-services", "openai-codex", "device-auth", transactionId, "payload"];
}

function encryptSecret(transactionId: string, secret: TransactionSecret): string {
    return privacyKit.encodeBase64(encryptString(encryptionPath(transactionId), JSON.stringify(secret)));
}

function decryptSecret(transactionId: string, secretEnc: string): TransactionSecret | null {
    try {
        const parsed = JSON.parse(decryptString(
            encryptionPath(transactionId),
            privacyKit.decodeBase64(secretEnc),
        )) as Partial<TransactionSecret>;
        if (
            typeof parsed.recipientPublicKeyB64Url !== "string"
            || typeof parsed.deviceAuthId !== "string"
            || typeof parsed.userCode !== "string"
            || typeof parsed.intervalMs !== "number"
            || !Number.isInteger(parsed.intervalMs)
            || parsed.intervalMs <= 0
            || (parsed.authorizationCode !== null && typeof parsed.authorizationCode !== "string")
            || (parsed.codeVerifier !== null && typeof parsed.codeVerifier !== "string")
            || (
                parsed.completionBundle !== undefined
                && parsed.completionBundle !== null
                && typeof parsed.completionBundle !== "string"
            )
        ) {
            return null;
        }
        return {
            recipientPublicKeyB64Url: parsed.recipientPublicKeyB64Url,
            deviceAuthId: parsed.deviceAuthId,
            userCode: parsed.userCode,
            intervalMs: parsed.intervalMs,
            authorizationCode: parsed.authorizationCode,
            codeVerifier: parsed.codeVerifier,
            completionBundle: parsed.completionBundle ?? null,
        };
    } catch {
        return null;
    }
}

function parseRecord(value: string): TransactionRecord | null {
    try {
        const parsed = JSON.parse(value) as Partial<TransactionRecord>;
        if (
            parsed.v !== 1
            || typeof parsed.accountId !== "string"
            || !["pending", "provider_polling", "approved", "token_exchanging", "completed", "expired"].includes(String(parsed.state))
            || typeof parsed.version !== "number"
            || !Number.isInteger(parsed.version)
            || parsed.version < 1
            || typeof parsed.nextPollAtMs !== "number"
            || !Number.isFinite(parsed.nextPollAtMs)
            || (parsed.leaseId !== null && typeof parsed.leaseId !== "string")
            || (parsed.leaseExpiresAtMs !== null && (typeof parsed.leaseExpiresAtMs !== "number" || !Number.isFinite(parsed.leaseExpiresAtMs)))
            || typeof parsed.secretEnc !== "string"
        ) {
            return null;
        }
        return parsed as TransactionRecord;
    } catch {
        return null;
    }
}

async function readStoredTransactionInTx(tx: Tx, transactionId: string): Promise<StoredTransaction | null> {
    const row = await tx.repeatKey.findUnique({ where: { key: transactionId } });
    if (!row) return null;
    const record = parseRecord(row.value);
    if (!record) return null;
    const secret = decryptSecret(transactionId, record.secretEnc);
    if (!secret) return null;
    return {
        key: row.key,
        value: row.value,
        expiresAtMs: row.expiresAt.getTime(),
        record,
        secret,
    };
}

async function compareAndReplaceInTx(input: Readonly<{
    tx: Tx;
    transactionId: string;
    expectedValue: string;
    record: TransactionRecord;
}>): Promise<boolean> {
    const updated = await input.tx.repeatKey.updateMany({
        where: { key: input.transactionId, value: input.expectedValue },
        data: { value: JSON.stringify(input.record) },
    });
    return updated.count === 1;
}

function nextRecord(input: Readonly<{
    transactionId: string;
    previous: TransactionRecord;
    secret: TransactionSecret;
    state: TransactionState;
    nextPollAtMs: number;
    leaseId: string | null;
    leaseExpiresAtMs: number | null;
}>): TransactionRecord {
    return {
        ...input.previous,
        state: input.state,
        version: input.previous.version + 1,
        nextPollAtMs: input.nextPollAtMs,
        leaseId: input.leaseId,
        leaseExpiresAtMs: input.leaseExpiresAtMs,
        secretEnc: encryptSecret(input.transactionId, input.secret),
    };
}

export async function createOpenAiCodexDeviceAuthTransaction(input: Readonly<{
    accountId: string;
    recipientPublicKeyB64Url: string;
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
    now: number;
    randomKey?: () => string;
}>): Promise<Readonly<{ transactionId: string; expiresAtMs: number }>> {
    const transactionId = `${TRANSACTION_KEY_PREFIX}${input.randomKey?.() ?? randomKeyNaked(24)}`;
    const expiresAtMs = input.now + TRANSACTION_TTL_MS;
    const secret: TransactionSecret = {
        recipientPublicKeyB64Url: input.recipientPublicKeyB64Url,
        deviceAuthId: input.deviceAuthId,
        userCode: input.userCode,
        intervalMs: input.intervalMs,
        authorizationCode: null,
        codeVerifier: null,
        completionBundle: null,
    };
    const record: TransactionRecord = {
        v: 1,
        accountId: input.accountId,
        state: "pending",
        version: 1,
        nextPollAtMs: input.now + input.intervalMs,
        leaseId: null,
        leaseExpiresAtMs: null,
        secretEnc: encryptSecret(transactionId, secret),
    };
    await inTx(async (tx) => {
        await tx.repeatKey.create({
            data: {
                key: transactionId,
                value: JSON.stringify(record),
                expiresAt: new Date(expiresAtMs),
            },
        });
    });
    return { transactionId, expiresAtMs };
}

export async function claimOpenAiCodexDeviceAuthTransactionWork(input: Readonly<{
    transactionId: string;
    accountId: string;
    now: number;
    randomLeaseId?: () => string;
}>): Promise<OpenAiCodexDeviceAuthTransactionWork> {
    if (!/^csda_[A-Za-z0-9]{8,128}$/.test(input.transactionId)) return { kind: "not_found" };
    return await inTx(async (tx) => {
        const stored = await readStoredTransactionInTx(tx, input.transactionId);
        if (!stored || stored.record.accountId !== input.accountId) return { kind: "not_found" };
        if (
            stored.record.state === "completed"
            && stored.expiresAtMs > input.now
            && stored.secret.completionBundle
        ) {
            return { kind: "completed", bundle: stored.secret.completionBundle };
        }
        if (stored.expiresAtMs <= input.now || stored.record.state === "expired" || stored.record.state === "completed") {
            if (stored.record.state !== "expired" && stored.record.state !== "completed") {
                await compareAndReplaceInTx({
                    tx,
                    transactionId: input.transactionId,
                    expectedValue: stored.value,
                    record: nextRecord({
                        transactionId: input.transactionId,
                        previous: stored.record,
                        secret: stored.secret,
                        state: "expired",
                        nextPollAtMs: input.now,
                        leaseId: null,
                        leaseExpiresAtMs: null,
                    }),
                });
            }
            return { kind: "expired" };
        }
        if (stored.record.state === "token_exchanging") {
            return { kind: "pending", retryAfterMs: Math.max(1, stored.expiresAtMs - input.now) };
        }
        if (
            stored.record.state === "provider_polling"
            && stored.record.leaseExpiresAtMs !== null
            && stored.record.leaseExpiresAtMs > input.now
        ) {
            return { kind: "pending", retryAfterMs: Math.max(1, stored.record.leaseExpiresAtMs - input.now) };
        }
        if (stored.record.state === "pending" && stored.record.nextPollAtMs > input.now) {
            return { kind: "pending", retryAfterMs: Math.max(1, stored.record.nextPollAtMs - input.now) };
        }

        const leaseId = input.randomLeaseId?.() ?? randomKeyNaked(24);
        const isApproved = stored.record.state === "approved";
        if (isApproved && stored.secret.authorizationCode && stored.secret.codeVerifier) {
            const claimed = nextRecord({
                transactionId: input.transactionId,
                previous: stored.record,
                secret: stored.secret,
                state: "token_exchanging",
                nextPollAtMs: input.now,
                leaseId,
                // Token exchange is deliberately non-reclaimable. If its process dies or the
                // provider outcome is ambiguous, the transaction expires instead of replaying a
                // single-use authorization code.
                leaseExpiresAtMs: stored.expiresAtMs,
            });
            if (!await compareAndReplaceInTx({
                tx,
                transactionId: input.transactionId,
                expectedValue: stored.value,
                record: claimed,
            })) {
                return { kind: "pending", retryAfterMs: 1 };
            }
            return {
                kind: "token_exchange",
                claim: { transactionId: input.transactionId, expectedValue: JSON.stringify(claimed), leaseId },
                authorizationCode: stored.secret.authorizationCode,
                codeVerifier: stored.secret.codeVerifier,
                recipientPublicKeyB64Url: stored.secret.recipientPublicKeyB64Url,
            };
        }

        const claimed = nextRecord({
            transactionId: input.transactionId,
            previous: stored.record,
            secret: stored.secret,
            state: "provider_polling",
            nextPollAtMs: input.now,
            leaseId,
            leaseExpiresAtMs: Math.min(stored.expiresAtMs, input.now + PROVIDER_POLL_LEASE_MS),
        });
        if (!await compareAndReplaceInTx({
            tx,
            transactionId: input.transactionId,
            expectedValue: stored.value,
            record: claimed,
        })) {
            return { kind: "pending", retryAfterMs: 1 };
        }
        return {
            kind: "provider_poll",
            claim: { transactionId: input.transactionId, expectedValue: JSON.stringify(claimed), leaseId },
            deviceAuthId: stored.secret.deviceAuthId,
            userCode: stored.secret.userCode,
            intervalMs: stored.secret.intervalMs,
        };
    });
}

export async function settleOpenAiCodexDeviceAuthProviderPending(input: Readonly<{
    claim: OpenAiCodexDeviceAuthTransactionClaim;
    accountId: string;
    now: number;
    retryAfterMs: number;
}>): Promise<boolean> {
    return await inTx(async (tx) => {
        const stored = await readStoredTransactionInTx(tx, input.claim.transactionId);
        if (
            !stored
            || stored.record.accountId !== input.accountId
            || stored.value !== input.claim.expectedValue
            || stored.record.state !== "provider_polling"
            || stored.record.leaseId !== input.claim.leaseId
        ) return false;
        return await compareAndReplaceInTx({
            tx,
            transactionId: input.claim.transactionId,
            expectedValue: stored.value,
            record: nextRecord({
                transactionId: input.claim.transactionId,
                previous: stored.record,
                secret: stored.secret,
                state: "pending",
                nextPollAtMs: Math.min(stored.expiresAtMs, input.now + Math.max(1, input.retryAfterMs)),
                leaseId: null,
                leaseExpiresAtMs: null,
            }),
        });
    });
}

export async function settleOpenAiCodexDeviceAuthProviderApproved(input: Readonly<{
    claim: OpenAiCodexDeviceAuthTransactionClaim;
    accountId: string;
    authorizationCode: string;
    codeVerifier: string;
    now: number;
}>): Promise<boolean> {
    return await inTx(async (tx) => {
        const stored = await readStoredTransactionInTx(tx, input.claim.transactionId);
        if (
            !stored
            || stored.record.accountId !== input.accountId
            || stored.value !== input.claim.expectedValue
            || stored.record.state !== "provider_polling"
            || stored.record.leaseId !== input.claim.leaseId
            || stored.expiresAtMs <= input.now
        ) return false;
        return await compareAndReplaceInTx({
            tx,
            transactionId: input.claim.transactionId,
            expectedValue: stored.value,
            record: nextRecord({
                transactionId: input.claim.transactionId,
                previous: stored.record,
                secret: {
                    ...stored.secret,
                    authorizationCode: input.authorizationCode,
                    codeVerifier: input.codeVerifier,
                },
                state: "approved",
                nextPollAtMs: input.now,
                leaseId: null,
                leaseExpiresAtMs: null,
            }),
        });
    });
}

export async function completeOpenAiCodexDeviceAuthTokenExchange(input: Readonly<{
    claim: OpenAiCodexDeviceAuthTransactionClaim;
    accountId: string;
    now: number;
    bundle: string;
}>): Promise<boolean> {
    return await inTx(async (tx) => {
        const stored = await readStoredTransactionInTx(tx, input.claim.transactionId);
        if (
            !stored
            || stored.record.accountId !== input.accountId
            || stored.value !== input.claim.expectedValue
            || stored.record.state !== "token_exchanging"
            || stored.record.leaseId !== input.claim.leaseId
            || stored.expiresAtMs <= input.now
        ) return false;
        return await compareAndReplaceInTx({
            tx,
            transactionId: input.claim.transactionId,
            expectedValue: stored.value,
            record: nextRecord({
                transactionId: input.claim.transactionId,
                previous: stored.record,
                secret: {
                    ...stored.secret,
                    authorizationCode: null,
                    codeVerifier: null,
                    completionBundle: input.bundle,
                },
                state: "completed",
                nextPollAtMs: input.now,
                leaseId: null,
                leaseExpiresAtMs: null,
            }),
        });
    });
}

export async function expireOpenAiCodexDeviceAuthTokenExchange(input: Readonly<{
    claim: OpenAiCodexDeviceAuthTransactionClaim;
    accountId: string;
    now: number;
}>): Promise<void> {
    await inTx(async (tx) => {
        const stored = await readStoredTransactionInTx(tx, input.claim.transactionId);
        if (
            !stored
            || stored.record.accountId !== input.accountId
            || stored.value !== input.claim.expectedValue
            || stored.record.state !== "token_exchanging"
            || stored.record.leaseId !== input.claim.leaseId
        ) return;
        await compareAndReplaceInTx({
            tx,
            transactionId: input.claim.transactionId,
            expectedValue: stored.value,
            record: nextRecord({
                transactionId: input.claim.transactionId,
                previous: stored.record,
                secret: {
                    ...stored.secret,
                    authorizationCode: null,
                    codeVerifier: null,
                    completionBundle: null,
                },
                state: "expired",
                nextPollAtMs: input.now,
                leaseId: null,
                leaseExpiresAtMs: null,
            }),
        });
    });
}
