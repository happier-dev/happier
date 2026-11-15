import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import type {
    OrdinarySessionMembershipChange,
    SessionListRenderableDelta,
} from '@/sync/store/domains/sessionListIndexFinalization';
import type { StorageState } from '@/sync/store/types';

import { forEachRecordValue } from './recordIteration';

/** The Session collections the store's changed-id publication describes. */
export type ActivityStoreRowCollections = Readonly<{
    sessions: unknown;
    sessionListRowsByServerId: unknown;
    ordinarySessionListMembershipByServerId: unknown;
}>;

export type ActivityStoreObservation = ActivityStoreRowCollections & Readonly<{ revision: number | null }>;

export type ActivityStoreChangeScope =
    | Readonly<{ complete: true }>
    | Readonly<{
        complete: false;
        /** Every Session whose record, row or ordinary membership can differ since the observation. */
        sessionIds: ReadonlySet<string>;
        ordinaryMembershipChanges: readonly OrdinarySessionMembershipChange[];
    }>;

const COMPLETE: ActivityStoreChangeScope = Object.freeze({ complete: true });
const NO_MEMBERSHIP_CHANGES: readonly OrdinarySessionMembershipChange[] = Object.freeze([]);

export function observeActivityStore(
    collections: ActivityStoreRowCollections,
    delta: SessionListRenderableDelta | undefined,
): ActivityStoreObservation {
    return {
        sessions: collections.sessions,
        sessionListRowsByServerId: collections.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: collections.ordinarySessionListMembershipByServerId,
        revision: delta?.revision ?? null,
    };
}

/**
 * Which Sessions can differ between an observed store and the next one. Known only when nothing moved,
 * or when the next store is exactly one changed-id revision later and any membership move is described.
 * Anything else (a revision gap, a collection moved without a revision step) is complete.
 */
export function readActivityStoreChangeScope(
    previous: ActivityStoreObservation | null,
    next: ActivityStoreRowCollections,
    delta: SessionListRenderableDelta | undefined,
): ActivityStoreChangeScope {
    if (previous === null) return COMPLETE;
    const revision = delta?.revision ?? null;
    const membershipUnchanged = previous.ordinarySessionListMembershipByServerId === next.ordinarySessionListMembershipByServerId;
    if (
        revision === previous.revision
        && previous.sessions === next.sessions
        && previous.sessionListRowsByServerId === next.sessionListRowsByServerId
        && membershipUnchanged
    ) {
        return { complete: false, sessionIds: new Set(), ordinaryMembershipChanges: NO_MEMBERSHIP_CHANGES };
    }
    if (!delta || previous.revision === null || revision !== previous.revision + 1) return COMPLETE;
    if (!membershipUnchanged && delta.ordinaryMembershipChanges === undefined) return COMPLETE;
    const sessionIds = new Set([...delta.changedSessionIds, ...delta.removedSessionIds, ...(delta.hydratedSessionIds ?? [])]);
    const ordinaryMembershipChanges = membershipUnchanged ? NO_MEMBERSHIP_CHANGES : delta.ordinaryMembershipChanges ?? NO_MEMBERSHIP_CHANGES;
    for (const change of ordinaryMembershipChanges) {
        for (const id of change.addedSessionIds) sessionIds.add(id);
        for (const id of change.removedSessionIds) sessionIds.add(id);
    }
    return { complete: false, sessionIds, ordinaryMembershipChanges };
}

/**
 * Per-key signatures of the facts a selector reads. A key is re-signed only when its value moved;
 * the caller learns whether any signature, or the key set, moved.
 */
export function createActivitySignatureTable<V>() {
    const entries = new Map<string, Readonly<{ value: V; signature: string }>>();
    return {
        has: (key: string) => entries.has(key),
        keys: () => entries.keys(),
        signature: (key: string) => entries.get(key)?.signature,
        value: (key: string) => entries.get(key)?.value,
        /** `force` re-signs an unchanged value whose signature also depends on something else (time). */
        write(key: string, value: V, sign: () => string, force = false): boolean {
            const previous = entries.get(key);
            if (previous !== undefined && previous.value === value && !force) return false;
            const signature = sign();
            entries.set(key, { value, signature });
            return previous?.signature !== signature;
        },
        delete: (key: string) => entries.delete(key),
        /** Drops every key outside `live`. */
        retain(live: ReadonlySet<string>): boolean {
            let moved = false;
            for (const key of entries.keys()) {
                if (!live.has(key)) {
                    entries.delete(key);
                    moved = true;
                }
            }
            return moved;
        },
    };
}

export type ActivitySignatureTable<V> = ReturnType<typeof createActivitySignatureTable<V>>;

/** Ordinary membership as sets, kept current from the store's described membership moves. */
export function createOrdinaryMembershipSets() {
    let sets = new Map<string, Set<string>>();
    return {
        servers: () => sets.keys(),
        has: (serverId: string, sessionId: string) => sets.get(serverId)?.has(sessionId) === true,
        replace(membershipByServerId: Readonly<Record<string, readonly string[] | undefined>> | undefined) {
            sets = new Map();
            for (const serverId in membershipByServerId ?? {}) {
                const membership = membershipByServerId?.[serverId];
                if (Array.isArray(membership)) sets.set(serverId, new Set(membership));
            }
        },
        apply(changes: readonly OrdinarySessionMembershipChange[]) {
            for (const change of changes) {
                const set = sets.get(change.serverId) ?? new Set<string>();
                sets.set(change.serverId, set);
                for (const id of change.removedSessionIds) set.delete(id);
                for (const id of change.addedSessionIds) set.add(id);
            }
        },
    };
}

type MembershipByServerId = Readonly<Record<string, readonly string[]>>;
type StoredSessionMessages = StorageState['sessionMessages'][string];

export type ActivityStoreSignerOptions = Readonly<{
    signSession: (session: Session, state: StorageState) => string;
    signRow: (row: SessionListRenderableSession, serverId: string) => string;
    /** Memberships fixed for the signer's lifetime whose rows are read besides ordinary membership. */
    fixedRowMemberships: readonly MembershipByServerId[];
    /** Transcripts of Sessions, ordinary members and these fixed members; `null` reads none. */
    transcripts: null | Readonly<{ fixedMemberships: readonly MembershipByServerId[]; detailAddresses?: readonly SessionAddress[] }>;
}>;

/** Which store collections moved since the signer's previous update. */
export type ActivityStoreMovedCollections = Readonly<{
    sessions: boolean;
    rows: boolean;
    membership: boolean;
    transcripts: boolean;
}>;

/**
 * The Session, scoped row and transcript facts one Activity selector reads, signed per key. A
 * publication whose change scope is known re-signs only the Sessions it names (and transcripts
 * whose pointer moved); anything else re-signs every key, reusing each unchanged value's signature.
 */
export function createActivityStoreSigner(options: ActivityStoreSignerOptions) {
    const fixedRowSets = options.fixedRowMemberships.map(toMembershipSets);
    const fixedTranscriptSets = (options.transcripts?.fixedMemberships ?? []).map(toMembershipSets);
    const ordinary = createOrdinaryMembershipSets();
    const sessionTable = createActivitySignatureTable<Session>();
    const rowTable = createActivitySignatureTable<SessionListRenderableSession | null>();
    const messageTable = createActivitySignatureTable<StoredSessionMessages | null>();
    const transcriptIds = new Set<string>();
    let potentialSessionIds: readonly string[] = [];
    let movedTranscriptIds = new Set<string>();

    const isRowMember = (serverId: string, sessionId: string) => ordinary.has(serverId, sessionId)
        || fixedRowSets.some(sets => sets.get(serverId)?.has(sessionId) === true);
    const isTranscriptMember = (state: StorageState, sessionId: string) => {
        if (state.sessions[sessionId] !== undefined) return true;
        for (const serverId of ordinary.servers()) if (ordinary.has(serverId, sessionId)) return true;
        return fixedTranscriptSets.some(sets => [...sets.values()].some(ids => ids.has(sessionId)));
    };
    const writeSession = (state: StorageState, id: string, session: Session) =>
        sessionTable.write(id, session, () => options.signSession(session, state));
    const writeRow = (state: StorageState, serverId: string, sessionId: string, key: string) => {
        const row = state.sessionListRowsByServerId?.[serverId]?.[sessionId] ?? null;
        return rowTable.write(key, row, () => row ? options.signRow(row, serverId) : '');
    };
    const writeMessages = (state: StorageState, id: string) => {
        const messages = state.sessionMessages[id] ?? null;
        if (messageTable.value(id) !== messages || !messageTable.has(id)) movedTranscriptIds.add(id);
        if (messages) transcriptIds.add(id);
        else transcriptIds.delete(id);
        return messageTable.write(id, messages, () => buildTranscriptSignature(messages));
    };
    const dropMessages = (id: string) => {
        transcriptIds.delete(id);
        if (!messageTable.delete(id)) return false;
        movedTranscriptIds.add(id);
        return true;
    };

    function signAllSessions(state: StorageState): boolean {
        let moved = false;
        const live = new Set<string>();
        forEachRecordValue(state.sessions, (session, id) => {
            live.add(id);
            if (writeSession(state, id, session)) moved = true;
        });
        return sessionTable.retain(live) || moved;
    }

    function signSessionsOf(state: StorageState, sessionIds: ReadonlySet<string>): boolean {
        let moved = false;
        for (const id of sessionIds) {
            const session = state.sessions[id];
            if (session ? writeSession(state, id, session) : sessionTable.delete(id)) moved = true;
        }
        return moved;
    }

    function signAllRows(state: StorageState): boolean {
        ordinary.replace(state.ordinarySessionListMembershipByServerId);
        let moved = false;
        const live = new Set<string>();
        for (const membershipByServerId of [state.ordinarySessionListMembershipByServerId ?? {}, ...options.fixedRowMemberships]) {
            for (const [serverId, membership] of Object.entries(membershipByServerId)) {
                for (const sessionId of membership ?? []) {
                    const key = sessionAddressKey({ serverId, sessionId });
                    if (live.has(key)) continue;
                    live.add(key);
                    if (writeRow(state, serverId, sessionId, key)) moved = true;
                }
            }
        }
        return rowTable.retain(live) || moved;
    }

    function signRowsOf(state: StorageState, sessionIds: ReadonlySet<string>): boolean {
        let moved = false;
        const servers = new Set([...ordinary.servers(), ...fixedRowSets.flatMap(sets => [...sets.keys()])]);
        for (const sessionId of sessionIds) {
            for (const serverId of servers) {
                const key = sessionAddressKey({ serverId, sessionId });
                if (isRowMember(serverId, sessionId) ? writeRow(state, serverId, sessionId, key) : rowTable.delete(key)) moved = true;
            }
        }
        return moved;
    }

    function signAllTranscripts(state: StorageState): boolean {
        const detailAddresses = options.transcripts?.detailAddresses;
        let live: Set<string>;
        if (detailAddresses) {
            potentialSessionIds = detailAddresses
                .filter(address => state.sessions[address.sessionId]?.serverId === address.serverId)
                .map(address => address.sessionId);
            live = new Set(potentialSessionIds);
        } else {
            live = new Set<string>();
            forEachRecordValue(state.sessions, (_session, id) => { live.add(id); });
            for (const membershipByServerId of [state.ordinarySessionListMembershipByServerId ?? {}, ...(options.transcripts?.fixedMemberships ?? [])]) {
                forEachRecordValue(membershipByServerId, (membership) => {
                    if (!Array.isArray(membership)) return;
                    for (const id of membership) if (id.trim()) live.add(id);
                });
            }
        }
        let moved = false;
        for (const id of live) if (writeMessages(state, id)) moved = true;
        for (const id of messageTable.keys()) {
            if (!live.has(id)) {
                transcriptIds.delete(id);
                movedTranscriptIds.add(id);
            }
        }
        return messageTable.retain(live) || moved;
    }

    /** Named Sessions may enter or leave the transcript corpus; other moved transcripts keep their membership. */
    function signTranscriptsOf(state: StorageState, sessionIds: ReadonlySet<string>, transcriptsMoved: boolean): boolean {
        let moved = false;
        for (const id of sessionIds) {
            if (isTranscriptMember(state, id) ? writeMessages(state, id) : dropMessages(id)) moved = true;
        }
        if (transcriptsMoved) {
            // Linear in loaded transcripts, not in Sessions.
            for (const id of new Set([...Object.keys(state.sessionMessages), ...transcriptIds])) {
                if (!sessionIds.has(id) && messageTable.has(id) && writeMessages(state, id)) moved = true;
            }
        }
        return moved;
    }

    return {
        /** Re-signs what the moved collections and the change scope allow; returns whether any signature moved. */
        update(state: StorageState, scope: ActivityStoreChangeScope, moved: ActivityStoreMovedCollections): boolean {
            movedTranscriptIds = new Set();
            let signatureMoved = false;
            if (moved.sessions && (scope.complete ? signAllSessions(state) : signSessionsOf(state, scope.sessionIds))) signatureMoved = true;
            if (moved.rows || moved.membership) {
                if (!scope.complete) ordinary.apply(scope.ordinaryMembershipChanges);
                if (scope.complete ? signAllRows(state) : signRowsOf(state, scope.sessionIds)) signatureMoved = true;
            }
            if (options.transcripts && (moved.sessions || moved.membership || moved.transcripts)
                && (scope.complete || options.transcripts.detailAddresses
                    ? signAllTranscripts(state)
                    : signTranscriptsOf(state, scope.sessionIds, moved.transcripts))) {
                signatureMoved = true;
            }
            return signatureMoved;
        },
        /** Detail mode: the demanded Sessions whose transcripts this signer reads. */
        potentialSessionIds: () => potentialSessionIds,
        sessionSignature: (sessionId: string) => sessionTable.signature(sessionId),
        transcriptSignature: (sessionId: string) => messageTable.signature(sessionId),
        /** Sessions whose transcript pointer the last update observed moving (or entering/leaving). */
        movedTranscriptIds: (): ReadonlySet<string> => movedTranscriptIds,
        sessionIds: () => sessionTable.keys(),
        rowKeys: () => rowTable.keys(),
        row: (key: string) => rowTable.value(key) ?? null,
    };
}

function toMembershipSets(membershipByServerId: MembershipByServerId): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map(Object.entries(membershipByServerId).map(([serverId, ids]) => [serverId, new Set(ids)]));
}

function readSignatureNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * The transcript facts Activity reads. The shared message reader accepts both the current normalized
 * store and the released array-shaped state, so the count reads either shape.
 */
function buildTranscriptSignature(sessionMessages: StoredSessionMessages | null): string {
    if (!sessionMessages) return '';
    const stateLike = sessionMessages as Readonly<{ messageIdsOldestFirst?: unknown; messages?: unknown }>;
    const messageCount = Array.isArray(stateLike.messageIdsOldestFirst)
        ? stateLike.messageIdsOldestFirst.length
        : Array.isArray(stateLike.messages) ? stateLike.messages.length : 0;
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readSignatureNumber(sessionMessages.messagesVersion) ?? '',
        readSignatureNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readSignatureNumber(sessionMessages.latestReadyEventAt) ?? '',
        messageCount,
    ].map(part => `${String(part).length}:${String(part)}`).join('');
}
