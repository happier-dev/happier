import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/vanilla/shallow';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { normalizeWorkspaceScopeBase, tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import type { Message } from '@happier-dev/session-core/messages';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { toAwarenessRuntimeInput } from '@/sync/domains/session/attention/runtimePresentation';
import { hasRunningToolCall } from '../derivation/runningToolCalls';

type StorageState = ReturnType<typeof storage.getState>;
type SessionMessages = StorageState['sessionMessages'][string];
export type FileWriteSessionSnapshot = Readonly<{ session: Session; address: SessionAddress; transcript: SessionMessages | null; workspaceRoot: string | null }>;
/** A live-write snapshot carries only the Session's running root calls; streamed text keeps its identity. */
export type FileWriteSessionRunningSnapshot = Readonly<{ session: Session; address: SessionAddress; runningCalls: readonly Message[]; workspaceRoot: string | null }>;
type FileWriteSessionAdmission = Omit<FileWriteSessionSnapshot, 'transcript'>;
const EMPTY_CALLS: readonly Message[] = Object.freeze([]);

function sameRuntimeInput(previous: Session, next: Session): boolean {
    if (previous === next) return true;
    const left = toAwarenessRuntimeInput(previous);
    const right = toAwarenessRuntimeInput(next);
    return shallow(left.lifecycle, right.lifecycle) && shallow(left.runtime, right.runtime) && shallow(left.pending, right.pending);
}

function sameAdmissions(previous: readonly FileWriteSessionAdmission[], next: readonly FileWriteSessionAdmission[]): boolean {
    return previous.length === next.length && previous.every((entry, index) => {
        const other = next[index];
        return entry.address.serverId === other.address.serverId && entry.address.sessionId === other.address.sessionId
            && entry.workspaceRoot === other.workspaceRoot && sameRuntimeInput(entry.session, other.session);
    });
}

type FileWriteSessionInput = Readonly<{
    address?: SessionAddress | null;
    scope?: WorkspaceScopeBase | null;
}>;

/** Select existing transcripts only; this projection never hydrates sessions or starts a watcher. */
export function useFileWriteSessionSnapshots(input: FileWriteSessionInput): readonly FileWriteSessionSnapshot[] {
    return useAdmittedFileWriteSnapshots(input, readAdmittedTranscript, buildTranscriptSnapshot);
}

/**
 * Live-write readers select each admitted Session's running root calls from the store's incremental index, so a
 * streamed text delta (a new transcript snapshot) republishes nothing and re-renders no live-write reader.
 */
export function useFileWriteSessionRunningSnapshots(input: FileWriteSessionInput): readonly FileWriteSessionRunningSnapshot[] {
    return useAdmittedFileWriteSnapshots(input, readAdmittedRunningCalls, buildRunningSnapshot);
}

function readAdmittedTranscript(state: StorageState, sessionId: string): SessionMessages | null {
    return state.sessionMessages[sessionId] ?? null;
}

function buildTranscriptSnapshot(admission: FileWriteSessionAdmission, transcript: SessionMessages | null): FileWriteSessionSnapshot {
    return { ...admission, transcript };
}

function readAdmittedRunningCalls(state: StorageState, sessionId: string, previous: readonly Message[] | undefined): readonly Message[] {
    const transcript = state.sessionMessages[sessionId];
    if (!transcript) return EMPTY_CALLS;
    const indexed = transcript.runningToolCallMessageIds;
    const calls: Message[] = [];
    if (indexed) {
        for (const id of indexed) {
            const message = transcript.messagesById[id];
            if (message) calls.push(message);
        }
    } else {
        // A retained snapshot written before the index existed is admitted by its next store write.
        for (const id of transcript.messageIdsOldestFirst) {
            const message = transcript.messagesById[id];
            if (message && hasRunningToolCall(message)) calls.push(message);
        }
    }
    if (previous && previous.length === calls.length && previous.every((call, index) => call === calls[index])) return previous;
    return calls.length === 0 ? EMPTY_CALLS : Object.freeze(calls);
}

function buildRunningSnapshot(admission: FileWriteSessionAdmission, runningCalls: readonly Message[]): FileWriteSessionRunningSnapshot {
    return { ...admission, runningCalls };
}

function useAdmittedFileWriteSnapshots<TContent, TSnapshot extends Readonly<{ session: Session; address: SessionAddress; workspaceRoot: string | null }>>(
    input: FileWriteSessionInput,
    readContent: (state: StorageState, sessionId: string, previous: TContent | undefined) => TContent,
    buildSnapshot: (admission: FileWriteSessionAdmission, content: TContent) => TSnapshot,
): readonly TSnapshot[] {
    const serverId = input.address?.serverId ?? input.scope?.serverId ?? '';
    const sessionId = input.address?.sessionId ?? '';
    const machineId = input.scope?.machineId ?? '';
    const rootPath = input.scope?.rootPath ?? '';
    const selectAdmissions = React.useMemo(() => {
        const requested = normalizeSessionAddress(serverId, sessionId);
        const workspaceScope = machineId && rootPath ? normalizeWorkspaceScopeBase({ serverId, machineId, rootPath }) : null;
        const workspaceKey = workspaceScope ? tryBuildWorkspaceCacheKey(workspaceScope) : null;
        const requestedServerId = requested?.serverId ?? workspaceScope?.serverId;
        return (state: ReturnType<typeof storage.getState>): readonly FileWriteSessionAdmission[] => {
            if (!requested && !workspaceKey) return [];
            const result: FileWriteSessionAdmission[] = [];
            for (const session of requested ? [state.sessions[requested.sessionId]] : Object.values(state.sessions)) {
                if (!session) continue;
                // The canonical stored-message reader permits the loaded Home only for an
                // existing row with no declared Home; rows and transcripts reset together.
                const address = normalizeSessionAddress(session.serverId, session.id)
                    ?? normalizeSessionAddress(getActiveServerSnapshot().serverId, session.id);
                if (!address || address.serverId !== requestedServerId || (requested && address.sessionId !== requested.sessionId)) continue;
                const target = resolveWorkspaceTargetForSessionFromState(state, address);
                if (!requested) {
                    if (!target || target.workspaceCacheKey !== workspaceKey) continue;
                }
                result.push({ session, address, workspaceRoot: target?.rootPath ?? null });
            }
            return result;
        };
    }, [serverId, sessionId, machineId, rootPath]);
    // The scoped store tracks the structural inputs read above, without subscribing
    // workspace admission to transcript arrivals from the rest of the Account.
    const admissions = storage(selectAdmissions, undefined, sameAdmissions);
    const transcriptScope = React.useMemo(() => ({ sessionMessages: admissions.map(entry => entry.session.id) }), [admissions]);
    const cached = React.useMemo(() => new Map<string, Readonly<{ snapshot: TSnapshot; content: TContent }>>(), [serverId, sessionId, machineId, rootPath]);
    const selector = React.useMemo(() => (state: StorageState): readonly TSnapshot[] => {
        const result: TSnapshot[] = [];
        for (const admission of admissions) {
            const { session, address, workspaceRoot } = admission;
            let entry = cached.get(session.id);
            const content = readContent(state, session.id, entry?.content);
            if (!entry || entry.snapshot.address.serverId !== address.serverId || !sameRuntimeInput(entry.snapshot.session, session)
                || entry.content !== content || entry.snapshot.workspaceRoot !== workspaceRoot) {
                entry = { snapshot: buildSnapshot(admission, content), content };
                cached.set(session.id, entry);
            }
            result.push(entry.snapshot);
        }
        const attached = new Set(result.map(snapshot => snapshot.session.id));
        for (const id of cached.keys()) if (!attached.has(id)) cached.delete(id);
        return result;
    }, [admissions, buildSnapshot, cached, readContent]);
    return storage(useShallow(selector), transcriptScope);
}

export function readFileWriteSessionMessages(snapshot: FileWriteSessionSnapshot): readonly Message[] {
    return readStoredSessionMessagesForAddress({
        sessions: { [snapshot.session.id]: snapshot.session },
        sessionMessages: snapshot.transcript ? { [snapshot.session.id]: snapshot.transcript } : {},
    }, snapshot.address);
}
