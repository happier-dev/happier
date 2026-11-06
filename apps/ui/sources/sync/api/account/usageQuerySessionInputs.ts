import type { Session } from '@/sync/domains/state/storageTypes';
import type { UsageSessionMessageEvidence, projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
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

export type SessionInputEvidence = Readonly<{
    session: UsageSessionInput;
    callerDataKeyEnvelope: string | null;
    detail: ReturnType<typeof projectSessionUsageWorkEvidence>;
    messageEvidence?: UsageSessionMessageEvidence;
    completeMessageCoverage: boolean;
}>;
export type SessionInputReader = (sessionId: string, readTranscript: boolean,
    load: (assertCurrent: () => void, signal: AbortSignal, retained: SessionInputEvidence | undefined,
        onProgress: (value: SessionInputEvidence) => void) => Promise<SessionInputEvidence | null>,
    onProgress?: (value: SessionInputEvidence) => void,
    admitted?: SessionInputEvidence, demandKey?: string, sourceReferenceKey?: string,
    isAdmissionCurrent?: () => boolean) => Promise<SessionInputEvidence | null>;
export type SessionInputSelectionReader = (demandKey: string,
    load: (isInputCurrent: (sessionId: string) => boolean, signal: AbortSignal) => Promise<readonly string[]>,
    isAdmissionCurrent?: () => boolean) => Promise<readonly string[]>;

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
    const entries = new Map<string, { sessionId: string; sourceReferenceKeys: Set<string>;
        basis: Readonly<{ storage: string; admitted?: string }>; needsAdmission: boolean;
        value?: SessionInputEvidence; failure?: SessionPartsHttpError; read: Promise<SessionInputEvidence | null>;
        listeners: Set<(value: SessionInputEvidence) => void> }>();
    // Complete selection is part of the same admission as its private inputs.
    // Retaining IDs lets Retry acquire only failed inputs, including an empty cohort.
    const selections = new Map<string, { needsAdmission: boolean; sessionIds?: readonly string[]; read: Promise<readonly string[]> }>();
    const invalidateSelections = () => { for (const selection of selections.values()) selection.needsAdmission = true; };
    const entriesForSessions = (sessionIds: Iterable<string>) => {
        const selected = new Set(sessionIds);
        return [...entries.values()].filter(entry => selected.has(entry.sessionId));
    };
    let currentness = captureAccountEncryptionCurrentness(input.lifetime.scope.serverId);
    const renewCurrentness = () => {
        if (currentness.isCurrent()) return false;
        currentness.dispose();
        currentness = captureAccountEncryptionCurrentness(input.lifetime.scope.serverId);
        // Fresh admission decides whether retained derived facts remain valid.
        // An observation withdrawal alone does not change Session content.
        for (const entry of entries.values()) entry.needsAdmission = true;
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
        | 'metadataLayoutVersion' | 'encryptionMode' | 'encryptedContentAvailability' | 'access'> | null | undefined) => [
        session?.seq, session?.updatedAt, session?.metadataVersion, session?.agentStateVersion,
        session?.metadataLayoutVersion, session?.encryptionMode, session?.encryptedContentAvailability, session?.access,
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
    const read: SessionInputReader = (sessionId, readTranscript, load, onProgress, admitted, demandKey, sourceReferenceKey, isAdmissionCurrent) => {
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
        const retained = entries.get(key);
        const observe = (entry: NonNullable<ReturnType<typeof entries.get>>) => {
            if (sourceReferenceKey) entry.sourceReferenceKeys.add(sourceReferenceKey);
            if (!onProgress) return entry.read;
            entry.listeners.add(onProgress);
            if (entry.value) onProgress(entry.value);
            return entry.read.finally(() => entry.listeners.delete(onProgress));
        };
        if (retained && retained.basis.storage === basis.storage && retained.basis.admitted === basis.admitted
            && !retained.needsAdmission) return observe(retained);
        const entry: NonNullable<ReturnType<typeof entries.get>> = { sessionId,
            sourceReferenceKeys: new Set(sourceReferenceKey ? [sourceReferenceKey] : []), basis, needsAdmission: isAdmissionCurrent?.() === false,
            read: Promise.resolve<SessionInputEvidence | null>(null), listeners: new Set() };
        entries.set(key, entry);
        // Streaming markers change the next admission, not this finite read.
        entry.read = load(input.assertCurrent, input.signal, retained?.value, value => {
            input.assertCurrent();
            entry.value = value;
            for (const listener of entry.listeners) listener(value);
        }).then(value => {
            input.assertCurrent();
            // Selection can precede per-Session admission. A wake during that
            // finite read must leave its replacement requiring fresh evidence.
            entry.needsAdmission ||= isAdmissionCurrent?.() === false || readBasis(sessionId) !== basis.storage;
            if (value) entry.value = value;
            // Successful partial pages remain reusable; failed or wholly
            // unopened pages remain retryable at the same Session version.
            if ((!value || readTranscript && !value.messageEvidence && !value.completeMessageCoverage)
                && entries.get(key) === entry) entries.delete(key);
            return value;
        }).catch(error => {
            if (entries.get(key) === entry) {
                if (error instanceof SessionPartsHttpError) {
                    // A typed refusal settles this admission, including any
                    // summary published before a private page was refused.
                    entry.failure = error;
                    entry.value = undefined;
                } else if (retained?.value && isTransientConnectivityError(error) && witness.isCurrent()
                    && input.lifetime.isCurrent() && readBasis(sessionId) === basis.storage) {
                    entry.value = retained.value;
                    entry.needsAdmission = true;
                } else entries.delete(key);
            }
            throw error;
        });
        return observe(entry);
    };
    return {
        read,
        readSelection(demandKey, load, isAdmissionCurrent) {
            input.assertCurrent();
            renewCurrentness();
            const retained = selections.get(demandKey);
            if (retained && !retained.needsAdmission) return retained.read;
            const selection: NonNullable<ReturnType<typeof selections.get>> = {
                needsAdmission: isAdmissionCurrent?.() === false, read: Promise.resolve<readonly string[]>([]),
            };
            selections.set(demandKey, selection);
            const admittedState = readRegisteredStorageState();
            selection.read = Promise.resolve().then(() => load(id => readBasis(id, admittedState) === readBasis(id), input.signal)).then(ids => {
                input.assertCurrent();
                selection.needsAdmission ||= isAdmissionCurrent?.() === false;
                selection.sessionIds = ids;
                return ids;
            }).catch(error => {
                if (selections.get(demandKey) === selection) selections.delete(demandKey);
                throw error;
            });
            return selection.read;
        },
        retryFailures(sourceReferenceKeys) {
            for (const [key, entry] of entries) if (entry.failure
                && [...entry.sourceReferenceKeys].some(reference => sourceReferenceKeys.has(reference))) entries.delete(key);
        },
        invalidateForHomeChange(event) {
            if (event.source !== 'connected' && event.changeKinds !== undefined && !event.changeKinds.includes('session')) return;
            invalidateSelections();
            const selected = event.source === 'connected' || event.entityIds === undefined
                ? entries.values() : entriesForSessions(event.entityIds);
            for (const entry of selected) {
                if (event.source === 'connected' || (event.entityIds === undefined
                    ? !readSessionState(entry.sessionId) && !readSessionRow(entry.sessionId)
                    : event.entityIds.includes(entry.sessionId))) entry.needsAdmission = true;
            }
        },
        reconcile(sessionIds, publication) {
            let changed = renewCurrentness() || publication?.scopeChanged === true;
            const selected = sessionIds === undefined ? entries.values() : entriesForSessions(sessionIds);
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
            }
            const membershipChanges = publication?.membershipChangedSessionIds;
            if (!changed && membershipChanges?.length) {
                // A sibling's opened input does not establish membership in
                // another demand's complete (possibly empty) selection.
                changed = selections.size === 0 || [...selections.values()].some(selection => {
                    if (selection.needsAdmission || !selection.sessionIds) return true;
                    const admittedIds = new Set(selection.sessionIds);
                    return membershipChanges.some(id => !admittedIds.has(id));
                });
            }
            if (changed) invalidateSelections();
            return changed;
        },
        dispose() { entries.clear(); selections.clear(); currentness.dispose(); },
    };
}
