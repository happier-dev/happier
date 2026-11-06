import {
    areCredentialsEqual,
    subscribeHomeCredentialMutations,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { parseToken } from '@/utils/auth/parseToken';

/** A refreshed Account bearer keeps authority; replacement identity, keys and restricted credentials do not. */
export function retainsHomeAccountCredential(original: AuthCredentials | null, next: AuthCredentials | null | undefined): boolean {
    if (!original || !next) return false;
    if (areCredentialsEqual(original, next)) return true;
    if (readCredentialAuthorityKind(original.token) !== 'account' || readCredentialAuthorityKind(next.token) !== 'account') return false;
    try {
        return parseToken(original.token) === parseToken(next.token)
            && areCredentialsEqual({ ...original, token: next.token }, next);
    } catch {
        return false;
    }
}

/**
 * The one record of "this Home's Account left". A Home holds one credential at a time, so anything
 * read through it belongs to that credential until the stored one stops being retainable: sign-out,
 * another Account, replaced keys. A same-Account bearer refresh is not a change.
 *
 * Two kinds of holder use it. A released reader holds no credential listener, yet may still vouch for
 * a shared answer: it compares its admitted epoch when next asked. A reconstructible cache keyed
 * without an Account subscribes, drops what it holds, and fences reads issued before the change with
 * the generation, so they neither join a successor's read nor land after the eviction.
 */
const homes = new Map<string, { epoch: number; credentials: AuthCredentials | null }>();
const retirementListeners = new Set<(serverId: string) => void>();
let generation = 0;
let subscribed = false;

function observeHomeCredential(serverId: string, next: AuthCredentials | null, previousIfUnseen: AuthCredentials | null): void {
    const state = homes.get(serverId);
    const retained = retainsHomeAccountCredential(state ? state.credentials : previousIfUnseen, next);
    if (!state) homes.set(serverId, { epoch: 0, credentials: next });
    else {
        if (!retained) state.epoch += 1;
        state.credentials = next;
    }
    if (retained) return;
    generation += 1;
    for (const listener of [...retirementListeners]) {
        try {
            listener(serverId);
        } catch {
            // One projection cannot suppress retirement for its siblings.
        }
    }
}

function ensureSubscribed(): void {
    if (subscribed) return;
    subscribed = true;
    subscribeHomeCredentialMutations((event) => observeHomeCredential(resolveServerProfileScopeIdForIdentifier(event.serverId),
        event.kind === 'credentials_removed' ? null : event.credentials ?? null, event.previousCredentials ?? null));
}

/** Bind a reader to the credential it just read; the epoch moves when that credential stops holding. */
export function admitHomeCredentialEpoch(serverId: string, credentials: AuthCredentials): number {
    ensureSubscribed();
    if (homes.has(serverId)) observeHomeCredential(serverId, credentials, null);
    else homes.set(serverId, { epoch: 0, credentials });
    return homes.get(serverId)!.epoch;
}

export function readHomeCredentialEpoch(serverId: string): number | undefined {
    return homes.get(serverId)?.epoch;
}

/** Whether credentials an operation was issued with still hold for this Home. A refreshed bearer does. */
export function isHomeCredentialCurrent(serverId: string, credentials: AuthCredentials): boolean {
    ensureSubscribed();
    const state = homes.get(resolveServerProfileScopeIdForIdentifier(serverId));
    return !state || retainsHomeAccountCredential(credentials, state.credentials);
}

/** Advances when any Home's Account leaves. Capture it before issuing a read this owner would retain. */
export function readHomeAccountGeneration(): number {
    ensureSubscribed();
    return generation;
}

/** Called with the Home's scope id after its record advanced, so `isCurrent` already answers false. */
export function subscribeHomeAccountRetirement(listener: (serverId: string) => void): () => void {
    ensureSubscribed();
    retirementListeners.add(listener);
    return () => { retirementListeners.delete(listener); };
}
