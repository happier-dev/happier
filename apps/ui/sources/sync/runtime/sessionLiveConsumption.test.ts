import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function resolveTestServerScopeId(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (value === 'profile-a' || value === 'legacy-a') return 'identity-a';
    return value;
}

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        resolveServerProfileScopeIdForIdentifier: (id: string | null | undefined) => resolveTestServerScopeId(id),
        areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => {
            const resolvedLeft = resolveTestServerScopeId(left);
            const resolvedRight = resolveTestServerScopeId(right);
            return Boolean(resolvedLeft && resolvedRight && resolvedLeft === resolvedRight);
        },
    };
});

import type { Session } from '@/sync/domains/state/storageTypes';
import { clearActiveViewingSessionsForServerScopeReset, markSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import { clearMountedSessionRealtimeTranscriptConsumers } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import {
    clearMountedSessionRealtimeScmConsumerScopes,
    registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import {
    clearSessionRealtimeTranscriptSuppression,
    enableSessionRealtimeTranscriptSuppression,
} from './sessionRealtimeTranscriptSuppression';
import { resolveSessionLiveConsumption, resolveSessionScmMutationSignal } from './sessionLiveConsumption';

describe('resolveSessionLiveConsumption realtime transcript suppression', () => {
    beforeEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
    });

    afterEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
    });

    it('forces matching visible sessions to non-visible non-full-consumer facts', () => {
        markSessionVisible('session-1', 'profile-a');

        expect(resolveSessionLiveConsumption('session-1', 'identity-a')).toEqual({
            isVisible: true,
            isFullContentConsumer: true,
        });

        enableSessionRealtimeTranscriptSuppression({
            sessionId: 'session-1',
            sourceServerId: 'profile-a',
        }, { isDevOrTest: true });

        expect(resolveSessionLiveConsumption('session-1', 'identity-a')).toEqual({
            isVisible: false,
            isFullContentConsumer: false,
        });
    });

    it('does not suppress a different session id', () => {
        markSessionVisible('session-1', 'profile-a');
        enableSessionRealtimeTranscriptSuppression({
            sessionId: 'session-2',
            sourceServerId: 'profile-a',
        }, { isDevOrTest: true });

        expect(resolveSessionLiveConsumption('session-1', 'identity-a')).toEqual({
            isVisible: true,
            isFullContentConsumer: true,
        });
    });

    it('does not suppress a different source server id', () => {
        markSessionVisible('session-1', 'profile-a');
        enableSessionRealtimeTranscriptSuppression({
            sessionId: 'session-1',
            sourceServerId: 'server-b',
        }, { isDevOrTest: true });

        expect(resolveSessionLiveConsumption('session-1', 'identity-a')).toEqual({
            isVisible: true,
            isFullContentConsumer: true,
        });
    });
});

describe('resolveSessionScmMutationSignal', () => {
    const initialStorageState = storage.getState();

    function buildSession(params: Readonly<{ id: string; path: string; machineId: string }>): Session {
        return {
            id: params.id,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 1_000,
            active: true,
            activeAt: 1_000,
            metadata: {
                path: params.path,
                machineId: params.machineId,
            } as Session['metadata'],
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            optimisticThinkingAt: null,
            encryptionMode: 'plain',
        };
    }

    beforeEach(() => {
        storage.setState(initialStorageState, true);
        clearMountedSessionRealtimeScmConsumerScopes();
        clearActiveViewingSessionsForServerScopeReset();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
    });

    afterEach(() => {
        storage.setState(initialStorageState, true);
        clearMountedSessionRealtimeScmConsumerScopes();
        clearActiveViewingSessionsForServerScopeReset();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
    });

    it('reports hidden same-project sessions without making them full content consumers', () => {
        storage.getState().applySessions([
            buildSession({ id: 'hidden-producer', machineId: 'machine-a', path: '/repo/packages/app' }),
            buildSession({ id: 'scm-consumer', machineId: 'machine-a', path: '/repo/packages/ui' }),
        ]);
        const unregister = registerSessionRealtimeScmConsumerScope({
            sessionId: 'scm-consumer',
            canonicalProjectKey: 'machine-a:/repo',
            machineScopeId: 'machine-a',
            repoRoot: '/repo',
        });

        try {
            expect(resolveSessionScmMutationSignal('hidden-producer')).toBe(true);
            expect(resolveSessionLiveConsumption('hidden-producer')).toEqual({
                isVisible: false,
                isFullContentConsumer: false,
            });
        } finally {
            unregister();
        }
    });

    it('reports false without mounted SCM consumer scopes', () => {
        storage.getState().applySessions([
            buildSession({ id: 'hidden-producer', machineId: 'machine-a', path: '/repo/packages/app' }),
        ]);
        expect(resolveSessionScmMutationSignal('hidden-producer')).toBe(false);
    });

    it('reports false for sessions outside the mounted project scope', () => {
        storage.getState().applySessions([
            buildSession({ id: 'other-repo-session', machineId: 'machine-a', path: '/elsewhere/app' }),
            buildSession({ id: 'scm-consumer', machineId: 'machine-a', path: '/repo/packages/ui' }),
        ]);
        const unregister = registerSessionRealtimeScmConsumerScope({
            sessionId: 'scm-consumer',
            canonicalProjectKey: 'machine-a:/repo',
            machineScopeId: 'machine-a',
            repoRoot: '/repo',
        });

        try {
            expect(resolveSessionScmMutationSignal('other-repo-session')).toBe(false);
        } finally {
            unregister();
        }
    });

    it('reports false when the session realtime transcript is suppressed', () => {
        storage.getState().applySessions([
            buildSession({ id: 'hidden-producer', machineId: 'machine-a', path: '/repo/packages/app' }),
        ]);
        const unregister = registerSessionRealtimeScmConsumerScope({
            sessionId: 'scm-consumer',
            canonicalProjectKey: 'machine-a:/repo',
            machineScopeId: 'machine-a',
            repoRoot: '/repo',
        });
        enableSessionRealtimeTranscriptSuppression({
            sessionId: 'hidden-producer',
            sourceServerId: 'profile-a',
        }, { isDevOrTest: true });

        try {
            expect(resolveSessionScmMutationSignal('hidden-producer', 'identity-a')).toBe(false);
        } finally {
            unregister();
        }
    });
});
