import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { VOICE_SETTINGS_PROVIDER_FOCUS_TARGET } from '@/voice/settings/voiceSettingsRouteFocus';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { t } from '@/text';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import type { VoiceAttemptIdleTarget } from './useVoiceAttemptControl';

const featureState = vi.hoisted(() => ({ current: {} as Record<string, boolean> }));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureState.current[featureId] ?? true,
}));

vi.mock('@/voice/agent/getVoiceAgentSessionTeleportAvailability', () => ({
    getVoiceAgentSessionTeleportAvailability: () => ({ ok: false }),
}));

const connectedServices = vi.hoisted(() => ({
    snapshot: { entries: [] as readonly ConnectedServiceRegistryEntry[] },
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => connectedServices.snapshot,
}));

const recoveryRuntime = vi.hoisted(() => ({
    serverId: 'server-work',
    machineId: 'machine-work',
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: recoveryRuntime.serverId,
        serverUrl: '',
        generation: 1,
    }),
}));

vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
    useVoiceExecutionMachinePresentation: () => ({
        machineId: recoveryRuntime.machineId,
        machineLabel: 'Work machine',
    }),
}));

const platformState = vi.hoisted(() => ({
    os: 'web',
    openSettings: vi.fn(async () => undefined),
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Linking: { ...actual.Linking, openSettings: platformState.openSettings },
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

const routerMock = vi.hoisted(() => ({ instance: null as { spies: { push: { mock: { calls: unknown[][] } } } } | null }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({ pathname: () => '/' });
    routerMock.instance = mock as never;
    return mock.module;
});

const initialStorageState = getStorage().getState();

/** A registered adapter is what publishes `allowsGlobalStart` to both owners. */
function createGlobalStartAdapter(
    id: string,
    overrides: Partial<Readonly<{
        requiresVoiceAgentFeature: boolean;
        allowsGlobalStart: boolean;
        cancelResponse: 'unsupported' | 'immediate';
        agentRuntime: Readonly<{ pluginId: string; localId: string }>;
    }>> = {},
): VoiceAdapterController {
    return {
        id,
        engineKind: 'realtime',
        start: async () => undefined,
        stop: async () => undefined,
        toggle: async () => undefined,
        interrupt: async () => undefined,
        bargeIn: async () => undefined,
        setMuted: async () => undefined,
        sendContextUpdate: () => undefined,
        getSnapshot: () => ({
            adapterId: id,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart: overrides.allowsGlobalStart ?? true,
            controlSessionScope: 'global',
            requiresVoiceAgentFeature: overrides.requiresVoiceAgentFeature ?? false,
            bargeInEnabled: false,
            cancelResponse: overrides.cancelResponse ?? 'unsupported',
            ...(overrides.agentRuntime ? { agentRuntime: overrides.agentRuntime } : {}),
        }),
    } as VoiceAdapterController;
}

function seedVoiceSettings(voice: unknown): void {
    getStorage().setState((state: any) => ({
        ...state,
        isDataReady: true,
        settings: { ...state.settings, voice },
    }));
}

/** The sidebar Horizon vessel's scope, so both owners are asked the same question. */
const GLOBAL_TARGET: VoiceAttemptIdleTarget = { kind: 'global' };

async function renderBothOwners() {
    const { useVoiceSurfaceModel } = await import('@/components/voice/surface/useVoiceSurfaceModel');
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    return await renderHook(() => ({
        model: useVoiceSurfaceModel({ variant: 'sidebar' } as any),
        control: useVoiceAttemptControl(GLOBAL_TARGET),
    }));
}

/**
 * §5.6 / the split-brain rule — start admission has exactly one owner, projected into Horizon and
 * the placement-free surfaces through the same attempt control. A second answer would offer a
 * Start the lifecycle owner refuses — a dead transport, which §2.2 forbids outright.
 *
 * `controlsDisabled` is the model's admission read through its public seam: with nothing running
 * (`canStop === false`) it is exactly `!canStart`.
 */
describe('useVoiceAttemptControl start admission', () => {
    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
    });

    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        getStorage().setState(initialStorageState, true);
    });

    it('refuses a start the surface model refuses when the connected-services reference is missing', async () => {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([createGlobalStartAdapter('happier.agent.codex/realtime-codex')]);
        // Provider selected, but its connected-services reference was never chosen: the surface
        // keeps it visible for remediation and refuses the start.
        seedVoiceSettings({
            providerId: 'happier.agent.codex/realtime-codex',
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
        });

        const hook = await renderBothOwners();
        const { model, control } = hook.getCurrent();

        expect(model).not.toBeNull();
        expect(model!.controlsDisabled).toBe(true);
        expect(control.canStart).toBe(false);

        await hook.unmount();
    });

    it('refuses a start the surface model refuses when the daemon voice agent is unavailable', async () => {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([
            createGlobalStartAdapter('local_conversation', { requiresVoiceAgentFeature: true }),
        ]);
        featureState.current = { 'voice.agent': false };
        seedVoiceSettings({
            providerId: 'local_conversation',
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            },
        });

        const hook = await renderBothOwners();
        const { model, control } = hook.getCurrent();

        expect(model).not.toBeNull();
        expect(model!.controlsDisabled).toBe(true);
        expect(control.canStart).toBe(false);

        await hook.unmount();
    });

    it('admits the start both owners agree on', async () => {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([createGlobalStartAdapter('local_conversation')]);
        seedVoiceSettings({
            providerId: 'local_conversation',
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            },
        });

        const hook = await renderBothOwners();
        const { model, control } = hook.getCurrent();

        expect(model).not.toBeNull();
        expect(model!.controlsDisabled).toBe(false);
        expect(control.canStart).toBe(true);
        expect(control.availability).toBe('ready');

        await hook.unmount();
    });
});

/**
 * The configured provider names the **next** idle admission; the published snapshot's `adapterId`
 * names the attempt running right now. Presentation must follow the attempt, because the lifecycle
 * owner keeps the source adapter live until its hand-off observes a disconnect — so a surface that
 * followed the selection would hide a still-open microphone (deleting its own Stop control) and
 * would project the newly selected provider's capabilities onto someone else's attempt.
 */
describe('presentation follows the running attempt, not the next selection', () => {
    const RUNNING_PROVIDER_ID = 'local_conversation';
    const NEXT_PROVIDER_ID = 'happier.agent.codex/realtime-codex';

    async function seedRunningAttempt() {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        registerVoiceAdapters([
            createGlobalStartAdapter(RUNNING_PROVIDER_ID, { cancelResponse: 'immediate' }),
            createGlobalStartAdapter(NEXT_PROVIDER_ID, { cancelResponse: 'unsupported' }),
        ]);
        seedVoiceSettings({
            providerId: RUNNING_PROVIDER_ID,
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            },
        });
        // Mid-turn: the assistant is thinking, so the attempt owns a cancellable response.
        setVoiceSessionSnapshot({
            adapterId: RUNNING_PROVIDER_ID,
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connected',
            mode: 'thinking',
            canStop: true,
        } as any);
    }

    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
    });

    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        registerVoiceAdapters([]);
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
        getStorage().setState(initialStorageState, true);
    });

    it('keeps a live attempt visible and stoppable after the selection changes to Off', async () => {
        await seedRunningAttempt();
        const hook = await renderBothOwners();
        expect(hook.getCurrent().model).not.toBeNull();

        await act(async () => {
            seedVoiceSettings({
                providerId: 'off',
                ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            });
        });

        // Off selects the next idle admission. It does not retire the running attempt, so hiding
        // the surface would leave the microphone open with nothing left to stop it.
        expect(hook.getCurrent().model).not.toBeNull();
        expect(hook.getCurrent().model!.canCancelTurn).toBe(true);
        expect(hook.getCurrent().control.canStop).toBe(true);

        await hook.unmount();
    });

    it('keeps the running provider capabilities after a different provider is selected', async () => {
        await seedRunningAttempt();
        const hook = await renderBothOwners();
        expect(hook.getCurrent().model!.canCancelTurn).toBe(true);

        await act(async () => {
            seedVoiceSettings({
                providerId: NEXT_PROVIDER_ID,
                ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            });
        });

        // The newly selected provider cannot cancel a response; the one actually running can.
        expect(hook.getCurrent().model).not.toBeNull();
        expect(hook.getCurrent().model!.canCancelTurn).toBe(true);
        expect(hook.getCurrent().control.canStop).toBe(true);

        await hook.unmount();
    });
});

/**
 * C1 parity — an external provider must reach the surface exactly like a built-in one.
 *
 * The selected provider is resolved through the same registry a plugin registers into, and that
 * registry is only populated once the plugin's runtime activates — after the first render on a cold
 * boot. Without a subscription to the registry's own revision the surface keeps its first answer
 * forever, so a persisted external selection stays permanently unrunnable until some unrelated
 * render happens to refresh it.
 */
describe('external provider registration reaches the surface', () => {
    const externalToken = Object.freeze({});
    const EXTERNAL_PROVIDER_ID = 'acme.voice.demo/realtime-demo';

    function externalDescriptor() {
        return {
            kind: 'voice.conversation-provider.v1' as const,
            pluginId: 'acme.voice.demo',
            providerId: EXTERNAL_PROVIDER_ID,
            settingsSectionId: 'voice.acme-demo',
            roles: [] as never[],
            requirements: [] as never[],
            source: { kind: 'external' as const, pluginId: 'acme.voice.demo', localId: 'realtime-demo' },
            projectSettings: () => ({ status: 'ready' as const, modeId: 'byo' }),
        };
    }

    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
    });

    afterEach(async () => {
        const { removeExternalVoiceProviderRegistration } = await import(
            '@/voice/registry/externalVoiceProviderRegistrations'
        );
        await act(async () => {
            removeExternalVoiceProviderRegistration(externalToken);
        });
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        getStorage().setState(initialStorageState, true);
    });

    it('becomes available when the plugin registers, with no unrelated rerender', async () => {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } =
            await import('@/voice/registry/externalVoiceProviderRegistrations');
        registerVoiceAdapters([createGlobalStartAdapter(EXTERNAL_PROVIDER_ID)]);
        seedVoiceSettings({
            providerId: EXTERNAL_PROVIDER_ID,
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
        });

        const hook = await renderBothOwners();
        // Cold boot: the plugin runtime has not registered its provider yet.
        expect(hook.getCurrent().model).toBeNull();

        await act(async () => {
            commitExternalVoiceProviderRegistration(Object.freeze({
                token: externalToken,
                pluginId: 'acme.voice.demo',
                localId: 'realtime-demo',
                providerId: EXTERNAL_PROVIDER_ID,
                descriptor: externalDescriptor() as never,
                adapter: null,
            }));
        });

        expect(hook.getCurrent().model).not.toBeNull();
        expect(hook.getCurrent().control.canStart).toBe(true);

        // Withdrawal is the same authority in the other direction.
        await act(async () => {
            removeExternalVoiceProviderRegistration(externalToken);
        });
        expect(hook.getCurrent().model).toBeNull();
        expect(hook.getCurrent().control.canStart).toBe(false);

        await hook.unmount();
    });
});

/**
 * §2.2 — the availability ladder has three rungs, and the middle one is the whole point.
 *
 * A provider the user selected but has not finished connecting cannot start, and it publishes no
 * `errorRecoveryAction` because nothing has failed yet — nothing was ever attempted. Reading that
 * as terminally unavailable renders **no transport at all**: the orb and the composer planet
 * silently disappear, and the one affordance that would fix the situation disappears with them.
 *
 * `recoverable` is the truthful answer there: the transport stays, and a tap opens the setup screen
 * through the same `onRecover` dispatch Horizon uses (§5.5) rather than a second recovery decision.
 */
describe('useVoiceAttemptControl availability ladder', () => {
    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        routerMock.instance?.spies.push.mock.calls.splice(0);
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
    });

    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        getStorage().setState(initialStorageState, true);
    });

    async function renderIncompleteSetup() {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([createGlobalStartAdapter('happier.agent.codex/realtime-codex')]);
        // The same seed as the admission test above: a provider is selected, its connected-services
        // reference was never chosen, and no attempt has failed.
        seedVoiceSettings({
            providerId: 'happier.agent.codex/realtime-codex',
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
        });
        return await renderBothOwners();
    }

    it('stays present and recoverable when the selected provider is not finished being set up', async () => {
        const hook = await renderIncompleteSetup();
        const { control } = hook.getCurrent();

        expect(control.canStart).toBe(false);
        // Not 'unavailable': the orb must not vanish on a problem the user can fix.
        expect(control.availability).toBe('recoverable');
        expect(control.primaryAction).toBe('recover');
        expect(control.primaryActionLabel).toBe(t('modals.openSettings'));
        expect(control.captionLabel).toBe(t('modals.openSettings'));

        await hook.unmount();
    });

    it('routes that recovery to the canonical Voice provider-focus screen', async () => {
        const hook = await renderIncompleteSetup();

        hook.getCurrent().control.onPrimaryAction();

        expect(routerMock.instance?.spies.push.mock.calls.map((call) => call[0]))
            .toContainEqual(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);

        await hook.unmount();
    });

    it('is still terminally unavailable when the refusal is not a setup the user can finish', async () => {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([
            createGlobalStartAdapter('local_conversation', { requiresVoiceAgentFeature: true }),
        ]);
        // A server feature the Voice settings screen cannot switch on. Sending the user there would
        // be a transport that still cannot do anything — exactly what the third rung exists for.
        featureState.current = { 'voice.agent': false };
        seedVoiceSettings({
            providerId: 'local_conversation',
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            },
        });

        const hook = await renderBothOwners();

        expect(hook.getCurrent().control.availability).toBe('unavailable');

        await hook.unmount();
    });
});

/**
 * Recovery routing belongs to the placement-free attempt projection. Horizon used to replace its
 * `onRecover` callback locally while Orb and composer kept the generic Voice-settings fallback,
 * which made one error land in two different places depending on which surface the user touched.
 */
describe('useVoiceAttemptControl recovery routing', () => {
    const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';
    const CODEX_RUNTIME = Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'codex',
    });
    const CONNECTED_SERVICE_ENTRY: ConnectedServiceRegistryEntry = {
        serviceId: 'openai-codex',
        service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        },
        // The projected entry for a released adapter carries its legacy service id; the canonical
        // account-route resolver refuses to build a route for an entry that does not.
        legacyServiceId: 'openai-codex',
        connectCommand: 'happier connect acme.connected-accounts/codex-account',
        supportsOauth: true,
        executable: true,
    };
    const SELECTED_PROFILE_VOICE_SETTINGS = {
        providerId: CODEX_PROVIDER_ID,
        ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
        providers: {
            [CODEX_PROVIDER_ID]: {
                schemaVersion: 2,
                config: {
                    globalConnectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'account-work',
                            },
                        },
                    },
                },
            },
        },
    } as const;

    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        connectedServices.snapshot = { entries: [] };
        platformState.os = 'web';
        platformState.openSettings.mockClear();
        routerMock.instance?.spies.push.mock.calls.splice(0);
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
    });

    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        connectedServices.snapshot = { entries: [] };
        getStorage().setState(initialStorageState, true);
    });

    async function renderBothRecoveryOwners(recoveryAction: 'connect_agent' | 'update_agent_runtime' | 'open_settings') {
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        registerVoiceAdapters([createGlobalStartAdapter(CODEX_PROVIDER_ID, { agentRuntime: CODEX_RUNTIME })]);
        seedVoiceSettings(SELECTED_PROFILE_VOICE_SETTINGS);
        setVoiceSessionSnapshot({
            adapterId: CODEX_PROVIDER_ID,
            sessionId: 'voice-control-session',
            status: 'error',
            mode: 'idle',
            canStop: false,
            errorRecoveryAction: recoveryAction,
            errorPresentation: 'error',
        } as never);
        return await renderBothOwners();
    }

    it('sends the same selected-profile Connect recovery from Horizon and placement-free consumers', async () => {
        connectedServices.snapshot = { entries: [CONNECTED_SERVICE_ENTRY] };
        const hook = await renderBothRecoveryOwners('connect_agent');
        const expectedRoute = {
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'account-work',
            },
        };

        hook.getCurrent().control.onRecover();
        expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toEqual(expectedRoute);

        routerMock.instance?.spies.push.mock.calls.splice(0);
        hook.getCurrent().model?.attemptControl.onRecover();
        expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toEqual(expectedRoute);

        await hook.unmount();
    });

    it('sends Agent runtime update recovery to the fully qualified update target from every placement', async () => {
        const hook = await renderBothRecoveryOwners('update_agent_runtime');
        const expectedRoute = {
            pathname: '/(app)/settings/agents/[agentId]',
            params: {
                agentId: 'codex',
                pluginId: 'happier.agent.codex',
                machineId: 'machine-work',
                serverId: 'server-work',
                installIntent: 'update',
            },
        };

        hook.getCurrent().control.onRecover();
        expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toEqual(expectedRoute);

        routerMock.instance?.spies.push.mock.calls.splice(0);
        hook.getCurrent().model?.attemptControl.onRecover();
        expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toEqual(expectedRoute);

        await hook.unmount();
    });

    it('opens native platform settings through the same recovery command', async () => {
        platformState.os = 'ios';
        const hook = await renderBothRecoveryOwners('open_settings');

        hook.getCurrent().control.onRecover();
        await vi.waitFor(() => {
            expect(platformState.openSettings).toHaveBeenCalledTimes(1);
        });

        await hook.unmount();
    });
});

/**
 * The Orb and Horizon are two placements of the same attempt, so microphone truth and the
 * placement-neutral caption must be projected once here. In particular, `muted === false` does
 * not mean capture is open: a half-duplex provider closes its input while output is speaking.
 */
describe('useVoiceAttemptControl capture and caption projection', () => {
    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([createGlobalStartAdapter('local_conversation')]);
        seedVoiceSettings({
            providerId: 'local_conversation',
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            },
        });
    });

    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        getStorage().setState(initialStorageState, true);
    });

    async function renderControl(snapshot: Readonly<Record<string, unknown>>) {
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot(snapshot as never);
        const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
        const { VoiceEnergyAppProvider } = await import('@/components/voice/light/VoiceEnergyAppProvider');
        function VoiceEnergyHookTestProvider(props: React.PropsWithChildren): React.ReactElement {
            return <VoiceEnergyAppProvider>{props.children}</VoiceEnergyAppProvider>;
        }
        return await renderHook(
            () => useVoiceAttemptControl(GLOBAL_TARGET),
            { wrapper: VoiceEnergyHookTestProvider },
        );
    }

    it('projects an unmuted but capture-closed attempt truthfully', async () => {
        const hook = await renderControl({
            adapterId: 'local_conversation',
            sessionId: 'control-1',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
            micMuted: false,
        });

        expect(hook.getCurrent().muted).toBe(false);
        expect(hook.getCurrent().capturing).toBe(false);
        expect(hook.getCurrent().micStateLabel).toBe(t('voiceSurface.a11y.microphoneInactive'));
        expect(hook.getCurrent().captionLabel).toBe(t('voiceSurface.a11y.microphoneInactive'));

        let writer: ReturnType<typeof voiceRuntimeLevelStore.open> | null = null;
        await act(async () => {
            writer = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'attempt-control-test' });
        });
        expect(hook.getCurrent().capturing).toBe(true);
        expect(hook.getCurrent().micStateLabel).toBe(t('voiceSurface.a11y.microphoneActive'));

        await act(async () => {
            writer?.close();
        });
        await hook.unmount();
    });

    it('keeps ready and connecting captions placement-neutral and privacy-safe', async () => {
        const ready = await renderControl({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
            micMuted: false,
        });
        expect(ready.getCurrent().captionLabel).toBe(t('voiceSurface.a11y.microphoneInactive'));
        await ready.unmount();

        const connecting = await renderControl({
            adapterId: 'local_conversation',
            sessionId: 'control-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
            micMuted: false,
        });
        expect(connecting.getCurrent().surfaceState).toBe('connecting');
        expect(connecting.getCurrent().captionLabel).toBe(t('voiceSurface.a11y.microphoneInactive'));
        await connecting.unmount();
    });
});

/**
 * §2.5 — targeting is **explicit at the call site and never inferred**.
 *
 * The projection hardcoded Global. That is right for the orb and for New Session, and wrong for the
 * composer of an existing session: pressing its planet opened a conversation bound to nothing while
 * the user was looking at the session they meant to talk about. The idle target is now the caller's
 * statement of which conversation a *start* creates — and nothing else. Once an attempt is running
 * every surface mirrors and settles that exact attempt, so the idle target must not reach `stop`.
 */
describe('useVoiceAttemptControl idle targeting', () => {
    const READY_LOCAL_CONVERSATION = {
        providerId: 'local_conversation',
        ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
        providers: {
            local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
        },
    } as const;

    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([createGlobalStartAdapter('local_conversation')]);
        seedVoiceSettings(READY_LOCAL_CONVERSATION);
    });

    afterEach(async () => {
        standardCleanup();
        vi.restoreAllMocks();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        getStorage().setState(initialStorageState, true);
    });

    async function renderControl(idleTarget: VoiceAttemptIdleTarget) {
        const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
        return await renderHook(() => useVoiceAttemptControl(idleTarget));
    }

    async function spyOnLifecycleRouting() {
        const { voiceSessionManager } = await import('@/voice/session/voiceSession');
        return {
            toggle: vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined),
            stop: vi.spyOn(voiceSessionManager, 'stop').mockResolvedValue(undefined),
        };
    }

    it('starts Global when the caller states the global idle target', async () => {
        const routing = await spyOnLifecycleRouting();
        const hook = await renderControl({ kind: 'global' });

        expect(hook.getCurrent().canStart).toBe(true);
        hook.getCurrent().onToggle();

        // The empty session id is the canonical global/hidden-owner start.
        expect(routing.toggle).toHaveBeenCalledWith('');

        await hook.unmount();
    });

    it('starts the exact session the caller states', async () => {
        const routing = await spyOnLifecycleRouting();
        const hook = await renderControl({ kind: 'session', sessionId: 'session-42' });

        expect(hook.getCurrent().canStart).toBe(true);
        hook.getCurrent().onToggle();

        expect(routing.toggle).toHaveBeenCalledWith('session-42');

        await hook.unmount();
    });

    it('settles the running attempt’s own session, not the idle target and not Global', async () => {
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'attempt-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        } as any);
        const routing = await spyOnLifecycleRouting();
        // A session-bound surface whose own session is *not* the running attempt's: the attempt is
        // immutable, so the surface controls that one rather than retargeting it.
        const hook = await renderControl({ kind: 'session', sessionId: 'session-42' });

        expect(hook.getCurrent().canStop).toBe(true);
        hook.getCurrent().onToggle();

        expect(routing.stop).toHaveBeenCalledWith('attempt-session');
        expect(routing.toggle).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('opens the exact conversation bound to the active attempt, not the idle target', async () => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        routerMock.instance?.spies.push.mock.calls.splice(0);
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'active-control-session',
            conversationSessionId: 'active-conversation-session',
            lifetime: 'runtime_attempt',
            transcriptMode: 'native_session',
            targetSessionId: 'active-conversation-session',
            updatedAt: 42,
        });
        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'active-control-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        } as any);

        // The surface's idle target deliberately names a different session. Once an attempt is
        // active, opening the Orb must follow its immutable canonical binding instead.
        const hook = await renderControl({ kind: 'session', sessionId: 'idle-target-session' });

        expect(hook.getCurrent().openConversationSessionId).toBe('active-conversation-session');
        hook.getCurrent().onOpenConversation();
        expect(routerMock.instance?.spies.push.mock.calls.map((call) => call[0]))
            .toContain('/session/active-conversation-session');

        await hook.unmount();
        voiceSessionBindingStore.getState().unbind('active-conversation-session');
    });
});

/**
 * An adapter reports a connection failure through the canonical lifecycle snapshot before its
 * Start promise rejects. The attempt control is the real fire-and-forget consumer shared by the
 * orb, the composer, and Horizon, so it must leave that already-visible recovery unobscured while
 * preserving unexpected rejections for diagnostics.
 */
describe('useVoiceAttemptControl terminal connection failures', () => {
    const PROVIDER_ID = 'local_conversation';

    beforeEach(async () => {
        const { resetVoiceSessionRuntimeStateForTests } = await import('@/voice/session/voiceSessionStore');
        await resetVoiceSessionRuntimeStateForTests();
        getStorage().setState(initialStorageState, true);
        featureState.current = { 'voice.agent': true };
        seedVoiceSettings({
            providerId: PROVIDER_ID,
            ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
            providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            },
        });
    });

    afterEach(async () => {
        standardCleanup();
        const { resetVoiceSessionRuntimeStateForTests } = await import('@/voice/session/voiceSessionStore');
        await resetVoiceSessionRuntimeStateForTests();
        getStorage().setState(initialStorageState, true);
        vi.restoreAllMocks();
    });

    function createStartFailureAdapter(start: (input: Readonly<{
        sessionId: string;
        publish: (snapshot: VoiceSessionSnapshot) => void;
    }>) => Promise<void>): VoiceAdapterController {
        let snapshot: VoiceSessionSnapshot = {
            adapterId: PROVIDER_ID,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        const listeners = new Set<() => void>();
        const publish = (next: VoiceSessionSnapshot) => {
            snapshot = next;
            for (const listener of listeners) listener();
        };

        return {
            id: PROVIDER_ID,
            engineKind: 'realtime',
            start: async ({ sessionId }) => {
                await start({ sessionId, publish });
            },
            stop: async () => undefined,
            toggle: async () => undefined,
            interrupt: async () => undefined,
            bargeIn: async () => undefined,
            setMuted: async () => undefined,
            sendContextUpdate: () => undefined,
            getSnapshot: () => snapshot,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            resolveSurfaceCapabilities: () => ({
                allowsGlobalStart: true,
                controlSessionScope: 'global',
                requiresVoiceAgentFeature: false,
                bargeInEnabled: false,
                cancelResponse: 'unsupported',
            }),
        } satisfies VoiceAdapterController;
    }

    async function renderWithLifecycle(adapter: VoiceAdapterController) {
        const [
            { getVoiceAdapterRegistry, registerVoiceAdapters },
            { createVoiceSessionLifecycleController },
            { setVoiceSessionLifecycleController },
            { setVoiceSessionSnapshot },
        ] = await Promise.all([
            import('@/voice/session/voiceAdapterRegistry'),
            import('@/voice/session/voiceSessionLifecycleController'),
            import('@/voice/session/voiceSessionLifecycleControllerStore'),
            import('@/voice/session/voiceSessionStore'),
        ]);
        registerVoiceAdapters([adapter]);
        const controller = createVoiceSessionLifecycleController({
            getRegistry: getVoiceAdapterRegistry,
        });
        controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        setVoiceSessionLifecycleController(controller);
        controller.setConfiguredProviderId(PROVIDER_ID);
        setVoiceSessionSnapshot(controller.getSnapshot());
        const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
        return await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));
    }

    it('offers Retry during an owned reconnect backoff and routes it without restarting the session', async () => {
        const retry = vi.fn(async () => undefined);
        const start = vi.fn(async () => undefined);
        const adapter: VoiceAdapterController = {
            id: PROVIDER_ID,
            engineKind: 'realtime',
            start,
            stop: async () => undefined,
            toggle: async () => undefined,
            retry,
            interrupt: async () => undefined,
            bargeIn: async () => undefined,
            setMuted: async () => undefined,
            sendContextUpdate: () => undefined,
            getSnapshot: () => ({
                adapterId: PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'connecting',
                mode: 'idle',
                canStop: true,
                presentationState: 'reconnecting',
                reconnectRetryAvailable: true,
            }),
            subscribe: () => () => {},
            resolveSurfaceCapabilities: () => ({
                allowsGlobalStart: true,
                controlSessionScope: 'global',
                requiresVoiceAgentFeature: false,
                bargeInEnabled: false,
                cancelResponse: 'unsupported',
            }),
        };
        const hook = await renderWithLifecycle(adapter);

        await vi.waitFor(() => {
            expect(hook.getCurrent().recoveryAvailable).toBe(true);
        });
        expect(hook.getCurrent().recoveryLabel).toBe(t('common.retry'));

        await act(async () => {
            hook.getCurrent().onRecover();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(retry).toHaveBeenCalledWith({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
        });
        expect(start).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps a published connection failure recoverable without logging through fire-and-forget', async () => {
        const connectionFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        const startSessionIds: string[] = [];
        const adapter = createStartFailureAdapter(async ({ sessionId, publish }) => {
            startSessionIds.push(sessionId);
            publish({
                adapterId: PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'connecting',
                mode: 'idle',
                canStop: true,
            });
            publish({
                adapterId: PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            });
            throw connectionFailure;
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderWithLifecycle(adapter);

        await act(async () => {
            hook.getCurrent().onToggle();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(hook.getCurrent().primaryAction).toBe('recover');
        });
        expect(hook.getCurrent().recoveryLabel).toBe(t('common.retry'));
        await act(async () => {
            hook.getCurrent().onRecover();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(startSessionIds).toEqual(['', VOICE_AGENT_GLOBAL_SESSION_ID]);
        });
        expect(consoleError.mock.calls.some(([entry]) =>
            String(entry).includes('[fireAndForget] VoiceAttemptControl.'),
        )).toBe(false);

        await hook.unmount();
    });

    it('still sends an unannounced start rejection to fire-and-forget diagnostics', async () => {
        const unexpectedFailure = new Error('unexpected_start_bug');
        const adapter = createStartFailureAdapter(async () => {
            throw unexpectedFailure;
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderWithLifecycle(adapter);

        await act(async () => {
            hook.getCurrent().onToggle();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                '[fireAndForget] VoiceAttemptControl.toggle',
                unexpectedFailure,
            );
        });

        await hook.unmount();
    });

    it('still sends a mismatched rejection to diagnostics after the retry recovery is rendered', async () => {
        const unexpectedFailure = Object.assign(new Error('unexpected_start_bug'), {
            code: 'unexpected_start_bug',
        });
        const adapter = createStartFailureAdapter(async ({ publish }) => {
            publish({
                adapterId: PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'connecting',
                mode: 'idle',
                canStop: true,
            });
            publish({
                adapterId: PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            });
            throw unexpectedFailure;
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderWithLifecycle(adapter);

        await act(async () => {
            hook.getCurrent().onToggle();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(hook.getCurrent().primaryAction).toBe('recover');
        });
        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                '[fireAndForget] VoiceAttemptControl.toggle',
                unexpectedFailure,
            );
        });

        await hook.unmount();
    });
});
