import type {
    ActionExecutorContext,
    BrowserPlatformV1,
    BrowserViewTargetV1,
    RuntimeActionExecute,
} from '@happier-dev/protocol';
import {
    isRuntimeActionIdV1,
    resolveExpectedHostActionPolicyOwner,
    resolveRuntimeActionHostEffectClass,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginSurfaceHostApi } from '@/components/plugins/surfaces';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

type JsonRecord = Readonly<Record<string, PluginUiJsonValueV1>>;

type BrowserPanelHostActionDescriptor = Readonly<{
    actionId: string;
    placement: 'browser.panel';
    scope: JsonRecord;
    policyOwner: string;
    effect: string;
    requiredFeatureIds: readonly string[];
    requiredPermissionIds: readonly string[];
}>;

/**
 * Project a {@link BrowserPlatformV1} onto a {@link LocalServicePreviewPlatform} for the plugin
 * hosted-web / preview surfaces. Both unions now share the same members (incl. `desktop`, Phase
 * 5.5), so this is the identity — the historical `desktop → 'web'` downgrade was a residue of the
 * finding #13 leak (when `LocalServicePreviewPlatform` could not represent `desktop`) and is removed
 * so a desktop plugin surface keeps its desktop identity rather than collapsing to a web tab.
 */
export function toLocalServicePreviewPlatform(platform: BrowserPlatformV1): LocalServicePreviewPlatform {
    return platform;
}

function readJsonRecord(value: PluginUiJsonValueV1 | undefined): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null;
}

function readUnknownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
}

function readJsonScope(value: unknown): JsonRecord | null {
    const scope = readUnknownRecord(value);
    return scope ? scope as JsonRecord : null;
}

function readBrowserPanelHostActionDescriptor(value: unknown): BrowserPanelHostActionDescriptor | null {
    const descriptor = readUnknownRecord(value);
    const actionId = readString(descriptor?.actionId);
    const scope = readJsonScope(descriptor?.scope);
    const policyOwner = readString(descriptor?.policyOwner);
    const effect = readString(descriptor?.effect);
    if (
        !actionId
        || descriptor?.placement !== 'browser.panel'
        || !scope
        || !policyOwner
        || !effect
    ) {
        return null;
    }

    return Object.freeze({
        actionId,
        placement: 'browser.panel',
        scope,
        policyOwner,
        effect,
        requiredFeatureIds: Object.freeze(readStringArray(descriptor.requiredFeatureIds)),
        requiredPermissionIds: Object.freeze(readStringArray(descriptor.requiredPermissionIds)),
    });
}

function selectBrowserPanelHostAction(
    placement: PluginUiSurfacePlacementProjection,
    actionId: string,
): BrowserPanelHostActionDescriptor | null {
    const rawHostActions = Array.isArray(placement.hostActions) ? placement.hostActions : [];
    for (const rawHostAction of rawHostActions) {
        const hostAction = readBrowserPanelHostActionDescriptor(rawHostAction);
        if (hostAction?.actionId === actionId) {
            return hostAction;
        }
    }
    return null;
}

function unavailable(reason: string): PluginUiJsonValueV1 {
    return {
        state: 'unavailable',
        reason,
        diagnostics: [reason],
    };
}

function readScopeKind(scope: JsonRecord): string | null {
    return readString(scope.kind);
}

/**
 * Canonical view-id derivation for a focused browser target. Delegates to the browser store owner
 * so the declared-scope check compares the SAME identity the executor will act on.
 */
function resolveFocusedBrowserViewId(target: BrowserViewTargetV1 | null | undefined): string | null {
    return target ? resolveBrowserViewIdForTarget(target) : null;
}

/**
 * Extract the browser-view identity a dispatch payload intends to act on, if any. The runtime
 * browser ActionSpecs key on `input.viewId` (see `RuntimeBrowserViewInputSchema`); a plugin that
 * declares a target view supplies it here. Absent ⇒ the action implicitly binds to the focused
 * view (the declared `browserView` scope), which is allowed.
 */
function readRequestedBrowserViewId(input: PluginUiJsonValueV1 | undefined): string | null {
    const record = readJsonRecord(input);
    return record ? readString(record.viewId) : null;
}

/**
 * Pre-dispatch revalidation of a declared browser-panel host action (PR-12, Seam 3).
 *
 * Re-derives policy parity from the SAME canonical resolvers the contribution-time
 * `superRefine` uses (`resolveExpectedHostActionPolicyOwner` /
 * `resolveRuntimeActionHostEffectClass`) — caller-asserted parity in the descriptor is
 * NEVER trusted at dispatch. Feature and live-scope gates are re-checked against current state.
 * Legacy descriptors carrying permission ids have no generated-UI permission authority and deny
 * unconditionally. Any failure denies fail-closed.
 */
function revalidateBrowserPanelHostActionDispatch(params: Readonly<{
    hostAction: BrowserPanelHostActionDescriptor;
    focusedTarget?: BrowserViewTargetV1 | null;
    requestedBrowserViewId?: string | null;
    isFeatureEnabled?: (featureId: string) => boolean;
}>): Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }> {
    const { hostAction } = params;

    // 1. The action id must be a runtime ActionSpec id.
    if (!isRuntimeActionIdV1(hostAction.actionId)) {
        return { ok: false, reason: 'browser_panel_host_action_denied_action_id' };
    }

    // 2. Policy owner re-derived from the canonical resolver (not the descriptor).
    const expectedPolicyOwner = resolveExpectedHostActionPolicyOwner(hostAction.actionId);
    if (expectedPolicyOwner === null || hostAction.policyOwner !== expectedPolicyOwner) {
        return { ok: false, reason: 'browser_panel_host_action_denied_policy_owner' };
    }

    // 3. Effect re-derived from the canonical resolver (never downgraded).
    const expectedEffect = resolveRuntimeActionHostEffectClass(hostAction.actionId);
    if (expectedEffect === null || hostAction.effect !== expectedEffect) {
        return { ok: false, reason: 'browser_panel_host_action_denied_effect' };
    }

    // 4. Feature gates re-checked against live state (fail-closed on missing checker).
    if (hostAction.requiredFeatureIds.length > 0) {
        const isFeatureEnabled = params.isFeatureEnabled;
        if (!isFeatureEnabled || !hostAction.requiredFeatureIds.every((featureId) => isFeatureEnabled(featureId) === true)) {
            return { ok: false, reason: 'browser_panel_host_action_denied_feature' };
        }
    }

    // 5. Generated UI has no durable-grant capability mapping. V2 declares required host methods,
    // and its current projection emits no host actions. A legacy descriptor with permission ids
    // cannot be safely interpreted as a project-scoped grant capability, so it always denies.
    if (hostAction.requiredPermissionIds.length > 0) {
        return { ok: false, reason: 'browser_panel_host_action_denied_permission' };
    }

    // 6. Scope (FINALIZATION-PLAN §3.6, refs #7c/review #5): the `browserView` scope binds the
    //    host action to the ACTUALLY-FOCUSED browser-session-view. Enforced in two parts:
    //    (a) presence — no focused target ⇒ nothing to scope to ⇒ deny;
    //    (b) match — if the dispatch payload names a target view (`input.viewId`), it MUST resolve
    //        to the focused view's canonical id. A payload pointing at
    //        any other view is an attempt to act outside the declared scope ⇒ deny. A payload that
    //        names no view implicitly binds to the focused view (the declared scope) ⇒ allowed.
    if (readScopeKind(hostAction.scope) === 'browserView') {
        const focusedBrowserViewId = resolveFocusedBrowserViewId(params.focusedTarget);
        if (!focusedBrowserViewId) {
            return { ok: false, reason: 'browser_panel_host_action_denied_scope' };
        }
        const requestedBrowserViewId = params.requestedBrowserViewId ?? null;
        if (requestedBrowserViewId !== null && requestedBrowserViewId !== focusedBrowserViewId) {
            return { ok: false, reason: 'browser_panel_host_action_denied_scope_mismatch' };
        }
    }

    return { ok: true };
}

export function createBrowserPanelPluginSurfaceHostApi(params: Readonly<{
    focusedTarget?: BrowserViewTargetV1 | null;
    fallbackHostApi?: PluginSurfaceHostApi;
    placement: PluginUiSurfacePlacementProjection;
    platform: BrowserPlatformV1;
    /**
     * Canonical runtime-action dispatch bridge (`actionExecutor` → `runtimeActionExecute`).
     * Supplied by the host wiring (FP-BRW-HOST-1). Absent ⇒ fail-closed default posture.
     */
    runtimeActionExecute?: RuntimeActionExecute;
    actionExecutorContext?: ActionExecutorContext;
    isFeatureEnabled?: (featureId: string) => boolean;
}>): PluginSurfaceHostApi {
    return Object.freeze({
        platform: toLocalServicePreviewPlatform(params.platform),
        channel: 'internal',
        handleRequest: async (request: PluginUiHostApiRequestEnvelopeV1) => {
            if (request.method !== 'dispatchAction') {
                return params.fallbackHostApi
                    ? params.fallbackHostApi.handleRequest(request)
                    : unavailable('browser_panel_host_api_unavailable');
            }

            const requestPayload = readJsonRecord(request.payload);
            const actionId = readString(requestPayload?.actionId);
            if (!requestPayload || !actionId) {
                return unavailable('browser_panel_host_action_invalid_payload');
            }

            const hostAction = selectBrowserPanelHostAction(params.placement, actionId);
            if (!hostAction) {
                return unavailable('browser_panel_host_action_not_declared');
            }

            // Pre-dispatch revalidation (feature/legacy-permission/scope/effect/policyOwner),
            // re-derived from canonical resolvers — descriptor parity is not trusted.
            const revalidation = revalidateBrowserPanelHostActionDispatch({
                hostAction,
                focusedTarget: params.focusedTarget,
                requestedBrowserViewId: readRequestedBrowserViewId(requestPayload.input),
                ...(params.isFeatureEnabled ? { isFeatureEnabled: params.isFeatureEnabled } : {}),
            });
            if (!revalidation.ok) {
                return unavailable(revalidation.reason);
            }

            // Route through the canonical ActionExecutor/runtimeActionExecute bridge.
            // No bridge ⇒ fail-closed default.
            if (!params.runtimeActionExecute || !isRuntimeActionIdV1(hostAction.actionId)) {
                return unavailable('browser_panel_host_action_handler_unavailable');
            }

            const result = await params.runtimeActionExecute({
                actionId: hostAction.actionId,
                input: requestPayload.input ?? null,
                context: params.actionExecutorContext ?? {},
            });
            return result as PluginUiJsonValueV1;
        },
    });
}
