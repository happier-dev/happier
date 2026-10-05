import { getStorage, selectSessionDisplayNameSource, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';

import { getSessionName, resolveLockedSessionTitle } from './sessionUtils';

/**
 * A session's name as every surface shows it (a tab, a drag preview, a chooser): the session title
 * owner's, locked titles included. One derivation, so a workspace tab and a Session canvas tab
 * cannot name the same session differently.
 */
export function sessionDisplayTitle(source: Parameters<typeof getSessionName>[0] | null): string | null {
    if (!source) return null;
    return resolveLockedSessionTitle(getSessionName(source, source.serverId));
}

/** A Home-qualified session's name, read once without subscribing (words of a drag verdict). */
export function readSessionDisplayTitle(address: Readonly<{ sessionId: string; serverId?: string | null }>): string | null {
    return sessionDisplayTitle(selectSessionDisplayNameSource(getStorage().getState(), address.sessionId, address.serverId ?? null));
}

/** Live names of Home-qualified sessions, in input order, through one store subscription. */
export function useSessionDisplayTitles(addresses: ReadonlyArray<Readonly<{ sessionId: string; serverId?: string | null }>>): readonly (string | null)[] {
    return useSessionDisplayNameProjections(addresses, sessionDisplayTitle);
}
