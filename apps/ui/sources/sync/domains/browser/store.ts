import type { BrowserTargetSuggestionV1, BrowserViewTargetV1 } from "@happier-dev/protocol";

import type { BrowserViewState } from "./types";

export function createBrowserViewState(): BrowserViewState {
    return {
        currentTarget: null,
        suggestions: [],
        suggestionGeneration: 0,
        refreshStatus: "idle",
        refreshError: null,
    };
}

export function openBrowserTarget(state: BrowserViewState, target: BrowserViewTargetV1): BrowserViewState {
    return {
        ...state,
        currentTarget: target,
    };
}

export function beginBrowserTargetSuggestionRefresh(state: BrowserViewState): BrowserViewState {
    return {
        ...state,
        refreshStatus: "refreshing",
        refreshError: null,
    };
}

export function applyBrowserTargetSuggestions(
    state: BrowserViewState,
    input: Readonly<{
        suggestions: readonly BrowserTargetSuggestionV1[];
        generation: number;
    }>,
): BrowserViewState {
    if (input.generation < state.suggestionGeneration) {
        return state;
    }
    return {
        ...state,
        suggestions: input.suggestions,
        suggestionGeneration: input.generation,
        refreshStatus: "idle",
        refreshError: null,
    };
}

export function failBrowserTargetSuggestionRefresh(state: BrowserViewState, refreshError: string): BrowserViewState {
    return {
        ...state,
        refreshStatus: "error",
        refreshError,
    };
}
