import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyCaptureFromUi } from './copyCaptureFromUi';

afterEach(() => vi.unstubAllGlobals());

describe('Capture UI copy Action capability', () => {
    it('copies the explicitly requested window text through Action admission without reading image pixels', async () => {
        const written: string[] = [];
        const commands: string[] = [];
        vi.stubGlobal('ClipboardItem', class { constructor(readonly data: Readonly<Record<string, Promise<Blob>>>) {} });
        const write = vi.fn(async (items: Array<{ data: Readonly<Record<string, Promise<Blob>>> }>) => {
            written.push(await (await items[0]!.data['text/plain'])!.text());
        });
        vi.stubGlobal('navigator', { clipboard: { write } });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (command === 'desktop_capture_window_text') return { status: 'ready', text: 'Visible selected window text', source: null };
            throw new Error(`Unexpected native command ${command}`);
        } });
        const pending = copyCaptureFromUi({ captureRef: 'kept', content: 'windowText' });
        expect(write).toHaveBeenCalledOnce();
        expect(await pending).toMatchObject({ ok: true, result: { status: 'copied' } });
        expect(written).toEqual(['Visible selected window text']);
        expect(commands).toEqual(['desktop_capture_window_text']);
    });

    it('never releases content to the clipboard on invalid admission or missing prepared pixels', async () => {
        let mutations = 0;
        const commands: string[] = [];
        vi.stubGlobal('ClipboardItem', class { constructor(readonly data: Readonly<Record<string, Promise<Blob>>>) {} });
        vi.stubGlobal('navigator', { clipboard: { write: async (items: Array<{ data: Readonly<Record<string, Promise<Blob>>> }>) => {
            await items[0]!.data['image/png'];
            mutations++;
        } } });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (command === 'desktop_capture_read_result') return { captureRef: 'kept', kind: 'still', path: '/Pictures/kept.png',
                mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1, origin: null, source: null, windowTextRef: null };
            if (command === 'desktop_capture_read_delivery_state') return { inUse: true,
                disclosure: { hasMarks: true, includeWindowText: false }, windowText: null };
            if (command === 'desktop_capture_read_prepared_png') throw 'prepared_missing';
            throw new Error(`Unexpected native command ${command}`);
        } });
        const prepare = vi.fn(async () => {});
        expect(await copyCaptureFromUi({ captureRef: '' }, prepare)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(prepare).not.toHaveBeenCalled();
        expect(commands).toEqual([]);
        expect(await copyCaptureFromUi({ captureRef: 'kept' }, async () => ({
            ok: false, errorCode: 'canvasUnavailable', error: 'canvasUnavailable',
        }))).toMatchObject({ ok: false, errorCode: 'canvasUnavailable' });
        expect(commands).toEqual([]);
        expect(await copyCaptureFromUi({ captureRef: 'kept' })).toMatchObject({ ok: false, errorCode: 'prepared_missing' });
        expect(mutations).toBe(0);
        expect(commands).not.toContain('desktop_capture_read_source_png');
    });

    it('starts the clipboard promise in the gesture and exposes only admitted prepared marked pixels by reference', async () => {
        const calls: string[] = [];
        let release = () => {};
        const prepared = new Promise<void>(resolve => { release = resolve; });
        const written: Uint8Array[] = [];
        let item: Readonly<Record<string, Promise<Blob>>> | null = null;
        vi.stubGlobal('ClipboardItem', class { constructor(readonly data: Readonly<Record<string, Promise<Blob>>>) { item = data; } });
        const write = vi.fn(async (items: Array<{ data: Readonly<Record<string, Promise<Blob>>> }>) => {
            const blob = await items[0]!.data['image/png'];
            written.push(new Uint8Array(await blob!.arrayBuffer()));
        });
        vi.stubGlobal('navigator', { clipboard: { write } });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            calls.push(command);
            if (command === 'desktop_capture_read_result') return { captureRef: 'kept', kind: 'still', path: '/Pictures/kept.png',
                mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1, origin: null, source: null, windowTextRef: null };
            if (command === 'desktop_capture_read_delivery_state') return { inUse: true,
                disclosure: { hasMarks: true, includeWindowText: false }, windowText: null };
            if (command === 'desktop_capture_read_prepared_png') return [9, 8, 7];
            throw new Error(`Unexpected native command ${command}`);
        } });
        const pending = copyCaptureFromUi({ captureRef: 'kept' }, () => prepared);
        expect(write).toHaveBeenCalledOnce();
        expect(item).not.toBeNull();
        expect(calls).toEqual([]);
        expect(written).toEqual([]);
        release();
        expect(await pending).toEqual({ ok: true, result: { captureRef: 'kept', status: 'copied' } });
        expect(written).toEqual([new Uint8Array([9, 8, 7])]);
        expect(calls.filter(command => command === 'desktop_capture_read_prepared_png')).toHaveLength(1);
        expect(calls).not.toContain('desktop_capture_read_source_png');
    });
});
