import type { SessionAddress } from '../sessionAddress';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { DiscussionAddressV1Schema } from '@happier-dev/protocol/discussions/content';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    SessionHumanPresenceVisibleReplaceResultV1Schema,
    SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT as VISIBLE_EVENT,
    SESSION_HUMAN_PRESENCE_TYPING_SET_EVENT as TYPING_EVENT,
    type SessionHumanPresencePendingMessageEditV1,
} from '@happier-dev/protocol/sessions';
import { getVisibleSessionSurfaces, subscribeSessionSurfaceVisibility } from '../sessionSurfaceVisibility';
import { readHostActivelyViewed, subscribeToHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { readComputerUiFocusState, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { humanPresenceLocationKey, sessionHumanPresenceStore, type DiscussionHumanPresenceTarget, type SessionHumanPresenceTarget } from './sessionHumanPresenceStore';

export type SessionHumanPresenceSocketTransport = Readonly<{
    isConnected(): boolean;
    subscribeStatus(listener: () => void): () => void;
    sendWithAck(event: string, payload: unknown): Promise<unknown>;
    send(event: string, payload: unknown): void;
    subscribeSnapshot(listener: (payload: unknown) => void): () => void;
}>;

type Attachment = {
    accountId: string;
    dispose(preserveObservation?: boolean): void;
    publish(): void;
    edit(target: SessionHumanPresenceTarget, nonEmpty: boolean): void;
    stop(target?: SessionHumanPresenceTarget): void;
};
const homes = new Map<string, Attachment>();
// The existing registration owner covers both rendered Discussions and admitted
// pending edits. It retains desired declarations across socket replacement.
const registeredLocations = new Map<string, {
    target: SessionHumanPresenceTarget;
    accountId: string;
    count: number;
    pendingEdit?: { holdId: string; settleAdmission?: (admitted: boolean) => void };
}>();
let detachVisibility: (() => void) | null = null;

const targetKey = (target: SessionHumanPresenceTarget) => JSON.stringify([target.serverId, humanPresenceLocationKey(target)]);
const targetIdentity = (target: SessionHumanPresenceTarget) => target.discussionId === undefined
    ? { sessionId: target.sessionId } : { discussionId: target.discussionId };

function currentDiscussionAttachment(target: DiscussionHumanPresenceTarget, lifetime: ServerAccountScopeLifetime): Attachment | undefined {
    const serverId = resolveServerProfileScopeIdForIdentifier(target.serverId);
    if (!lifetime.isCurrent() || resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId) !== serverId) return;
    const home = homes.get(serverId);
    return home?.accountId === lifetime.scope.accountId ? home : undefined;
}

/** Registers one visible discussion through the existing per-Home replace-set owner. */
export function registerDiscussionHumanPresence(target: DiscussionHumanPresenceTarget, lifetime: ServerAccountScopeLifetime): () => void {
    const parsed = DiscussionAddressV1Schema.safeParse(target);
    if (!parsed.success || !lifetime.isCurrent()) return () => {};
    const normalized = { ...parsed.data, serverId: resolveServerProfileScopeIdForIdentifier(parsed.data.serverId) };
    if (resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId) !== normalized.serverId) return () => {};
    const key = JSON.stringify([lifetime.scope.accountId, targetKey(normalized)]);
    const entry = registeredLocations.get(key) ?? { target: normalized, accountId: lifetime.scope.accountId, count: 0 };
    entry.count++;
    registeredLocations.set(key, entry);
    homes.get(normalized.serverId)?.publish();
    let disposed = false;
    let retirement: Readonly<{ dispose(): void }> | undefined;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        retirement?.dispose();
        if (registeredLocations.get(key) !== entry) return;
        if (--entry.count === 0) registeredLocations.delete(key);
        homes.get(normalized.serverId)?.publish();
    };
    retirement = lifetime.onRetire(dispose);
    return dispose;
}

/** Acquire only after the existing socket owner admits this edit declaration. */
export async function registerSessionPendingMessageEdit(
    target: SessionAddress,
    holdId: string,
    lifetime: ServerAccountScopeLifetime,
): Promise<() => void> {
    const serverId = resolveServerProfileScopeIdForIdentifier(target.serverId);
    const home = homes.get(serverId);
    if (!lifetime.isCurrent() || resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId) !== serverId
        || !home || home.accountId !== lifetime.scope.accountId) {
        throw new Error('Pending message edit presence unavailable');
    }
    return new Promise((resolve, reject) => {
        const normalized = { serverId, sessionId: target.sessionId };
        const key = JSON.stringify([lifetime.scope.accountId, targetKey(normalized), holdId]);
        let disposed = false;
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const pendingEdit: { holdId: string; settleAdmission?: (admitted: boolean) => void } = {
            holdId,
            settleAdmission(admitted) {
                pendingEdit.settleAdmission = undefined;
                if (admitted) resolve(dispose);
                else { dispose(); reject(new Error('Pending message edit presence unavailable')); }
            },
        };
        const entry = { target: normalized, accountId: lifetime.scope.accountId, count: 1, pendingEdit };
        function dispose() {
            if (disposed) return;
            disposed = true;
            retirement?.dispose();
            if (registeredLocations.get(key) === entry) registeredLocations.delete(key);
            pendingEdit.settleAdmission?.(false);
            homes.get(serverId)?.publish();
        }
        registeredLocations.set(key, entry);
        retirement = lifetime.onRetire(dispose);
        home.publish();
    });
}

export function reportSessionTypingEdit(address: SessionAddress, nonEmpty: boolean): void {
    const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
    homes.get(serverId)?.edit({ ...address, serverId }, nonEmpty);
}
export function stopSessionTyping(address: SessionAddress): void {
    const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
    homes.get(serverId)?.stop({ ...address, serverId });
}
export function reportDiscussionTypingEdit(target: DiscussionHumanPresenceTarget, nonEmpty: boolean, lifetime: ServerAccountScopeLifetime): void {
    currentDiscussionAttachment(target, lifetime)?.edit({ ...target, serverId: resolveServerProfileScopeIdForIdentifier(target.serverId) }, nonEmpty);
}
export function stopDiscussionTyping(target: DiscussionHumanPresenceTarget, lifetime: ServerAccountScopeLifetime): void {
    currentDiscussionAttachment(target, lifetime)?.stop({ ...target, serverId: resolveServerProfileScopeIdForIdentifier(target.serverId) });
}

export function attachSessionHumanPresenceSocket(input: Readonly<{
    serverId: string;
    accountId: string;
    transport: SessionHumanPresenceSocketTransport;
}>): () => void {
    const { accountId, transport } = input;
    const serverId = resolveServerProfileScopeIdForIdentifier(input.serverId);
    homes.get(serverId)?.dispose(true);
    let handle = sessionHumanPresenceStore.attachHome(serverId, accountId);
    let connected = false;
    let disposed = false;
    let focusSignature: string | null = null;
    const publishFocus = () => {
        if (disposed || !connected) return;
        const focus = readComputerUiFocusState();
        if (!focus.computer && focusSignature === null) return;
        const next = JSON.stringify(focus);
        if (next === focusSignature) return;
        focusSignature = next;
        transport.send('ui-focus', focus);
    };
    let generation = 0;
    let support: 'unknown' | 'supported' | 'unavailable' = 'unknown';
    let pending = false;
    let signature: string | null = null;
    let unacknowledgedDeclarationMayBeApplied = false;
    let admitted = new Set<string>();
    let admittedLocations = new Set<string>();
    let typing: {target: SessionHumanPresenceTarget; renewedAt: number; timer: ReturnType<typeof setTimeout>} | null = null;
    const currentLocations = (): DiscussionHumanPresenceTarget[] => readHostActivelyViewed()
        ? [...registeredLocations.values()].filter((entry) => entry.accountId === accountId && entry.target.serverId === serverId
                && entry.target.discussionId !== undefined)
            .map((entry) => entry.target as DiscussionHumanPresenceTarget)
            .sort((left, right) => left.discussionId.localeCompare(right.discussionId))
        : [];
    const currentIds = () => readHostActivelyViewed()
        ? [...new Set(getVisibleSessionSurfaces()
            .filter((address) => address.serverId === serverId)
            .map((address) => address.sessionId))].sort()
        : [];
    const stop = (target?: SessionHumanPresenceTarget) => {
        if (!typing || (target && targetKey(target) !== targetKey(typing.target))) return;
        clearTimeout(typing.timer);
        if (transport.isConnected() && support === 'supported') transport.send(TYPING_EVENT, {
            v: 1,
            ...targetIdentity(typing.target),
            typing: false,
        });
        typing = null;
    };
    const publish = () => {
        const ids = currentIds();
        const locations = currentLocations().map(({ discussionId }) => ({ discussionId }));
        const edits = [...registeredLocations.values()].filter(entry => entry.accountId === accountId
            && entry.target.serverId === serverId && entry.pendingEdit !== undefined);
        const pendingMessageEdits = edits.map(entry => ({ sessionId: entry.target.sessionId!, holdId: entry.pendingEdit!.holdId }))
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.holdId.localeCompare(right.holdId));
        const settleEdits = (admittedEdits: readonly SessionHumanPresencePendingMessageEditV1[]) => {
            for (const entry of edits) entry.pendingEdit!.settleAdmission?.(admittedEdits.some(edit =>
                edit.sessionId === entry.target.sessionId && edit.holdId === entry.pendingEdit!.holdId));
        };
        const desiredKeys = new Set(locations.map((location) => location.discussionId));
        if (typing && (typeof typing.target.sessionId === 'string'
            ? !ids.includes(typing.target.sessionId)
            : !desiredKeys.has(typing.target.discussionId))) stop();
        if (disposed || !connected) { settleEdits([]); return; }
        if (pending) return;
        const includePendingEdits = pendingMessageEdits.length > 0;
        const nextSignature = JSON.stringify([ids, locations, includePendingEdits ? pendingMessageEdits : null]);
        if (signature === nextSignature) return;
        if (support === 'unavailable') {
            settleEdits([]);
            // A timed-out/malformed acknowledgement does not reveal whether the Home
            // committed the declaration. Do not probe again, but clear that possible
            // declaration once when this host stops presenting every Session.
            if (ids.length === 0 && locations.length === 0 && unacknowledgedDeclarationMayBeApplied) {
                transport.send(VISIBLE_EVENT, { v: 1, sessionIds: [] });
                unacknowledgedDeclarationMayBeApplied = false;
                signature = nextSignature;
            }
            return;
        }
        signature = nextSignature;
        pending = true;
        unacknowledgedDeclarationMayBeApplied = true;
        const issuedGeneration = generation;
        handle.beginDeclaration(ids, locations);
        const payload = {
            v: 1 as const,
            sessionIds: ids,
            ...(locations.length > 0 ? { locations } : {}),
            ...(includePendingEdits ? { pendingMessageEdits } : {}),
        };
        void transport.sendWithAck(VISIBLE_EVENT, payload).then((raw) => {
            if (disposed || issuedGeneration !== generation) return;
            const parsed = SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse(raw);
            if (!parsed.success) {
                settleEdits([]);
                // A malformed or absent reply is inconclusive transport evidence, not
                // proof about the Home. Stop probing this generation.
                stop();
                support = 'unavailable';
                handle.setStatus('unavailable');
                return;
            }
            unacknowledgedDeclarationMayBeApplied = false;
            if (!parsed.data.ok) {
                settleEdits([]);
                stop();
                admitted.clear();
                admittedLocations.clear();
                if (parsed.data.errorCode === 'UNSUPPORTED_VERSION') {
                    support = 'unavailable';
                    handle.setStatus('unsupported');
                    return;
                }
                // A strict V1 refusal still proves the operation exists, so temporary
                // unavailability must not permanently silence this Home. The attempted
                // signature is retained so the same rejected set is not retried in a
                // loop; the next actual visibility change declares again.
                support = 'supported';
                handle.setStatus('unavailable');
                return;
            }
            support = 'supported';
            settleEdits(parsed.data.admittedPendingMessageEdits ?? []);
            admitted = new Set(parsed.data.admittedSessionIds.filter((sessionId) => ids.includes(sessionId)));
            admittedLocations = new Set((parsed.data.admittedLocations ?? [])
                .map((location) => location.discussionId)
                .filter((key): key is string => typeof key === 'string' && desiredKeys.has(key)));
            handle.confirmDeclaration(
                [...admitted],
                locations.filter((location) => admittedLocations.has(location.discussionId)),
            );
            if (typing && (typeof typing.target.sessionId === 'string'
                ? !admitted.has(typing.target.sessionId)
                : !admittedLocations.has(typing.target.discussionId))) stop();
        }).catch(() => {
            if (disposed || issuedGeneration !== generation) return;
            stop();
            support = 'unavailable';
            settleEdits([]);
            handle.setStatus('unavailable');
        }).finally(() => {
            if (disposed || issuedGeneration !== generation) return;
            pending = false;
            publish();
        });
    };
    const attachment: Attachment = {
        accountId,
        dispose: (preserveObservation) => dispose(preserveObservation),
        publish,
        stop,
        edit(target, nonEmpty) {
            if (!nonEmpty) { stop(target); return; }
            const targetAdmitted = typeof target.sessionId === 'string'
                ? admitted.has(target.sessionId)
                : admittedLocations.has(target.discussionId);
            const targetVisible = typeof target.sessionId === 'string'
                ? currentIds().includes(target.sessionId)
                : currentLocations().some((location) => targetKey(location) === targetKey(target));
            if (disposed || !connected || support !== 'supported' || !targetAdmitted || !targetVisible) return;
            if (!typing || targetKey(typing.target) !== targetKey(target)) stop();
            const now = Date.now();
            const renew = !typing || now - typing.renewedAt >= 2_000;
            const renewedAt = renew ? now : typing!.renewedAt;
            if (typing) clearTimeout(typing.timer);
            if (renew) transport.send(TYPING_EVENT, {
                v: 1,
                ...targetIdentity(target),
                typing: true,
            });
            typing = { target, renewedAt, timer: setTimeout(() => stop(target), 4_000) };
        },
    };
    homes.set(serverId, attachment);
    if (!detachVisibility) {
        const notify = () => { for (const home of homes.values()) home.publish(); };
        const offSurfaces = subscribeSessionSurfaceVisibility(notify);
        const offHost = subscribeToHostActivelyViewed(notify);
        detachVisibility = () => { offSurfaces(); offHost(); };
    }
    const changeStatus = () => {
        const next = transport.isConnected();
        if (next === connected) return;
        stop();
        connected = next;
        focusSignature = null;
        generation++;
        pending = false;
        signature = null;
        admitted.clear();
        admittedLocations.clear();
        unacknowledgedDeclarationMayBeApplied = false;
        if (!connected) {
            // A retired transport cannot acknowledge a new acquire. Admitted
            // declarations have no pending callback and remain desired on reconnect.
            for (const entry of registeredLocations.values()) {
                if (entry.accountId === accountId && entry.target.serverId === serverId) entry.pendingEdit?.settleAdmission?.(false);
            }
        }
        if (connected) {
            publishFocus();
            handle = sessionHumanPresenceStore.attachHome(serverId, accountId);
            support = 'unknown';
            publish();
        } else handle.setStatus('connecting');
    };
    const offStatus = transport.subscribeStatus(changeStatus);
    const offFocus = subscribeToRuntimeActiveChange(publishFocus, { includeWindowFocus: true });
    const offSnapshot = transport.subscribeSnapshot((raw) => {
        if (!disposed && connected && support === 'supported') handle.receiveSnapshot(raw);
    });
    changeStatus();
    function dispose(preserveObservation = false) {
        if (disposed) return;
        if (connected && focusSignature !== null) transport.send('ui-focus', { computer: true, focused: false });
        stop();
        if (connected && (support === 'supported' || unacknowledgedDeclarationMayBeApplied)) {
            transport.send(VISIBLE_EVENT, { v: 1, sessionIds: [] });
            unacknowledgedDeclarationMayBeApplied = false;
        }
        disposed = true;
        generation++;
        offStatus(); offSnapshot(); offFocus();
        if (!preserveObservation) handle.dispose();
        if (homes.get(serverId) === attachment) homes.delete(serverId);
        if (homes.size === 0) { detachVisibility?.(); detachVisibility = null; }
    }
    return dispose;
}
