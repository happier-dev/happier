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

type SessionMessages = ReturnType<typeof storage.getState>['sessionMessages'][string];
export type FileWriteSessionSnapshot = Readonly<{ session: Session; address: SessionAddress; transcript: SessionMessages | null; workspaceRoot: string | null }>;
type FileWriteSessionAdmission = Omit<FileWriteSessionSnapshot, 'transcript'>;

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

/** Select existing transcripts only; this projection never hydrates sessions or starts a watcher. */
export function useFileWriteSessionSnapshots(input: Readonly<{
    address?: SessionAddress | null;
    scope?: WorkspaceScopeBase | null;
}>): readonly FileWriteSessionSnapshot[] {
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
    const cached = React.useMemo(() => new Map<string, FileWriteSessionSnapshot>(), [serverId, sessionId, machineId, rootPath]);
    const selector = React.useMemo(() => (state: ReturnType<typeof storage.getState>): readonly FileWriteSessionSnapshot[] => {
        const result: FileWriteSessionSnapshot[] = [];
        for (const { session, address, workspaceRoot } of admissions) {
            const transcript = state.sessionMessages[session.id] ?? null;
            let snapshot = cached.get(session.id);
            if (!snapshot || snapshot.address.serverId !== address.serverId || !sameRuntimeInput(snapshot.session, session)
                || snapshot.transcript !== transcript || snapshot.workspaceRoot !== workspaceRoot) {
                snapshot = { session, address, transcript, workspaceRoot };
                cached.set(session.id, snapshot);
            }
            result.push(snapshot);
        }
        const attached = new Set(result.map(snapshot => snapshot.session.id));
        for (const id of cached.keys()) if (!attached.has(id)) cached.delete(id);
        return result;
    }, [admissions, cached]);
    return storage(useShallow(selector), transcriptScope);
}

export function readFileWriteSessionMessages(snapshot: FileWriteSessionSnapshot): readonly Message[] {
    return readStoredSessionMessagesForAddress({
        sessions: { [snapshot.session.id]: snapshot.session },
        sessionMessages: snapshot.transcript ? { [snapshot.session.id]: snapshot.transcript } : {},
    }, snapshot.address);
}
