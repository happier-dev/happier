import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { isAccountFollowConfigurationChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';
import { readAccountSessionDeliveryMutedScopes } from '@/sync/api/session/sessionFollowApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

type MutedScopes = readonly FollowDeliveryMuteScopeV1[] | null;
type Entry = Readonly<{ scope: ServerAccountScope; read: Promise<MutedScopes> }>;

/**
 * An Account's delivery mutes for one Home. They change rarely and their change is pushed (the Account's
 * Follow configuration change), so they are read once per Home Account and again only after that push or a
 * credential change. Every arriving alert, push and the Activity membership share that one read.
 */
const entries = new Map<string, Entry>();
let subscribed = false;

function forget(serverId: string): void {
    for (const key of [...entries.keys()]) if (areServerProfileIdentifiersEquivalent(key, serverId)) entries.delete(key);
}

function subscribe(): void {
    if (subscribed) return;
    subscribed = true;
    // App-lifetime observers of two existing pushes; they only drop an entry, the next reader reads again.
    subscribeHomeAccountChange(event => { if (isAccountFollowConfigurationChangeRelevant(event)) forget(event.serverId); });
    subscribeHomeCredentialChange(event => forget(event.serverId));
}

/** Null never means unmuted: the mutes are not known (the read failed), so callers stay quiet. */
export function readAccountDeliveryMutedScopes(scope: ServerAccountScope): Promise<MutedScopes> {
    subscribe();
    const current = entries.get(scope.serverId);
    if (current && current.scope.accountId === scope.accountId) return current.read;
    const entry: Entry = { scope, read: readAccountSessionDeliveryMutedScopes(scope) };
    entries.set(scope.serverId, entry);
    // A failed read is not a fact: the next reader asks again.
    void entry.read.then(scopes => { if (scopes === null && entries.get(scope.serverId) === entry) entries.delete(scope.serverId); });
    return entry.read;
}
