import { dropLoginEligibilityPositiveCacheEntry, enforceLoginEligibility, invalidateLoginEligibilityPositiveCache } from "@/app/auth/enforceLoginEligibility";
import { advanceSignInPolicyGeneration, readSignInPolicyGeneration } from "@/app/auth/signInPolicyGeneration";
import { readHomeConfigEnv } from "@/app/home/settings/homeSettings";
import { warn } from "@/utils/logging/log";

type LiveSocket = Readonly<{ data: unknown; disconnect(close?: boolean): unknown }>;

/**
 * Socket sign-in eligibility is decided once, at the handshake. When the Home sign-in policy
 * changes, re-decide it for each Account connected to this node (one eligibility decision per
 * Account) and disconnect that Account's local sockets when the policy now refuses it, as every
 * other credential revocation does. A policy the owner cannot evaluate right now (503) keeps the
 * sockets; HTTP and the next handshake refuse on their own.
 */
export async function evictSignInIneligibleSockets(sockets: Iterable<LiveSocket>): Promise<void> {
    invalidateLoginEligibilityPositiveCache();
    await disconnectSignInIneligibleSockets(sockets);
}

/**
 * The eviction pass sees only sockets already connected. A handshake whose eligibility decision
 * started under an older sign-in policy generation (`socket.data.signInPolicyGeneration`, set by
 * api/socket.ts before that decision) may connect after the pass, so it is re-decided once here.
 */
export async function recheckSocketAdmittedUnderOlderSignInPolicy(socket: LiveSocket): Promise<void> {
    const admitted = (socket.data as { signInPolicyGeneration?: unknown } | undefined)?.signInPolicyGeneration;
    if (typeof admitted !== "number" || admitted === readSignInPolicyGeneration()) return;
    await disconnectSignInIneligibleSockets([socket]);
}

async function disconnectSignInIneligibleSockets(sockets: Iterable<LiveSocket>): Promise<void> {
    const byAccount = new Map<string, LiveSocket[]>();
    for (const socket of [...sockets]) {
        const accountId = (socket.data as { userId?: unknown } | undefined)?.userId;
        if (typeof accountId !== "string") continue;
        byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), socket]);
    }
    for (const [accountId, accountSockets] of byAccount) {
        const eligibility = await enforceLoginEligibility({ accountId, readEnv: () => readHomeConfigEnv() });
        if (eligibility.ok) continue;
        if (eligibility.statusCode === 503) {
            warn({ module: "auth-sign-in-policy", event: "socket_eligibility_unavailable", accountId },
                "Sign-in policy changed but eligibility is unavailable; live sockets stay until their next admission");
            continue;
        }
        for (const socket of accountSockets) socket.disconnect(true);
    }
}

/** Connect owner wiring (api/socket.ts): re-decide local sockets on every sign-in policy change. */
export function registerSignInPolicyEviction(input: Readonly<{
    sockets: () => Iterable<LiveSocket>;
    onSignInPolicyChange: (listener: () => void) => () => void;
}>): () => void {
    return input.onSignInPolicyChange(() => {
        void evictSignInIneligibleSockets(input.sockets()).catch(error => {
            warn({ module: "auth-sign-in-policy", event: "socket_eviction_failed", error },
                "Sign-in policy socket re-check failed");
        });
    });
}

/**
 * Connect owner wiring (api/socket.ts): an Account whose sign-in was revoked on any node
 * (`eventRouter.revokeAccountSignIn`) loses this node's cached sign-in result, so its reconnect
 * is re-decided.
 */
export function registerAccountSignInRevocation(
    onAccountSignInRevoked: (listener: (accountId: string) => void) => () => void,
): () => void {
    return onAccountSignInRevoked(accountId => {
        dropLoginEligibilityPositiveCacheEntry(accountId);
        // A check already in flight (decided from the pre-verdict stored result) must not cache.
        advanceSignInPolicyGeneration();
    });
}
