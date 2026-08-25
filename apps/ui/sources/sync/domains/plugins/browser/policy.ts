import {
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy/evaluate';
import { resolvePluginLocalizedText, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginBrowserProjectionEntry } from './targets';

export type PluginBrowserPolicyDecision = Readonly<{
    visible: boolean;
    enabled: boolean;
    unavailableReason: string | null;
}>;

const DEFERRED_POLICY_FIELDS = [
    'visibility',
    'enabled',
    'featureGate',
    'compatibility',
    'availability',
] as const;

function hasRequiredPolicyValue(policy: unknown): boolean {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        return false;
    }
    const value = policy as Readonly<Record<string, unknown>>;
    return (Array.isArray(value.requiredFeatureIds) && value.requiredFeatureIds.length > 0)
        || (Array.isArray(value.requiredPermissionIds) && value.requiredPermissionIds.length > 0)
        || typeof value.profileMode === 'string';
}

/**
 * Whether a browser entry DECLARES any host-evaluated policy field. Retained for
 * diagnostics; declared policy is now EVALUATED (Phase 1.1) via the shared
 * `evaluatePluginUiPolicy`, not silently hidden.
 */
export function hasDeferredPluginBrowserPolicy(
    entry: PluginBrowserProjectionEntry | null | undefined,
): boolean {
    if (!entry) {
        return false;
    }
    return DEFERRED_POLICY_FIELDS.some((field) => entry[field] !== undefined)
        || hasRequiredPolicyValue(entry.policy);
}

/**
 * Canonical render/use gate for a plugin browser projection entry. Shares the
 * single policy evaluator with the plugin-UI surfaces: declared
 * `visibility/enabled/featureGate/compatibility` and `policy.{requiredFeatureIds,
 * requiredPermissionIds, profileMode}` are EVALUATED against the host context.
 *
 * The context is optional so the existing pure callers keep working; gating
 * signals that REQUIRE a resolver fail closed when none is supplied.
 */
export function canUsePluginBrowserProjectionEntry(
    entry: PluginBrowserProjectionEntry | null | undefined,
    ctx: PluginUiPolicyEvaluationContext = {},
): boolean {
    const decision = resolvePluginBrowserPolicyDecision(entry, ctx);
    return decision.visible && decision.enabled;
}

function readLocalizedText(
    value: unknown,
    pluginId: string,
    localize?: PluginLocalizedTextResolver,
): string | null {
    const resolved = localize?.(pluginId, value) ?? resolvePluginLocalizedText({
        projection: null,
        pluginId,
        value,
    });
    const normalized = resolved.trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Browser presentation policy preserves the shared evaluator's visible/enabled split. Disabled
 * entries remain visible and expose the author-supplied reason; hidden entries remain absent.
 */
export function resolvePluginBrowserPolicyDecision(
    entry: PluginBrowserProjectionEntry | null | undefined,
    ctx: PluginUiPolicyEvaluationContext = {},
    localize?: PluginLocalizedTextResolver,
): PluginBrowserPolicyDecision {
    if (!entry) {
        return { visible: false, enabled: false, unavailableReason: null };
    }
    const decision = evaluatePluginUiPolicy(entry, ctx);
    if (!decision.visible || decision.enabled) {
        return {
            visible: decision.visible,
            enabled: decision.enabled,
            unavailableReason: null,
        };
    }
    const availability = entry.availability;
    const pluginId = typeof entry.pluginId === 'string' ? entry.pluginId : null;
    const disabledReason = pluginId && availability && typeof availability === 'object' && !Array.isArray(availability)
        ? readLocalizedText(
            (availability as Readonly<{ disabledReason?: unknown }>).disabledReason,
            pluginId,
            localize,
        )
        : null;
    return {
        visible: true,
        enabled: false,
        unavailableReason: disabledReason ?? decision.diagnostics[0] ?? 'plugin_browser_action_unavailable',
    };
}
