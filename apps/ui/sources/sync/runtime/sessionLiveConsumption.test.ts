import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import {
    clearMountedSessionRealtimeScmConsumerScopes,
    registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { resolveSessionLiveConsumption, resolveSessionScmMutationSignal } from './sessionLiveConsumption';

const initialStorageState = storage.getInitialState();

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
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 900,
    };
}

function registerRepoScmScope(): () => void {
    return registerSessionRealtimeScmConsumerScope({
        serverId: null,
        sessionId: 'scm-consumer',
        canonicalProjectKey: 'machine-a:/repo',
        machineScopeId: 'machine-a',
        repoRoot: '/repo',
    });
}

describe('resolveSessionScmMutationSignal', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
        clearMountedSessionRealtimeScmConsumerScopes();
        resetSessionSurfaceVisibilityForTests();
        voiceSessionBindingStore.setState(voiceSessionBindingStore.getInitialState(), true);
        setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    });

    afterEach(() => {
        storage.setState(initialStorageState, true);
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
        clearMountedSessionRealtimeScmConsumerScopes();
        resetSessionSurfaceVisibilityForTests();
        voiceSessionBindingStore.setState(voiceSessionBindingStore.getInitialState(), true);
        setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    });

    it('reports hidden same-project sessions without making them full content consumers', () => {
        storage.getState().applySessions([
            buildSession({ id: 'hidden-producer', machineId: 'machine-a', path: '/repo/packages/app' }),
            buildSession({ id: 'scm-consumer', machineId: 'machine-a', path: '/repo/packages/ui' }),
        ]);
        const unregister = registerRepoScmScope();

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

    it('keeps the mounted SCM consumer session itself a full content consumer', () => {
        storage.getState().applySessions([
            buildSession({ id: 'scm-consumer', machineId: 'machine-a', path: '/repo/packages/ui' }),
        ]);
        const unregister = registerRepoScmScope();

        try {
            expect(resolveSessionScmMutationSignal('scm-consumer')).toBe(true);
            expect(resolveSessionLiveConsumption('scm-consumer')).toEqual({
                isVisible: false,
                isFullContentConsumer: true,
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
        const unregister = registerRepoScmScope();

        try {
            expect(resolveSessionScmMutationSignal('other-repo-session')).toBe(false);
        } finally {
            unregister();
        }
    });

    it('uses only attempt-local current targets as Voice transcript consumers', () => {
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress({
            serverId: 'home-a',
            sessionId: 'same-session',
        });
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{
            serverId: 'home-b',
            sessionId: 'tracked-session',
        }]);
        useVoiceTargetStore.getState().setLastFocusedSessionAddress({
            serverId: 'home-b',
            sessionId: 'focused-session',
        });

        expect(resolveSessionLiveConsumption('same-session', 'home-a').isFullContentConsumer).toBe(true);
        expect(resolveSessionLiveConsumption('same-session', 'home-b').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('tracked-session', 'home-b').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('tracked-session', 'home-a').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('focused-session', 'home-b').isFullContentConsumer).toBe(true);
        expect(resolveSessionLiveConsumption('focused-session', 'home-a').isFullContentConsumer).toBe(false);
    });

    it('consumes a global Voice conversation on its exact Home without inventing a target or control session', () => {
        setVoiceSessionSnapshot({ adapterId: 'realtime', sessionId: 'global-control', status: 'connecting', mode: 'idle', canStop: true });
        voiceSessionBindingStore.getState().bind({
            adapterId: 'realtime', controlSessionId: 'global-control',
            conversationSessionId: 'conversation',
            conversationSessionAddress: { serverId: 'conversation-home', sessionId: 'conversation' },
            targetSessionAddress: null, transcriptMode: 'synthetic', lifetime: 'runtime_attempt', updatedAt: 1,
        });
        expect(resolveSessionLiveConsumption('conversation', 'conversation-home').isFullContentConsumer).toBe(true);
        expect(resolveSessionLiveConsumption('conversation', 'other-home').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('global-control', 'conversation-home').isFullContentConsumer).toBe(false);

        voiceSessionBindingStore.getState().bind({
            adapterId: 'realtime', controlSessionId: 'global-control',
            conversationSessionId: 'conversation',
            conversationSessionAddress: { serverId: 'conversation-home', sessionId: 'conversation' },
            targetSessionAddress: { serverId: 'target-home', sessionId: 'target' },
            transcriptMode: 'synthetic', lifetime: 'runtime_attempt', updatedAt: 2,
        });
        expect(resolveSessionLiveConsumption('conversation', 'conversation-home').isFullContentConsumer).toBe(true);
        expect(resolveSessionLiveConsumption('conversation', 'target-home').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('target', 'target-home').isFullContentConsumer).toBe(true);
        expect(resolveSessionLiveConsumption('target', 'conversation-home').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('global-control', 'target-home').isFullContentConsumer).toBe(false);

        // Retained association is history, not a reason to keep hydrating either
        // transcript after this device's actual bound attempt has ended.
        setVoiceSessionSnapshot({ adapterId: 'realtime', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
        expect(resolveSessionLiveConsumption('conversation', 'conversation-home').isFullContentConsumer).toBe(false);
        expect(resolveSessionLiveConsumption('target', 'target-home').isFullContentConsumer).toBe(false);
    });
});
