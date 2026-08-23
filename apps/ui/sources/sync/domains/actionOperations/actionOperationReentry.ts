import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadNewSessionDraft } from '@/sync/domains/state/persistence';

export type ActionOperationReentryTarget =
    | Readonly<{ kind: 'new_session'; draftScope: ServerAccountScope; operationId: string }>
    | Readonly<{ kind: 'session'; sessionId: string; serverId: string | null }>
    | Readonly<{ kind: 'detail' }>;

export type ActionOperationLocalPresentation = Readonly<{
    kind: 'setup_needs_attention';
}>;

export type NewSessionOperationReentryRegistration = Readonly<{
    markSetupNeedsAttention: (createdSessionId: string) => void;
    markWorkflowComplete: (createdSessionId: string) => void;
}>;

type NewSessionReentryEntry = {
    kind: 'new_session';
    key: string;
    requestId: string;
    draftScope: ServerAccountScope;
    workflow: 'pending' | 'setup_needs_attention' | 'complete';
    createdSessionId: string | null;
};

const DEFAULT_MAX_REENTRY_ENTRIES = 100;

function snapshotRequestId(snapshot: ActionOperationSnapshotV1): string | null {
    const direct = typeof snapshot.requestId === 'string' ? snapshot.requestId.trim() : '';
    if (direct) return direct;
    return snapshot.domainRef?.kind === 'spawnAttempt' ? snapshot.domainRef.id : null;
}

function readStringField(value: unknown, field: string): string | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    return trimmed || null;
}

function entryKey(accountId: string, requestId: string): string {
    return JSON.stringify([accountId, requestId]);
}

export function createActionOperationReentryRegistry(options?: Readonly<{ maxEntries?: number }>) {
    const maxEntries = Math.max(1, Math.trunc(options?.maxEntries ?? DEFAULT_MAX_REENTRY_ENTRIES));
    const entries = new Map<string, NewSessionReentryEntry>();
    const listeners = new Set<() => void>();
    let revision = 0;

    const publish = (): void => {
        revision += 1;
        for (const listener of listeners) listener();
    };

    const retain = (entry: NewSessionReentryEntry): void => {
        entries.delete(entry.key);
        entries.set(entry.key, entry);
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (typeof oldest !== 'string') break;
            entries.delete(oldest);
        }
        publish();
    };

    return {
        registerNewSession(params: Readonly<{
            requestId: string;
            draftScope: ServerAccountScope;
        }>): NewSessionOperationReentryRegistration {
            const requestId = params.requestId.trim();
            const key = entryKey(params.draftScope.accountId, requestId);
            const entry: NewSessionReentryEntry = {
                kind: 'new_session',
                key,
                requestId,
                draftScope: params.draftScope,
                workflow: 'pending',
                createdSessionId: null,
            };
            retain(entry);
            return {
                markSetupNeedsAttention: (createdSessionId) => {
                    if (entries.get(key) !== entry) return;
                    entry.workflow = 'setup_needs_attention';
                    entry.createdSessionId = createdSessionId.trim() || null;
                    retain(entry);
                },
                markWorkflowComplete: (createdSessionId) => {
                    if (entries.get(key) !== entry) return;
                    entry.workflow = 'complete';
                    entry.createdSessionId = createdSessionId.trim() || null;
                    retain(entry);
                },
            };
        },
        resolve(
            snapshot: ActionOperationSnapshotV1,
            deps?: Readonly<{ loadDraft?: (scope: ServerAccountScope) => unknown }>,
        ): ActionOperationReentryTarget {
            if (snapshot.actionId === 'session.fork') {
                if (snapshot.state !== 'succeeded') return { kind: 'detail' };
                const childSessionId = readStringField(snapshot.result, 'childSessionId');
                return childSessionId
                    ? { kind: 'session', sessionId: childSessionId, serverId: null }
                    : { kind: 'detail' };
            }
            if (snapshot.actionId === 'session.handoff') {
                if (snapshot.state !== 'succeeded') return { kind: 'detail' };
                const sessionId = snapshot.scope.sessionId?.trim() || null;
                return sessionId
                    ? { kind: 'session', sessionId, serverId: null }
                    : { kind: 'detail' };
            }
            if (snapshot.actionId !== 'session.spawn_new') return { kind: 'detail' };
            const requestId = snapshotRequestId(snapshot);
            const entry = requestId ? entries.get(entryKey(snapshot.scope.accountId, requestId)) : null;
            if (!entry) return { kind: 'detail' };
            if (entry.workflow === 'complete' && entry.createdSessionId) {
                return {
                    kind: 'session',
                    sessionId: entry.createdSessionId,
                    serverId: entry.draftScope.serverId,
                };
            }
            const draft = (deps?.loadDraft ?? loadNewSessionDraft)(entry.draftScope);
            return draft
                ? { kind: 'new_session', draftScope: entry.draftScope, operationId: snapshot.operationId }
                : { kind: 'detail' };
        },
        resolvePresentation(snapshot: ActionOperationSnapshotV1): ActionOperationLocalPresentation | null {
            if (snapshot.actionId !== 'session.spawn_new' || snapshot.state !== 'succeeded') return null;
            const requestId = snapshotRequestId(snapshot);
            const entry = requestId ? entries.get(entryKey(snapshot.scope.accountId, requestId)) : null;
            return entry?.workflow === 'setup_needs_attention'
                ? { kind: 'setup_needs_attention' }
                : null;
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getRevision(): number {
            return revision;
        },
        readRequestIds(): readonly string[] {
            return Array.from(entries.values(), (entry) => entry.requestId);
        },
    };
}

export const actionOperationReentry = createActionOperationReentryRegistry();
