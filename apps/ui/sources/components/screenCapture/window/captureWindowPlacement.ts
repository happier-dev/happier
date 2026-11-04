import { z } from 'zod/mini';

import { hideCaptureWindow, presentCaptureWindow, readCaptureWindowPlacement, type CaptureWindowPosition } from '@/desktop/capture/captureWindowHost';
import { createPersistentUiState, UiStatePersistenceError } from '@/sync/domains/state/persistentUiState';
import type { CaptureRect } from './resolveCaptureWindowFrame';

const positionSchema = z.catch(z.nullable(z.object({ x: z.number(), y: z.number() })), null);
const positionState = createPersistentUiState('capture-window-position-v1', value => positionSchema.parse(value));

/** Position is sampled at existing frame/close boundaries, never per drag event or while hidden. */
export function createCaptureWindowPlacement() {
    let expected: Pick<CaptureRect, 'x' | 'y'> | null = null;
    const rememberDrag = (position: CaptureWindowPosition | null) => {
        if (!position || !expected) return;
        // Tauri positions land on physical pixels; fractional logical coordinates are not a drag.
        if (Math.round(position.x * position.scale) === Math.round(expected.x * position.scale)
            && Math.round(position.y * position.scale) === Math.round(expected.y * position.scale)) return;
        try { positionState.set('centred', { x: position.x, y: position.y }); }
        catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[capture-window] Window position could not be remembered.');
        }
    };
    return {
        remembered: positionState.read('centred') ?? null,
        readPreviousFrame: readCaptureWindowPlacement,
        /** `glassRadius`: the resting card's radius when it fills `frame` (see `presentCaptureWindow`). */
        async present(frame: CaptureRect, signal?: AbortSignal, glassRadius: number | null = null): Promise<void> {
            if (signal?.aborted) return;
            const position = await presentCaptureWindow(frame, { glassRadius });
            if (signal?.aborted) return;
            rememberDrag(position);
            expected = frame;
        },
        async hide(): Promise<void> {
            rememberDrag(await hideCaptureWindow());
            expected = null;
        },
    };
}
