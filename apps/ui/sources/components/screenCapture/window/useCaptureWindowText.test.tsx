import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageMarksDocumentV1Schema, applyImageMarksOperations } from '@happier-dev/protocol';
import type { NativeCapturePermissions, NativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { useCaptureWindowText } from './useCaptureWindowText';

const unavailable: NativeCaptureWindowText = { status: 'unavailable', reason: 'provider_unavailable',
    source: { appName: 'Terminal', windowTitle: 'Selected window', windowId: 1 } };
const permissionEvents = vi.hoisted(() => ({ receive: null as ((event: { payload: NativeCapturePermissions }) => void) | null }));
// The native permission event transport is a genuine process boundary.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_event: string, handler: (event: { payload: NativeCapturePermissions }) => void) => {
    permissionEvents.receive = handler;
    return () => { if (permissionEvents.receive === handler) permissionEvents.receive = null; };
} }));

describe('Capture window text on first inclusion', () => {
    afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); permissionEvents.receive = null; });

    it('makes zero reads off, shares the first pending read, and retains its typed result across toggles', async () => {
        const pending = createDeferred<NativeCaptureWindowText>();
        const calls: unknown[] = [];
        // Tauri invoke is the OS/process boundary; the typed native adapter stays real.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            return pending.promise;
        } });
        const hook = await renderHook(() => useCaptureWindowText({ captureRef: 'capture', defaultIncluded: false }));
        await hook.rerender();
        expect(calls).toEqual([]);
        expect(hook.getCurrent().read).toEqual({ status: 'idle' });
        await act(async () => { hook.getCurrent().setIncluded(true); });
        expect(calls).toEqual([{ command: 'desktop_capture_window_text', args: { captureRef: 'capture' } }]);
        expect(hook.getCurrent().read).toEqual({ status: 'loading' });
        let prepared = false;
        let preparation: Promise<Readonly<{ includeWindowText: boolean }>>;
        await act(async () => { preparation = hook.getCurrent().prepareDisclosure().then(result => { prepared = true; return result; }); });
        expect(prepared).toBe(false);
        await act(async () => { hook.getCurrent().setIncluded(false); });
        await act(async () => { hook.getCurrent().setIncluded(true); });
        expect(calls).toHaveLength(1);
        await act(async () => { pending.resolve(unavailable); });
        expect(await preparation!).toEqual({ includeWindowText: true });
        expect(hook.getCurrent().read).toEqual({ status: 'settled', result: unavailable });
        await act(async () => { hook.getCurrent().setIncluded(false); });
        await act(async () => { hook.getCurrent().setIncluded(true); });
        expect(hook.getCurrent().read).toEqual({ status: 'settled', result: unavailable });
        expect(calls).toHaveLength(1);
    });

    it.each(['ready', 'partial'] as const)('previews the same sanitized %s outcome across toggles without another read', async status => {
        const text = status === 'ready' ? 'Visible '.repeat(131_072) : 'Visible partial text';
        const result: NativeCaptureWindowText = status === 'ready' ? { status, text, source: null }
            : { status, text, source: null, reason: 'provider_unavailable' };
        let reads = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { reads += 1; return result; } });
        const hook = await renderHook(() => useCaptureWindowText({ captureRef: 'capture', defaultIncluded: true }));
        const preview = hook.getCurrent().read;
        expect(preview.status).toBe('settled');
        if (preview.status !== 'settled') throw new Error('Native text did not settle');
        expect(preview.result).toBe(result);
        for (let index = 0; index < 5; index += 1) {
            await act(async () => { hook.getCurrent().setIncluded(false); });
            await act(async () => { hook.getCurrent().setIncluded(true); });
        }
        expect(reads).toBe(1);
    });

    it('requests Accessibility only after opt-in and resumes the first native traversal on the grant event', async () => {
        const calls: string[] = [];
        let reads = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_text') return ++reads === 1
                ? { status: 'unavailable', reason: 'permission_required', source: null }
                : { status: 'ready', text: 'Granted selected-window text', source: null };
            if (command === 'desktop_capture_permissions_watch') return args?.consumed
                ? { screen: 'granted', windowText: 'request_required' } : null;
            if (command === 'desktop_capture_request_permission') return {
                snapshot: { screen: 'granted', windowText: 'denied' }, recovery: 'open_settings' };
            throw new Error('Unexpected native text permission command');
        } });
        const hook = await renderHook(() => useCaptureWindowText({ captureRef: 'capture', defaultIncluded: false }));
        expect(calls).toEqual([]);
        await act(async () => { hook.getCurrent().setIncluded(true); });
        expect(hook.getCurrent().read).toMatchObject({ status: 'settled', result: { reason: 'permission_required' } });
        await act(async () => { await hook.getCurrent().requestPermission(); });
        expect(calls).toContain('desktop_capture_request_permission');
        const queuedGrant = permissionEvents.receive;
        await act(async () => { hook.getCurrent().setIncluded(false); });
        expect(permissionEvents.receive).toBeNull();
        await act(async () => { queuedGrant?.({ payload: { screen: 'granted', windowText: 'granted',
            recoveryActions: { screen: [], windowText: [] } } }); });
        expect(reads).toBe(1);
        await act(async () => { hook.getCurrent().setIncluded(true); });
        await vi.waitFor(() => expect(permissionEvents.receive).not.toBeNull());
        await act(async () => { permissionEvents.receive?.({ payload: { screen: 'granted', windowText: 'granted',
            recoveryActions: { screen: [], windowText: [] } } }); });
        expect(hook.getCurrent().read).toMatchObject({ status: 'settled', result: { status: 'ready', text: 'Granted selected-window text' } });
        expect(reads).toBe(2);
        expect(calls.filter(command => command === 'desktop_capture_request_permission')).toHaveLength(1);
        expect(permissionEvents.receive).toBeNull();
    });

    it('uses the shared blur warning before any native read and keeps the same outcome after Undo', async () => {
        let reads = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { reads += 1; return unavailable; } });
        const empty = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 100, height: 100, scale: 1 }, marks: [] });
        const blurred = applyImageMarksOperations(empty, [{ kind: 'mark.add',
            mark: { id: 'secret', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 's' } }]);
        const hook = await renderHook(() => useCaptureWindowText({ captureRef: 'capture', defaultIncluded: false }));
        await act(async () => { hook.getCurrent().onDocumentChange(blurred, 'edit'); });
        await act(async () => { hook.getCurrent().setIncluded(true); });
        expect(hook.getCurrent().disclosure.warning).toBe('pending');
        expect(reads).toBe(0);
        await act(async () => { hook.getCurrent().resolveWarning(false); });
        expect(reads).toBe(0);
        await act(async () => { hook.getCurrent().setIncluded(true); });
        await act(async () => { hook.getCurrent().resolveWarning(true); });
        expect(hook.getCurrent().read).toEqual({ status: 'settled', result: unavailable });
        const another = applyImageMarksOperations(blurred, [{ kind: 'mark.add',
            mark: { id: 'another', kind: 'blur', rect: { x: 50, y: 50, width: 20, height: 20 }, size: 's' } }]);
        await act(async () => { hook.getCurrent().onDocumentChange(another, 'edit'); });
        expect(hook.getCurrent().disclosure.included).toBe(false);
        await act(async () => { hook.getCurrent().onDocumentChange(blurred, 'undo'); });
        expect(hook.getCurrent().disclosure.included).toBe(true);
        expect(reads).toBe(1);
    });

    it('keeps native failure typed and never polls or repeats the failed read on another toggle', async () => {
        let reads = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { reads += 1; throw 'unknown_capture'; } });
        const hook = await renderHook(() => useCaptureWindowText({ captureRef: 'capture', defaultIncluded: true }));
        expect(hook.getCurrent().read).toEqual({ status: 'failed', errorCode: 'unknown_capture' });
        await act(async () => { hook.getCurrent().setIncluded(false); });
        await act(async () => { hook.getCurrent().setIncluded(true); });
        await hook.rerender();
        expect(reads).toBe(1);
    });

    it('reads a new capture once and ignores completion belonging to a prior capture', async () => {
        const pending = createDeferred<NativeCaptureWindowText>();
        let captureRef = 'first';
        const refs: unknown[] = [];
        const noWindow: NativeCaptureWindowText = { status: 'unavailable', reason: 'no_window_context', source: null };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (_command: string, args?: Record<string, unknown>) => {
            refs.push(args?.captureRef);
            return args?.captureRef === 'first' ? pending.promise : noWindow;
        } });
        const hook = await renderHook(() => useCaptureWindowText({ captureRef, defaultIncluded: true }));
        captureRef = 'second';
        await hook.rerender();
        expect(hook.getCurrent().read).toEqual({ status: 'settled', result: noWindow });
        await act(async () => { pending.resolve(unavailable); });
        expect(hook.getCurrent().read).toEqual({ status: 'settled', result: noWindow });
        expect(refs).toEqual(['first', 'second']);
    });
});
