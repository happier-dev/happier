import type { BrowserTargetSuggestionV1, BrowserViewTargetV1 } from "@happier-dev/protocol";

export type BrowserTargetSuggestion = BrowserTargetSuggestionV1;
export type BrowserViewTarget = BrowserViewTargetV1;

export type BrowserTargetRefreshStatus = "idle" | "refreshing" | "error";

export type BrowserViewState = Readonly<{
    currentTarget: BrowserViewTarget | null;
    suggestions: readonly BrowserTargetSuggestion[];
    suggestionGeneration: number;
    refreshStatus: BrowserTargetRefreshStatus;
    refreshError: string | null;
}>;
