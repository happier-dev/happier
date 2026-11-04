import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { NativeRecentCaptureEntry, NativeRecentCapturesSnapshot } from '@/desktop/capture/nativeCapture';
import { NativeCaptureError, openRecentCapture } from '@/desktop/capture/nativeCapture';

import { useRecentCaptures } from './useRecentCaptures';

const events = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: unknown }) => void>() }));
// The native webview transport is the boundary; the hook and capture adapter stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    events.listeners.set(event, handler);
    return () => { events.listeners.delete(event); };
} }));

const entry = (path: string, modifiedAt = 1): NativeRecentCaptureEntry => ({
    path, name: path.split('/').at(-1)!, kind: 'still', byteSize: 4, modifiedAt,
    modifiedAtNanos: String(modifiedAt),
});

describe('recent capture demand and recovery', () => {
    beforeEach(() => { events.listeners.clear(); });
    afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); events.listeners.clear(); });

    it('distinguishes pending, partial and empty reads, retains ready rows while Refresh settles, and reconciles equal wire snapshots', async () => {
        const initial = createDeferred<NativeRecentCapturesSnapshot>();
        const refresh = createDeferred<NativeRecentCapturesSnapshot>();
        const calls: string[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string) => {
            calls.push(command);
            if (command === 'desktop_capture_recent_open') return initial.promise;
            if (command === 'desktop_capture_recent_refresh') return refresh.promise;
            if (command === 'desktop_capture_recent_close') return;
            throw 'operation_unavailable';
        } });
        const hook = await renderHook(() => useRecentCaptures());
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', entries: [], error: null });
        const readable = entry('/library/readable.png');
        const folders = [{ path: '/library', issue: null }, { path: '/denied', issue: 'denied' }] as const;
        await act(async () => { initial.resolve({ entries: [readable], folders }); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', entries: [readable], folders, error: null });
        const readyEntries = hook.getCurrent().entries;
        let refreshing!: ReturnType<ReturnType<typeof useRecentCaptures>['refresh']>;
        await act(async () => { refreshing = hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', refreshing: true, error: null });
        expect(hook.getCurrent().entries).toBe(readyEntries);
        await act(async () => { refresh.resolve({ entries: [{ ...readable }], folders: folders.map(folder => ({ ...folder })) }); await refreshing; });
        expect(hook.getCurrent().entries).toBe(readyEntries);
        expect(hook.getCurrent().entries[0]).toBe(readable);
        expect(hook.getCurrent().refreshing).toBe(false);
        await hook.unmount();
        expect(calls.filter(command => command === 'desktop_capture_recent_close')).toHaveLength(1);

        const emptyRead = createDeferred<NativeRecentCapturesSnapshot>();
        const emptyOpened = createDeferred<void>();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string) => {
            if (command === 'desktop_capture_recent_open') { emptyOpened.resolve(); return emptyRead.promise; }
        } });
        const empty = await renderHook(() => useRecentCaptures());
        await act(async () => { await emptyOpened.promise; emptyRead.resolve({ entries: [], folders: [] }); });
        expect(empty.getCurrent()).toMatchObject({ status: 'ready', entries: [], error: null });
    });

    it('settles a failed open visibly and retries it only on explicit Refresh', async () => {
        const recovered = entry('/library/recovered.png');
        const failedRead = createDeferred<NativeRecentCapturesSnapshot>();
        const opened = createDeferred<void>();
        const invoke = vi.fn().mockImplementationOnce(() => { opened.resolve(); return failedRead.promise; }).mockResolvedValue({ entries: [recovered], folders: [] });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const hook = await renderHook(() => useRecentCaptures());
        await act(async () => { await opened.promise; failedRead.reject('file_io'); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: { code: 'file_io' }, entries: [] });
        expect(invoke).toHaveBeenCalledTimes(1);
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', error: null, entries: [recovered] });
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_capture_recent_open', 'desktop_capture_recent_open']);
    });

    it('preserves pushes arriving during the initial read without replacing other rows, then releases demand on close', async () => {
        const stable = entry('/library/stable.png');
        const changed = entry('/library/changed.png');
        const initial = createDeferred<NativeRecentCapturesSnapshot>();
        const opened = createDeferred<void>();
        const invoke = vi.fn(async (command: string) => {
            if (command === 'desktop_capture_recent_open') { opened.resolve(); return initial.promise; }
            if (command === 'desktop_capture_recent_close') return;
            throw 'operation_unavailable';
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const hook = await renderHook(() => useRecentCaptures());
        await opened.promise;
        const next = { ...changed, byteSize: 8, modifiedAt: 2, modifiedAtNanos: '2' };
        await act(async () => {
            events.listeners.get('desktopCapture://recents')?.({ payload: { upserted: [next], removed: [], folders: null, reconciled: false } });
        });
        await act(async () => { initial.resolve({ entries: [stable, changed], folders: [] }); });
        expect(hook.getCurrent().entries).toEqual([next, stable]);
        expect(hook.getCurrent().entries.find(row => row.path === stable.path)).toBe(stable);
        await hook.unmount();
        await flushHookEffects();
        expect(events.listeners.size).toBe(0);
        expect(invoke.mock.calls.filter(([command]) => command === 'desktop_capture_recent_close')).toHaveLength(1);
    });

    it('imports a chosen file once, reports rejection, and treats chooser cancellation as no work', async () => {
        let selected: string | null = null;
        let denied = true;
        const calls: string[] = [];
        const chosen = entry('/outside/screenshot.png');
        const folders: (string | null)[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_recent_open') {
                folders.push(args?.selectedFolder as string | null);
                return { entries: args?.selectedFolder === '/outside' ? [chosen] : [], folders: [] };
            }
            if (command === 'desktop_capture_recent_choose_file') return selected === null ? null : { path: selected, folder: '/outside' };
            if (command === 'desktop_capture_recent_open_media') {
                if (denied) throw 'file_io';
                return { captureRef: 'imported', mimeType: 'image/png', width: 2, height: 2 };
            }
        } });
        const hook = await renderHook(() => useRecentCaptures());
        const receive = vi.fn();
        const consume = async (entry: NativeRecentCaptureEntry) => { receive(await openRecentCapture(entry.path)); };
        await act(async () => { await hook.getCurrent().chooseFile(consume); });
        expect(hook.getCurrent().error).toBeNull();
        expect(calls.filter(command => command === 'desktop_capture_recent_open_media')).toHaveLength(0);
        selected = '/outside/screenshot.png';
        await act(async () => { await hook.getCurrent().chooseFile(consume); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: { code: 'file_io' }, entries: [chosen] });
        expect(receive).not.toHaveBeenCalled();
        denied = false;
        await act(async () => { await hook.getCurrent().chooseFile(consume); });
        expect(receive).toHaveBeenCalledOnce();
        expect(receive.mock.calls[0]?.[0]).toMatchObject({ captureRef: 'imported' });
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().status).toBe('ready');
        expect(calls.filter(command => command === 'desktop_capture_recent_open_media')).toHaveLength(2);
        expect(folders).toEqual([null, '/outside', '/outside']);
        selected = '/outside/not-listed.txt';
        await act(async () => { await hook.getCurrent().chooseFile(consume); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: { code: 'invalid_media' } });
        expect(calls.filter(command => command === 'desktop_capture_recent_open_media')).toHaveLength(2);
    });

    it('leaves folder cancellation alone and opens a selected folder through the same metadata owner', async () => {
        let folder: string | null = null;
        const selected = entry('/selected/recording.mov');
        const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
        const opened = createDeferred<void>();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            if (command === 'desktop_pick_folder') return folder;
            if (command === 'desktop_capture_recent_open') {
                opened.resolve();
                return { entries: args?.selectedFolder ? [selected] : [], folders: [] };
            }
        } });
        const hook = await renderHook(() => useRecentCaptures());
        await act(async () => { await opened.promise; });
        await act(async () => { expect(await hook.getCurrent().chooseFolder()).toBe(false); });
        expect(hook.getCurrent().error).toBeNull();
        expect(calls.filter(({ command }) => command === 'desktop_capture_recent_open')).toHaveLength(1);
        folder = '/selected';
        await act(async () => { expect(await hook.getCurrent().chooseFolder()).toBe(true); });
        expect(hook.getCurrent().entries).toEqual([selected]);
        expect(calls.filter(({ command }) => command === 'desktop_capture_recent_open').map(({ args }) => args?.selectedFolder)).toEqual([null, '/selected']);
        expect(calls.some(({ command }) => command === 'desktop_capture_recent_open_media')).toBe(false);
    });

    it('exposes consumer and folder-choice failures in the same result, keeps ready rows, and recovers on a successful choice', async () => {
        const readable = entry('/library/readable.png');
        const opened = createDeferred<void>();
        let folderFails = true;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            if (command === 'desktop_capture_recent_open') { opened.resolve(); return { entries: [readable], folders: [] }; }
            if (command === 'desktop_pick_folder') { if (folderFails) throw 'file_io'; return null; }
        } });
        const hook = await renderHook(() => useRecentCaptures());
        await act(async () => { await opened.promise; });
        const rows = hook.getCurrent().entries;
        await act(async () => { expect(await hook.getCurrent().choose(readable, async () => { throw new NativeCaptureError('invalid_media'); })).toBe(false); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: { code: 'invalid_media' }, choosing: false });
        expect(hook.getCurrent().entries).toBe(rows);
        await act(async () => { expect(await hook.getCurrent().chooseFolder()).toBe(false); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: { code: 'file_io' } });
        folderFails = false;
        await act(async () => { expect(await hook.getCurrent().chooseFolder()).toBe(false); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: { code: 'file_io' } });
        await act(async () => { expect(await hook.getCurrent().choose(readable, async () => {})).toBe(true); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', error: null, choosing: false });
        expect(hook.getCurrent().entries).toBe(rows);
    });
});
