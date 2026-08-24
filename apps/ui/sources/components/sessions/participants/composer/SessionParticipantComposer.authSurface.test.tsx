import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: { addEventListener: appStateAddListener },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const modalAlertSpy = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: (...args: unknown[]) => modalAlertSpy(...args),
        },
    }).module;
});

const agentInputSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: unknown) => {
        agentInputSpy(props);
        return React.createElement('AgentInput', props as Record<string, unknown>);
    },
}));

vi.mock('@/components/autocomplete/suggestions', () => ({
    getSuggestions: vi.fn(async () => []),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunSend: vi.fn(async () => ({ ok: true })),
    isExecutionRunNotRunningSendError: vi.fn(() => false),
}));

const pendingFireAndForget = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>, options?: { tag?: string }) => {
        if (options?.tag === 'SessionParticipantComposer.sendMessage') {
            pendingFireAndForget.push(promise);
        }
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { renderScreen } from '@/dev/testkit';
import { resetReactNativeMmkvStub } from '@/dev/testkit/mocks/mmkv';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { Encryption } from '@/sync/encryption/encryption';
import { HappyError } from '@/utils/errors/errors';

const initialStorageState = storage.getState();

function createActiveSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function readLatestAgentInputProps(): {
    onChangeText: (text: string) => void;
    onSend: () => void;
} {
    const props = agentInputSpy.mock.lastCall?.[0];
    if (!props || typeof props !== 'object') {
        throw new Error('AgentInput props were not captured');
    }
    return props as {
        onChangeText: (text: string) => void;
        onSend: () => void;
    };
}

describe('SessionParticipantComposer auth send surface', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        resetReactNativeMmkvStub();
        appStateAddListener.mockClear();
        agentInputSpy.mockClear();
        modalAlertSpy.mockClear();
        pendingFireAndForget.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('surfaces not_authenticated from the real pending send path instead of silently enqueueing', async () => {
        const sessionId = 's_auth_surface';
        const activeServer = upsertAndActivateServer({ serverUrl: 'https://relay.example.test' });
        storage.getState().activateProfileScope({
            serverId: activeServer.id,
            accountId: 'account-auth-surface',
        });
        storage.getState().applySessions([createActiveSession(sessionId)]);
        storage.getState().applySettingsLocal({ sessionMessageSendMode: 'agent_queue' });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('@/sync/sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(
            new HappyError('Authentication required', false, {
                kind: 'auth',
                code: 'not_authenticated',
            }),
        );
        const emitWithAck = vi.fn();
        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck,
            send,
        });

        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId={sessionId}
            canSendMessages
            recipient={null}
        />);

        await act(async () => {
            readLatestAgentInputProps().onChangeText('stale auth send');
        });

        await act(async () => {
            readLatestAgentInputProps().onSend();
            await flushHookEffects({ cycles: 2, turns: 2 });
            await Promise.allSettled(pendingFireAndForget);
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'Authentication required');
        expect(apiSocket.sessionRPC).toHaveBeenCalledTimes(1);
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });
});
