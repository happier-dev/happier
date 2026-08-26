import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { storage } from '@/sync/domains/state/storage';
import { resolveDisabledVoiceActionIdsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';

import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

type VoiceAdapterRegistry = Readonly<{
    get: (id: string) => VoiceAdapterController | null;
    list: () => ReadonlyArray<VoiceAdapterController>;
    subscribe?: (listener: () => void) => () => void;
}>;

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy } }));

afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
});

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

function createAdapter(params: Readonly<{
    id: string;
    snapshot: VoiceSessionSnapshot;
    engineKind?: VoiceAdapterController['engineKind'];
    freshSnapshots?: boolean;
    retry?: () => Promise<void>;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
}>): Readonly<{
    controller: VoiceAdapterController;
    setSnapshot: (snapshot: VoiceSessionSnapshot) => void;
    stop: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
    bargeIn: ReturnType<typeof vi.fn>;
    listenerCount: () => number;
}> {
    let snapshot = params.snapshot;
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) {
            listener();
        }
    };
    const start = vi.fn(async () => {
        if (params.start) {
            await params.start();
        }
    });
    const stop = vi.fn(async () => {
        if (params.stop) {
            await params.stop();
        }
    });
    const retry = vi.fn(async () => {
        if (params.retry) {
            await params.retry();
        }
    });
    const toggle = vi.fn(async () => {});
    const bargeIn = vi.fn(async () => {});

    return {
        controller: {
            id: params.id,
            engineKind: params.engineKind ?? 'realtime',
            start,
            stop,
            toggle,
            retry,
            interrupt: vi.fn(async () => {}),
            bargeIn,
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(() => {}),
            getSnapshot: () => params.freshSnapshots ? { ...snapshot } : snapshot,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        },
        setSnapshot: (next: VoiceSessionSnapshot) => {
            snapshot = next;
            notify();
        },
        stop,
        start,
        retry,
        toggle,
        bargeIn,
        listenerCount: () => listeners.size,
    };
}

describe('createVoiceSessionLifecycleController', () => {
    it('reports the configured provider consumed by the lifecycle owner', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: () => null,
            list: () => [],
        }) });

        expect(controller.getConfiguredProviderId()).toBeNull();
        controller.setConfiguredProviderId('local_conversation');
        expect(controller.getConfiguredProviderId()).toBe('local_conversation');
    });

    it('publishes a current retryable unavailability outcome when the selected provider withdraws before Start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const captureAdmission = createVoiceCaptureAdmissionController();
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        let registered = true;
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => ({
                get: (id) => registered && id === adapter.controller.id ? adapter.controller : null,
                list: () => registered ? [adapter.controller] : [],
            }),
        });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        registered = false;
        const published = vi.fn();
        const unsubscribe = controller.subscribe(published);

        try {
            await controller.toggle('session-1');

            expect(adapter.start).not.toHaveBeenCalled();
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'service_temporarily_unavailable',
                errorMessage: 'voice_provider_adapter_not_registered',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            });
            expect(published).toHaveBeenCalledTimes(1);

            // The lifecycle refusal happens before Start, so it cannot retain
            // capture admission while the selected provider is unavailable.
            const dictationAdmission = captureAdmission.acquire('dictation');
            expect(dictationAdmission).toMatchObject({ status: 'acquired' });
            if (dictationAdmission.status === 'acquired') dictationAdmission.lease.release();

            controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
            expect(controller.getSnapshot()).toEqual({
                adapterId: null,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
        } finally {
            unsubscribe();
            await controller.dispose();
        }
    });

    it('stays silent when Voice is switched off rather than misreporting a refusal', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: () => null,
            list: () => [],
        }) });
        controller.setConfiguredProviderId('off');
        logSpy.mockClear();

        await controller.toggle('session-1');

        expect(logSpy.mock.calls.map((call) => String(call[0])).filter(
            (line) => line.includes('[voiceRuntimeFailure]'),
        )).toEqual([]);
    });

    it('publishes the configured provider recoverable error after it disconnects', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const deniedSnapshot: VoiceSessionSnapshot = {
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
            errorCode: 'mic_permission_denied',
            errorMessage: 'mic_permission_denied',
            errorRecoveryAction: 'open_settings',
            errorPresentation: 'permission_required',
        };
        const configured = createAdapter({
            id: 'local_conversation',
            snapshot: deniedSnapshot,
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === configured.controller.id ? configured.controller : null,
            list: () => [configured.controller],
        }) });

        controller.setConfiguredProviderId('local_conversation');
        controller.rearmAfterCredentialAuthorityChange();

        expect(controller.getSnapshot()).toEqual(deniedSnapshot);
    });

    it('does not let a terminal error from the previous provider override the newly configured provider', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previous = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'provider_auth_invalid',
                errorMessage: 'credential_unavailable',
                errorRecoveryAction: 'review_credentials',
                errorPresentation: 'error',
            },
        });
        const configured = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => {
                if (id === previous.controller.id) return previous.controller;
                if (id === configured.controller.id) return configured.controller;
                return null;
            },
            list: () => [previous.controller, configured.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: OPENAI_PROVIDER_ID,
            status: 'error',
            errorCode: 'provider_auth_invalid',
        });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);

        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(previous.start).not.toHaveBeenCalled();
        expect(previous.stop).not.toHaveBeenCalled();
        expect(configured.start).not.toHaveBeenCalled();
        expect(configured.stop).not.toHaveBeenCalled();
    });

    it('rearms only a terminal provider-auth failure and waits for the next explicit start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const authFailure: VoiceSessionSnapshot = {
            adapterId: OPENAI_PROVIDER_ID,
            sessionId: 'session-1',
            status: 'error',
            mode: 'idle',
            canStop: false,
            errorCode: 'provider_auth_invalid',
            errorMessage: 'credential_unavailable',
            errorRecoveryAction: 'review_credentials',
            errorPresentation: 'error',
        };
        const configured = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: authFailure,
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === configured.controller.id ? configured.controller : null,
            list: () => [configured.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange();

        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(configured.start).not.toHaveBeenCalled();
        expect(configured.stop).not.toHaveBeenCalled();

        await controller.toggle('session-2');
        expect(configured.start).toHaveBeenCalledWith({ sessionId: 'session-2' });

        configured.setSnapshot(authFailure);
        expect(controller.getSnapshot()).toEqual(authFailure);
    });

    it('fences an active attachment when its credential authority changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: 'global-voice-home',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === active.controller.id ? active.controller : null,
            list: () => [active.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });

        expect(active.stop).toHaveBeenCalledOnce();
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'global-voice-home' });
        expect(active.start).not.toHaveBeenCalled();
    });

    it('keeps a connecting ordinary attachment when the change applies only to the next start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connecting = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'voice-session',
                status: 'connecting',
                mode: 'idle',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === connecting.controller.id ? connecting.controller : null,
            list: () => [connecting.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: false,
        });

        expect(connecting.stop).not.toHaveBeenCalled();
    });

    it('keeps in-flight ordinary preparation when the change applies only to the next start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await startDeferred.promise;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === preparing.controller.id ? preparing.controller : null,
            list: () => [preparing.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        const preparation = controller.toggle('voice-session');
        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: false,
        });

        expect(preparing.stop).not.toHaveBeenCalled();

        startDeferred.resolve();
        await preparation;
    });

    it('fences a connecting attachment when its exact credential authority changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connecting = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                status: 'connecting',
                mode: 'idle',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === connecting.controller.id ? connecting.controller : null,
            list: () => [connecting.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({ globalBindingAuthorityChanged: true });

        expect(connecting.stop).toHaveBeenCalledOnce();
        expect(connecting.stop).toHaveBeenCalledWith({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });
    });

    it('fences in-flight preparation when its exact credential authority changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await startDeferred.promise;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === preparing.controller.id ? preparing.controller : null,
            list: () => [preparing.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        const preparation = controller.toggle(VOICE_AGENT_GLOBAL_SESSION_ID);
        await vi.waitFor(() => expect(preparing.start).toHaveBeenCalledOnce());
        controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });

        expect(preparing.stop).toHaveBeenCalledOnce();
        expect(preparing.stop).toHaveBeenCalledWith({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });

        startDeferred.resolve();
        await preparation;
    });

    it('fences a pending Global Agent start when its selected global binding changes before publication', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const startDeferred = createDeferred<void>();
        const preparing = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await startDeferred.promise;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === preparing.controller.id ? preparing.controller : null,
            list: () => [preparing.controller],
        }) });

        controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
        const preparation = controller.toggle(VOICE_AGENT_GLOBAL_SESSION_ID);
        await vi.waitFor(() => expect(preparing.start).toHaveBeenCalledOnce());
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'disconnected',
        });

        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: true,
        });

        expect(preparing.stop).toHaveBeenCalledOnce();
        expect(preparing.stop).toHaveBeenCalledWith({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        });

        startDeferred.resolve();
        await preparation;
    });

    it('retains an established ordinary OpenAI attachment until terminal after a next-start-only change', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connected = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'voice-session',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === connected.controller.id ? connected.controller : null,
            list: () => [connected.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        controller.rearmAfterCredentialAuthorityChange({
            exactSessionAccountScopeChanged: false,
            globalBindingAuthorityChanged: false,
        });

        expect(connected.stop).not.toHaveBeenCalled();
    });

    it('routes barge-in only through the active adapter capability', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? active.controller : null,
            list: () => [active.controller],
        }) });
        controller.setConfiguredProviderId('active');
        await controller.bargeIn('fallback');
        expect(active.bargeIn).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('routes output focus only through the exact active realtime adapter', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const setOutputFocusState = vi.fn(() => 'applied' as const);
        const adapter: VoiceAdapterController = {
            ...active.controller,
            setOutputFocusState,
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? adapter : null,
            list: () => [adapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        await expect(applyOutputFocusState('fallback', 'suspended')).resolves.toBe('applied');
        expect(setOutputFocusState).toHaveBeenCalledWith({ sessionId: 'session-1', state: 'suspended' });
    });

    it('fails closed through the captured realtime adapter when active output restoration is unsupported', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const adapter: VoiceAdapterController = {
            ...active.controller,
            setOutputFocusState: vi.fn(() => 'unsupported' as const),
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? adapter : null,
            list: () => [adapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        await expect(applyOutputFocusState('fallback', 'active')).resolves.toBe('unsupported');
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('fails closed through the captured realtime adapter when active output restoration throws', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const adapter: VoiceAdapterController = {
            ...active.controller,
            setOutputFocusState: vi.fn(() => { throw new Error('output_restore_failed'); }),
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? adapter : null,
            list: () => [adapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        await expect(applyOutputFocusState('fallback', 'active')).resolves.toBe('unsupported');
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('does not stop a same-session replacement after delayed unsupported output focus', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const incumbent = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const replacement = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const incumbentAdapter: VoiceAdapterController = {
            ...incumbent.controller,
            setOutputFocusState: vi.fn(() => 'unsupported' as const),
        };
        const replacementAdapter: VoiceAdapterController = {
            ...replacement.controller,
            setOutputFocusState: vi.fn(() => 'applied' as const),
        };
        let currentAdapter = incumbentAdapter;
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? currentAdapter : null,
            list: () => [currentAdapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        const apply = applyOutputFocusState('fallback', 'suspended');
        expect(incumbentAdapter.setOutputFocusState).toHaveBeenCalledTimes(1);

        currentAdapter = replacementAdapter;

        await expect(apply).resolves.toBe('unsupported');
        expect(incumbent.stop).not.toHaveBeenCalled();
        expect(replacement.stop).not.toHaveBeenCalled();
    });

    it('still stops the same owned attempt after an ordinary snapshot update', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const active = createAdapter({
            id: 'active',
            snapshot: { adapterId: 'active', sessionId: 'session-1', status: 'connected', mode: 'speaking', canStop: true },
        });
        const adapter: VoiceAdapterController = {
            ...active.controller,
            setOutputFocusState: vi.fn(() => 'unsupported' as const),
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === 'active' ? adapter : null,
            list: () => [adapter],
        }) });
        controller.setConfiguredProviderId('active');

        const applyOutputFocusState = controller.setOutputFocusState;
        if (!applyOutputFocusState) throw new Error('voice_output_focus_owner_missing');
        const apply = applyOutputFocusState('fallback', 'suspended');
        expect(adapter.setOutputFocusState).toHaveBeenCalledTimes(1);

        active.setSnapshot({
            adapterId: 'active',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
        await expect(apply).resolves.toBe('unsupported');
        expect(active.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });
    it('does not republish a pending switch after dispose', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const stopDeferred = createDeferred<void>();
        const sourceSnapshot: VoiceSessionSnapshot = {
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };
        const targetSnapshot: VoiceSessionSnapshot = {
            adapterId: 'local_conversation',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        const sourceAdapter = createAdapter({
            id: 'local_direct',
            snapshot: sourceSnapshot,
            stop: async () => {
                await stopDeferred.promise;
            },
        });
        const targetAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: targetSnapshot,
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === targetAdapter.controller.id) return targetAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, targetAdapter.controller],
        };

        // The published snapshot already reflects the active source adapter (the
        // realistic state once adapters derive from the owner-aware machine);
        // the controller no longer relies on a blind active-adapter fallback to
        // discover an owner, so it must start from the owner's snapshot.
        setVoiceSessionSnapshot(sourceSnapshot);

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        expect(controller.getSnapshot()).toEqual(sourceSnapshot);
        expect(sourceAdapter.stop).toHaveBeenCalledTimes(1);
        const stopCallPromise = sourceAdapter.stop.mock.results[0]?.value as Promise<void>;

        controller.dispose();
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        stopDeferred.resolve();
        await stopCallPromise;

        expect(getVoiceSessionSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
    });

    it('discards an Account-retired pending provider switch before source stop settles', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const sourceStopDeferred = createDeferred<void>();
        let sourceAdapter!: ReturnType<typeof createAdapter>;
        sourceAdapter = createAdapter({
            id: 'realtime-source',
            snapshot: {
                adapterId: 'realtime-source',
                sessionId: 'voice-session',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
            stop: async () => {
                await sourceStopDeferred.promise;
                sourceAdapter.setSnapshot({
                    adapterId: 'realtime-source',
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            },
        });
        const targetAdapter = createAdapter({
            id: 'realtime-target',
            snapshot: {
                adapterId: 'realtime-target',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === targetAdapter.controller.id) return targetAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, targetAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: sourceAdapter.controller.id,
            sessionId: 'voice-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => registry });
        controller.setConfiguredProviderId(sourceAdapter.controller.id);
        controller.setConfiguredProviderId(targetAdapter.controller.id);

        expect(sourceAdapter.stop).toHaveBeenCalledOnce();
        expect(targetAdapter.start).not.toHaveBeenCalled();

        controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
        sourceStopDeferred.resolve();
        await sourceAdapter.stop.mock.results[0]?.value;

        expect(targetAdapter.start).not.toHaveBeenCalled();
        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        await controller.dispose();
    });

    it('keeps ownership disconnected while a provider switch is pending and ignores stale source reconnects', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const stopDeferred = createDeferred<void>();
        const sourceAdapter = createAdapter({
            id: 'local_direct',
            snapshot: {
                adapterId: 'local_direct',
                sessionId: 'session-1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
            stop: async () => {
                sourceAdapter.setSnapshot({
                    adapterId: 'local_direct',
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
                await stopDeferred.promise;
            },
        });
        const targetStartDeferred = createDeferred<void>();
        const targetAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                await targetStartDeferred.promise;
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === targetAdapter.controller.id) return targetAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, targetAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        expect(sourceAdapter.stop).toHaveBeenCalledTimes(1);
        expect(targetAdapter.start).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        sourceAdapter.setSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        expect(controller.getSnapshot()).toMatchObject({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(targetAdapter.start).toHaveBeenCalledTimes(1);

        targetAdapter.setSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        expect(controller.getSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        stopDeferred.resolve();
        await sourceAdapter.stop.mock.results[0]?.value;
        targetStartDeferred.resolve();
        await targetAdapter.start.mock.results[0]?.value;
    });

    it('stays disconnected after switching off even if the old source later reconnects', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const stopDeferred = createDeferred<void>();
        const sourceAdapter = createAdapter({
            id: 'local_direct',
            snapshot: {
                adapterId: 'local_direct',
                sessionId: 'session-1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
            stop: async () => {
                await stopDeferred.promise;
            },
        });
        const idlePeer = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                if (id === idlePeer.controller.id) return idlePeer.controller;
                return null;
            },
            list: () => [sourceAdapter.controller, idlePeer.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('off');
        expect(sourceAdapter.stop).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        await act(async () => {
            sourceAdapter.setSnapshot({
                adapterId: 'local_direct',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
        });

        expect(controller.getSnapshot()).toMatchObject({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        sourceAdapter.setSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });

        expect(controller.getSnapshot()).toMatchObject({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        stopDeferred.resolve();
        await sourceAdapter.stop.mock.results[0]?.value;
    });

    it('stops the owned adapter through the canonical lifecycle controller seam', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const stopDeferred = createDeferred<void>();
        const sourceAdapter = createAdapter({
            id: 'local_direct',
            snapshot: {
                adapterId: 'local_direct',
                sessionId: 'session-1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
            stop: async () => {
                sourceAdapter.setSnapshot({
                    adapterId: 'local_direct',
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
                await stopDeferred.promise;
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => {
                if (id === sourceAdapter.controller.id) return sourceAdapter.controller;
                return null;
            },
            list: () => [sourceAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_direct');

        const stopPromise = controller.stop('stale-session');

        expect(sourceAdapter.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(controller.getSnapshot()).toEqual({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        stopDeferred.resolve();
        await stopPromise;

        expect(getVoiceSessionSnapshot()).toEqual({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
    });

    it('starts the configured adapter when toggled from a disconnected state', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const targetAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => (id === targetAdapter.controller.id ? targetAdapter.controller : null),
            list: () => [targetAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        await controller.toggle('session-1');

        expect(targetAdapter.start).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(targetAdapter.toggle).not.toHaveBeenCalled();
        expect(targetAdapter.stop).not.toHaveBeenCalled();
    });

    it('settles a current terminal retryable connection failure after the adapter publishes recovery', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connectionFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        let adapter!: ReturnType<typeof createAdapter>;
        adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: 'session-1',
                    status: 'connecting',
                    mode: 'idle',
                    canStop: true,
                });
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: 'session-1',
                    status: 'error',
                    mode: 'idle',
                    canStop: false,
                    errorCode: 'voice_connection_failed',
                    errorMessage: 'voice_connection_failed',
                    errorRecoveryAction: 'retry',
                    errorPresentation: 'error',
                });
                throw connectionFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).resolves.toBeUndefined();
        expect(controller.getSnapshot()).toMatchObject({
            adapterId: OPENAI_PROVIDER_ID,
            sessionId: 'session-1',
            status: 'error',
            canStop: false,
            errorCode: 'voice_connection_failed',
            errorRecoveryAction: 'retry',
        });
    });

    it('settles a blank global Start only after the canonical global session enters and leaves the attempt', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const connectionFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        let adapter!: ReturnType<typeof createAdapter>;
        adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                    status: 'connecting',
                    mode: 'idle',
                    canStop: true,
                });
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
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
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('')).resolves.toBeUndefined();
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'error',
            errorRecoveryAction: 'retry',
        });
    });

    it('rethrows an unannounced failure after an unrelated registry republish refreshes a prior retryable error', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const programmerFailure = new Error('unexpected_start_bug');
        let republishRegistry = () => {};
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            freshSnapshots: true,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            },
            start: async () => {
                republishRegistry();
                throw programmerFailure;
            },
        });
        const registry = {
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
            subscribe: (listener: () => void) => {
                republishRegistry = listener;
                return () => {};
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => registry });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(programmerFailure);
    });

    it('rethrows a blank global Start when a registry republish only carries a prior direct-session retryable error', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const programmerFailure = new Error('unexpected_start_bug');
        let republishRegistry = () => {};
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            freshSnapshots: true,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'direct-session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            },
            start: async () => {
                republishRegistry();
                throw programmerFailure;
            },
        });
        const registry = {
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
            subscribe: (listener: () => void) => {
                republishRegistry = listener;
                return () => {};
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => registry });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('')).rejects.toBe(programmerFailure);
        expect(adapter.start).toHaveBeenCalledWith({ sessionId: '' });
        expect(controller.getSnapshot().sessionId).not.toBe(VOICE_AGENT_GLOBAL_SESSION_ID);
    });

    it('rethrows a retryable failure that was already published before this Start', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previousFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'previous-session',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'voice_connection_failed',
                errorMessage: 'voice_connection_failed',
                errorRecoveryAction: 'retry',
                errorPresentation: 'error',
            },
            start: async () => {
                throw previousFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(previousFailure);
    });

    it('rethrows a current terminal failure without retryable recovery', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const credentialFailure = Object.assign(new Error('credential_unavailable'), {
            code: 'credential_unavailable',
        });
        let adapter!: ReturnType<typeof createAdapter>;
        adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: 'session-1',
                    status: 'error',
                    mode: 'idle',
                    canStop: false,
                    errorCode: 'provider_auth_invalid',
                    errorMessage: 'credential_unavailable',
                    errorRecoveryAction: 'review_credentials',
                    errorPresentation: 'error',
                });
                throw credentialFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(credentialFailure);
    });

    it('rethrows a cancellation after the attempted adapter settles disconnected', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const cancelled = Object.assign(new Error('voice_connection_aborted'), { name: 'AbortError' });
        let adapter!: ReturnType<typeof createAdapter>;
        adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                adapter.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
                throw cancelled;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(cancelled);
    });

    it('rethrows an old adapter failure after the configured provider changes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const staleFailure = Object.assign(new Error('voice_connection_failed'), {
            code: 'voice_connection_failed',
        });
        let controller!: ReturnType<typeof createVoiceSessionLifecycleController>;
        let source!: ReturnType<typeof createAdapter>;
        source = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                controller.setConfiguredProviderId(CODEX_PROVIDER_ID);
                source.setSnapshot({
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: 'session-1',
                    status: 'error',
                    mode: 'idle',
                    canStop: false,
                    errorCode: 'voice_connection_failed',
                    errorMessage: 'voice_connection_failed',
                    errorRecoveryAction: 'retry',
                    errorPresentation: 'error',
                });
                throw staleFailure;
            },
        });
        const target = createAdapter({
            id: CODEX_PROVIDER_ID,
            snapshot: {
                adapterId: CODEX_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
        });
        controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => {
                if (id === source.controller.id) return source.controller;
                if (id === target.controller.id) return target.controller;
                return null;
            },
            list: () => [source.controller, target.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(staleFailure);
    });

    it('rethrows a start rejection that published no terminal recovery', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const programmerFailure = new Error('unexpected_start_bug');
        const adapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                throw programmerFailure;
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }) });
        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);

        await expect(controller.toggle('session-1')).rejects.toBe(programmerFailure);
    });

    it('stops the owned adapter when toggled from an active state', async () => {
        vi.resetModules();

        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

        const sourceAdapter = createAdapter({
            id: 'local_conversation',
            snapshot: {
                adapterId: 'local_conversation',
                sessionId: 'session-1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            },
        });
        const registry: VoiceAdapterRegistry = {
            get: (id) => (id === sourceAdapter.controller.id ? sourceAdapter.controller : null),
            list: () => [sourceAdapter.controller],
        };

        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        const controller = createVoiceSessionLifecycleController({
            getRegistry: () => registry,
        });

        controller.setConfiguredProviderId('local_conversation');
        await controller.toggle('session-1');

        expect(sourceAdapter.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
        expect(sourceAdapter.start).not.toHaveBeenCalled();
    });

    it('routes Retry for an owned reconnect through the same adapter without toggling its lifecycle', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const sourceAdapter = createAdapter({
            id: OPENAI_PROVIDER_ID,
            snapshot: {
                adapterId: OPENAI_PROVIDER_ID,
                sessionId: 'owned-reconnect',
                status: 'connecting',
                mode: 'idle',
                canStop: true,
                presentationState: 'reconnecting',
                reconnectRetryAvailable: true,
            },
        });
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id: string) => id === sourceAdapter.controller.id ? sourceAdapter.controller : null,
            list: () => [sourceAdapter.controller],
        }) });

        controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
        await controller.retry('stale-session-id');

        expect(sourceAdapter.retry).toHaveBeenCalledWith({ sessionId: 'owned-reconnect' });
        expect(sourceAdapter.start).not.toHaveBeenCalled();
        expect(sourceAdapter.stop).not.toHaveBeenCalled();
        expect(sourceAdapter.toggle).not.toHaveBeenCalled();
    });

    it('reconnects a realtime attempt with the current UI tool set only when disclosure crosses the off boundary', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previousSettings = storage.getState().settings;
        const currentUiContext = {
            readCurrentUiContext: () => ({
                navigation: { area: 'app' as const, screen: 'home' },
                commands: [],
            }),
            resolveCurrentUiCommand: () => null,
            subscribe: () => () => {},
            invokeCurrentUiCommand: async () => ({ ok: true as const }),
        };
        const hostLease = createBundledConversationRuntimeHostLease({ currentUiContext });
        const captureAdmission = createVoiceCaptureAdmissionController();
        const toolSetsSeenByProvider: string[][] = [];
        const currentUiToolNames = new Set([
            String(getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '').trim(),
            String(getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName ?? '').trim(),
        ]);
        let snapshot: VoiceSessionSnapshot = {
            adapterId: 'realtime-test',
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
        const adapter: VoiceAdapterController = {
            id: 'realtime-test',
            engineKind: 'realtime',
            start: vi.fn(async ({ sessionId }) => {
                toolSetsSeenByProvider.push(
                    hostLease.host.getRealtimeClientToolDefinitions({ effectCalls: 'stable_ids', exposure: 'voice_assistant' })
                        .map((tool) => tool.name)
                        .filter((name) => currentUiToolNames.has(name)),
                );
                publish({
                    adapterId: 'realtime-test',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            }),
            stop: vi.fn(async ({ sessionId }) => {
                publish({
                    adapterId: 'realtime-test',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => snapshot,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => ({
                get: (id) => id === adapter.id ? adapter : null,
                list: () => [adapter],
            }),
        });
        const setMode = (currentUiContextMode: 'off' | 'on_demand' | 'automatic') => {
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode,
                        },
                    },
                },
            }));
        };

        try {
            controller.setConfiguredProviderId(adapter.id);
            setMode('off');
            controller.setCurrentUiContextToolSetEnabled(false);
            await controller.toggle('voice-session');
            expect(toolSetsSeenByProvider).toEqual([[]]);

            setMode('on_demand');
            controller.setCurrentUiContextToolSetEnabled(true);
            await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(2));
            expect(toolSetsSeenByProvider).toEqual([
                [],
                ['readCurrentUiContext', 'invokeCurrentUiCommand'],
            ]);

            setMode('automatic');
            controller.setCurrentUiContextToolSetEnabled(true);
            setMode('on_demand');
            controller.setCurrentUiContextToolSetEnabled(true);
            expect(adapter.start).toHaveBeenCalledTimes(2);
            expect(adapter.stop).toHaveBeenCalledTimes(1);
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: adapter.id,
                sessionId: 'voice-session',
                status: 'connected',
                canStop: true,
            });

            setMode('off');
            controller.setCurrentUiContextToolSetEnabled(false);
            await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(3));
            expect(toolSetsSeenByProvider).toEqual([
                [],
                ['readCurrentUiContext', 'invokeCurrentUiCommand'],
                [],
            ]);
        } finally {
            await controller.dispose();
            hostLease.revoke();
            storage.setState((state) => ({ ...state, settings: previousSettings }));
        }
    });

    it('restarts a realtime provider-switch target when current-UI disclosure changes while it connects', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const previousSettings = storage.getState().settings;
        const currentUiContext = {
            readCurrentUiContext: () => ({
                navigation: { area: 'app' as const, screen: 'home' },
                commands: [],
            }),
            resolveCurrentUiCommand: () => null,
            subscribe: () => () => {},
            invokeCurrentUiCommand: async () => ({ ok: true as const }),
        };
        const hostLease = createBundledConversationRuntimeHostLease({ currentUiContext });
        const currentUiToolNames = new Set([
            String(getActionSpec('ui.current_context.read').bindings?.voiceClientToolName ?? '').trim(),
            String(getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName ?? '').trim(),
        ]);
        const targetToolSetsSeenByProvider: string[][] = [];
        const targetFirstStart = createDeferred<void>();
        let targetStarts = 0;
        let sourceSnapshot: VoiceSessionSnapshot = {
            adapterId: 'realtime-source',
            sessionId: 'voice-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };
        let targetSnapshot: VoiceSessionSnapshot = {
            adapterId: 'realtime-target',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        const sourceListeners = new Set<() => void>();
        const targetListeners = new Set<() => void>();
        const sourceAdapter: VoiceAdapterController = {
            id: 'realtime-source',
            engineKind: 'realtime',
            start: vi.fn(async () => {}),
            stop: vi.fn(async ({ sessionId }) => {
                sourceSnapshot = {
                    adapterId: 'realtime-source',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                };
                for (const listener of sourceListeners) listener();
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            bargeIn: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => sourceSnapshot,
            subscribe: (listener) => {
                sourceListeners.add(listener);
                return () => sourceListeners.delete(listener);
            },
        };
        const targetAdapter: VoiceAdapterController = {
            id: 'realtime-target',
            engineKind: 'realtime',
            start: vi.fn(async ({ sessionId }) => {
                targetStarts += 1;
                targetToolSetsSeenByProvider.push(
                    hostLease.host.getRealtimeClientToolDefinitions({ effectCalls: 'stable_ids', exposure: 'voice_assistant' })
                        .map((tool) => tool.name)
                        .filter((name) => currentUiToolNames.has(name)),
                );
                if (targetStarts === 1) {
                    await targetFirstStart.promise;
                }
                targetSnapshot = {
                    adapterId: 'realtime-target',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                };
                for (const listener of targetListeners) listener();
            }),
            stop: vi.fn(async ({ sessionId }) => {
                targetSnapshot = {
                    adapterId: 'realtime-target',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                };
                for (const listener of targetListeners) listener();
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            bargeIn: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => targetSnapshot,
            subscribe: (listener) => {
                targetListeners.add(listener);
                return () => targetListeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id) => {
                if (id === sourceAdapter.id) return sourceAdapter;
                if (id === targetAdapter.id) return targetAdapter;
                return null;
            },
            list: () => [sourceAdapter, targetAdapter],
        }) });
        const setMode = (currentUiContextMode: 'off' | 'on_demand' | 'automatic') => {
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode,
                        },
                    },
                },
            }));
        };

        try {
            setVoiceSessionSnapshot(sourceSnapshot);
            setMode('on_demand');
            controller.setCurrentUiContextToolSetEnabled(true);
            controller.setConfiguredProviderId(sourceAdapter.id);
            controller.setConfiguredProviderId(targetAdapter.id);
            await vi.waitFor(() => expect(targetAdapter.start).toHaveBeenCalledTimes(1));

            setMode('off');
            controller.setCurrentUiContextToolSetEnabled(false);
            targetFirstStart.resolve();

            await vi.waitFor(() => expect(targetAdapter.start).toHaveBeenCalledTimes(2));
            expect(targetToolSetsSeenByProvider).toEqual([
                ['readCurrentUiContext', 'invokeCurrentUiCommand'],
                [],
            ]);
        } finally {
            targetFirstStart.resolve();
            await controller.dispose();
            hostLease.revoke();
            storage.setState((state) => ({ ...state, settings: previousSettings }));
        }
    });

    it.each(['on_demand', 'automatic'] as const)(
        'retires and reseeds an active local Agent model session when current-UI disclosure returns from off to %s',
        async (restoredCurrentUiContextMode) => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previousSettings = storage.getState().settings;
        const currentUiActionIds = ['ui.current_context.read', 'ui.current_context.command.invoke'];
        const seededModelSessions: Array<Readonly<{ id: string; disabledActionIds: readonly string[] }>> = [];
        const retiredModelSessionIds: string[] = [];
        let activeModelSessionId: string | null = null;
        let snapshot: VoiceSessionSnapshot = {
            adapterId: 'local_conversation',
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
        const adapter: VoiceAdapterController = {
            id: 'local_conversation',
            engineKind: 'local',
            start: vi.fn(async ({ sessionId }) => {
                const id = `model-session-${seededModelSessions.length + 1}`;
                seededModelSessions.push({
                    id,
                    // This is the immutable daemon-start input that seeds the
                    // Local Agent model session's available-action guidance.
                    disabledActionIds: resolveDisabledVoiceActionIdsFromState(storage.getState()),
                });
                activeModelSessionId = id;
                publish({
                    adapterId: 'local_conversation',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            }),
            stop: vi.fn(async ({ sessionId }) => {
                if (activeModelSessionId) {
                    retiredModelSessionIds.push(activeModelSessionId);
                    activeModelSessionId = null;
                }
                publish({
                    adapterId: 'local_conversation',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            bargeIn: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            sendTextTurn: vi.fn(async () => {}),
            getSnapshot: () => snapshot,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id) => id === adapter.id ? adapter : null,
            list: () => [adapter],
        }) });
        const setMode = (currentUiContextMode: 'off' | 'on_demand' | 'automatic') => {
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode,
                        },
                    },
                },
            }));
        };

        try {
            controller.setConfiguredProviderId(adapter.id);
            setMode(restoredCurrentUiContextMode);
            controller.setCurrentUiContextToolSetEnabled(true);
            await controller.toggle('local-session');

            expect(seededModelSessions).toHaveLength(1);
            expect(seededModelSessions[0].disabledActionIds).not.toEqual(expect.arrayContaining(currentUiActionIds));

            setMode('off');
            controller.setCurrentUiContextToolSetEnabled(false);

            await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(2));
            expect(adapter.stop).toHaveBeenCalledWith({ sessionId: 'local-session' });
            expect(retiredModelSessionIds).toEqual(['model-session-1']);
            expect(seededModelSessions.map((session) => session.id)).toEqual([
                'model-session-1',
                'model-session-2',
            ]);
            expect(seededModelSessions[1].disabledActionIds).toEqual(expect.arrayContaining(currentUiActionIds));
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: adapter.id,
                sessionId: 'local-session',
                status: 'connected',
                canStop: true,
            });

            setMode(restoredCurrentUiContextMode);
            controller.setCurrentUiContextToolSetEnabled(true);
            await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(3));
            expect(retiredModelSessionIds).toEqual(['model-session-1', 'model-session-2']);
            expect(seededModelSessions.map((session) => session.id)).toEqual([
                'model-session-1',
                'model-session-2',
                'model-session-3',
            ]);
            expect(seededModelSessions[2].disabledActionIds).not.toEqual(
                expect.arrayContaining(currentUiActionIds),
            );
        } finally {
            await controller.dispose();
            storage.setState((state) => ({ ...state, settings: previousSettings }));
        }
        },
    );

    it('does not interrupt a local direct attempt with no model-session tool catalog', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const previousSettings = storage.getState().settings;
        let snapshot: VoiceSessionSnapshot = {
            adapterId: 'local_direct',
            sessionId: 'local-session',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };
        const listeners = new Set<() => void>();
        const adapter: VoiceAdapterController = {
            id: 'local_direct',
            engineKind: 'local',
            start: vi.fn(async () => {}),
            stop: vi.fn(async ({ sessionId }) => {
                snapshot = {
                    adapterId: 'local_direct',
                    sessionId,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                };
                for (const listener of listeners) listener();
            }),
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => snapshot,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({
            get: (id) => id === adapter.id ? adapter : null,
            list: () => [adapter],
        }) });

        try {
            controller.setConfiguredProviderId(adapter.id);
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode: 'on_demand',
                        },
                    },
                },
            }));
            controller.setCurrentUiContextToolSetEnabled(true);

            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode: 'off',
                        },
                    },
                },
            }));
            controller.setCurrentUiContextToolSetEnabled(false);

            expect(adapter.stop).not.toHaveBeenCalled();
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: adapter.id,
                sessionId: 'local-session',
                status: 'connected',
                canStop: true,
            });

            storage.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode: 'automatic',
                        },
                    },
                },
            }));
            controller.setCurrentUiContextToolSetEnabled(true);

            expect(adapter.stop).not.toHaveBeenCalled();
            expect(adapter.start).not.toHaveBeenCalled();
        } finally {
            await controller.dispose();
            storage.setState((state) => ({ ...state, settings: previousSettings }));
        }
    });

    it('keeps the withdrawn provider owning its live attempt until that exact adapter terminalizes', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const captureAdmission = createVoiceCaptureAdmissionController();
        const stopReached = createDeferred<void>();
        const releaseStop = createDeferred<void>();
        let snapshot: VoiceSessionSnapshot = {
            adapterId: 'realtime-retiring',
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
        const stop = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => {
            stopReached.resolve();
            await releaseStop.promise;
            publish({
                adapterId: 'realtime-retiring',
                sessionId,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
        });
        const adapter: VoiceAdapterController = {
            id: 'realtime-retiring',
            engineKind: 'realtime',
            start: vi.fn(async ({ sessionId }) => {
                publish({
                    adapterId: 'realtime-retiring',
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            }),
            stop,
            toggle: vi.fn(async () => {}),
            interrupt: vi.fn(async () => {}),
            setMuted: vi.fn(async () => {}),
            sendContextUpdate: vi.fn(),
            getSnapshot: () => snapshot,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        let registered = true;
        const registryListeners = new Set<() => void>();
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => ({
                get: (id) => (registered && id === adapter.id ? adapter : null),
                list: () => (registered ? [adapter] : []),
                subscribe: (listener: () => void) => {
                    registryListeners.add(listener);
                    return () => registryListeners.delete(listener);
                },
            }),
        });

        try {
            controller.setConfiguredProviderId(adapter.id);
            await act(async () => {
                await controller.toggle('voice-global');
            });
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: adapter.id,
                status: 'connected',
                canStop: true,
            });
            expect(captureAdmission.acquire('dictation')).toMatchObject({ status: 'busy' });

            // The plugin projection withdraws the registration synchronously so
            // no new Start can select it, while its runtime is still stopping.
            registered = false;
            act(() => {
                for (const listener of [...registryListeners]) listener();
            });

            // Withdrawal is not termination: the retired adapter still owns live
            // media, so this owner must not publish idle or hand global capture
            // admission to another product.
            expect(controller.getSnapshot()).toMatchObject({
                adapterId: adapter.id,
                status: 'connected',
                canStop: true,
            });
            expect(captureAdmission.acquire('dictation')).toMatchObject({ status: 'busy' });

            // Stop authority stays with that exact adapter.
            await stopReached.promise;
            await act(async () => {
                releaseStop.resolve();
                await releaseStop.promise;
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('disconnected'));
            expect(stop).toHaveBeenCalledTimes(1);
            const afterTerminal = captureAdmission.acquire('dictation');
            expect(afterTerminal).toMatchObject({ status: 'acquired' });
            if (afterTerminal.status === 'acquired') afterTerminal.lease.release();
        } finally {
            releaseStop.resolve();
            await controller.dispose();
        }
    });

    it('tracks current and retained adapter subscriptions by object identity across a same-ID replacement', async () => {
        const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
        const captureAdmission = createVoiceCaptureAdmissionController();
        const releaseRetiredStop = createDeferred<void>();
        const retiredStopStarted = createDeferred<void>();
        const adapterId = 'realtime-replacement';
        const sessionId = 'voice-session';
        let retired!: ReturnType<typeof createAdapter>;
        retired = createAdapter({
            id: adapterId,
            snapshot: {
                adapterId,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            start: async () => {
                retired.setSnapshot({
                    adapterId,
                    sessionId,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            },
            stop: async () => {
                retiredStopStarted.resolve();
                await releaseRetiredStop.promise;
                retired.setSnapshot({
                    adapterId,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            },
        });
        let replacement!: ReturnType<typeof createAdapter>;
        replacement = createAdapter({
            id: adapterId,
            snapshot: {
                adapterId,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            },
            stop: async () => {
                replacement.setSnapshot({
                    adapterId,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                });
            },
        });
        let current = retired.controller;
        const registryListeners = new Set<() => void>();
        const registry: VoiceAdapterRegistry = {
            get: (id) => id === adapterId ? current : null,
            list: () => [current],
            subscribe: (listener) => {
                registryListeners.add(listener);
                return () => registryListeners.delete(listener);
            },
        };
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
            getRegistry: () => registry,
        });

        try {
            controller.setConfiguredProviderId(adapterId);
            await controller.toggle(sessionId);
            expect(retired.listenerCount()).toBe(1);

            current = replacement.controller;
            for (const listener of [...registryListeners]) listener();
            await retiredStopStarted.promise;

            // While the old real-time attempt is stopping, it remains retained
            // for terminalization and the replacement must already be current.
            expect(retired.listenerCount()).toBe(1);
            expect(replacement.listenerCount()).toBe(1);

            releaseRetiredStop.resolve();
            await vi.waitFor(() => {
                const admission = captureAdmission.acquire('dictation');
                expect(admission).toMatchObject({ status: 'acquired' });
                if (admission.status === 'acquired') admission.lease.release();
            });

            // Retention ends with the old attempt. Its subscription must not
            // wait for an unrelated later registry publication to disappear.
            expect(retired.listenerCount()).toBe(0);
            expect(replacement.listenerCount()).toBe(1);

            replacement.setSnapshot({
                adapterId,
                sessionId,
                status: 'connected',
                mode: 'listening',
                canStop: true,
            });
            expect(controller.getSnapshot()).toMatchObject({
                adapterId,
                sessionId,
                status: 'connected',
                canStop: true,
            });

            await controller.stop('stale-session');
            expect(replacement.stop).toHaveBeenCalledWith({ sessionId });
            expect(controller.getSnapshot().status).toBe('disconnected');
        } finally {
            releaseRetiredStop.resolve();
            await controller.dispose();
        }
    });

    it.each(['stop', 'toggle'] as const)(
        '%s stops a pending realtime Start before its first active snapshot and releases capture admission',
        async (operation) => {
            const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
            const captureAdmission = createVoiceCaptureAdmissionController();
            const startDeferred = createDeferred<void>();
            const adapter = createAdapter({
                id: OPENAI_PROVIDER_ID,
                snapshot: {
                    adapterId: OPENAI_PROVIDER_ID,
                    sessionId: null,
                    status: 'disconnected',
                    mode: 'idle',
                    canStop: false,
                },
                start: async () => {
                    await startDeferred.promise;
                },
            });
            const controller = createVoiceSessionLifecycleController({
                captureAdmission,
                getRegistry: () => ({
                    get: (id) => id === adapter.controller.id ? adapter.controller : null,
                    list: () => [adapter.controller],
                }),
            });
            let start: Promise<void> | null = null;

            try {
                controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
                start = controller.toggle('starting-session');
                await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledOnce());
                expect(captureAdmission.acquire('dictation')).toMatchObject({ status: 'busy' });

                const endAttempt = operation === 'stop'
                    ? controller.stop('stale-session')
                    : controller.toggle('stale-session');
                await expect(endAttempt).resolves.toBeUndefined();

                expect(adapter.start).toHaveBeenCalledOnce();
                expect(adapter.stop).toHaveBeenCalledWith({ sessionId: 'starting-session' });
                const releasedAdmission = captureAdmission.acquire('dictation');
                expect(releasedAdmission).toMatchObject({ status: 'acquired' });
                if (releasedAdmission.status === 'acquired') releasedAdmission.lease.release();

                startDeferred.resolve();
                await start;
            } finally {
                startDeferred.resolve();
                await start?.catch(() => undefined);
                await controller.dispose();
            }
        },
    );
});
