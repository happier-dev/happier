import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import {
    PluginUiActionDescriptorV1Schema,
    type PluginUiActionDescriptorV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginJsonValueV2Schema,
    type ActionExecutorContext,
} from '@happier-dev/protocol';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import {
    executePluginUiAction,
    type ExecutePluginUiActionResult,
    type PluginUiActionExecutorRunner,
    type PluginUiActionHostHandlers,
} from '@/components/plugins/surfaces/executePluginUiAction';
import { resolvePluginUiIoniconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import type {
    PluginUiProjectionModel,
    PluginUiSessionHeaderActionProjection,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import {
    machinePluginStructuredMessageActionExecute,
} from '@/sync/ops/machineContributionRegistryProjection';

export const PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX = 'plugin-ui:';

export type PluginSessionHeaderActionTransport =
    typeof machinePluginStructuredMessageActionExecute;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readTitle(action: PluginUiSessionHeaderActionProjection): Readonly<{
    key: string | null;
    fallback: string;
}> {
    if (typeof action.title === 'string') {
        return { key: null, fallback: action.title };
    }
    return {
        key: action.title.key,
        fallback: action.title.fallback,
    };
}

/**
 * Adapt the already-resolved contribution reference into the existing UI
 * executeAction descriptor. The UI projection owner only publishes a header
 * entry when its reference resolves to a current, UI-surfaced action.
 */
function parseHeaderActionDescriptor(
    action: PluginUiSessionHeaderActionProjection,
): PluginUiActionDescriptorV1 | null {
    const title = readTitle(action);
    const parsed = PluginUiActionDescriptorV1Schema.safeParse({
        id: action.descriptorId,
        kind: 'executeAction',
        labelKey: title.key ?? action.descriptorId,
        target: {
            actionId: action.qualifiedActionId,
        },
    });
    return parsed.success ? parsed.data : null;
}

function isSurfaceableHeaderAction(action: PluginUiSessionHeaderActionProjection): boolean {
    return parseHeaderActionDescriptor(action) !== null;
}

/**
 * Adapts the current projected header-action catalog to the daemon's canonical
 * generation-leased action RPC. The projection is presentation state only:
 * currentness, policy, and handler execution remain daemon-owned.
 */
export function createPluginSessionHeaderActionExecutor(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    machineId: string | null | undefined;
    serverId?: string | null;
    execute?: PluginSessionHeaderActionTransport;
}>): PluginUiActionExecutorRunner {
    const generation = params.projection?.generation ?? null;
    const machineId = params.machineId?.trim() ?? '';
    const qualifiedActionIds = new Set(
        Object.values(params.projection?.sessionHeaderActionsById ?? {})
            .map((entry) => entry.qualifiedActionId),
    );
    const execute = params.execute ?? machinePluginStructuredMessageActionExecute;
    return Object.freeze({
        execute: async (actionId, input, context) => {
            if (
                generation === null
                || machineId.length === 0
                || !qualifiedActionIds.has(actionId)
            ) {
                return {
                    ok: false,
                    errorCode: 'plugin_ui_action_unavailable',
                    error: 'plugin_ui_action_unavailable',
                };
            }
            const parsedInput = PluginJsonValueV2Schema.safeParse(input);
            if (!parsedInput.success) {
                return {
                    ok: false,
                    errorCode: 'plugin_ui_action_invalid_input',
                    error: 'plugin_ui_action_invalid_input',
                };
            }
            try {
                const result = await execute(machineId, {
                    ...(params.serverId ? { serverId: params.serverId } : {}),
                    expectedGeneration: String(generation),
                    qualifiedActionId: actionId,
                    input: parsedInput.data,
                    ...(context?.defaultSessionId
                        ? { sessionId: context.defaultSessionId }
                        : {}),
                    executionSurface: 'ui',
                });
                if (!result.supported) {
                    return {
                        ok: false,
                        errorCode: 'plugin_ui_action_runtime_unavailable',
                        error: 'plugin_ui_action_runtime_unavailable',
                    };
                }
                return result.result.ok
                    ? {
                        ok: true,
                        result: result.result.result,
                    }
                    : {
                        ok: false,
                        errorCode: result.result.code,
                        error: result.result.code,
                    };
            } catch {
                return {
                    ok: false,
                    errorCode: 'plugin_ui_action_runtime_unavailable',
                    error: 'plugin_ui_action_runtime_unavailable',
                };
            }
        },
    });
}

export function createPluginSessionHeaderActionMenuId(action: PluginUiSessionHeaderActionProjection): string {
    return `${PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX}${action.id}`;
}

export function createPluginSessionHeaderActionDropdownItems(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    iconColor: string;
    locale?: string | null;
}>): readonly DropdownMenuItem[] {
    const projection = params.projection;
    if (!projection) {
        return [];
    }

    return Object.values(projection.sessionHeaderActionsById)
        .map((action) => ({
            action,
            policy: evaluatePluginUiPolicy(action, {}),
        }))
        .filter(({ action, policy }) => policy.visible && isSurfaceableHeaderAction(action))
        .sort((left, right) => {
            const leftOrder = typeof left.action.order === 'number' ? left.action.order : 0;
            const rightOrder = typeof right.action.order === 'number' ? right.action.order : 0;
            return leftOrder - rightOrder || left.action.id.localeCompare(right.action.id);
        })
        .map(({ action, policy }): DropdownMenuItem => {
            const title = readTitle(action);
            return {
                id: createPluginSessionHeaderActionMenuId(action),
                title: resolvePluginUiText({
                    projection,
                    pluginId: action.pluginId,
                    key: title.key,
                    locale: params.locale,
                    fallback: title.fallback,
                }),
                icon: <Ionicons name={resolvePluginUiIoniconName(null)} size={16} color={params.iconColor} />,
                ...(policy.enabled ? {} : { disabled: true }),
            };
        });
}

function readRightSidebarTabSlug(placement: PluginUiSurfacePlacementProjection): string {
    const rightSidebar = readRecord(placement.rightSidebar);
    const tabId = rightSidebar?.tabId;
    const slug = (typeof tabId === 'string' && tabId.trim().length > 0 ? tabId : placement.descriptorId).trim();
    return slug.length > 0 ? slug : 'tab';
}

/**
 * Resolve the session right-sidebar tab id that an `openSurface` header action
 * should activate. A header action's `surfaceId` references a session
 * right-sidebar placement by its descriptor id; this maps it to the
 * `plugin:<pluginId>:<tabSlug>` tab id the pane right-sidebar uses (matching
 * `resolveRightSidebarPluginTabs`). Returns `null` when no session right-sidebar
 * placement matches the surface id.
 */
export function resolveSessionPluginSurfaceRightTabId(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    surfaceId: string;
}>): string | null {
    const projection = params.projection;
    const surfaceId = params.surfaceId.trim();
    if (!projection || surfaceId.length === 0) {
        return null;
    }
    for (const placement of selectPluginRightSidebarTabPlacements(projection, 'session')) {
        if (placement.descriptorId === surfaceId || placement.id === surfaceId) {
            return `plugin:${placement.pluginId}:${readRightSidebarTabSlug(placement)}`;
        }
    }
    return null;
}

/**
 * Resolve the full canonical action descriptor a plugin session header-action
 * menu id refers to. Returns `null` for non-plugin menu ids or unresolved /
 * malformed descriptors (fail-closed).
 */
export function resolvePluginSessionHeaderActionDescriptor(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    menuActionId: string;
}>): PluginUiActionDescriptorV1 | null {
    if (!params.menuActionId.startsWith(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX)) {
        return null;
    }
    const descriptorId = params.menuActionId.slice(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX.length);
    const action = params.projection?.sessionHeaderActionsById[descriptorId];
    return action ? parseHeaderActionDescriptor(action) : null;
}

/**
 * Dispatch a selected plugin session-header contribution through the existing
 * plugin-UI action executor. Session-header declarations reference an action
 * contribution; they do not author the broader six-kind UI action union.
 */
export async function dispatchPluginSessionHeaderAction(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    menuActionId: string;
    data?: unknown;
    executor?: PluginUiActionExecutorRunner;
    context?: ActionExecutorContext;
    host?: PluginUiActionHostHandlers;
}>): Promise<ExecutePluginUiActionResult | null> {
    const action = resolvePluginSessionHeaderActionDescriptor({
        projection: params.projection,
        menuActionId: params.menuActionId,
    });
    if (!action) {
        return null;
    }
    return executePluginUiAction({
        action,
        data: params.data,
        executor: params.executor,
        context: params.context,
        host: params.host,
    });
}
