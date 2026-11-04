import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createCaptureWindowPlacement } from './captureWindowPlacement';
import { resolveCaptureWindowFrame } from './resolveCaptureWindowFrame';

describe('Capture window position memory', () => {
    afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); });

    it('remembers the last manual drag at a frame boundary, not the opening or pill positions', async () => {
        clearPersistenceStorage();
        let position = { x: 0, y: 0, scale: 2 };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: { frame?: { x: number; y: number } }) => {
            const previous = position;
            if (command === 'desktop_capture_window_present' && args?.frame) {
                position = { ...args.frame, scale: 2 };
                return previous;
            }
            if (command === 'desktop_capture_window_hide') return previous;
            if (command === 'desktop_capture_window_ready') return true;
            throw new Error('Unexpected native window command');
        } });
        const placement = createCaptureWindowPlacement();
        expect(placement.remembered).toBeNull();
        const opened = { x: 100.2, y: 200.2, width: 740, height: 500 };
        await placement.present(opened);
        // Native positions are physical-pixel rounded, not evidence of a manual drag.
        position = { x: 100, y: 200, scale: 2 };
        await placement.present({ ...opened, height: 480 });
        expect(createCaptureWindowPlacement().remembered).toBeNull();
        position = { x: -420, y: 80, scale: 2 };
        await placement.present({ x: 150, y: 600, width: 460, height: 52 });
        await placement.hide();
        expect(createCaptureWindowPlacement().remembered).toEqual({ x: -420, y: 80 });

        const next = createCaptureWindowPlacement();
        const input = { picture: { width: 500, height: 300 }, workArea: { x: -1000, y: 0, width: 2400, height: 1000 },
            metrics: { gutter: 24, screenInset: 24, chromeTop: 68, chromeBottom: 124, floorWidth: 740 },
            remembered: next.remembered };
        expect(resolveCaptureWindowFrame({ ...input, origin: null }).window).toMatchObject({ x: -420, y: 80 });
        expect(resolveCaptureWindowFrame({ ...input, origin: { x: 300, y: 200, width: 500, height: 300 } }).window.x).not.toBe(-420);
    });

    it('remembers a manual drag when the person closes without another frame transition', async () => {
        clearPersistenceStorage();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) =>
            command === 'desktop_capture_window_hide' ? { x: 80, y: 90, scale: 1 } : { x: 0, y: 0, scale: 1 } });
        const placement = createCaptureWindowPlacement();
        await placement.present({ x: 100, y: 200, width: 740, height: 500 });
        await placement.hide();
        expect(createCaptureWindowPlacement().remembered).toEqual({ x: 80, y: 90 });
    });
});
