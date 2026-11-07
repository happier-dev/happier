import { ScmDiffSummaryResultUpdateEphemeralSchema, type ScmDiffSummaryResultRevisionHint } from '@happier-dev/protocol/scm/diffSummaryResult';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

type Listener = (change: ScmDiffSummaryResultRevisionHint) => void;
const listeners = new Map<string, Set<Listener>>();
function key(serverId: string, machineId: string) {
    return JSON.stringify([resolveServerProfileScopeIdForIdentifier(serverId), machineId]);
}

/** Both Home sockets route hints here; mounted readers retain their own Account/permission lifetime. */
export function notifyScmDiffSummaryResultActivity(serverId: string | null | undefined, update: unknown): void {
    if (!serverId) return;
    const parsed = ScmDiffSummaryResultUpdateEphemeralSchema.safeParse(update);
    if (!parsed.success) return;
    for (const listener of [...(listeners.get(key(serverId, parsed.data.machineId)) ?? [])]) listener(parsed.data);
}

export function subscribeScmDiffSummaryResultActivity(address: Readonly<{ serverId: string; machineId: string }>, listener: Listener): () => void {
    const addressKey = key(address.serverId, address.machineId);
    const subscribed = listeners.get(addressKey) ?? new Set<Listener>();
    subscribed.add(listener);
    listeners.set(addressKey, subscribed);
    return () => {
        subscribed.delete(listener);
        if (subscribed.size === 0) listeners.delete(addressKey);
    };
}
