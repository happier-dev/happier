import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import type { NativeCaptureSnapshot } from './nativeCapture';
import { setScreenSharingPrivacyActive, useCapturePrivacyActive, useNativeRecordingActive } from './useNativeRecordingActive';

const nativeEvents = vi.hoisted(() => ({
    receive: null as null | ((event: { payload: NativeCaptureSnapshot }) => void),
    listen: vi.fn(), stop: vi.fn(),
}));
// Native events and IPC are the process boundary; recording classification stays real.
vi.mock('@tauri-apps/api/event', () => ({ listen: nativeEvents.listen }));

function awaitNativeListener(): Promise<void> {
    return new Promise(resolve => {
        nativeEvents.listen.mockImplementation(async (_event: string, receive: typeof nativeEvents.receive) => {
            nativeEvents.receive = receive; resolve(); return nativeEvents.stop;
        });
    });
}

afterEach(async () => {
    await standardCleanup(); setScreenSharingPrivacyActive(false);
    nativeEvents.receive = null;
    vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('native recording activity projection', () => {
    it.each(['idle', 'recording'] as const)('hides opted-in native lists before the initial %s snapshot arrives', async initialStatus => {
        let resolveState!: (snapshot: NativeCaptureSnapshot) => void;
        const initialState = new Promise<NativeCaptureSnapshot>(resolve => { resolveState = resolve; });
        const listening = awaitNativeListener();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(() => initialState) });
        const hook = await renderHook(() => useCapturePrivacyActive(true));
        expect(hook.getCurrent()).toBe(true);
        // The native event API is imported asynchronously; only push after its listener exists.
        await act(async () => { await listening; });
        await act(async () => resolveState(initialStatus === 'idle' ? { status: 'idle' } : {
            status: 'recording', operationRef: 1,
            recording: { phase: 'recording', timing: { durationMs: 0, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null },
        }));
        expect(hook.getCurrent()).toBe(initialStatus === 'recording');
        await act(async () => nativeEvents.receive?.({ payload: { status: 'idle' } }));
        expect(hook.getCurrent()).toBe(false);
    });

    it('keeps chosen native lists private when initial state is unavailable and recovers on push', async () => {
        const listening = awaitNativeListener();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(async () => { throw new Error('native state unavailable'); }) });
        const hook = await renderHook(() => useCapturePrivacyActive(true));
        await act(async () => { await listening; });
        expect(hook.getCurrent()).toBe(true);
        await act(async () => nativeEvents.receive?.({ payload: { status: 'idle' } }));
        expect(hook.getCurrent()).toBe(false);
    });

    it('keeps privacy while either sharing intent or recording is active and settles native failure', async () => {
        const listening = awaitNativeListener();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(async () => ({ status: 'idle' })) });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useCapturePrivacyActive(true); });
        await act(async () => { await listening; });
        await act(async () => { setScreenSharingPrivacyActive(true); });
        expect(hook.getCurrent()).toBe(true);
        const sharingRenders = renders;
        await act(async () => { setScreenSharingPrivacyActive(true); });
        expect(renders).toBe(sharingRenders);
        await act(async () => nativeEvents.receive?.({ payload: { status: 'recording', operationRef: 1,
            recording: { phase: 'paused', timing: { durationMs: 100, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null } } }));
        await act(async () => { setScreenSharingPrivacyActive(false); });
        expect(hook.getCurrent()).toBe(true);
        await act(async () => nativeEvents.receive?.({ payload: { status: 'failed', reason: 'native_failure' } }));
        expect(hook.getCurrent()).toBe(false);
        await act(async () => { setScreenSharingPrivacyActive(true); });
        await act(async () => nativeEvents.receive?.({ payload: { status: 'idle' } }));
        expect(hook.getCurrent()).toBe(true);
        await act(async () => { setScreenSharingPrivacyActive(false); });
        expect(hook.getCurrent()).toBe(false);
    });

    it('does not hide an unconsumed list for manual sharing and retains deliberate intent across remount', async () => {
        setScreenSharingPrivacyActive(true);
        const inactive = await renderHook(() => useCapturePrivacyActive(false));
        expect(inactive.getCurrent()).toBe(false);
        await inactive.unmount();
        const active = await renderHook(() => useCapturePrivacyActive(true));
        expect(active.getCurrent()).toBe(true);
        expect(nativeEvents.listen).not.toHaveBeenCalled();
    });

    it('shares one push subscription, ignores timing ticks, retains pause privacy and recovers on stop', async () => {
        const listening = awaitNativeListener();
        let state: NativeCaptureSnapshot = { status: 'idle' };
        const invoke = vi.fn(async () => state);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        let renders = 0;
        const first = await renderHook(() => { renders += 1; return useNativeRecordingActive(true); });
        const second = await renderHook(() => useNativeRecordingActive(true));
        await act(async () => { await listening; });
        expect(first.getCurrent()).toBe(false);
        expect(nativeEvents.listen).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledTimes(1);
        const push = async (phase: 'recording' | 'paused' | 'ready', durationMs: number) => {
            state = { status: 'recording', operationRef: 1,
                recording: { phase, timing: { durationMs, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null } };
            await act(async () => nativeEvents.receive?.({ payload: state }));
        };
        await push('recording', 0);
        expect(first.getCurrent()).toBe(true);
        expect(second.getCurrent()).toBe(true);
        const activeRenders = renders;
        for (let tick = 1; tick <= 20; tick += 1) await push('recording', tick * 1000);
        await push('paused', 20_000);
        expect(renders).toBe(activeRenders);
        expect(first.getCurrent()).toBe(true);
        await push('ready', 20_000);
        expect(first.getCurrent()).toBe(false);
        expect(invoke).toHaveBeenCalledTimes(1);
        await first.unmount(); await second.unmount();
        expect(nativeEvents.stop).toHaveBeenCalledTimes(1);
    });

    it('does no native work without explicit opt-in', async () => {
        const invoke = vi.fn();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const hook = await renderHook(() => useNativeRecordingActive(false));
        expect(hook.getCurrent()).toBe(false);
        expect(invoke).not.toHaveBeenCalled();
        expect(nativeEvents.listen).not.toHaveBeenCalled();
    });
});
