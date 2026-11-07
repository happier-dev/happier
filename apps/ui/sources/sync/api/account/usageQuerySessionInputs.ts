import type { Session } from '@/sync/domains/state/storageTypes';
import type { UsageSessionMessageEvidence, projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS } from '@happier-dev/protocol/usage/usageTimingV1';
import type { UsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { captureAccountEncryptionCurrentness } from './apiAccountEncryptionMode';
import { SessionPartsHttpError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { readUsageHistoryFailure } from './usageHistoryReadState';

export type SessionInputEvidence = Readonly<{
    session: UsageSessionInput;
    callerDataKeyEnvelope: string | null;
    detail: ReturnType<typeof projectSessionUsageWorkEvidence>;
    messageEvidence?: UsageSessionMessageEvidence;
    completeMessageCoverage: boolean;
    /** Compact identities without a current fact still need their private Session context. */
    sessionContextComplete?: boolean;
    /** Completed reads retain opened facts while their encrypted write is retried. */
    workFactsPersisted?: boolean;
    workFactsWriteErrorCode?: string;
}>;
export type SessionInputReader = (sessionId: string, readTranscript: boolean,
    load: (assertCurrent: () => void, signal: AbortSignal, retained: SessionInputEvidence | undefined,
        onProgress: (value: SessionInputEvidence) => void) => Promise<SessionInputEvidence | null>,
    onProgress?: (value: SessionInputEvidence) => void,
    admitted?: SessionInputEvidence, demandKey?: string, sourceReferenceKey?: string,
    /** The caller's demand. A shared read ends once every signalled borrower has left. */
    signal?: AbortSignal) => Promise<SessionInputEvidence | null>;
/** Selected ids, plus the rows a selection read opened for the borrowers of that same read. */
export type SessionInputSelection = Readonly<{ ids: readonly string[]; rows?: unknown }>;
export type SessionInputSelectionReader = (demandKey: string,
    /** Without candidates, discover the whole window; with them, answer only which of them belong to it. */
    load: (isInputCurrent: (sessionId: string) => boolean, signal: AbortSignal,
        candidateSessionIds?: readonly string[]) => Promise<SessionInputSelection>,
    signal?: AbortSignal) => Promise<SessionInputSelection>;

type SharedRead = { abort: AbortController; waiters: number; settled: boolean };

/** Demand follows its borrowers: a borrower without a signal holds the read until it settles. */
function borrowSharedRead(read: SharedRead, settlement: Promise<unknown>, signal: AbortSignal | undefined, withdraw: () => void) {
    read.waiters += 1;
    if (!signal) return;
    const leave = () => {
        read.waiters -= 1;
        if (read.waiters === 0 && !read.settled) withdraw();
    };
    if (signal.aborted) { leave(); return; }
    signal.addEventListener('abort', leave, { once: true });
    void settlement.then(() => signal.removeEventListener('abort', leave), () => signal.removeEventListener('abort', leave));
}

/** Starts synchronously: batched callers collect their requests in the same turn. */
function startSharedRead<T>(ownerSignal: AbortSignal, start: (signal: AbortSignal) => Promise<T>) {
    const shared: SharedRead = { abort: new AbortController(), waiters: 0, settled: false };
    const cancellation = mergeAbortSignals([ownerSignal, shared.abort.signal]);
    let started: Promise<T>;
    try { started = start(cancellation.signal); } catch (error) { started = Promise.reject(error); }
    const read = started.finally(() => {
        shared.settled = true;
        cancellation.dispose();
    });
    return { shared, read };
}

/** The Account Resource's existing private evidence and admission lifetime. */
export function createUsageQuerySessionInputs(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
    assertCurrent(): void;
}>): Readonly<{
    read: SessionInputReader;
    readSelection: SessionInputSelectionReader;
    retryFailures(sourceReferenceKeys: ReadonlySet<string>): void;
    invalidateForHomeChange(event: HomeAccountChangeEvent): void;
    reconcile(sessionIds?: Iterable<string>, publication?: Readonly<{
        scopeChanged: boolean; membershipChangedSessionIds: readonly string[];
    }>): boolean;
    dispose(): void;
}> {
    type InputEntry = { sessionId: string; readTranscript: boolean; sourceReferenceKeys: Set<string>;
        basis: Readonly<{ storage: string; admitted?: string }>; needsAdmission: boolean;
        value?: SessionInputEvidence; failure?: unknown; read: Promise<SessionInputEvidence | null>;
        listeners: Set<(value: SessionInputEvidence) => void>; shared?: SharedRead; lastGood?: SessionInputEvidence };
    const entries = new Map<string, Map<string, InputEntry>>();
    function* allEntries() { for (const group of entries.values()) yield* group.values(); }
    // Complete selection is part of the same admission as its private inputs.
    // Retaining IDs lets Retry acquire only failed inputs, including an empty cohort.
    // A member's own change re-admits that member's input. A changed Session
    // outside the cohort is asked about by itself (row-level); only a removal,
    // scope, currentness or unnamed change re-discovers the whole window.
    type Selection = { needsAdmission: boolean; sessionIds?: readonly string[];
        changedDuringRead: Set<string>; candidates: Set<string>; read: Promise<SessionInputSelection>; shared?: SharedRead };
    const selections = new Map<string, Selection>();
    const invalidateSelections = () => { for (const selection of selections.values()) selection.needsAdmission = true; };
    const invalidateSelectionsFor = (sessionIds: readonly string[], left = false) => {
        if (!sessionIds.length) return;
        for (const selection of selections.values()) {
            // Removal is rare; an in-flight read cannot know whether its result already excludes it.
            if (!selection.sessionIds) {
                if (left) selection.needsAdmission = true;
                else for (const id of sessionIds) selection.changedDuringRead.add(id);
                continue;
            }
            const admitted = new Set(selection.sessionIds);
            if (left) { if (sessionIds.some(id => admitted.has(id))) selection.needsAdmission = true; }
            else for (const id of sessionIds) if (!admitted.has(id)) selection.candidates.add(id);
        }
    };
    function* entriesForSessions(sessionIds: Iterable<string>) {
        for (const id of new Set(sessionIds)) yield* entries.get(id)?.values() ?? [];
    }
    let currentness = captureAccountEncryptionCurrentness(input.lifetime.scope.serverId);
    const renewCurrentness = () => {
        if (currentness.isCurrent()) return false;
        currentness.dispose();
        currentness = captureAccountEncryptionCurrentness(input.lifetime.scope.serverId);
        // Fresh admission decides whether retained derived facts remain valid.
        // An observation withdrawal alone does not change Session content.
        for (const entry of allEntries()) entry.needsAdmission = true;
        invalidateSelections();
        return true;
    };
    const readSessionState = (id: string, state = readRegisteredStorageState()) => {
        const session = state && areServerAccountScopesEqual(state.profileScope, input.lifetime.scope) ? state.sessions[id] : undefined;
        return session && (!session.serverId || areServerProfileIdentifiersEquivalent(session.serverId, input.lifetime.scope.serverId)) ? session : undefined;
    };
    const readSessionRow = (id: string, state = readRegisteredStorageState()) => {
        return state && areServerAccountScopesEqual(state.profileScope, input.lifetime.scope)
            ? readSessionListRowForServerId(state.sessionListRowsByServerId, input.lifetime.scope.serverId, id) : null;
    };
    const version = (session: Pick<Session, 'seq' | 'updatedAt' | 'metadataVersion' | 'agentStateVersion'
        | 'metadataLayoutVersion' | 'encryptionMode' | 'encryptedContentAvailability' | 'access' | 'active'> | null | undefined) => [
        session?.seq, session?.updatedAt, session?.metadataVersion, session?.agentStateVersion,
        session?.metadataLayoutVersion, session?.encryptionMode, session?.encryptedContentAvailability, session?.access, session?.active,
    ];
    const readBasis = (id: string, state = readRegisteredStorageState()) => {
        const session = readSessionState(id, state);
        // List markers survive detail eviction. Transport withdrawal is not a
        // content version; the canonical finite witness fences identity changes.
        return JSON.stringify([version(session), session?.sessionTurns?.updatedAt, version(readSessionRow(id, state))]);
    };
    const matchesOpenedInput = (id: string, value: SessionInputEvidence) => {
        const state = readRegisteredStorageState();
        const session = readSessionState(id, state);
        const row = readSessionRow(id, state);
        if (!session && !row) return false;
        const openedVersion = JSON.stringify(version(value.session));
        return (!session || JSON.stringify(version(session)) === openedVersion)
            && (!row || JSON.stringify(version(row)) === openedVersion)
            && (!session?.sessionTurns || session.sessionTurns.updatedAt === value.session.sessionTurns?.updatedAt);
    };
    const read: SessionInputReader = (sessionId, readTranscript, load, onProgress, admitted, demandKey, sourceReferenceKey, signal) => {
        input.assertCurrent();
        renewCurrentness();
        const witness = currentness;
        // A transcript belongs to its admitted summary. A streaming marker may
        // advance between phases without changing that finite read's summary.
        const basis = { storage: readBasis(sessionId), ...(admitted ? { admitted: JSON.stringify([
            version(admitted.session), admitted.session.sessionTurns?.updatedAt, admitted.callerDataKeyEnvelope,
        ]) } : {}) };
        // Summary admission cannot satisfy later private transcript demand,
        // and a held transcript must not hold an interval-only consumer.
        const key = JSON.stringify([sessionId, readTranscript, demandKey ?? null]);
        const group = entries.get(sessionId) ?? new Map<string, InputEntry>();
        entries.set(sessionId, group);
        const retained = group.get(key);
        const observe = (entry: InputEntry) => {
            if (sourceReferenceKey) entry.sourceReferenceKeys.add(sourceReferenceKey);
            if (entry.shared) borrowSharedRead(entry.shared, entry.read, signal, () => {
                // Every consumer left before this read settled. End its physical
                // read and keep the last admitted value for the next demand.
                entry.shared!.abort.abort();
                if (group.get(key) !== entry) return;
                const lastGood = entry.lastGood;
                if (lastGood) group.set(key, { sessionId, readTranscript, sourceReferenceKeys: entry.sourceReferenceKeys, basis: entry.basis,
                    needsAdmission: true, value: lastGood, read: Promise.resolve(lastGood), listeners: new Set() });
                else group.delete(key);
            });
            if (!onProgress) return entry.read;
            entry.listeners.add(onProgress);
            if (entry.value) onProgress(entry.value);
            return entry.read.finally(() => entry.listeners.delete(onProgress));
        };
        if (retained && retained.basis.storage === basis.storage && retained.basis.admitted === basis.admitted
            && !retained.needsAdmission) return observe(retained);
        const entry: InputEntry = { sessionId, readTranscript,
            sourceReferenceKeys: new Set(sourceReferenceKey ? [sourceReferenceKey] : []), basis, needsAdmission: false,
            read: Promise.resolve<SessionInputEvidence | null>(null), listeners: new Set(),
            ...(retained?.value && !retained.failure ? { lastGood: retained.value } : {}) };
        group.set(key, entry);
        // Streaming markers change the next admission, not this finite read.
        const started = startSharedRead(input.signal, loadSignal => load(input.assertCurrent, loadSignal, retained?.value, value => {
            input.assertCurrent();
            entry.value = value;
            for (const listener of entry.listeners) listener(value);
        }));
        entry.shared = started.shared;
        entry.read = started.read.then(value => {
            input.assertCurrent();
            // Selection can precede per-Session admission. A wake during that
            // finite read must leave its replacement requiring fresh evidence.
            entry.needsAdmission ||= readBasis(sessionId) !== basis.storage;
            entry.needsAdmission ||= value?.workFactsPersisted === false;
            entry.needsAdmission ||= readTranscript && value?.completeMessageCoverage === false;
            if (value) entry.value = value;
            if (value?.workFactsPersisted && value.completeMessageCoverage && !entry.needsAdmission) {
                // One converted Session also completes its already-admitted summaries.
                // Keep this in the input owner: an ordinary reopen must not revive Not read.
                const openedVersion = JSON.stringify(version(value.session));
                for (const sibling of group.values()) {
                    if (sibling.readTranscript || sibling.needsAdmission || sibling.failure || !sibling.value
                        || sibling.shared && !sibling.shared.settled || sibling.basis.storage !== basis.storage
                        || sibling.value.callerDataKeyEnvelope !== value.callerDataKeyEnvelope
                        || JSON.stringify(version(sibling.value.session)) !== openedVersion) continue;
                    sibling.value = value;
                    sibling.read = Promise.resolve(value);
                    for (const listener of sibling.listeners) listener(value);
                }
            }
            // Partial evidence remains visible, but its next transcript demand
            // needs fresh admission even at the same Session version.
            if ((!value || readTranscript && !value.messageEvidence && !value.completeMessageCoverage)
                && group.get(key) === entry) group.delete(key);
            return value;
        }).catch(error => {
            if (group.get(key) === entry) {
                if (error instanceof SessionPartsHttpError || !readUsageHistoryFailure(error).retryable) {
                    // A typed refusal settles this admission, including any
                    // summary published before a private page was refused.
                    entry.failure = error;
                    entry.value = undefined;
                } else if (retained?.value && isTransientConnectivityError(error) && witness.isCurrent()
                    && input.lifetime.isCurrent() && readBasis(sessionId) === basis.storage) {
                    entry.value = retained.value;
                    entry.needsAdmission = true;
                } else group.delete(key);
            }
            throw error;
        });
        return observe(entry);
    };
    const readSelection: SessionInputSelectionReader = (demandKey, load, signal) => {
        input.assertCurrent();
        renewCurrentness();
        const retained = selections.get(demandKey);
        // Borrowers of an in-flight read receive the rows it opened; a later hit
        // of the settled selection receives only its ids (its rows may be stale).
        const borrow = (selection: Selection, withdraw: () => void) => {
            if (selection.shared) borrowSharedRead(selection.shared, selection.read, signal, () => {
                selection.shared!.abort.abort();
                withdraw();
            });
            return selection.read;
        };
        const start = (selection: Selection, candidateSessionIds?: readonly string[]) => {
            const admittedState = readRegisteredStorageState();
            const started = startSharedRead(input.signal, loadSignal => Promise.resolve()
                .then(() => load(id => readBasis(id, admittedState) === readBasis(id), loadSignal, candidateSessionIds)));
            selection.shared = started.shared;
            return started.read;
        };
        const settle = (selection: Selection, ids: readonly string[]) => {
            input.assertCurrent();
            const admitted = new Set(ids);
            for (const id of selection.changedDuringRead) if (!admitted.has(id)) selection.candidates.add(id);
            selection.changedDuringRead.clear();
            selection.sessionIds = ids;
            // Borrowers already hold the answer; the retained selection keeps ids only.
            selection.read = Promise.resolve({ ids });
        };
        if (retained && !retained.needsAdmission && retained.sessionIds && retained.candidates.size) {
            const asked = [...retained.candidates].sort();
            const members = retained.sessionIds;
            const selection: Selection = { needsAdmission: false, changedDuringRead: new Set(), candidates: new Set(),
                read: Promise.resolve({ ids: [] }) };
            selections.set(demandKey, selection);
            const restore = () => {
                // An unanswered question stays open; the admitted cohort is still last-good.
                if (selections.get(demandKey) !== selection) return;
                for (const id of [...asked, ...selection.changedDuringRead]) retained.candidates.add(id);
                selections.set(demandKey, retained);
            };
            selection.read = start(selection, asked).then(answer => {
                // An answer that adds nobody keeps the admitted cohort's identity.
                const ids = answer.ids.every(id => members.includes(id)) ? members : [...new Set([...members, ...answer.ids])].sort();
                settle(selection, ids);
                return { ...answer, ids };
            }).catch(error => { restore(); throw error; });
            return borrow(selection, restore);
        }
        if (retained && !retained.needsAdmission) {
            if (retained.sessionIds) return Promise.resolve({ ids: retained.sessionIds });
            // Joining an in-flight read is joining its admission. A demand that arrives
            // after a Session outside the read's result changed asks about that Session
            // next; a change after joining invalidates the owner, which reads again itself.
            const changedBeforeJoin = [...retained.changedDuringRead];
            return borrow(retained, () => { if (selections.get(demandKey) === retained) selections.delete(demandKey); })
                .then(answer => changedBeforeJoin.some(id => !answer.ids.includes(id)) ? readSelection(demandKey, load, signal) : answer);
        }
        const selection: Selection = {
            needsAdmission: false, changedDuringRead: new Set(), candidates: new Set(), read: Promise.resolve({ ids: [] }),
        };
        selections.set(demandKey, selection);
        selection.read = start(selection).then(answer => {
            settle(selection, answer.ids);
            return answer;
        }).catch(error => {
            if (selections.get(demandKey) === selection) selections.delete(demandKey);
            throw error;
        });
        return borrow(selection, () => { if (selections.get(demandKey) === selection) selections.delete(demandKey); });
    };
    return {
        read,
        readSelection,
        retryFailures(sourceReferenceKeys) {
            for (const group of entries.values()) for (const [key, entry] of group) if (entry.failure && readUsageHistoryFailure(entry.failure).retryable
                && [...entry.sourceReferenceKeys].some(reference => sourceReferenceKeys.has(reference))) group.delete(key);
        },
        invalidateForHomeChange(event) {
            const workFactSessionIds = event.sessionSystemRecords?.filter(record => record.address === undefined
                || record.address.owner === USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.owner
                    && record.address.namespace === USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.namespace
                    && record.address.kind === USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.kind
                    && record.address.localId === USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.localId)
                .map(record => record.sessionId) ?? [];
            // A record write changes private evidence, not Session membership.
            // Unconsumed Sessions need no read; retained inputs re-admit by id.
            for (const entry of entriesForSessions(workFactSessionIds)) entry.needsAdmission = true;
            if (event.source !== 'connected' && event.changeKinds !== undefined && !event.changeKinds.includes('session')) return;
            if (event.source === 'connected' || event.entityIds === undefined) invalidateSelections();
            else invalidateSelectionsFor(event.entityIds);
            const selected = event.source === 'connected' || event.entityIds === undefined
                ? allEntries() : entriesForSessions(event.entityIds);
            for (const entry of selected) {
                if (event.source === 'connected' || (event.entityIds === undefined
                    ? !readSessionState(entry.sessionId) && !readSessionRow(entry.sessionId)
                    : event.entityIds.includes(entry.sessionId))) entry.needsAdmission = true;
            }
        },
        reconcile(sessionIds, publication) {
            let changed = renewCurrentness() || publication?.scopeChanged === true;
            if (publication?.scopeChanged) invalidateSelections();
            const contentChangedIds: string[] = [];
            const selected = sessionIds === undefined ? allEntries() : entriesForSessions(sessionIds);
            for (const entry of selected) {
                const storage = readBasis(entry.sessionId);
                if (storage === entry.basis.storage) continue;
                // Cold list/detail hydration can arrive after Usage opened
                // this exact revision. It adds a local marker, not new facts.
                if (!entry.needsAdmission && entry.value && matchesOpenedInput(entry.sessionId, entry.value)) {
                    entry.basis = { ...entry.basis, storage };
                    continue;
                }
                entry.needsAdmission = true;
                changed = true;
                contentChangedIds.push(entry.sessionId);
            }
            invalidateSelectionsFor(contentChangedIds);
            const membershipChanges = publication?.membershipChangedSessionIds;
            if (membershipChanges?.length) {
                const left = membershipChanges.filter(id => !readSessionState(id) && !readSessionRow(id));
                const arrived = membershipChanges.filter(id => !left.includes(id));
                // A sibling's opened input does not establish membership in
                // another demand's complete (possibly empty) selection.
                changed ||= selections.size === 0 || [...selections.values()].some(selection => {
                    if (selection.needsAdmission || !selection.sessionIds) return true;
                    const admittedIds = new Set(selection.sessionIds);
                    return arrived.some(id => !admittedIds.has(id)) || left.some(id => admittedIds.has(id));
                });
                invalidateSelectionsFor(arrived);
                invalidateSelectionsFor(left, true);
            }
            return changed;
        },
        dispose() { entries.clear(); selections.clear(); currentness.dispose(); },
    };
}
