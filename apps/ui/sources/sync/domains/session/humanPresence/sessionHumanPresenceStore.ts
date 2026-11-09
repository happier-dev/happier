import { SessionHumanPresenceSnapshotV1Schema, type SessionHumanPresenceViewerV1, type SessionHumanPresenceLocationV1 } from '@happier-dev/protocol/sessions';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions/content';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { SessionAddress } from '../sessionAddress';

export type SessionHumanPresenceViewer = SessionHumanPresenceViewerV1;
export type DiscussionHumanPresenceTarget = DiscussionAddressV1 & Readonly<{ sessionId?: never }>;
export type SessionHumanPresenceTarget =
    | (SessionAddress & Readonly<{ discussionId?: never }>)
    | DiscussionHumanPresenceTarget;
type PresenceLocation =
    | Readonly<{ sessionId: string; discussionId?: never }>
    | (SessionHumanPresenceLocationV1 & Readonly<{ sessionId?: never }>);

export function humanPresenceLocationKey(location: PresenceLocation): string {
    return JSON.stringify(location.discussionId === undefined
        ? ['session', location.sessionId] : ['discussion', location.discussionId]);
}
export type SessionHumanPresenceView = Readonly<{
    status: 'unsupported' | 'connecting' | 'live' | 'stale' | 'unavailable';
    viewers: readonly SessionHumanPresenceViewer[];
    observedAt: number | null;
}>;
type HomeStatus = 'connecting' | 'unavailable' | 'unsupported';
/** Shared per-status singletons keep `useSyncExternalStore` snapshots referentially stable. */
const emptyView = (status: HomeStatus): SessionHumanPresenceView => ({ status, viewers: [], observedAt: null });
const emptyViews: Record<HomeStatus, SessionHumanPresenceView> = {
    connecting: emptyView('connecting'),
    unavailable: emptyView('unavailable'),
    unsupported: emptyView('unsupported'),
};

type Home = {
    accountId: string;
    status: HomeStatus;
    declared: Set<string>;
    /** Server-acknowledged subset of `declared`; `null` while the current declaration is unacknowledged. */
    admitted: Set<string> | null;
    observations: Map<string, SessionHumanPresenceView>;
};

/** Ephemeral human observations only. Visibility, access and read state have independent owners. */
export function createSessionHumanPresenceStore() {
    const homes = new Map<string, Home>();
    const listeners = new Map<string, Set<() => void>>();
    const subscriptions = new Map<string, SessionHumanPresenceTarget>();
    const read = (address: SessionHumanPresenceTarget, accountId?: string): SessionHumanPresenceView => {
        const home = homes.get(address.serverId);
        if (!home || accountId !== undefined && home.accountId !== accountId) return emptyViews.unavailable;
        const key = humanPresenceLocationKey(address);
        const observation = home.observations.get(key);
        if (observation) return observation;
        // An acknowledged declaration is the Home's complete answer: a Session it
        // did not admit will never receive a snapshot, so presenting it as pending
        // would be an indefinite untruth. Before that answer arrives the socket is
        // genuinely still connecting.
        return home.status === 'connecting' && home.admitted !== null && !home.admitted.has(key)
            ? emptyViews.unavailable
            : emptyViews[home.status];
    };
    function notifyChanged(serverId: string, change: () => void) {
        const before = new Map<string, SessionHumanPresenceView>();
        for (const [key, address] of subscriptions) if (address.serverId === serverId) before.set(key, read(address));
        change();
        for (const [key, previous] of before) {
            const address = subscriptions.get(key);
            if (address && previous !== read(address)) for (const listener of listeners.get(key) ?? []) listener();
        }
    }
    function markStale(home: Home) {
        for (const [sessionId, view] of home.observations) {
            if (view.status !== 'stale') home.observations.set(sessionId, { ...view, status: 'stale' });
        }
    }
    return {
        read,
        subscribe(address: SessionHumanPresenceTarget, listener: () => void) {
            const key = JSON.stringify([address.serverId, humanPresenceLocationKey(address)]);
            const set = listeners.get(key) ?? new Set<() => void>();
            set.add(listener);
            listeners.set(key, set);
            subscriptions.set(key, address);
            return () => {
                set.delete(listener);
                if (set.size === 0) { listeners.delete(key); subscriptions.delete(key); }
            };
        },
        attachHome(serverId: string, accountId: string) {
            const previous = homes.get(serverId);
            const home: Home = {
                accountId, status: 'connecting', declared: new Set(), admitted: null,
                observations: previous?.accountId === accountId ? previous.observations : new Map(),
            };
            notifyChanged(serverId, () => { markStale(home); homes.set(serverId, home); });
            const current = () => homes.get(serverId) === home;
            return {
                beginDeclaration(sessionIds: readonly string[], locations: readonly SessionHumanPresenceLocationV1[] = []) {
                    if (!current()) return;
                    notifyChanged(serverId, () => {
                        home.declared = new Set([
                            ...sessionIds.map((sessionId) => humanPresenceLocationKey({ sessionId })),
                            ...locations.map(humanPresenceLocationKey),
                        ]);
                        home.admitted = null;
                        home.status = 'connecting';
                        markStale(home);
                    });
                },
                /** The acknowledged admitted set is the server's access answer, not a second authorization. */
                confirmDeclaration(sessionIds: readonly string[], locations: readonly SessionHumanPresenceLocationV1[] = []) {
                    if (!current()) return;
                    notifyChanged(serverId, () => {
                        const admitted = new Set([
                            ...sessionIds.map((sessionId) => humanPresenceLocationKey({ sessionId })),
                            ...locations.map(humanPresenceLocationKey),
                        ].filter((key) => home.declared.has(key)));
                        home.admitted = admitted;
                        for (const key of [...home.observations.keys()]) {
                            if (!admitted.has(key)) home.observations.delete(key);
                        }
                    });
                },
                setStatus(status: HomeStatus) {
                    if (!current()) return;
                    notifyChanged(serverId, () => {
                        home.status = status;
                        if (status === 'unsupported') home.observations.clear();
                        else markStale(home);
                    });
                },
                receiveSnapshot(raw: unknown) {
                    if (!current() || home.status === 'unsupported' || home.status === 'unavailable') return;
                    const parsed = SessionHumanPresenceSnapshotV1Schema.safeParse(raw);
                    if (!parsed.success) return;
                    const key = humanPresenceLocationKey(parsed.data);
                    if (!(home.admitted ?? home.declared).has(key)) return;
                    const snapshot = parsed.data;
                    const unique = new Map<string, SessionHumanPresenceViewer>();
                    for (const viewer of snapshot.viewers) {
                        if (viewer.account.accountId === accountId) continue;
                        const existing = unique.get(viewer.account.accountId);
                        unique.set(viewer.account.accountId, existing?.typing && !viewer.typing ? { ...viewer, typing: true } : viewer);
                    }
                    const viewers = [...unique.values()].sort((a, b) => (
                        (formatAccountDisplayName(a.account) ?? '').toLocaleLowerCase().localeCompare((formatAccountDisplayName(b.account) ?? '').toLocaleLowerCase())
                        || a.account.accountId.localeCompare(b.account.accountId)
                    ));
                    const previousView = home.observations.get(key);
                    const next: SessionHumanPresenceView = { status: 'live', viewers, observedAt: snapshot.observedAt };
                    // The observation clock alone is no change: a heartbeat with the same viewers keeps the view.
                    if (previousView?.status === next.status
                        && JSON.stringify(previousView.viewers) === JSON.stringify(next.viewers)) return;
                    notifyChanged(serverId, () => home.observations.set(key, next));
                },
                dispose() {
                    if (current()) notifyChanged(serverId, () => homes.delete(serverId));
                },
            };
        },
    };
}

export const sessionHumanPresenceStore = createSessionHumanPresenceStore();
