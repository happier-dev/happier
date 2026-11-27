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
import type { SessionLiveTranscriptReason } from '@/sync/domains/session/realtime/sessionRealtimeVisibility';
import { clearActiveViewingSessionsForServerScopeReset, markSessionHidden, markSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import {
    clearMountedSessionRealtimeTranscriptConsumers,
    registerSessionRealtimeTranscriptConsumer,
    registerSessionTranscriptRetentionConsumer,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import {
    clearMountedSessionRealtimeScmConsumerScopes,
    registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import {
    clearSessionRealtimeTranscriptSuppression,
    enableSessionRealtimeTranscriptSuppression,
} from './sessionRealtimeTranscriptSuppression';
import {
    readSessionLiveTranscriptInterestSessionIds,
    resolveSessionLiveConsumption,
    resolveSessionScmMutationSignal,
    subscribeToSessionLiveTranscriptInterestChanges,
} from './sessionLiveConsumption';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

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

const scmConsumerScope = {
    sessionId: 'scm-consumer',
    canonicalProjectKey: 'machine-a:/repo',
    machineScopeId: 'machine-a',
    repoRoot: '/repo',
} as const;

/** Every reason `sessionNeedsLiveTranscript` recognises, driven through the store that owns it. */
const liveTranscriptReasonRows: ReadonlyArray<Readonly<{
    reason: SessionLiveTranscriptReason;
    sessionId: string;
    engage: () => () => void;
}>> = [
    {
        reason: 'visible',
        sessionId: 's-visible',
        engage: () => {
            markSessionVisible('s-visible', 'profile-a');
            return () => markSessionHidden('s-visible', 'profile-a');
        },
    },
    {
        reason: 'explicitTranscriptConsumer',
        sessionId: 's-explicit',
        engage: () => registerSessionRealtimeTranscriptConsumer('s-explicit', 'profile-a'),
    },
    {
        reason: 'scmSameSession',
        sessionId: 'scm-consumer',
        engage: () => registerSessionRealtimeScmConsumerScope(scmConsumerScope),
    },
    {
        reason: 'voicePrimaryAction',
        sessionId: 's-primary',
        engage: () => {
            useVoiceTargetStore.getState().setPrimaryActionSessionId('s-primary');
            return () => useVoiceTargetStore.getState().setPrimaryActionSessionId(null);
        },
    },
    {
        reason: 'voiceTracked',
        sessionId: 's-tracked',
        engage: () => {
            useVoiceTargetStore.getState().addTrackedSessionId('s-tracked');
            return () => useVoiceTargetStore.getState().removeTrackedSessionId('s-tracked');
        },
    },
    {
        reason: 'voiceReadback',
        sessionId: 's-readback',
        engage: () => {
            useVoiceTargetStore.getState().setLastFocusedSessionId('s-readback');
            return () => useVoiceTargetStore.getState().setLastFocusedSessionId(null);
        },
    },
    {
        reason: 'voiceBoundTarget',
        sessionId: 's-bound',
        engage: () => {
            voiceSessionBindingStore.getState().bind({
                adapterId: 'adapter',
                controlSessionId: 'control-1',
                conversationSessionId: 'conversation-1',
                transcriptMode: 'native_session',
                targetSessionId: 's-bound',
                updatedAt: 0,
            });
            return () => voiceSessionBindingStore.getState().unbind('conversation-1');
        },
    },
];

describe('readSessionLiveTranscriptInterestSessionIds', () => {
    const initialStorageState = storage.getState();

    function resetInterestSources(): void {
        storage.setState(initialStorageState, true);
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        clearMountedSessionRealtimeScmConsumerScopes();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
        useVoiceTargetStore.setState({
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        });
        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
    }

    beforeEach(resetInterestSources);
    afterEach(resetInterestSources);

    it.each(liveTranscriptReasonRows)('declares the session behind the $reason reason for exactly as long as it applies', ({ sessionId, engage }) => {
        expect(readSessionLiveTranscriptInterestSessionIds()).toEqual([]);

        const release = engage();
        try {
            expect(resolveSessionLiveConsumption(sessionId, 'profile-a').isFullContentConsumer).toBe(true);
            expect(readSessionLiveTranscriptInterestSessionIds()).toEqual([sessionId]);
        } finally {
            release();
        }

        expect(resolveSessionLiveConsumption(sessionId, 'profile-a').isFullContentConsumer).toBe(false);
        expect(readSessionLiveTranscriptInterestSessionIds()).toEqual([]);
    });

    it('declares exactly the sessions the canonical consumer predicate treats as live-content consumers', () => {
        storage.getState().applySessions([
            buildSession({ id: 'visible-session', machineId: 'machine-a', path: '/repo/packages/app' }),
            buildSession({ id: 'hidden-producer', machineId: 'machine-a', path: '/repo/packages/app' }),
            buildSession({ id: 'scm-consumer', machineId: 'machine-a', path: '/repo/packages/ui' }),
            buildSession({ id: 'retained-session', machineId: 'machine-a', path: '/repo/packages/ui' }),
            buildSession({ id: 'idle-session', machineId: 'machine-a', path: '/elsewhere/app' }),
        ]);
        markSessionVisible('visible-session', 'profile-a');
        registerSessionRealtimeScmConsumerScope(scmConsumerScope);
        registerSessionTranscriptRetentionConsumer('retained-session', 'profile-a');
        useVoiceTargetStore.getState().addTrackedSessionId('idle-session');

        // A hidden same-project session is a mutation-signal consumer, not a transcript consumer,
        // until a voice reason independently makes it one.
        expect(resolveSessionScmMutationSignal('hidden-producer')).toBe(true);
        const declaredWithoutVoice = readSessionLiveTranscriptInterestSessionIds();
        expect(declaredWithoutVoice).toEqual(['idle-session', 'scm-consumer', 'visible-session']);
        for (const sessionId of Object.keys(storage.getState().sessions)) {
            expect(declaredWithoutVoice.includes(sessionId)).toBe(
                resolveSessionLiveConsumption(sessionId, 'profile-a').isFullContentConsumer,
            );
        }

        useVoiceTargetStore.getState().addTrackedSessionId('hidden-producer');
        const declaredWithVoice = readSessionLiveTranscriptInterestSessionIds();
        expect(declaredWithVoice).toEqual(['hidden-producer', 'idle-session', 'scm-consumer', 'visible-session']);
        for (const sessionId of Object.keys(storage.getState().sessions)) {
            expect(declaredWithVoice.includes(sessionId)).toBe(
                resolveSessionLiveConsumption(sessionId, 'profile-a').isFullContentConsumer,
            );
        }
    });

    it.each(liveTranscriptReasonRows)('notifies interest subscribers when the $reason reason starts and ends', ({ engage }) => {
        const listener = vi.fn();
        const unsubscribe = subscribeToSessionLiveTranscriptInterestChanges(listener);

        const release = engage();
        expect(listener).toHaveBeenCalledTimes(1);
        release();
        expect(listener).toHaveBeenCalledTimes(2);

        unsubscribe();
        engage()();
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('stays silent while a second hold on an already declared session changes nothing', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToSessionLiveTranscriptInterestChanges(listener);
        const first = registerSessionRealtimeTranscriptConsumer('s-shared');
        const second = registerSessionRealtimeTranscriptConsumer('s-shared');
        expect(listener).toHaveBeenCalledTimes(1);

        first();
        expect(listener).toHaveBeenCalledTimes(1);
        second();
        expect(listener).toHaveBeenCalledTimes(2);

        markSessionVisible('s-panes', 'profile-a');
        markSessionVisible('s-panes', 'profile-b');
        expect(listener).toHaveBeenCalledTimes(3);
        markSessionHidden('s-panes', 'profile-a');
        expect(listener).toHaveBeenCalledTimes(3);
        unsubscribe();
        markSessionHidden('s-panes', 'profile-b');
    });
});
