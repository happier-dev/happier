import type { Message } from "@happier-dev/session-core/messages";
import type { ActivitySequenceEventReferenceV1} from '@happier-dev/protocol/activity/eventIdentity';
import type { AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { SessionFollowStalledOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';

type ActivitySessionUpdateNotification = Readonly<{
    address: SessionAddress;
    messages?: Message[];
} & (
    | { event: 'human_message'; committedSequence: ActivitySequenceEventReferenceV1; sourceAccountId: string }
    | { event: 'message'; committedSequence: ActivitySequenceEventReferenceV1;
        followEvent?: Readonly<{ kind: 'goal_changed' | 'update_posted' }> }
    | { event: 'failed' | 'cancelled'; turnId: string }
    | { event: 'source_unavailable'; stalledOccurrence?: SessionFollowStalledOccurrenceV1 }
)>;

export type ActivityLocalNotificationEvent =
    | (ActivitySessionUpdateNotification & Readonly<{ kind: 'session-update' }>)
    | Readonly<{
        kind: 'ready';
        event: 'ready';
        address: SessionAddress;
        messages?: Message[];
        committedSequence?: ActivitySequenceEventReferenceV1;
        committedLocalId?: string;
        source?: 'reconciliation';
    }>
    | Readonly<{
        kind: 'agent-request';
        event: 'permission_required' | 'user_action_required';
        address: SessionAddress;
        requestId: string;
        turnId?: string;
        requestKind: AgentRequestKind;
        toolName: string;
        toolArgs: unknown;
    }>;

type Listener = (event: ActivityLocalNotificationEvent) => void;

const listeners = new Set<Listener>();
const mutedWakeReconciliations = new Map<string, number>();
const wakeKey = (address: SessionAddress) => JSON.stringify([
    resolveServerProfileScopeIdForIdentifier(address.serverId), address.sessionId,
]);

/** Only the reconciliation of a qualified muted wake is silent; no preference is stored here. */
export async function withMutedActivityLocalNotifications<T>(address: SessionAddress, reconcile: () => Promise<T>): Promise<T> {
    const key = wakeKey(address);
    mutedWakeReconciliations.set(key, (mutedWakeReconciliations.get(key) ?? 0) + 1);
    try { return await reconcile(); }
    finally {
        const remaining = (mutedWakeReconciliations.get(key) ?? 1) - 1;
        if (remaining > 0) mutedWakeReconciliations.set(key, remaining);
        else mutedWakeReconciliations.delete(key);
    }
}

export function isActivityLocalNotificationMutedForWake(address: SessionAddress): boolean {
    return mutedWakeReconciliations.has(wakeKey(address));
}

function publish(event: ActivityLocalNotificationEvent): void {
    for (const listener of Array.from(listeners)) {
        try {
            listener(event);
        } catch {
            // One consumer cannot prevent the other current consumers from receiving a fact.
        }
    }
}

export function notifyActivitySessionUpdate(params: ActivitySessionUpdateNotification): void {
    const address = normalizeSessionAddress(params.address.serverId, params.address.sessionId);
    if (!address) return;
    publish({ ...params, address, kind: 'session-update' });
}

export function subscribeActivityLocalNotifications(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyActivityReady(
    addressInput: SessionAddress,
    messages?: Message[],
    committedSequence?: ActivitySequenceEventReferenceV1,
    committedLocalId?: string,
    source?: 'reconciliation',
): void {
    const address = normalizeSessionAddress(addressInput.serverId, addressInput.sessionId);
    if (!address) return;

    const event: ActivityLocalNotificationEvent = {
        kind: 'ready',
        event: 'ready',
        address,
        messages,
        ...(committedSequence ? { committedSequence } : {}),
        ...(committedLocalId ? { committedLocalId } : {}),
        ...(source ? { source } : {}),
    };

    publish(event);
}

export function notifyActivityAgentRequest(params: Readonly<{
    address: SessionAddress;
    requestId: string;
    turnId?: string;
    requestKind: AgentRequestKind;
    toolName: string;
    toolArgs: unknown;
}>): void {
    const address = normalizeSessionAddress(params.address.serverId, params.address.sessionId);
    const requestId = typeof params.requestId === 'string' ? params.requestId.trim() : '';
    const toolName = typeof params.toolName === 'string' ? params.toolName.trim() : '';
    if (!address || !requestId || !toolName) return;

    const event: ActivityLocalNotificationEvent = {
        kind: 'agent-request',
        event: params.requestKind === 'permission' ? 'permission_required' : 'user_action_required',
        address,
        requestId,
        ...(typeof params.turnId === 'string' && params.turnId.trim().length > 0
            ? { turnId: params.turnId.trim() }
            : {}),
        requestKind: params.requestKind,
        toolName,
        toolArgs: params.toolArgs,
    };

    publish(event);
}

export function resetActivityLocalNotificationRuntimeForTests(): void {
    listeners.clear();
}
