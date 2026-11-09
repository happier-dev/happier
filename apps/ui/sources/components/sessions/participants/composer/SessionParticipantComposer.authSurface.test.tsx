import 'fake-indexeddb/auto';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceV1Schema, SessionConsumptionReplaceAckV1Schema } from '@happier-dev/protocol/sessions/sessionConsumptionV1';
import { SessionUserMessageSendRequestSchema, SessionUserMessageSendResponseSchema } from '@happier-dev/protocol/sessions/userMessageRpc';
import { MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION } from '@/utils/system/versionUtils';
import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

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

// This integration test owns the real authenticated Session-input boundary;
// transfer availability is separate, while the exact Home/Account binding is
// required by the canonical pending enqueue path even for a text-only send.
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
vi.mock('@/components/sessions/files/useSessionFileUploadAvailability', () => ({
    useSessionFileUploadAvailability: () => false,
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
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';



import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';



const submittedSessionIds: string[] = [];
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        queueMicrotask(() => { for (const listener of socket.listeners('connect')) listener(); });
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: unknown) => {
        if (event === SESSION_CONSUMPTION_REPLACE_EVENT) {
            return SessionConsumptionReplaceAckV1Schema.parse({ ok: true, ...SessionConsumptionReplaceV1Schema.parse(payload) });
        }
        if (event !== SOCKET_RPC_EVENTS.CALL) return { ok: true };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) {
            throw new Error('Invalid Socket RPC request');
        }
        const separator = payload.method.indexOf(':');
        if (payload.method.slice(separator + 1) === SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND) {
            SessionUserMessageSendRequestSchema.parse(payload.params);
            submittedSessionIds.push(payload.method.slice(0, separator));
            const refusal = createNotAuthenticatedError();
            return { ok: true, result: SessionUserMessageSendResponseSchema.parse({
                ok: false, error: refusal.message, errorCode: refusal.code,
            }) };
        }
        return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    });
});
await loadSyncSingletonForTests();
const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { storage } = await import('@/sync/domains/state/storage');
const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
const initialStorageState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function createActiveSession(sessionId: string, serverId: string) {
    const now = Date.now();
    return createSessionFixture({
        id: sessionId,
        serverId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: {
            machineId: 'machine-1',
            host: 'tester.local',
            flavor: 'codex',
            version: MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION,
            path: '/tmp',
            homeDir: '/tmp',
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        pendingVersion: 1,
        optimisticThinkingAt: null,
    });
}

function readLatestAgentInputProps(): {
    onChangeText: (text: string) => void;
    onSend: () => void;
    value?: string;
    isSendDisabled?: boolean;
    disabled?: boolean;
} {
    const props = agentInputSpy.mock.lastCall?.[0];
    if (!props || typeof props !== 'object') {
        throw new Error('AgentInput props were not captured');
    }
    return props as {
        onChangeText: (text: string) => void;
        onSend: () => void;
        value?: string;
        isSendDisabled?: boolean;
        disabled?: boolean;
    };
}

describe('SessionParticipantComposer auth send surface', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        agentInputSpy.mockClear();
        modalAlertSpy.mockClear();
        submittedSessionIds.length = 0;
        resetServerFeaturesClientForTests();
    });

    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = null;
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
    });

    it('surfaces not_authenticated from the real Session send path instead of silently enqueueing', async () => {
        const accountId = 'participant-auth-account';

        const sessionId = 's_auth_surface';
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://server-auth-surface.example.test',
            accountId,
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;



                if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: accountId }));
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
                    features: {}, capabilities: { session: { pendingInput: { protocolVersion: 1 } } },
                }));
                if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
                if (path === '/v1/account/encryption/currentness') return new Response(JSON.stringify(createPlainAccountEncryptionCurrentnessFixture()));
                const bootstrapResponse = createEmptyAccountBootstrapHttpResponse(path, init);
                if (bootstrapResponse) return bootstrapResponse;
                return new Response('{}', { status: 404 });
            },
        });
        const activeServer = connection.home;
        const activeScope = {
            serverId: activeServer.id,
            accountId,
        } as const;
        storage.getState().activateProfileScope(activeScope);
        expect(getActiveServerSnapshot().serverId).toBe(activeServer.id);
        expect(getActiveServerAccountScope()).toEqual(activeScope);
        await getServerFeaturesSnapshot({ serverId: activeServer.id, force: true });
        await vi.waitFor(() => {
            expect(storage.getState().profile.id).toBe(accountId);
            expect(storage.getState().settingsVersion).toBeGreaterThan(0);
        });
        storage.getState().applySessions([createActiveSession(sessionId, activeServer.id)]);
        storage.getState().applySettingsLocal({ sessionMessageSendMode: 'agent_queue' });

        await renderScreen(<SessionParticipantComposer
            sessionId={sessionId}
            serverId={activeServer.id}
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
        expect(submittedSessionIds).toContain(sessionId);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });
});
