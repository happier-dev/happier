import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture, flushHookEffects, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import {
    resetSessionSurfaceVisibilityForTests,
    setFocusedSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { createLocalDirectVoiceAdapter } from '@/voice/adapters/localDirect/localDirectAdapter';
import { createBuiltinVoiceAdapterAssembly } from '@/dev/testkit/harness/builtinVoiceAdapters';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { voiceSettingsParse, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';

function localVoiceSettings(global: boolean) {
    return voiceSettingsParse(global ? { providerId: 'local_conversation', providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
    } } : { providerId: 'local_direct', providers: {
        local_direct: { schemaVersion: 1, config: {} },
    } });
}
let assembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>> | undefined;

describe('useVoiceSurfaceTargetState', () => {
    beforeEach(() => {
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionAddress: null,
            voiceLiveContextSessionAddresses: [],
            lastFocusedSessionAddress: { serverId: 'server-a', sessionId: 'voice-last-focused' },
        });
        resetSessionSurfaceVisibilityForTests();
        registerVoiceAdapters([]);
    });
    afterEach(async () => {
        await assembly?.dispose();
        assembly = undefined;
        registerVoiceAdapters([]);
    });

    it('keeps the failed Session target in the default glance after focus moves', async () => {
        const previous = storage.getState();
        const store = await import('@/voice/session/voiceSessionStore');
        const accountScope = { serverId: 'server-a', accountId: 'account-a' };
        const targetSessionAddress = { serverId: 'server-a', sessionId: 'failed-session' };
        storage.setState({ profileScope: accountScope });
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        const snapshot = { adapterId: 'local_conversation', sessionId: '__voice_agent__', status: 'connected' as const,
            mode: 'listening' as const, canStop: true };
        store.setVoiceSessionSnapshot(snapshot, null, { accountScope, targetSessionAddress, conversationScope: null });
        store.setVoiceSessionSnapshot({ ...snapshot, status: 'disconnected', mode: 'idle', canStop: false, errorCode: 'provider_error' });
        setFocusedSessionId('other-session', 'server-b');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');
        const hook = await renderHook(() => useVoiceSurfaceTargetState({ pathname: '/', providerId: 'local_conversation',
            sessionId: null, variant: 'sidebar', voice: localVoiceSettings(true) }));
        try {
            expect(hook.getCurrent().startSessionAddress).toEqual(targetSessionAddress);
            expect(hook.getCurrent().bindingScope).toBe('session');
        } finally {
            await hook.unmount();
            store.resetVoiceSessionStoreForTests();
            storage.setState(previous, true);
        }
    });

    it('keeps an explicitly placed in-session surface bound to its exact session when Global is the default', async () => {
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/exact-session',
            providerId: 'local_conversation',
            sessionId: 'exact-session',
            serverId: 'server-a',
            variant: 'session',
            voice: {
                ...localVoiceSettings(true),
                ui: {
                    scopeDefault: 'global',
                    surfaceLocation: 'session',
                },
            },
        }));

        expect(hook.getCurrent().bindingScope).toBe('session');
        expect(hook.getCurrent().startSessionId).toBe('exact-session');
        await hook.unmount();
    });

    it('keeps an in-session Voice surface bound to its rendered Home when another Home is active', async () => {
        registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'local_direct',
            sessionId: 'shared-session',
            serverId: 'server-b',
            variant: 'session',
            voice: localVoiceSettings(false),
        }));

        expect(hook.getCurrent().startSessionAddress).toEqual({
            serverId: 'server-b',
            sessionId: 'shared-session',
        });
        await hook.unmount();
    });

    it('does not reconstruct an in-session Voice target from a bare Session id', async () => {
        registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
        const previousStorageState = storage.getState();
        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                'shared-session': createSessionFixture({
                    id: 'shared-session',
                    serverId: 'server-a',
                    metadata: null,
                }),
            },
        }));
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'local_direct',
            sessionId: 'shared-session',
            serverId: null,
            variant: 'session',
            voice: localVoiceSettings(false),
        }));

        expect(hook.getCurrent().bindingScope).toBe('session');
        expect(hook.getCurrent().startSessionAddress).toBeNull();
        await hook.unmount();
        storage.setState(previousStorageState, true);
    });

    it('treats an explicitly unavailable mounted address as authoritative over legacy qualified props', async () => {
        registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'local_direct',
            sessionAddress: null,
            sessionId: 'shared-session',
            serverId: 'server-a',
            variant: 'session',
            voice: localVoiceSettings(false),
        }));

        expect(hook.getCurrent().startSessionAddress).toBeNull();
        await hook.unmount();
    });

    it('keeps exact-session scope when the voice surface is explicitly placed in the sidebar', async () => {
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        setFocusedSessionId('exact-session', 'server-a');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'local_conversation',
            sessionId: null,
            variant: 'sidebar',
            voice: {
                ...localVoiceSettings(true),
                ui: {
                    scopeDefault: 'session',
                    surfaceLocation: 'sidebar',
                },
            },
        }));

        expect(hook.getCurrent().bindingScope).toBe('session');
        expect(hook.getCurrent().startSessionId).toBe('exact-session');
        await hook.unmount();
    });

    it('prefers the focused visible session over the route session for surface-scoped sidebar targeting', async () => {
        registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
        setFocusedSessionId('split-focused-session', 'server-a');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'local_direct',
            sessionId: null,
            variant: 'sidebar',
            voice: localVoiceSettings(false),
        }));

        expect(hook.getCurrent().startSessionId).toBe('split-focused-session');
        await hook.unmount();
    });

    it('keeps the focused Session Home instead of retargeting Voice through the ambient active Home', async () => {
        registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
        setFocusedSessionId('shared-session', 'server-b');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/shared-session',
            providerId: 'local_direct',
            sessionId: null,
            variant: 'sidebar',
            voice: localVoiceSettings(false),
        }));

        expect(hook.getCurrent().startSessionAddress).toEqual({
            serverId: 'server-b',
            sessionId: 'shared-session',
        });
        await hook.unmount();
    });

    it('resolves a global-scoped Voice Home start independently of focused, routed, last-focused, or tool-target sessions', async () => {
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        setFocusedSessionId('split-focused-session', 'server-a');
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionAddress: { serverId: 'server-a', sessionId: 'tool-target-session' },
            lastFocusedSessionAddress: { serverId: 'server-a', sessionId: 'last-focused-session' },
        });
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'local_conversation',
            sessionId: null,
            variant: 'sidebar',
            voice: localVoiceSettings(true),
        }));

        expect(hook.getCurrent().bindingScope).toBe('global');
        expect(hook.getCurrent().startSessionId).toBe(null);
        expect(hook.getCurrent().targetLabel).toBe(null);
        await hook.unmount();
    });

    it('resolves the exact explicit session surface for a global-capable provider', async () => {
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        setFocusedSessionId('other-focused-session');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/session/route-session',
            providerId: 'local_conversation',
            sessionId: 'exact-session',
            serverId: 'server-a',
            variant: 'session',
            voice: {
                ...localVoiceSettings(true),
                ui: {
                    scopeDefault: 'session',
                    surfaceLocation: 'session',
                },
            },
        }));

        expect(hook.getCurrent().startSessionId).toBe('exact-session');
        await hook.unmount();
    });

    it('allows a second registered realtime provider to declare global start without host edits', async () => {
        const source = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
        if (!source) throw new Error('Second realtime provider contribution unavailable');
        // A second public plugin declaration uses the real vendor activation leaf.
        // The canonical host producer derives capabilities from this admitted input.
        const pluginId = 'acme.voice.second';
        const entry = { ...source, pluginId,
            providerId: buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId: source.declaration.id })),
            declaration: { ...source.declaration, capabilities: { ...source.declaration.capabilities,
                turn: { ...source.declaration.capabilities.turn, bargeIn: true, interruptionPolicy: 'client_two_stage' as const } } } };
        assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
        registerVoiceAdapters(assembly.adapters);
        const sourceSettings = writeVoiceProviderSettingsConfig(voiceSettingsParse({}), source.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
        const voice = voiceSettingsParse({ providerId: entry.providerId,
            providers: { [entry.providerId]: sourceSettings.providers[source.providerId] } });
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/',
            providerId: entry.providerId,
            sessionId: null,
            variant: 'sidebar',
            voice,
        }));

        expect(hook.getCurrent().allowsGlobalStart).toBe(true);
        expect(hook.getCurrent().bargeInEnabled).toBe(true);
        expect(hook.getCurrent().cancelResponseSupported).toBe(false);
        await hook.unmount();
    });

    it('fails global start closed when a configured provider is not registered', async () => {
        const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
        if (!entry) throw new Error('Realtime provider contribution unavailable');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            pathname: '/',
            providerId: entry.providerId,
            sessionId: null,
            variant: 'sidebar',
            voice: { ...writeVoiceProviderSettingsConfig(voiceSettingsParse({}), entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS), providerId: entry.providerId },
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
            providerId: 'local_direct',
            sessionId: null,
            variant: 'sidebar' as const,
            voice: localVoiceSettings(false),
        };
        let unmountHook: (() => Promise<void>) | null = null;

        try {
            registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
            setFocusedSessionId(selectedSessionId, serverId);
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [selectedSessionId]: createSessionFixture({
                        id: selectedSessionId,
                        serverId,
                        metadata: {
                            host: 'surface-host',
                            path: '/surface/raw-selected',
                            summaryText: 'Raw selected summary',
                        },
                    }),
                    [unrelatedSessionId]: createSessionFixture({
                        id: unrelatedSessionId,
                        serverId,
                        metadata: {
                            host: 'surface-host',
                            path: '/surface/raw-unrelated',
                            summaryText: 'Raw unrelated summary',
                        },
                    }),
                },
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [serverId]: {
                        ...(state.sessionListRowsByServerId[serverId] ?? {}),
                        [selectedSessionId]: createSessionListRenderableSessionFixture({
                            id: selectedSessionId,
                            metadata: {
                                host: 'surface-host',
                                path: '/surface/selected',
                                summaryText: 'Preferred selected summary',
                            },
                        }),
                        [unrelatedSessionId]: createSessionListRenderableSessionFixture({
                            id: unrelatedSessionId,
                            metadata: {
                                host: 'surface-host',
                                path: '/surface/unrelated',
                                summaryText: 'Preferred unrelated summary',
                            },
                        }),
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

            // Voice privacy limits what the provider is told, never what this device shows its own
            // user: the label is the Session's display name, never a redacted placeholder (R12a).

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
            expect(hook.getCurrent().targetLabel).toBe('Raw selected summary');

            await act(async () => {
                storage.setState((state) => {
                    const sessions = { ...state.sessions };
                    delete sessions[selectedSessionId];
                    return { ...state, sessions };
                });
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            // Not on this device: no invented name.
            expect(hook.getCurrent().targetLabel).toBe(null);

        } finally {
            await unmountHook?.();
            await act(async () => {
                storage.setState(previousStorageState);
            });
        }
    });
});
