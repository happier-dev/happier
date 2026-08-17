import { describe, expect, it, vi } from 'vitest';

import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import { createVoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy } }));

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
    it('rejects conversational Voice before its realtime mic owner starts when Dictation started first', async () => {
        const { adapter, captureAdmission, lifecycle } = createHarness();
        const dictation = captureAdmission.acquire('dictation');
        if (dictation.status !== 'acquired') throw new Error('expected Dictation admission');
        logSpy.mockClear();

        await expect(lifecycle.toggle('session-1')).rejects.toMatchObject({
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

        await lifecycle.toggle('session-1');
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

        const starting = pending.lifecycle.toggle('pending-start');
        await vi.waitFor(() => {
            expect(adapter.start).toHaveBeenCalledWith({ sessionId: 'pending-start' });
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
        await expect(failed.lifecycle.toggle('failed')).rejects.toThrow('mic_permission_denied');
        expect(failed.captureAdmission.acquire('dictation').status).toBe('acquired');

        const terminal = createHarness();
        await terminal.lifecycle.toggle('terminal');
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
        await disposed.lifecycle.toggle('disposed');
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

        await lifecycle.toggle('retry-session');
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

        await lifecycle.toggle('retry-session');

        expect(adapter.stop).not.toHaveBeenCalled();
        expect(adapter.start).toHaveBeenCalledTimes(2);
        expect(adapter.start).toHaveBeenLastCalledWith({
            sessionId: 'retry-session',
        });
    });
});
