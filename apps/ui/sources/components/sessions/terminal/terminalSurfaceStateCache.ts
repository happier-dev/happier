import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol';

import {
    appendTerminalPreviewText as appendTerminalPreviewTextForStream,
    createEmptyTerminalPreviewState,
    TERMINAL_PREVIEW_MAX_OUTPUT_CHARS,
} from '@/sync/domains/terminal/stream/replay';
import type { TerminalStreamCursor } from '@/sync/domains/terminal/stream/model';

export type TerminalSurfaceState = Readonly<{
    terminalId: string | null;
    cursor: number;
    cursorMode: TerminalStreamCursor['mode'];
    output: string;
    detectedUrl: DaemonTerminalStreamEventUrl | null;
}>;

type TerminalSurfaceStateInput = Omit<TerminalSurfaceState, 'cursorMode'> & Readonly<{
    cursorMode?: TerminalStreamCursor['mode'];
}>;

const TERMINAL_SURFACE_CACHE_MAX_ENTRIES = 12;
const TERMINAL_SURFACE_CACHE_MAX_OUTPUT_CHARS = TERMINAL_PREVIEW_MAX_OUTPUT_CHARS;

const terminalSurfaceStateCache = new Map<string, TerminalSurfaceState>();

export function createEmptyTerminalSurfaceState(): TerminalSurfaceState {
    return createEmptyTerminalPreviewState();
}

export function readTerminalSurfaceState(terminalKey: string): TerminalSurfaceState | null {
    const cached = terminalSurfaceStateCache.get(terminalKey) ?? null;
    if (!cached) {
        return null;
    }
    terminalSurfaceStateCache.delete(terminalKey);
    terminalSurfaceStateCache.set(terminalKey, cached);
    return cached;
}

export function replaceTerminalSurfaceState(terminalKey: string, state: TerminalSurfaceStateInput): TerminalSurfaceState {
    const nextState = {
        ...state,
        cursorMode: state.cursorMode ?? 'byte-offset',
        output: trimTerminalSurfaceOutput(state.output),
    } satisfies TerminalSurfaceState;

    terminalSurfaceStateCache.delete(terminalKey);
    terminalSurfaceStateCache.set(terminalKey, nextState);
    evictOverflowTerminalSurfaceStates();
    return nextState;
}

export function updateTerminalSurfaceState(
    terminalKey: string,
    updater: (current: TerminalSurfaceState) => TerminalSurfaceState,
): TerminalSurfaceState {
    const current = readTerminalSurfaceState(terminalKey) ?? createEmptyTerminalSurfaceState();
    return replaceTerminalSurfaceState(terminalKey, updater(current));
}

function evictOverflowTerminalSurfaceStates(): void {
    while (terminalSurfaceStateCache.size > TERMINAL_SURFACE_CACHE_MAX_ENTRIES) {
        const oldestKey = terminalSurfaceStateCache.keys().next().value;
        if (typeof oldestKey !== 'string') {
            return;
        }
        terminalSurfaceStateCache.delete(oldestKey);
    }
}

function trimTerminalSurfaceOutput(output: string): string {
    if (output.length <= TERMINAL_SURFACE_CACHE_MAX_OUTPUT_CHARS) {
        return output;
    }
    return output.slice(output.length - TERMINAL_SURFACE_CACHE_MAX_OUTPUT_CHARS);
}

export function appendTerminalPreviewText(
    state: TerminalSurfaceState,
    text: string,
): TerminalSurfaceState {
    return appendTerminalPreviewTextForStream(state, text);
}
