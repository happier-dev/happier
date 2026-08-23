import type { ExternalSessionsBrowseInteraction } from './ExternalSessionsBrowseScreen';

/**
 * Whether one browse row's activation cannot succeed because its machine is offline.
 *
 * Offline is not a property of the listing — retained rows stay readable, an already
 * linked session opens through local navigation, and returning a remote session id to
 * the new-session draft is a local selection whose own flow owns reconnecting. It is a
 * property of ONE activation: linking an unlinked candidate needs a link-ensure round
 * trip to that machine, so pressing such a row while disconnected starts an operation
 * that cannot succeed and reports a generic RPC error instead of the real reason.
 *
 * The single owner of that rule, so the row's disabled/focusable presentation and the
 * screen's activation guard cannot disagree about which rows are actually pressable.
 */
export function isExternalSessionBrowseCandidateOfflineInert(params: Readonly<{
    offline: boolean;
    interaction: ExternalSessionsBrowseInteraction;
    linkedSessionId: string | null | undefined;
}>): boolean {
    if (!params.offline) return false;
    if (params.interaction === 'pickRemoteSessionId') return false;
    return !params.linkedSessionId;
}
