import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import {
    resetSessionSurfaceVisibilityForTests,
    setFocusedSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterController } from '@/voice/session/types';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/voice/agent/getVoiceAgentSessionTeleportAvailability', () => ({
    getVoiceAgentSessionTeleportAvailability: () => ({ ok: false }),
}));

describe('useVoiceSurfaceTargetState', () => {
    beforeEach(() => {
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionAddress: null,
            voiceLiveContextSessionAddresses: [],
            lastFocusedSessionAddress: { serverId: 'server-a', sessionId: 'voice-last-focused' },
        } as any);
        resetSessionSurfaceVisibilityForTests();
        registerVoiceAdapters([]);
    });

    it('keeps an explicitly placed in-session surface bound to its exact session when Global is the default', async () => {
        registerVoiceAdapters([createSurfaceAdapter('global_provider', true, 'global')]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/exact-session',
            providerId: 'global_provider',
            sessionId: 'exact-session',
            serverId: 'server-a',
            variant: 'session',
            voice: {
                ui: {
                    scopeDefault: 'global',
                    surfaceLocation: 'session',
                },
            },
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().bindingScope).toBe('session');
        expect(hook.getCurrent().startSessionId).toBe('exact-session');
        await hook.unmount();
    });

    it('keeps an in-session Voice surface bound to its rendered Home when another Home is active', async () => {
        registerVoiceAdapters([createSurfaceAdapter('surface_provider', false, 'surface')]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'surface_provider',
            sessionId: 'shared-session',
            serverId: 'server-b',
            variant: 'session',
            voice: null,
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().startSessionAddress).toEqual({
            serverId: 'server-b',
            sessionId: 'shared-session',
        });
        await hook.unmount();
    });

    it('does not reconstruct an in-session Voice target from a bare Session id', async () => {
        registerVoiceAdapters([createSurfaceAdapter('surface_provider', false, 'surface')]);
        const previousStorageState = storage.getState();
        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                'shared-session': {
                    id: 'shared-session',
                    serverId: 'server-a',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    presence: 1,
                    metadata: null,
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 1,
                    thinking: false,
                    thinkingAt: 0,
                } satisfies Session,
            },
        }));
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'surface_provider',
            sessionId: 'shared-session',
            serverId: null,
            variant: 'session',
            voice: null,
            voicePrivacy: { shareFilePaths: true, shareSessionSummary: true },
        }));

        expect(hook.getCurrent().bindingScope).toBe('session');
        expect(hook.getCurrent().startSessionAddress).toBeNull();
        await hook.unmount();
        storage.setState(previousStorageState, true);
    });

    it('treats an explicitly unavailable mounted address as authoritative over legacy qualified props', async () => {
        registerVoiceAdapters([createSurfaceAdapter('surface_provider', false, 'surface')]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'surface_provider',
            sessionAddress: null,
            sessionId: 'shared-session',
            serverId: 'server-a',
            variant: 'session',
            voice: null,
            voicePrivacy: { shareFilePaths: true, shareSessionSummary: true },
        }));

        expect(hook.getCurrent().startSessionAddress).toBeNull();
        await hook.unmount();
    });

    it('keeps exact-session scope when the voice surface is explicitly placed in the sidebar', async () => {
        registerVoiceAdapters([createSurfaceAdapter('global_provider', true, 'global')]);
        setFocusedSessionId('exact-session', 'server-a');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'global_provider',
            sessionId: null,
            variant: 'sidebar',
            voice: {
                ui: {
                    scopeDefault: 'session',
                    surfaceLocation: 'sidebar',
                },
            },
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().bindingScope).toBe('session');
        expect(hook.getCurrent().startSessionId).toBe('exact-session');
        await hook.unmount();
    });

    it('prefers the focused visible session over the route session for surface-scoped sidebar targeting', async () => {
        registerVoiceAdapters([createSurfaceAdapter('surface_provider', false, 'surface')]);
        setFocusedSessionId('split-focused-session', 'server-a');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'surface_provider',
            sessionId: null,
            variant: 'sidebar',
            voice: null,
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().startSessionId).toBe('split-focused-session');
        await hook.unmount();
    });

    it('keeps the focused Session Home instead of retargeting Voice through the ambient active Home', async () => {
        registerVoiceAdapters([createSurfaceAdapter('surface_provider', false, 'surface')]);
        setFocusedSessionId('shared-session', 'server-b');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'surface_provider',
            sessionId: null,
            variant: 'sidebar',
            voice: null,
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().startSessionAddress).toEqual({
            serverId: 'server-b',
            sessionId: 'shared-session',
        });
        await hook.unmount();
    });

    it('resolves a global-scoped Voice Home start independently of focused, routed, last-focused, or tool-target sessions', async () => {
        registerVoiceAdapters([createSurfaceAdapter('global_provider', true, 'global')]);
        setFocusedSessionId('split-focused-session', 'server-a');
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionAddress: { serverId: 'server-a', sessionId: 'tool-target-session' },
            lastFocusedSessionAddress: { serverId: 'server-a', sessionId: 'last-focused-session' },
        } as any);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'global_provider',
            sessionId: null,
            variant: 'sidebar',
            voice: null,
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().bindingScope).toBe('global');
        expect(hook.getCurrent().startSessionId).toBe(null);
        expect(hook.getCurrent().targetLabel).toBe(null);
        await hook.unmount();
    });

    it('resolves the exact explicit session surface for a global-capable provider', async () => {
        registerVoiceAdapters([createSurfaceAdapter('global_provider', true, 'global')]);
        setFocusedSessionId('other-focused-session');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'global_provider',
            sessionId: 'exact-session',
            serverId: 'server-a',
            variant: 'session',
            voice: {
                ui: {
                    scopeDefault: 'session',
                    surfaceLocation: 'session',
                },
            },
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().startSessionId).toBe('exact-session');
        await hook.unmount();
    });

    it('allows a fake second realtime provider to declare global start without host edits', async () => {
        registerVoiceAdapters([createSurfaceAdapter('realtime_second_provider', true, 'global')]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/',
            providerId: 'realtime_second_provider',
            sessionId: null,
            variant: 'sidebar',
            voice: {},
            voicePrivacy: { shareFilePaths: false, shareSessionSummary: false },
        }));

        expect(hook.getCurrent().allowsGlobalStart).toBe(true);
        expect(hook.getCurrent().bargeInEnabled).toBe(true);
        expect(hook.getCurrent().cancelResponseSupported).toBe(false);
        await hook.unmount();
    });

    it('fails global start closed when a configured provider is not registered', async () => {
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/',
            providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            sessionId: null,
            variant: 'sidebar',
            voice: {},
            voicePrivacy: { shareFilePaths: false, shareSessionSummary: false },
        }));

        expect(hook.getCurrent().allowsGlobalStart).toBe(false);
        await hook.unmount();
    });

    it('reacts only to preferred metadata for the selected sidebar target', async () => {
        const previousStorageState = storage.getState();
        const selectedSessionId = 'surface-selected-session';
        const unrelatedSessionId = 'surface-unrelated-session';
        const serverId = 'surface-test-server';
        const baseParams = {
            pathname: '/',
            providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            sessionId: null,
            variant: 'sidebar' as const,
            voice: null,
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        };
        let unmountHook: (() => Promise<void>) | null = null;

        try {
            registerVoiceAdapters([createSurfaceAdapter('happier.voice.elevenlabs/realtime-elevenlabs', false, 'surface')]);
            setFocusedSessionId(selectedSessionId, serverId);
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [selectedSessionId]: {
                        id: selectedSessionId,
                        serverId,
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: false,
                        activeAt: 1,
                        presence: 1,
                        metadata: {
                            host: 'surface-host',
                            path: '/surface/raw-selected',
                            summaryText: 'Raw selected summary',
                        },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                    } satisfies Session,
                    [unrelatedSessionId]: {
                        id: unrelatedSessionId,
                        serverId,
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: false,
                        activeAt: 1,
                        presence: 1,
                        metadata: {
                            host: 'surface-host',
                            path: '/surface/raw-unrelated',
                            summaryText: 'Raw unrelated summary',
                        },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                    } satisfies Session,
                },
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [serverId]: {
                        ...(state.sessionListRowsByServerId[serverId] ?? {}),
                        [selectedSessionId]: {
                            id: selectedSessionId,
                            seq: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            active: false,
                            activeAt: 1,
                            presence: 1,
                            metadata: {
                                host: 'surface-host',
                                path: '/surface/selected',
                                summaryText: 'Preferred selected summary',
                            },
                            metadataVersion: 1,
                            agentStateVersion: 1,
                            thinking: false,
                            thinkingAt: 0,
                        } satisfies SessionListRenderableSession,
                        [unrelatedSessionId]: {
                            id: unrelatedSessionId,
                            seq: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            active: false,
                            activeAt: 1,
                            presence: 1,
                            metadata: {
                                host: 'surface-host',
                                path: '/surface/unrelated',
                                summaryText: 'Preferred unrelated summary',
                            },
                            metadataVersion: 1,
                            agentStateVersion: 1,
                            thinking: false,
                            thinkingAt: 0,
                        } satisfies SessionListRenderableSession,
                    },
                },
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    [serverId]: [selectedSessionId, unrelatedSessionId],
                },
                sessionListIndexByServerId: {
                    ...state.sessionListIndexByServerId,
                    [serverId]: [
                        { type: 'session', sessionId: selectedSessionId, serverId, serverName: 'Surface test' },
                        { type: 'session', sessionId: unrelatedSessionId, serverId, serverName: 'Surface test' },
                    ],
                },
                concurrentSessionListCacheByServerId: {},
            }));
            useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId, sessionId: selectedSessionId });
            const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

            let renderCount = 0;
            const hook = await renderHook(
                (params: typeof baseParams) => {
                    renderCount += 1;
                    return useVoiceSurfaceTargetState(params);
                },
                { initialProps: baseParams },
            );
            unmountHook = hook.unmount;

            expect(hook.getCurrent().targetLabel).toBe('Preferred selected summary');
            const settledRenderCount = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            ...state.sessionListRowsByServerId[serverId],
                            [unrelatedSessionId]: {
                                ...state.sessionListRowsByServerId[serverId]![unrelatedSessionId]!,
                                metadata: {
                                    ...state.sessionListRowsByServerId[serverId]![unrelatedSessionId]!.metadata,
                                    host: state.sessionListRowsByServerId[serverId]![unrelatedSessionId]!.metadata!.host,
                                    path: state.sessionListRowsByServerId[serverId]![unrelatedSessionId]!.metadata!.path,
                                    summaryText: 'Updated unrelated summary',
                                },
                            },
                        },
                    },
                }));
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            expect(renderCount).toBe(settledRenderCount);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            ...state.sessionListRowsByServerId[serverId],
                            [selectedSessionId]: {
                                ...state.sessionListRowsByServerId[serverId]![selectedSessionId]!,
                                metadata: {
                                    ...state.sessionListRowsByServerId[serverId]![selectedSessionId]!.metadata,
                                    host: state.sessionListRowsByServerId[serverId]![selectedSessionId]!.metadata!.host,
                                    path: state.sessionListRowsByServerId[serverId]![selectedSessionId]!.metadata!.path,
                                    summaryText: 'Updated preferred summary',
                                },
                            },
                        },
                    },
                }));
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            expect(hook.getCurrent().targetLabel).toBe('Updated preferred summary');

            await act(async () => {
                storage.setState((state) => {
                    const serverRows = { ...state.sessionListRowsByServerId[serverId] };
                    delete serverRows[selectedSessionId];
                    return {
                        ...state,
                        sessionListRowsByServerId: {
                            ...state.sessionListRowsByServerId,
                            [serverId]: serverRows,
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            expect(hook.getCurrent().targetLabel).toBe('Raw selected summary');

            await hook.rerender({
                ...baseParams,
                voicePrivacy: {
                    shareFilePaths: false,
                    shareSessionSummary: false,
                },
            });
            expect(hook.getCurrent().targetLabel).toBe('the current session');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [selectedSessionId]: {
                            ...state.sessions[selectedSessionId]!,
                            metadata: {
                                ...state.sessions[selectedSessionId]!.metadata,
                                host: state.sessions[selectedSessionId]!.metadata!.host,
                                path: state.sessions[selectedSessionId]!.metadata!.path,
                                name: 'Offline raw target',
                            },
                        },
                    },
                }));
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            expect(hook.getCurrent().targetLabel).toBe('the current session');

            await act(async () => {
                storage.setState((state) => {
                    const sessions = { ...state.sessions };
                    delete sessions[selectedSessionId];
                    return { ...state, sessions };
                });
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            expect(hook.getCurrent().targetLabel).toBe('the current session');

        } finally {
            await unmountHook?.();
            await act(async () => {
                storage.setState(previousStorageState);
            });
        }
    });
});

function createSurfaceAdapter(
    id: string,
    allowsGlobalStart: boolean,
    controlSessionScope: 'surface' | 'global',
): VoiceAdapterController {
    return {
        id,
        engineKind: 'realtime',
        start: async () => {},
        stop: async () => {},
        toggle: async () => {},
        interrupt: async () => {},
        bargeIn: async () => {},
        setMuted: async () => {},
        sendContextUpdate: () => {},
        getSnapshot: () => ({ adapterId: id, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart,
            controlSessionScope,
            requiresVoiceAgentFeature: false,
            bargeInEnabled: true,
        }),
    };
}
