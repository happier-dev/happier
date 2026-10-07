import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
} from '@happier-dev/protocol/sessions';
import type {
    ComposerPresentationDocumentMutation,
    ComposerPresentationTarget,
} from './sessionComposerPresentationTargets';

import {
    createSessionFixture,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    resetSessionDraftValueCachesForTests,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import {
    resetSessionSurfaceVisibilityForTests,
    setFocusedSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import { loadSessionDrafts, saveSessionDrafts } from '@/sync/domains/state/sessionPersistence';
import { apiSocket } from '@/sync/api/session/apiSocket';

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
    captureActiveServerAccountScopeLifetime: () => {
        const captured = activeScopeState.value;
        if (!captured) return null;
        return {
            scope: captured,
            isCurrent: () => activeScopeState.value?.serverId === captured.serverId
                && activeScopeState.value?.accountId === captured.accountId,
            onRetire: () => ({ dispose: () => {} }),
        };
    },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (input: unknown) => sessionRpc(input),
}));

import {
    registerComposerPresentationTarget,
    registerSessionComposerPresentationTarget,
    registerSessionPresentationOnlyTarget,
} from './sessionComposerPresentationTargets';
import { publishPresentationNotice, readPresentationNotice, retirePresentationNotice } from './presentationNotices';
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

function createRuntimeSessionComposerTarget(sessionId: string) {
    let revision = 1;
    let text = '';
    const commitDocument = vi.fn((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>) => {
        if (input.expectedRevision !== revision) {
            return { status: 'conflict' as const, currentRevision: revision };
        }
        text = input.mutation.text;
        revision += 1;
        return { status: 'applied' as const, revision };
    });
    const target: ComposerPresentationTarget = {
        readRevision: () => revision,
        replace: (next, expectedRevision) => {
            if (expectedRevision !== revision) return revision;
            text = next;
            revision += 1;
            return revision;
        },
        readSnapshot: () => ({
            revision,
            ref: { kind: 'session', sessionId },
            text,
            references: [],
            attachments: [],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: {
                focused: true,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            },
        }),
        commitDocument,
    };
    return {
        target,
        readText: () => text,
        commitDocument,
    };
}

afterEach(() => {
    retirePresentationNotice();
    standardCleanup();
    resetSessionSurfaceVisibilityForTests();
    activeScopeState.value = null;
    persistentValues.clear();
    resetSessionDraftValueCachesForTests();
    storage.setState(initialStorageState, true);
    sessionRpc.mockReset();
});

describe('CurrentSessionPresentationRuntime', () => {
    it('rebinds once when the authenticated Home socket reconnects', async () => {
        const sessionId = 'reconnected-session';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        const unregister = registerSessionComposerPresentationTarget(address, createRuntimeSessionComposerTarget(sessionId).target);
        activeScopeState.value = persistentSessionScope;
        setFocusedSessionId(sessionId, address.serverId);
        storage.setState((state) => ({
            ...state,
            sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: address.serverId, active: true }) },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ method: string; sessionId: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return { status: 'bound', sessionId: input.sessionId, hostNonce: 'host-1', revision: 1 };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD) return { status: 'retired' };
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });
        const statusListener: {
            current: ((status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) | null;
        } = { current: null };
        const statusSubscription = vi.spyOn(apiSocket, 'onStatusChange').mockImplementation((listener) => {
            statusListener.current = listener;
            listener('connected');
            return () => {
                statusListener.current = null;
                return true;
            };
        });

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 6, turns: 3 });
            expect(sessionRpc.mock.calls.filter(([input]) => (
                (input as Readonly<{ method: string }>).method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD
            ))).toHaveLength(1);

            const emitStatus = statusListener.current ?? (() => { throw new Error('Expected socket status subscription'); });
            emitStatus('disconnected');
            emitStatus('connected');
            await flushHookEffects({ cycles: 6, turns: 3 });
            expect(sessionRpc.mock.calls.filter(([input]) => (
                (input as Readonly<{ method: string }>).method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD
            ))).toHaveLength(2);
        } finally {
            statusSubscription.mockRestore();
            unregister();
        }
    });

    it('does not rebind when the host echoes its accepted binding or a row omits presentation state', async () => {
        const sessionId = 'quiet-session';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        const unregister = registerSessionComposerPresentationTarget(address, createRuntimeSessionComposerTarget(sessionId).target);
        activeScopeState.value = persistentSessionScope;
        setFocusedSessionId(sessionId, address.serverId);
        storage.setState((state) => ({
            ...state,
            sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: address.serverId, active: true }) },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ method: string; sessionId: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return { status: 'bound', sessionId: input.sessionId, hostNonce: 'host-1', revision: 1 };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD) return { status: 'retired' };
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 6, turns: 3 });
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...state.sessions[sessionId]!,
                        agentState: {
                            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                                v: 1, hostNonce: 'host-1', revision: 1, statuses: [], widgets: [],
                            },
                        },
                    },
                },
            }));
            await flushHookEffects({ cycles: 6, turns: 3 });
            storage.setState((state) => ({
                ...state,
                sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId]!, agentState: null } },
            }));
            await flushHookEffects({ cycles: 6, turns: 3 });
            expect(sessionRpc.mock.calls.filter(([input]) => (
                (input as Readonly<{ method: string }>).method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD
            ))).toHaveLength(1);
        } finally {
            unregister();
        }
    });

    it('retires its exact mounted Session binding when the runtime unmounts', async () => {
        const sessionId = 'mounted-session';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        const composer = createRuntimeSessionComposerTarget(sessionId);
        const unregister = registerSessionComposerPresentationTarget(address, composer.target);
        activeScopeState.value = persistentSessionScope;
        setFocusedSessionId(sessionId, address.serverId);
        storage.setState((state) => ({
            ...state,
            sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, serverId: address.serverId, active: true }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ method: string; sessionId: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return { status: 'bound', sessionId: input.sessionId, hostNonce: 'host-1', revision: 1 };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD) return { status: 'retired' };
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        const screen = await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
        await flushHookEffects({ cycles: 6, turns: 3 });
        expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
            sessionId,
        }));

        await screen.unmount();
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
            sessionId,
            payload: { clientId: 'client-1' },
        }));
        unregister();
    });

    it('retires a bind that is accepted after its mounted runtime already unmounted', async () => {
        const sessionId = 'late-bind-session';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        const composer = createRuntimeSessionComposerTarget(sessionId);
        const unregister = registerSessionComposerPresentationTarget(address, composer.target);
        let settleBind!: (result: Readonly<{
            status: 'bound';
            sessionId: string;
            hostNonce: string;
            revision: number;
        }>) => void;
        const bindResult = new Promise<Readonly<{
            status: 'bound';
            sessionId: string;
            hostNonce: string;
            revision: number;
        }>>((resolve) => { settleBind = resolve; });
        activeScopeState.value = persistentSessionScope;
        setFocusedSessionId(sessionId, address.serverId);
        storage.setState((state) => ({
            ...state,
            sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, serverId: address.serverId, active: true }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ method: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) return await bindResult;
            if (input.method === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD) return { status: 'retired' };
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        const screen = await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
        await vi.waitFor(() => expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
            sessionId,
        })));
        await screen.unmount();
        settleBind({ status: 'bound', sessionId, hostNonce: 'host-1', revision: 1 });
        await flushHookEffects({ cycles: 6, turns: 3 });

        expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
            sessionId,
            payload: { clientId: 'client-1' },
        }));
        unregister();
    });

    it('retires its exact binding when the mounted Session leaves the active account scope', async () => {
        const sessionId = 'retired-session';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        const composer = createRuntimeSessionComposerTarget(sessionId);
        const unregister = registerSessionComposerPresentationTarget(address, composer.target);
        activeScopeState.value = persistentSessionScope;
        setFocusedSessionId(sessionId, address.serverId);
        storage.setState((state) => ({
            ...state,
            sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, serverId: address.serverId, active: true }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ method: string; sessionId: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return { status: 'bound', sessionId: input.sessionId, hostNonce: 'host-1', revision: 1 };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD) return { status: 'retired' };
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
        await flushHookEffects({ cycles: 6, turns: 3 });
        sessionRpc.mockClear();

        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                [sessionId]: { ...state.sessions[sessionId]!, active: false },
            },
        }));
        await flushHookEffects({ cycles: 6, turns: 3 });

        expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
            sessionId,
            payload: { clientId: 'client-1' },
        }));
        unregister();
    });

    it('applies and acknowledges a command through the exact Home when two Homes mount the same Session id', async () => {
        const sessionId = 'same-session-id';
        const addressA = { serverId: 'https://home-a.example.test', sessionId } as const;
        const addressB = { serverId: 'https://home-b.example.test', sessionId } as const;
        const composerA = createRuntimeSessionComposerTarget(sessionId);
        const composerB = createRuntimeSessionComposerTarget(sessionId);
        const unregisterA = registerSessionComposerPresentationTarget(addressA, composerA.target);
        const unregisterB = registerSessionComposerPresentationTarget(addressB, composerB.target);
        activeScopeState.value = { serverId: addressA.serverId, accountId: 'account-runtime' };
        setFocusedSessionId(sessionId, addressA.serverId);
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: {},
            sessions: {
                [sessionId]: createSessionFixture({
                    id: sessionId,
                    serverId: addressA.serverId,
                    active: true,
                    agentState: {
                        [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                            v: 1,
                            hostNonce: 'host-a',
                            revision: 1,
                            statuses: [],
                            widgets: [],
                            command: {
                                id: 'replace-a',
                                clientId: 'client-1',
                                kind: 'composer.replace',
                                transaction: {
                                    expectedRevision: 1,
                                    operations: [{ kind: 'text.set', text: 'Home A only' }],
                                },
                            },
                        },
                    },
                }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{
            serverId: string;
            sessionId: string;
            method: string;
        }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return {
                    status: 'bound',
                    sessionId: input.sessionId,
                    hostNonce: input.serverId === addressB.serverId ? 'host-b' : 'host-a',
                    revision: 1,
                };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD) return undefined;
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 8, turns: 3 });

            expect(composerA.readText()).toBe('Home A only');
            expect(composerA.commitDocument).toHaveBeenCalledTimes(1);
            expect(composerB.readText()).toBe('');
            expect(composerB.commitDocument).not.toHaveBeenCalled();
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverId: addressA.serverId,
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
            }));
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverId: addressA.serverId,
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
            }));

            // Re-observing the exact command may resend its settled ACK, but must
            // never apply the viewer-local effect a second time.
            storage.setState((state) => ({ ...state }));
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(composerA.commitDocument).toHaveBeenCalledTimes(1);

            activeScopeState.value = { serverId: addressB.serverId, accountId: 'account-runtime' };
            setFocusedSessionId(sessionId, addressB.serverId);
            storage.setState((state) => ({
                ...state,
                sessions: {
                    [sessionId]: createSessionFixture({
                        id: sessionId,
                        serverId: addressB.serverId,
                        active: true,
                        agentState: {
                            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                                v: 1,
                                hostNonce: 'host-b',
                                revision: 1,
                                statuses: [],
                                widgets: [],
                                command: {
                                    id: 'replace-b',
                                    clientId: 'client-1',
                                    kind: 'composer.replace',
                                    transaction: {
                                        expectedRevision: 1,
                                        operations: [{ kind: 'text.set', text: 'Home B only' }],
                                    },
                                },
                            },
                        },
                    }),
                },
            }));
            await flushHookEffects({ cycles: 8, turns: 3 });

            expect(composerA.readText()).toBe('Home A only');
            expect(composerA.commitDocument).toHaveBeenCalledTimes(1);
            expect(composerB.readText()).toBe('Home B only');
            expect(composerB.commitDocument).toHaveBeenCalledTimes(1);
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverId: addressB.serverId,
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
            }));
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverId: addressB.serverId,
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
            }));

            storage.setState((state) => ({ ...state }));
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(composerB.commitDocument).toHaveBeenCalledTimes(1);
        } finally {
            unregisterB();
            unregisterA();
        }
    });

    it('does not apply a replacement Home row through an in-flight bind for the captured Home', async () => {
        const sessionId = 'same-session-id-bind-race';
        const addressA = { serverId: 'https://home-a.example.test', sessionId } as const;
        const addressB = { serverId: 'https://home-b.example.test', sessionId } as const;
        const composerA = createRuntimeSessionComposerTarget(sessionId);
        const composerB = createRuntimeSessionComposerTarget(sessionId);
        const unregisterA = registerSessionComposerPresentationTarget(addressA, composerA.target);
        const unregisterB = registerSessionComposerPresentationTarget(addressB, composerB.target);
        let settleBind!: (value: Readonly<{
            status: 'bound';
            sessionId: string;
            hostNonce: string;
            revision: number;
        }>) => void;
        const bindResult = new Promise<Readonly<{
            status: 'bound';
            sessionId: string;
            hostNonce: string;
            revision: number;
        }>>((resolve) => {
            settleBind = resolve;
        });
        activeScopeState.value = { serverId: addressA.serverId, accountId: 'account-runtime' };
        setFocusedSessionId(sessionId, addressA.serverId);
        const commandState = (text: string) => ({
            v: 1 as const,
            // A nonce can legitimately collide across independently running
            // Homes. Home identity, never nonce uniqueness, is the routing fence.
            hostNonce: 'same-host-nonce',
            revision: 1,
            statuses: [],
            widgets: [],
            command: {
                id: `replace-${text}`,
                clientId: 'client-1',
                kind: 'composer.replace' as const,
                transaction: {
                    expectedRevision: 1,
                    operations: [{ kind: 'text.set' as const, text }],
                },
            },
        });
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: {},
            sessions: {
                [sessionId]: createSessionFixture({
                    id: sessionId,
                    serverId: addressA.serverId,
                    active: true,
                    agentState: {
                        [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: commandState('Home A command'),
                    },
                }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{
            serverId: string;
            sessionId: string;
            method: string;
        }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) return await bindResult;
            if (input.method === CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD) return undefined;
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverId: addressA.serverId,
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
            }));

            // Model the narrow store-transition window where the same raw key
            // has already been replaced by Home B before the active scope moves.
            // The A request must not read B's command and apply it to A's target.
            storage.setState((state) => ({
                ...state,
                sessions: {
                    [sessionId]: createSessionFixture({
                        id: sessionId,
                        serverId: addressB.serverId,
                        active: true,
                        agentState: {
                            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: commandState('Home B command'),
                        },
                    }),
                },
            }));
            settleBind({
                status: 'bound',
                sessionId,
                hostNonce: 'same-host-nonce',
                revision: 1,
            });
            await flushHookEffects({ cycles: 8, turns: 3 });

            expect(composerA.readText()).toBe('');
            expect(composerB.readText()).toBe('');
            expect(composerA.commitDocument).not.toHaveBeenCalled();
            expect(composerB.commitDocument).not.toHaveBeenCalled();
            expect(sessionRpc.mock.calls.filter(([input]) => (
                (input as Readonly<{ method: string }>).method === CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD
            ))).toHaveLength(0);
        } finally {
            unregisterB();
            unregisterA();
        }
    });

    it('does not reuse command custody across Account bindings with the same Session id and host nonce', async () => {
        const sessionId = 'same-id-across-accounts';
        const address = { serverId: 'server-runtime', sessionId } as const;
        const composer = createRuntimeSessionComposerTarget(sessionId);
        const unregister = registerSessionComposerPresentationTarget(address, composer.target);
        const command = (message: string) => ({
            v: 1 as const,
            hostNonce: 'host-shared-test-nonce',
            revision: 1,
            statuses: [],
            widgets: [],
            command: {
                id: 'same-command-id',
                clientId: 'client-1',
                kind: 'notify' as const,
                message,
                severity: 'info' as const,
            },
        });
        activeScopeState.value = { serverId: 'server-runtime', accountId: 'account-a' };
        setFocusedSessionId(sessionId, address.serverId);
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: {},
            sessions: {
                [sessionId]: createSessionFixture({
                    id: sessionId,
                    serverId: 'server-runtime',
                    active: true,
                    agentState: { [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: command('account-a') },
                }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ sessionId: string; method: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return {
                    status: 'bound',
                    sessionId: input.sessionId,
                    hostNonce: 'host-shared-test-nonce',
                    revision: 1,
                };
            }
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(readPresentationNotice()?.message).toBe('account-a');
            const accountANoticeKey = readPresentationNotice()?.key;

            activeScopeState.value = { serverId: 'server-runtime', accountId: 'account-b' };
            storage.setState((state) => ({
                ...state,
                sessions: {
                    [sessionId]: createSessionFixture({
                        id: sessionId,
                        serverId: 'server-runtime',
                        active: true,
                        agentState: { [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: command('account-b') },
                    }),
                },
            }));
            await flushHookEffects({ cycles: 4, turns: 2 });

            expect(readPresentationNotice()?.message).toBe('account-b');
            expect(readPresentationNotice()?.key).not.toBe(accountANoticeKey);
            expect(sessionRpc.mock.calls.filter(([input]) => (
                (input as Readonly<{ method: string }>).method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD
            ))).toHaveLength(2);
        } finally {
            unregister();
        }
    });

    it('deduplicates every command for the current host binding without an arbitrary count eviction', async () => {
        const sessionId = 'session-runtime-binding-dedupe';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        const composer = createRuntimeSessionComposerTarget(sessionId);
        const unregister = registerSessionComposerPresentationTarget(address, composer.target);
        activeScopeState.value = persistentSessionScope;
        setFocusedSessionId(sessionId, address.serverId);
        let currentHostNonce = 'host-long-lived';
        const command = (id: string) => ({
            v: 1 as const,
            hostNonce: currentHostNonce,
            revision: 1,
            statuses: [],
            widgets: [],
            command: {
                id,
                clientId: 'client-1',
                kind: 'notify' as const,
                message: id,
                severity: 'info' as const,
            },
        });
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: {},
            sessions: {
                [sessionId]: createSessionFixture({
                    id: sessionId,
                    serverId: persistentSessionScope.serverId,
                    active: true,
                    agentState: {
                        [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: command('command-0'),
                    },
                }),
            },
        }));
        sessionRpc.mockImplementation(async (input: Readonly<{ sessionId: string; method: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return {
                    status: 'bound',
                    sessionId: input.sessionId,
                    hostNonce: currentHostNonce,
                    revision: 1,
                };
            }
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 3, turns: 2 });
            for (let index = 1; index <= 256; index += 1) {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [sessionId]: {
                            ...state.sessions[sessionId]!,
                            agentState: {
                                [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: command(`command-${index}`),
                            },
                        },
                    },
                }));
                await flushHookEffects({ cycles: 1, turns: 1 });
            }
            expect(readPresentationNotice()?.message).toBe('command-256');

            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...state.sessions[sessionId]!,
                        agentState: {
                            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: command('command-0'),
                        },
                    },
                },
            }));
            await flushHookEffects({ cycles: 3, turns: 2 });

            expect(readPresentationNotice()?.message).toBe('command-256');

            currentHostNonce = 'host-replaced';
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...state.sessions[sessionId]!,
                        agentState: {
                            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: command('replacement-command'),
                        },
                    },
                },
            }));
            await flushHookEffects({ cycles: 3, turns: 2 });

            expect(readPresentationNotice()?.message).toBe('replacement-command');
            expect(sessionRpc.mock.calls.filter(([input]) => (
                (input as Readonly<{ method: string }>).method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD
            ))).toHaveLength(2);
        } finally {
            unregister();
        }
    });

    it('does not bind or acknowledge a command without a mounted Session composer', async () => {
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
                    serverId: persistentSessionScope.serverId,
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
        setFocusedSessionId(sessionId, persistentSessionScope.serverId);

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 8, turns: 3 });

            expect(sessionRpc).not.toHaveBeenCalled();
            expect(loadSessionDrafts(persistentSessionScope)[sessionId]).toBe('persistent before');
            expect(pendingReplace).not.toHaveBeenCalled();
        } finally {
            unregister();
        }
    });

    it('binds a presented composer-less surface and applies its presentation command without a mounted Chat', async () => {
        // Cold direct entry to the full-screen Board or Companion: no Chat composer
        // was ever mounted for this Session, only the presented surface's adapter.
        const sessionId = 'session-runtime-cold-surface';
        const address = { serverId: persistentSessionScope.serverId, sessionId } as const;
        activeScopeState.value = persistentSessionScope;
        let returnedToChat = false;
        const applyIntent = vi.fn((intent: Readonly<{ kind: string }>) => {
            returnedToChat = intent.kind === 'chat.return';
            return { status: 'applied' as const };
        });
        let presented = true;
        const unregister = registerSessionPresentationOnlyTarget(address, {
            applySessionPresentationIntent: applyIntent,
            isCurrent: () => presented,
        });
        const withCommand = (command: Record<string, unknown>) => storage.setState((state) => ({
            ...state,
            deletedSessionIds: {},
            sessions: {
                [sessionId]: createSessionFixture({
                    id: sessionId,
                    serverId: address.serverId,
                    active: true,
                    agentState: {
                        [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                            v: 1, hostNonce: 'host-1', revision: 1, statuses: [], widgets: [], command,
                        },
                    },
                }),
            },
        }));
        withCommand({ id: 'return-1', clientId: 'client-1', kind: 'presentation.apply', intent: { kind: 'chat.return' } });
        sessionRpc.mockImplementation(async (input: Readonly<{ sessionId: string; method: string }>) => {
            if (input.method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
                return { status: 'bound', sessionId: input.sessionId, hostNonce: 'host-1', revision: 1 };
            }
            if (input.method === CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD) return undefined;
            if (input.method === CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD) return undefined;
            throw new Error(`Unexpected session presentation RPC: ${input.method}`);
        });
        setFocusedSessionId(sessionId, address.serverId);

        try {
            await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
            await flushHookEffects({ cycles: 8, turns: 3 });

            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
                payload: expect.objectContaining({ draftRevision: 0 }),
            }));
            expect(applyIntent).toHaveBeenCalledTimes(1);
            expect(returnedToChat).toBe(true);
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
                payload: expect.objectContaining({ commandId: 'return-1', result: { status: 'applied' } }),
            }));

            // A composer command has no composer to act on here: one truthful refusal.
            withCommand({
                id: 'replace-1', clientId: 'client-1', kind: 'composer.replace',
                transaction: { expectedRevision: 0, operations: [{ kind: 'text.set', text: 'nope' }] },
            });
            await flushHookEffects({ cycles: 8, turns: 3 });
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
                payload: expect.objectContaining({ commandId: 'replace-1', result: { status: 'composerUnavailable' } }),
            }));

            // Leaving the surface retires the binding.
            presented = false;
            storage.setState((state) => ({ ...state }));
            await flushHookEffects({ cycles: 8, turns: 3 });
            expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
            }));
        } finally {
            unregister();
        }
    });

    it('offers a caller-owned local inverse on the one notice host and retires the notice it ran for', async () => {
        const run = vi.fn();
        const screen = await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            publishPresentationNotice({
                key: 'notice-1',
                message: 'Added to Companion',
                severity: 'info',
                undo: { label: 'Undo', run },
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const undoControl = screen.findByTestId('current-session-presentation-notice-undo');
        expect(undoControl?.props.accessibilityLabel).toBe('Undo');

        await act(async () => {
            undoControl?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(run).toHaveBeenCalledTimes(1);
        expect(readPresentationNotice()).toBeNull();
        expect(screen.findAllByTestId('current-session-presentation-notice-undo')).toHaveLength(0);
    });

    it('holds the existing notice lifetime open while the inverse control is in use', async () => {
        // Render on real timers first; only the notice lifetime is put on fake
        // timers, so render helpers never await a timer that will not fire.
        const screen = await renderScreen(React.createElement(CurrentSessionPresentationRuntime));
        await flushHookEffects({ cycles: 2, turns: 2 });
        vi.useFakeTimers();
        try {
            await act(async () => {
                publishPresentationNotice({
                    key: 'notice-2',
                    message: 'Board opened by the agent',
                    severity: 'info',
                    undo: { label: 'Undo', run: () => {} },
                });
            });

            await act(async () => {
                screen.findByTestId('current-session-presentation-notice-undo')?.props.onFocus?.();
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10_000);
            });
            expect(readPresentationNotice()?.key).toBe('notice-2');

            await act(async () => {
                screen.findByTestId('current-session-presentation-notice-undo')?.props.onBlur?.();
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000);
            });
            expect(readPresentationNotice()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
