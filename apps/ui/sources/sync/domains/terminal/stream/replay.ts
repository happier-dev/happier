import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol';

export type TerminalPreviewState = Readonly<{
    terminalId: string | null;
    cursor: number;
    output: string;
    detectedUrl: DaemonTerminalStreamEventUrl | null;
}>;

export type TerminalReplayPlan = Readonly<{
    initialCursor: number;
    renderPreview: boolean;
    clearRenderer: boolean;
}>;

export const TERMINAL_PREVIEW_MAX_OUTPUT_CHARS = 64_000;

export function createEmptyTerminalPreviewState(): TerminalPreviewState {
    return {
        terminalId: null,
        cursor: 0,
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
    cachedCursor: number;
}>): TerminalReplayPlan {
    const sameTerminal = input.cachedTerminalId === input.ensuredTerminalId;
    const canRenderPreview = input.reused && sameTerminal && input.cachedOutput.length > 0;

    return {
        initialCursor: canRenderPreview ? Math.max(0, input.cachedCursor) : 0,
        renderPreview: canRenderPreview,
        clearRenderer: !canRenderPreview,
    };
}
