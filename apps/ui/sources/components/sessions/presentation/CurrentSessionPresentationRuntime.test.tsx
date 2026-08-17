import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
} from '@happier-dev/protocol/sessions';

import {
    createSessionFixture,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    resetSessionDraftValueCachesForTests,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import {
    resetSessionSurfaceVisibilityForTests,
    setFocusedSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import { loadSessionDrafts, saveSessionDrafts } from '@/sync/domains/state/sessionPersistence';

const sessionRpc = vi.hoisted(() => vi.fn());
const persistentValues = vi.hoisted(() => new Map<string, string>());
const activeScopeState = vi.hoisted(() => ({
    value: null as Readonly<{ serverId: string; accountId: string }> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistentValues.get(key);
        }

        set(key: string, value: string) {
            persistentValues.set(key, value);
        }

        delete(key: string) {
            persistentValues.delete(key);
        }
    }

    return { MMKV };
});
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Readonly<{ children?: React.ReactNode }>) => (
        React.createElement('Text', props, props.children)
    ),
}));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => 'client-1' }));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => activeScopeState.value,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (input: unknown) => sessionRpc(input),
}));

import { registerComposerPresentationTarget } from './sessionComposerPresentationTargets';
import { CurrentSessionPresentationRuntime } from './CurrentSessionPresentationRuntime';

const persistentSessionScope: ServerAccountScope = {
    serverId: 'server-runtime',
    accountId: 'account-runtime',
};
const initialStorageState = storage.getState();

function activatePersistentSessionDraft(sessionId: string, text: string): void {
    persistentValues.clear();
    resetSessionDraftValueCachesForTests();
    activeScopeState.value = persistentSessionScope;
    storage.getState().clearSessionLocalStateScope();
    saveSessionDrafts({ [sessionId]: text }, persistentSessionScope);
    storage.getState().activateSessionLocalStateScope(persistentSessionScope);
}

afterEach(() => {
    standardCleanup();
    resetSessionSurfaceVisibilityForTests();
    activeScopeState.value = null;
    persistentValues.clear();
    resetSessionDraftValueCachesForTests();
    storage.setState(initialStorageState, true);
    sessionRpc.mockReset();
});

describe('CurrentSessionPresentationRuntime', () => {
    it('acknowledges a daemon replacement as unavailable without mutating an offscreen Session draft', async () => {
        const sessionId = 'session-runtime-daemon-visual-scope';
        const pendingRef = { kind: 'pendingMessage', sessionId, localId: 'pending-1' } as const;
        activatePersistentSessionDraft(sessionId, 'persistent before');
        const persistentRevision = 0;
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: {},
            sessions: {
                [sessionId]: createSessionFixture({
                    id: sessionId,
                    active: true,
                    agentState: {
                        [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                            v: 1,
                            hostNonce: 'host-1',
                            revision: 1,
                            statuses: [],
                            widgets: [],
                            command: {
                                id: 'command-1',
                                clientId: 'client-1',
                                kind: 'composer.replace',
                                transaction: {
                                    expectedRevision: persistentRevision,
                                    operations: [{ kind: 'text.set', text: 'daemon replacement' }],
                                },
                            },
                        },
                    },
                }),
            },
        }));
        const pendingReplace = vi.fn((text: string, expectedRevision: number) => (
            expectedRevision === persistentRevision ? persistentRevision + 1 : persistentRevision
        ));
        const unregister = registerComposerPresentationTarget(pendingRef, {
            readRevision: () => persistentRevision,
            replace: pendingReplace,
        });
        sessionRpc.mockImplementation(async (input: Readonly<{
            sessionId: string;
            method: string;
        }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return {
                    status: 'bound',
                    sessionId: input.sessionId,
                    hostNonce: 'host-1',
                    revision: 1,
                };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD) return undefined;
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });
        setFocusedSessionId(sessionId);

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 8, turns: 3 });

            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
                payload: expect.objectContaining({
                    clientId: 'client-1',
                    focused: false,
                    draftRevision: persistentRevision,
                }),
            }));
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
                payload: expect.objectContaining({
                    hostNonce: 'host-1',
                    clientId: 'client-1',
                    commandId: 'command-1',
                    result: { status: 'composerUnavailable' },
                }),
            }));
            expect(loadSessionDrafts(persistentSessionScope)[sessionId]).toBe('persistent before');
            expect(pendingReplace).not.toHaveBeenCalled();
        } finally {
            unregister();
        }
    });
});
