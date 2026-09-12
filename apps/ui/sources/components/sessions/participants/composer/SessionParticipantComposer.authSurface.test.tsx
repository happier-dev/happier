import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

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

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
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

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { Encryption } from '@/sync/encryption/encryption';
import { SessionParticipantComposer } from './SessionParticipantComposer';

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
        pendingVersion: 2,
        pendingCount: 0,
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
        kvStore.clear();
        appStateAddListener.mockClear();
        agentInputSpy.mockClear();
        modalAlertSpy.mockClear();
        resetServerFeaturesClientForTests();
    });

    afterEach(() => {
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
    });

    it('surfaces not_authenticated from the real pending send path instead of silently enqueueing', async () => {
        const sessionId = 's_auth_surface';
        const activeServer = upsertAndActivateServer({
            serverUrl: 'https://server-auth-surface.example.test',
            scope: 'device',
        });
        const activeScope = {
            serverId: activeServer.id,
            accountId: 'account-auth-surface',
        } as const;
        storage.getState().activateProfileScope(activeScope);
        expect(getActiveServerSnapshot().serverId).toBe(activeServer.id);
        expect(getActiveServerAccountScope()).toEqual(activeScope);
        primeServerFeaturesSnapshot({
            serverId: activeServer.id,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: {
                        session: {
                            pendingInput: { protocolVersion: 1 },
                        },
                    },
                }),
            },
        });
        storage.getState().applySessions([createActiveSession(sessionId)]);
        storage.getState().applySettingsLocal({ sessionMessageSendMode: 'agent_queue' });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        sync.encryption = encryption;
        const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(
            new Response('auth failed', { status: 401 }),
        );

        await renderScreen(<SessionParticipantComposer
            sessionId={sessionId}
            canSendMessages
            recipient={null}
        />);
        expect(getActiveServerAccountScope()).toEqual(activeScope);

        await act(async () => {
            readLatestAgentInputProps().onChangeText('stale auth send');
        });

        await act(async () => {
            readLatestAgentInputProps().onSend();
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        await vi.waitFor(() => {
            expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'Authentication required');
        });
        expect(request).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending`,
            expect.objectContaining({ method: 'POST' }),
        );
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });
});
