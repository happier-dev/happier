import { Context } from "@/context";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { afterTx, inReadSnapshot, inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from "@/app/changes/markAccountChanged";
import { isReservedUsername, normalizeUsername, resolveUsernamePolicyFromEnv, validateUsername } from "./usernamePolicy";
import { withdrawPublicProfileInTx, replacePublicProfileForProviderResetInTx } from '@/app/account/profile/publicProfileWithdrawal';

export class UsernameTakenError extends Error {
    constructor() {
        super('username-taken');
        this.name = 'UsernameTakenError';
    }
}

export class InvalidUsernameError extends Error {
    constructor() {
        super("invalid-username");
        this.name = "InvalidUsernameError";
    }
}

export class UsernameChangedError extends Error {
    constructor() {
        super('username-changed');
        this.name = 'UsernameChangedError';
    }
}

export type UsernameChange =
    | { kind: "manual_set"; username: string }
    | { kind: "release" }
    | { kind: "operator_reclaim"; username: string }
    | { kind: "identity_fill"; suggestion: string }
    | { kind: "identity_unlink"; matchingUsername: string }
    | { kind: "account_replacement"; oldAccountId: string; desiredUsername: string | null };

export interface UsernameAvailability {
    username: string;
    availability: "available" | "unavailable" | "invalid" | "reserved";
}

export interface UsernameReleaseResult {
    username: null;
    released: boolean;
    reservedUntilMs: number | null;
}

export interface UsernameReclaimResult {
    username: null;
    reclaimed: boolean;
}

/** Advisory read of the same admission rules used inside every username mutation. */
export async function readUsernameAvailabilityInTx(
    tx: Tx, accountId: string, input: string, env: NodeJS.ProcessEnv = process.env,
): Promise<UsernameAvailability> {
    const username = normalizeUsername(input);
    const current = await tx.account.findUnique({ where: { id: accountId }, select: { username: true } });
    if (current?.username === username) return { username, availability: "available" };
    if (!validateUsername(username, env).ok) return { username, availability: "invalid" };
    if (isReservedUsername(username)) return { username, availability: "reserved" };
    const [holder, hold] = await Promise.all([
        tx.account.findUnique({ where: { username }, select: { id: true } }),
        tx.releasedUsername.findUnique({ where: { username }, select: { expiresAt: true } }),
    ]);
    return { username, availability: holder || (hold && hold.expiresAt.getTime() > Date.now()) ? "unavailable" : "available" };
}

/** Two presentation candidates, never reservations or an unbounded namespace search. */
export async function usernameCheck(accountId: string, input: string, env: NodeJS.ProcessEnv = process.env) {
    return inReadSnapshot(async tx => {
        const result = await readUsernameAvailabilityInTx(tx, accountId, input, env);
        if (result.availability !== "unavailable") return { ...result, suggestions: [] as string[] };
        const policy = resolveUsernamePolicyFromEnv(env);
        const candidates = [...new Set(["1", "2"].map(suffix => result.username.slice(0, policy.maxLen - suffix.length) + suffix))];
        const checked = await Promise.all(candidates.map(candidate => readUsernameAvailabilityInTx(tx, accountId, candidate, env)));
        return { ...result, suggestions: checked.filter(candidate => candidate.availability === "available").map(candidate => candidate.username) };
    });
}

async function publishUsernameChangeInTx(tx: Tx, accountId: string, username: string | null): Promise<void> {
    const cursor = await markAccountChanged(tx, { accountId, kind: "account", entityId: "self", hint: { username } });
    afterTx(tx, () => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildUpdateAccountUpdate(accountId, { username }, cursor.resolveCursor(), randomKeyNaked(12)),
            recipientFilter: { type: "user-scoped-only" },
        });
    });
}

export function changeUsernameInTx(tx: Tx, accountId: string, change: { kind: "release" }, env?: NodeJS.ProcessEnv): Promise<UsernameReleaseResult>;
export function changeUsernameInTx(tx: Tx, accountId: string, change: { kind: "operator_reclaim"; username: string }, env?: NodeJS.ProcessEnv): Promise<UsernameReclaimResult>;
export function changeUsernameInTx(tx: Tx, accountId: string, change: UsernameChange, env?: NodeJS.ProcessEnv): Promise<{ username: string | null }>;
/**
 * The sole username writer. Claiming callers use an admitted serializable
 * transaction so claim/hold reads and identity lifecycle commit together.
 * Explicit release instead relies on the exclusive Account admission below.
 */
export async function changeUsernameInTx(
    tx: Tx, accountId: string, change: UsernameChange, env: NodeJS.ProcessEnv = process.env,
): Promise<{ username: string | null } | UsernameReleaseResult | UsernameReclaimResult> {
    await acquireAccountChangePublicationLocksInTx(tx,
        change.kind === "account_replacement" ? [accountId, change.oldAccountId] : [accountId],
        { includeSingleAccount: true, intent: "exclusive" });
    const account = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { username: true, usernameAutoFillEnabled: true } });

    if (change.kind === "operator_reclaim") {
        if (account.username === null) return { username: null, reclaimed: false };
        // Review names the exact stored handle, including grandfathered spelling.
        if (account.username !== change.username) throw new UsernameChangedError();
        await withdrawPublicProfileInTx(tx, accountId);
        await tx.account.update({ where: { id: accountId }, data: { username: null, usernameAutoFillEnabled: false } });
        await publishUsernameChangeInTx(tx, accountId, null);
        return { username: null, reclaimed: true };
    }

    if (change.kind === "account_replacement") {
        const old = await tx.account.findUniqueOrThrow({ where: { id: change.oldAccountId }, select: { username: true, usernameAutoFillEnabled: true } });
        let username = change.desiredUsername;
        if (username !== null && username !== old.username) {
            const admission = await readUsernameAvailabilityInTx(tx, accountId, username, env);
            assertUsernameAvailable(admission);
            username = admission.username;
        }
        await replacePublicProfileForProviderResetInTx(tx, change.oldAccountId, accountId);
        await tx.account.update({ where: { id: change.oldAccountId }, data: { username: null, usernameAutoFillEnabled: false } });
        await tx.account.update({ where: { id: accountId }, data: { username, usernameAutoFillEnabled: old.usernameAutoFillEnabled } });
        if (old.username !== null) await publishUsernameChangeInTx(tx, change.oldAccountId, null);
        if (username !== account.username) await publishUsernameChangeInTx(tx, accountId, username);
        return { username };
    }

    if (change.kind === "release") {
        if (account.username === null) {
            if (account.usernameAutoFillEnabled) await tx.account.update({ where: { id: accountId }, data: { usernameAutoFillEnabled: false } });
            return { username: null, released: false, reservedUntilMs: null };
        }
        // The approved hold is exactly thirty days, independent of Account lifetime.
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await tx.releasedUsername.upsert({ where: { username: account.username }, create: { username: account.username, expiresAt }, update: { expiresAt } });
        await withdrawPublicProfileInTx(tx, accountId);
        await tx.account.update({ where: { id: accountId }, data: { username: null, usernameAutoFillEnabled: false } });
        await publishUsernameChangeInTx(tx, accountId, null);
        return { username: null, released: true, reservedUntilMs: expiresAt.getTime() };
    }

    if (change.kind === "identity_unlink") {
        if (!account.usernameAutoFillEnabled || account.username !== normalizeUsername(change.matchingUsername)) return { username: account.username };
        await withdrawPublicProfileInTx(tx, accountId);
        await tx.account.update({ where: { id: accountId }, data: { username: null } });
        await publishUsernameChangeInTx(tx, accountId, null);
        return { username: null };
    }

    if (change.kind === "identity_fill" && (account.username !== null || !account.usernameAutoFillEnabled)) return { username: account.username };
    const admission = await readUsernameAvailabilityInTx(tx, accountId,
        change.kind === "manual_set" ? change.username : change.suggestion, env);
    if (change.kind === "identity_fill" && admission.availability !== "available") return { username: account.username };
    assertUsernameAvailable(admission);
    if (change.kind === "manual_set" && account.username === admission.username && !account.usernameAutoFillEnabled) {
        return { username: admission.username };
    }
    try {
        await tx.account.update({ where: { id: accountId }, data: {
            username: admission.username,
            ...(change.kind === "manual_set" ? { usernameAutoFillEnabled: false } : {}),
        } });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        // Throw out of this aborted transaction; provisioning retries the whole
        // admission and then observes the unavailable suggestion as a no-op.
        if (change.kind === "identity_fill") throw new TransactionReplayRequiredError("username-admission-changed");
        throw new UsernameTakenError();
    }
    if (account.username !== admission.username) await withdrawPublicProfileInTx(tx, accountId);
    await publishUsernameChangeInTx(tx, accountId, admission.username);
    return { username: admission.username };
}

function assertUsernameAvailable(admission: UsernameAvailability): void {
    if (admission.availability === "unavailable") throw new UsernameTakenError();
    if (admission.availability !== "available") throw new InvalidUsernameError();
}

/** Legacy explicit update wrapper, preserving typed conflict and normalized result. */
export async function usernameUpdate(ctx: Context, username: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
    const result = await inTx(tx => changeUsernameInTx(tx, ctx.uid, { kind: "manual_set", username }, env), { isolationLevel: "Serializable" });
    if (result.username === null) throw new Error("Manual username admission returned no username");
    return result.username;
}

/** Explicit release and hold commit once; a repeated release never extends expiry. */
export async function usernameRelease(ctx: Context, env: NodeJS.ProcessEnv = process.env): Promise<UsernameReleaseResult> {
    return inTx(tx => changeUsernameInTx(tx, ctx.uid, { kind: "release" }, env), { isolationLevel: "ReadCommitted" });
}
