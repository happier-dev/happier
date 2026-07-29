import type { Ionicons } from '@expo/vector-icons';

import { resolvePluginUiIoniconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { resolvePluginDisplayString } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import { canRenderPluginUiProjectionEntry, type PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type {
    RightSidebarPluginTabDefinition,
    RightSidebarScope,
} from './rightSidebarBuiltinTabs';

const RESERVED_BUILTIN_TAB_IDS = new Set([
    'git',
    'files',
    'agents',
    'terminal',
    'browser',
    'services',
]);

type UnknownRecord = Readonly<Record<string, unknown>>;

export type ResolveRightSidebarPluginTabsInput = Readonly<{
    scope: RightSidebarScope;
    placements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
    policyContext?: PluginUiPolicyEvaluationContext;
}>;

function readRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePluginTabSlug(value: string): string {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : 'tab';
}

function resolvePluginTabLabel(placement: PluginUiSurfacePlacementProjection): string {
    // UX-1: `labelKey`/`titleKey` are translation KEYS (resolved via the catalog, the same
    // precedence the built-in tabs use), `developerFallback`/`label` are literals, and the
    // descriptorId is the last-resort fallback so an unresolved key never renders raw.
    return resolvePluginDisplayString({
        developerFallback: placement.display.developerFallback,
        literals: [placement.display.label],
        keys: [placement.display.labelKey, placement.display.titleKey],
        fallback: placement.descriptorId,
    }) ?? placement.descriptorId;
}

function resolvePluginTabIcon(placement: PluginUiSurfacePlacementProjection): keyof typeof Ionicons.glyphMap {
    const token = readString(placement.display.iconToken) ?? readString(placement.display.icon);
    return resolvePluginUiIoniconName(token);
}

function resolveDisabledReason(
    placement: PluginUiSurfacePlacementProjection,
    tabSlug: string,
    policyContext: PluginUiPolicyEvaluationContext | undefined,
): string | null {
    if (RESERVED_BUILTIN_TAB_IDS.has(tabSlug)) {
        return 'right_sidebar_tab_id_reserved';
    }
    if (placement.availability.state !== 'available') {
        return placement.availability.reason;
    }
    if (!canRenderPluginUiProjectionEntry(placement, policyContext)) {
        return 'policy_deferred';
    }
    return null;
}

function shouldHideDisabledTab(rightSidebar: UnknownRecord, disabledReason: string | null): boolean {
    return disabledReason !== null && rightSidebar.disabledPolicy !== 'disable';
}

export function resolveRightSidebarPluginTabs(
    input: ResolveRightSidebarPluginTabsInput,
): readonly RightSidebarPluginTabDefinition[] {
    const generation = input.projectionGeneration ?? null;
    const tabs: RightSidebarPluginTabDefinition[] = [];
    const seenTabIds = new Set<string>();

    for (const placement of input.placements ?? []) {
        const rightSidebar = readRecord(placement.rightSidebar);
        if (!rightSidebar || rightSidebar.scope !== input.scope) {
            continue;
        }

        const tabSlug = normalizePluginTabSlug(
            readString(rightSidebar.tabId) ?? placement.descriptorId,
        );
        const disabledReason = resolveDisabledReason(placement, tabSlug, input.policyContext);
        if (shouldHideDisabledTab(rightSidebar, disabledReason)) {
            continue;
        }

        const tabId = `plugin:${placement.pluginId}:${tabSlug}` as const;
        if (seenTabIds.has(tabId)) {
            continue;
        }
        seenTabIds.add(tabId);

        const mobile = readRecord(rightSidebar.mobile);
        tabs.push(Object.freeze({
            id: tabId,
            owner: 'plugin',
            label: resolvePluginTabLabel(placement),
            icon: resolvePluginTabIcon(placement),
            order: readNumber(rightSidebar.order) ?? placement.order ?? Number.MAX_SAFE_INTEGER,
            scopes: Object.freeze([input.scope]),
            ...(mobile?.enabled === true ? {
                mobileSurfaces: Object.freeze({ [input.scope]: 'plugin' }),
            } : {}),
            ...(disabledReason ? { disabledReason } : {}),
            placement,
            plugin: Object.freeze({
                pluginId: placement.pluginId,
                descriptorId: placement.descriptorId,
                generation,
            }),
            retentionKey: `${tabId}:${generation ?? 'unknown'}`,
        }));
    }

    return Object.freeze(tabs.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)));
}
