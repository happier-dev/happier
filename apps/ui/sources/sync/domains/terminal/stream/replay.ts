import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol/daemon/terminal';

import type { TerminalStreamCursor } from './model';

export type TerminalPreviewState = Readonly<{
    terminalId: string | null;
    cursor: number;
    cursorMode: TerminalStreamCursor['mode'];
    output: string;
    detectedUrl: DaemonTerminalStreamEventUrl | null;
}>;

export type TerminalReplayPlan = Readonly<{
    initialCursor: TerminalStreamCursor;
    renderPreview: boolean;
    clearRenderer: boolean;
    replacePreviewOnReplay: boolean;
}>;

export const TERMINAL_PREVIEW_MAX_OUTPUT_CHARS = 64_000;

export function createEmptyTerminalPreviewState(): TerminalPreviewState {
    return {
        terminalId: null,
        cursor: 0,
        cursorMode: 'byte-offset',
        output: '',
        detectedUrl: null,
    };
}

export function trimTerminalPreviewOutput(output: string): string {
    if (output.length <= TERMINAL_PREVIEW_MAX_OUTPUT_CHARS) {
        return output;
    }
    return output.slice(output.length - TERMINAL_PREVIEW_MAX_OUTPUT_CHARS);
}

export function appendTerminalPreviewText(state: TerminalPreviewState, text: string): TerminalPreviewState {
    if (!text) {
        return state;
    }
    return {
        ...state,
        output: trimTerminalPreviewOutput(state.output + text),
    };
}

export function resolveTerminalReplayPlan(input: Readonly<{
    cachedTerminalId: string | null;
    ensuredTerminalId: string;
    reused: boolean;
    cachedOutput: string;
    replayMode: TerminalStreamCursor['mode'];
    restoredCursor?: TerminalStreamCursor;
}>): TerminalReplayPlan {
    const sameTerminal = input.cachedTerminalId === input.ensuredTerminalId;
    if (input.reused && sameTerminal && input.restoredCursor?.mode === input.replayMode) {
        return { initialCursor: input.restoredCursor, renderPreview: false,
            clearRenderer: false, replacePreviewOnReplay: false };
    }
    const canRenderPreview = input.reused && sameTerminal && input.cachedOutput.length > 0;

    return {
        initialCursor: {
            mode: input.replayMode,
            // A new renderer needs the retained bytes, not the previous renderer's tail cursor.
            value: 0,
        },
        renderPreview: canRenderPreview,
        clearRenderer: !canRenderPreview,
        replacePreviewOnReplay: canRenderPreview,
    };
}
