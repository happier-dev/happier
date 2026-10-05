import { describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import { createVoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';
import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import { createSdkHandleConnection } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import { createOpenAiRealtimeProtocolAdapter } from '../../../../../packages/plugins/openai/src/ui/voice/protocol';
import { executeVoiceConversationAction } from '@/sync/ops/actions/voiceConversationAction';
import { registerVoiceAdapters } from './voiceAdapterRegistry';
import { setVoiceSessionLifecycleController } from './voiceSessionLifecycleControllerStore';
import { getVoiceSessionAttemptId, setVoiceSessionSnapshot, resetVoiceSessionRuntimeStateForTests } from './voiceSessionStore';
import { storage } from '@/sync/domains/state/storage';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy } }));

const sessionAddress = (sessionId: string) => ({ serverId: 'server-1', sessionId });

function createRealtimeAdapter(input?: Readonly<{
    startError?: Error;
}>) {
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
        listeners.forEach((listener) => listener());
    };
    const start = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => {
        if (input?.startError) throw input.startError;
        publish({
            adapterId: 'realtime-test',
            sessionId,
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
    });
    const stop = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => {
        publish({
            adapterId: 'realtime-test',
            sessionId,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
    });
    const controller: VoiceAdapterController = {
        id: 'realtime-test',
        engineKind: 'realtime',
        start,
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
    return {
        controller,
        publish,
        start,
        stop,
    };
}

function createHarness(adapter = createRealtimeAdapter()) {
    const captureAdmission = createVoiceCaptureAdmissionController();
    const lifecycle = createVoiceSessionLifecycleController({
        captureAdmission,
        getRegistry: () => ({
            get: (id: string) => id === adapter.controller.id ? adapter.controller : null,
            list: () => [adapter.controller],
        }),
    });
    lifecycle.setConfiguredProviderId(adapter.controller.id);
    return {
        adapter,
        captureAdmission,
        lifecycle,
    };
}

describe('Voice session lifecycle capture admission', () => {
    it('cancels held input when a suspension arrives while user Mute is already applied', async () => {
        const sent: unknown[] = [];
        const connection = createSdkHandleConnection({ driver: {
            open: async () => {}, close: async () => {}, sendControl: async (event) => { sent.push(event); },
        } });
        let userMuted = false;
        let captureOpen = false;
        let snapshot: VoiceSessionSnapshot = { adapterId: 'held', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false };
        const listeners = new Set<() => void>();
        const publish = (next: VoiceSessionSnapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };
        const controller = createVoiceConversationController({
            adapter: { ...createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'prepared', session: {
                config: {}, safeMetadata: null, inputCommitRequired: true,
            } }) }), id: 'held', turnControls: {
                cancelResponse: 'immediate', truncatePlayback: 'unsupported', clearInput: true,
                stopSession: true, resumption: 'none', replay: 'none', exactMessage: false,
            } },
            createConnection: async () => connection, isSelectionCurrent: () => true, onCanonicalEvent: async () => {},
            holdCapture: { async setOpen({ open }) { captureOpen = open === null ? !userMuted : open; } },
            machine: {
                connecting() {}, ending() {}, failed() {},
                connected({ controlSessionId }) { publish({ adapterId: 'held', sessionId: controlSessionId, status: 'connected', mode: 'listening', canStop: true }); },
                disconnected() { publish({ ...snapshot, status: 'disconnected', canStop: false }); },
            },
        });
        // A concrete plugin adapter over the real turn controller; only the media/transport boundary is simulated.
        const adapter: VoiceAdapterController = {
            id: 'held', engineKind: 'realtime',
            start: async ({ sessionId }) => { await controller.start({ controlSessionId: sessionId }); },
            stop: async () => { await controller.stop(); }, toggle: async () => {}, interrupt: async () => {},
            getSnapshot: () => ({ ...snapshot, micMuted: userMuted, canHoldToTalk: controller.canHoldToTalk() }),
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            beginHoldToTalk: controller.beginHoldToTalk,
            cancelHoldToTalk: async () => { await controller.cancelHoldToTalk(); },
            setMuted: async ({ muted }) => { if (muted) await controller.cancelHoldToTalk(); userMuted = muted; captureOpen = !muted; },
            sendContextUpdate() {},
        };
        const lifecycle = createVoiceSessionLifecycleController({
            captureAdmission: createVoiceCaptureAdmissionController(),
            getRegistry: () => ({ get: (id) => id === adapter.id ? adapter : null, list: () => [adapter] }),
        });
        lifecycle.setConfiguredProviderId(adapter.id);
        registerVoiceAdapters([adapter]);
        setVoiceSessionLifecycleController(lifecycle);
        const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
        const previousHoldEnabled = storage.getState().localSettings.voiceHoldToTalkEnabled;
        storage.setState((state) => ({ localSettings: { ...state.localSettings, voiceHoldToTalkEnabled: true } }));
        try {
            await lifecycle.toggle(sessionAddress('held-session'));
            const expectedAttempt = getVoiceSessionAttemptId()!;
            const invoke = (action: Parameters<typeof executeVoiceConversationAction>[0]) => executeVoiceConversationAction(action, { expectedAttempt }, { navigate() {} });
            expect((await executeVoiceConversationAction('ui.voice_global.set_muted', { expectedAttempt, muted: true }, { navigate() {} })).status).toBe('completed');
            expect((await invoke('ui.voice_global.hold_begin')).status).toBe('completed');
            expect(captureOpen).toBe(true);
            const suspension = await lifecycle.suspendInput('held-session');
            expect(suspension).not.toBeNull();
            expect(captureOpen).toBe(false);
            expect(lifecycle.beginHoldToTalk('held-session')).toBeNull();
            await invoke('ui.voice_global.hold_release');
            await suspension!.release();
            expect(captureOpen).toBe(false);
            expect(userMuted).toBe(true);
            expect(sent.filter((event) => JSON.stringify(event) === JSON.stringify({ type: 'input_audio_buffer.commit' }))).toHaveLength(0);
        } finally {
            storage.setState((state) => ({ localSettings: { ...state.localSettings, voiceHoldToTalkEnabled: previousHoldEnabled } }));
            unsubscribe(); await lifecycle.dispose(); await resetVoiceSessionRuntimeStateForTests();
        }
    });
    it('rejects conversational Voice before its realtime mic owner starts when Dictation started first', async () => {
        const { adapter, captureAdmission, lifecycle } = createHarness();
        const dictation = captureAdmission.acquire('dictation');
        if (dictation.status !== 'acquired') throw new Error('expected Dictation admission');
        logSpy.mockClear();

        await expect(lifecycle.toggle(sessionAddress('session-1'))).rejects.toMatchObject({
            name: 'VoiceCaptureBusyError',
            code: 'voice_capture_busy_dictation',
            activeOwner: 'dictation',
        });
        expect(adapter.start).not.toHaveBeenCalled();
        // The rejection is swallowed by the surface's fire-and-forget dispatch,
        // so this refusal is invisible unless the owner names it.
        const record = logSpy.mock.calls
            .map((call) => String(call[0]))
            .find((line) => line.includes('[voiceRuntimeFailure]'));
        expect(record).toContain('voice_capture_busy_dictation');
    });

    it('retains admission through the realtime session and releases after End Voice', async () => {
        const { adapter, captureAdmission, lifecycle } = createHarness();

        await lifecycle.toggle(sessionAddress('session-1'));
        expect(adapter.start).toHaveBeenCalledOnce();
        expect(captureAdmission.acquire('dictation')).toEqual({
            status: 'busy',
            activeOwner: 'conversation',
        });

        await lifecycle.stop('session-1');
        expect(adapter.stop).toHaveBeenCalledOnce();
        const dictation = captureAdmission.acquire('dictation');
        expect(dictation.status).toBe('acquired');
        if (dictation.status === 'acquired') dictation.lease.release();
    });

    it('stops an admitted realtime adapter when disposal races its pending start', async () => {
        let resolveStart!: () => void;
        const startDeferred = new Promise<void>((resolve) => {
            resolveStart = resolve;
        });
        const adapter = createRealtimeAdapter();
        adapter.start.mockImplementationOnce(async () => {
            await startDeferred;
        });
        adapter.stop.mockImplementationOnce(async () => {
            await startDeferred;
        });
        const pending = createHarness(adapter);

        const starting = pending.lifecycle.toggle(sessionAddress('pending-start'));
        await vi.waitFor(() => {
            expect(adapter.start).toHaveBeenCalledWith({
                sessionId: 'pending-start',
                requestedTargetSessionAddress: sessionAddress('pending-start'),
            });
        });
        const disposal = pending.lifecycle.dispose();

        expect(adapter.stop).toHaveBeenCalledWith({ sessionId: 'pending-start' });
        expect(pending.captureAdmission.acquire('dictation')).toEqual({
            status: 'busy',
            activeOwner: 'conversation',
        });

        resolveStart();
        await Promise.all([starting, disposal]);
        expect(pending.captureAdmission.acquire('dictation').status).toBe('acquired');
    });

    it('releases after acquisition failure and terminal loss, but retains admission through lifecycle disposal teardown', async () => {
        const failedAdapter = createRealtimeAdapter({
            startError: new Error('mic_permission_denied'),
        });
        const failed = createHarness(failedAdapter);
        await expect(failed.lifecycle.toggle(sessionAddress('failed'))).rejects.toThrow('mic_permission_denied');
        expect(failed.captureAdmission.acquire('dictation').status).toBe('acquired');

        const terminal = createHarness();
        await terminal.lifecycle.toggle(sessionAddress('terminal'));
        terminal.adapter.publish({
            adapterId: 'realtime-test',
            sessionId: 'terminal',
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(terminal.captureAdmission.acquire('dictation').status).toBe('acquired');

        let resolveStop!: () => void;
        const disposedAdapter = createRealtimeAdapter();
        disposedAdapter.stop.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveStop = resolve;
        }));
        const disposed = createHarness(disposedAdapter);
        await disposed.lifecycle.toggle(sessionAddress('disposed'));
        const disposal = disposed.lifecycle.dispose();
        expect(disposed.adapter.stop).toHaveBeenCalledWith({ sessionId: 'disposed' });
        expect(disposed.captureAdmission.acquire('dictation')).toEqual({
            status: 'busy',
            activeOwner: 'conversation',
        });
        resolveStop();
        await disposal;
        expect(disposed.captureAdmission.acquire('dictation').status).toBe('acquired');
    });

    it('releases a terminal error owner and lets Retry start a fresh realtime attempt', async () => {
        const { adapter, captureAdmission, lifecycle } = createHarness();

        await lifecycle.toggle(sessionAddress('retry-session'));
        adapter.publish({
            adapterId: 'realtime-test',
            sessionId: 'retry-session',
            status: 'error',
            mode: 'idle',
            canStop: false,
            errorCode: 'voice_connection_failed',
            errorRecoveryAction: 'retry',
            errorPresentation: 'error',
        });

        const dictation = captureAdmission.acquire('dictation');
        expect(dictation.status).toBe('acquired');
        if (dictation.status === 'acquired') dictation.lease.release();

        await lifecycle.toggle(sessionAddress('retry-session'));

        expect(adapter.stop).not.toHaveBeenCalled();
        expect(adapter.start).toHaveBeenCalledTimes(2);
        expect(adapter.start).toHaveBeenLastCalledWith({
            sessionId: 'retry-session',
            requestedTargetSessionAddress: sessionAddress('retry-session'),
        });
    });
});
