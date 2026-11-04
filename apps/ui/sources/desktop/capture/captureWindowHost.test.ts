import { afterEach, describe, expect, it, vi } from 'vitest';

import { presentCaptureWindow } from './captureWindowHost';

describe('Capture native presentation', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('acknowledges the shared capture, permission and control host only after two paint frames', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
        const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => null);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const shown = presentCaptureWindow({ x: 10, y: 20, width: 253, height: 44 }, { activate: false, glassRadius: 22 });
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        const paints = () => invoke.mock.calls.filter(call => call[0] === 'desktop_capture_window_ready');
        expect(paints()).toHaveLength(0);
        expect(frames).toHaveLength(1);
        frames.shift()!(0);
        await Promise.resolve();
        expect(paints()).toHaveLength(0);
        frames.shift()!(16);
        await shown;
        expect(invoke).toHaveBeenCalledWith('desktop_capture_window_present', expect.objectContaining({ activate: false, glassRadius: 22 }));
        expect(invoke).toHaveBeenCalledWith('desktop_capture_window_ready', { phase: 'paint' });
    });

});
