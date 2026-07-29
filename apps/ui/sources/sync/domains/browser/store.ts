import type {
    BrowserCommandV1,
    BrowserPlatformV1,
    BrowserTargetPolicyDecisionV1,
    BrowserTargetSuggestionV1,
    BrowserViewTargetV1,
} from "@happier-dev/protocol";

import type { DesktopWebViewNativeAvailability } from "./adapters/desktopWebView";
import type { BrowserViewState } from "./types";
import { createBrowserControlState, dispatchBrowserControlCommand } from "./control";

export const DEFAULT_BROWSER_SESSION_ID = "browser_session_default";

function resolveDefaultBrowserViewId(target: BrowserViewTargetV1): string {
    return `browser_view:${target.targetId}`;
}

/**
 * Canonical `viewId` for a browser target's content/view record. Exposed so the open-routing
 * owner (and any caller) agrees on the same identity as {@link openBrowserTarget} without
 * duplicating the `browser_view:${targetId}` rule. Ordering authority stays in `control/**`.
 */
export function resolveBrowserViewIdForTarget(target: BrowserViewTargetV1): string {
    return resolveDefaultBrowserViewId(target);
}

function resolveInitialCurrentUrl(target: BrowserViewTargetV1): string | undefined {
    return target.kind === "externalUrl" ? target.url : undefined;
}

export function createBrowserViewState(): BrowserViewState {
    return {
        ...createBrowserControlState(),
        suggestions: [],
        suggestionGeneration: 0,
        refreshStatus: "idle",
        refreshError: null,
    };
}

export function openBrowserTarget(
    state: BrowserViewState,
    target: BrowserViewTargetV1,
    options: Readonly<{
        browserSessionId?: string;
        viewId?: string;
        platform: BrowserPlatformV1;
        currentUrl?: string;
        currentUrlExpiresAt?: number;
        targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
        desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    }>,
): BrowserViewState {
    const viewId = options.viewId ?? resolveDefaultBrowserViewId(target);
    const command = {
        kind: "openView",
        commandId: `browser_command:${viewId}:open`,
        browserSessionId: options.browserSessionId ?? DEFAULT_BROWSER_SESSION_ID,
        viewId,
        target,
        platform: options.platform,
        currentUrl: options.currentUrl ?? resolveInitialCurrentUrl(target),
        currentUrlExpiresAt: options.currentUrlExpiresAt,
        focus: true,
    } satisfies BrowserCommandV1;
    const result = dispatchBrowserControlCommand(state, command, {
        targetPolicyDecision: options.targetPolicyDecision,
        desktopWebViewAvailability: options.desktopWebViewAvailability,
    });
    return {
        ...result.state,
        suggestions: state.suggestions,
        suggestionGeneration: state.suggestionGeneration,
        refreshStatus: state.refreshStatus,
        refreshError: state.refreshError,
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
