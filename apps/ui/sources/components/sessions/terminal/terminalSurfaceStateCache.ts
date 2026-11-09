import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol/daemon/terminal';

import {
    appendTerminalPreviewText as appendTerminalPreviewTextForStream,
    createEmptyTerminalPreviewState,
    TERMINAL_PREVIEW_MAX_OUTPUT_CHARS,
} from '@/sync/domains/terminal/stream/replay';
import type { TerminalStreamCursor, TerminalOutputRetention } from '@/sync/domains/terminal/stream/model';
import type { EmbeddedTerminalRendererResource, TerminalFindSnapshot } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TerminalUtf8ProjectionDecoder } from '@/sync/domains/terminal/stream/runtime';

export type TerminalSurfaceState = Readonly<{
    terminalId: string | null;
    cursor: number;
    cursorMode: TerminalStreamCursor['mode'];
    output: string;
    /** Streaming UTF-8 projection state travels with the parsed renderer. */
    previewDecoder?: TerminalUtf8ProjectionDecoder;
    /** The parsed web renderer survives a move without another raw-output cache. */
    rendererResource?: EmbeddedTerminalRendererResource;
    /** Account that supplied this ephemeral renderer preview. */
    scope?: ServerAccountScope;
    detectedUrl: DaemonTerminalStreamEventUrl | null;
    outputRetention?: TerminalOutputRetention;
    /** Observed native termination, retained with this process's output across view remounts. */
    exit?: Readonly<{ exitCode: number | null; signal: number | null; scope: ServerAccountScope | null }>;
    /** Ephemeral same-surface renderer handoff; matching/counts belong to the new renderer. */
    find?: Pick<TerminalFindSnapshot, 'open' | 'query' | 'options'>;
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
    evictOverflowTerminalSurfaceStates();
    return cached;
}

export function replaceTerminalSurfaceState(terminalKey: string, state: TerminalSurfaceStateInput): TerminalSurfaceState {
    const previous = terminalSurfaceStateCache.get(terminalKey);
    if (previous?.rendererResource && previous.rendererResource !== state.rendererResource) {
        previous.rendererResource.dispose();
    }
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
        // An attached renderer contains visible history that may no longer exist in
        // the daemon ring. Reclaim dormant entries before releasing a live host.
        const oldestKey = [...terminalSurfaceStateCache].find(([, state]) => state.rendererResource?.attached !== true)?.[0];
        if (typeof oldestKey !== 'string') {
            return;
        }
        terminalSurfaceStateCache.get(oldestKey)?.rendererResource?.dispose();
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
