import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol';

export type TerminalSurfaceState = Readonly<{
    terminalId: string | null;
    cursor: number;
    output: string;
    detectedUrl: DaemonTerminalStreamEventUrl | null;
}>;

const TERMINAL_SURFACE_CACHE_MAX_ENTRIES = 12;
const TERMINAL_SURFACE_CACHE_MAX_OUTPUT_CHARS = 64_000;

const terminalSurfaceStateCache = new Map<string, TerminalSurfaceState>();

export function createEmptyTerminalSurfaceState(): TerminalSurfaceState {
    return {
        terminalId: null,
        cursor: 0,
        output: '',
        detectedUrl: null,
    };
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

export function replaceTerminalSurfaceState(terminalKey: string, state: TerminalSurfaceState): TerminalSurfaceState {
    const nextState = {
        ...state,
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
