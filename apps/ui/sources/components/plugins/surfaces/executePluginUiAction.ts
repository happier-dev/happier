import type {
    ActionExecuteResult,
    ActionExecutorContext,
    ActionId,
} from '@happier-dev/protocol';
import type { PluginUiActionDescriptorV1 } from '@happier-dev/protocol/plugins/ui';

/**
 * Phase 1.5 — the SINGLE plugin-UI action executor.
 *
 * Routes ALL six declared plugin-UI action kinds (the previous state: only
 * `openSurface` executed; `copy/executeAction/openExternal/refresh/retry` were
 * accepted but never executed, finding #5):
 *
 *   - `executeAction` → the canonical `ActionExecutor.execute` front door
 *     (reuses `createDefaultActionExecutor`); enablement + approval + grants all
 *     resolve in one place (§2.3 single front door).
 *   - `copy` / `openExternal` / `openSurface` / `refresh` / `retry` → host
 *     affordance callbacks (clipboard / external open / open-surface / resource
 *     refresh). These are not ActionSpec ids, so they route through injected host
 *     handlers — but through THIS one executor, not scattered call sites.
 *
 * Path-based targets (`valuePath`, `urlPath`, `payloadPath`, `resourceIdPath`)
 * are resolved against the supplied surface `data` context.
 */

type UnknownRecord = Readonly<Record<string, unknown>>;

export type PluginUiActionExecutorRunner = Readonly<{
    execute: (
        actionId: ActionId,
        input: unknown,
        context?: ActionExecutorContext,
    ) => Promise<ActionExecuteResult>;
}>;

/**
 * Host affordance callbacks for the non-ActionSpec action kinds. Any callback
 * left unset makes its kind fail closed (`handler_unavailable`).
 */
export type PluginUiActionHostHandlers = Readonly<{
    copy?: (value: string) => void | Promise<void>;
    openExternal?: (url: string, policyId?: string) => void | Promise<void>;
    openSurface?: (surfaceId: string) => void | Promise<void>;
    refresh?: (
        target: Readonly<{ resourceKind?: string; resourceId?: string; surfaceId?: string }>,
    ) => void | Promise<void>;
}>;

export type ExecutePluginUiActionInput = Readonly<{
    action: PluginUiActionDescriptorV1;
    /** The surface data context the action's path targets resolve against. */
    data?: unknown;
    /** Canonical action executor (`createDefaultActionExecutor`) for `executeAction`. */
    executor?: PluginUiActionExecutorRunner;
    /** Front-door context (surface/placement/session/server) for `executeAction`. */
    context?: ActionExecutorContext;
    host?: PluginUiActionHostHandlers;
}>;

export type ExecutePluginUiActionResult =
    | Readonly<{ ok: true; kind: PluginUiActionDescriptorV1['kind']; result?: unknown }>
    | Readonly<{ ok: false; kind: PluginUiActionDescriptorV1['kind']; errorCode: string; error: string }>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

/** Resolve a JSON-pointer-ish path (`/a/b` or `a.b`) against the data context. */
function readPath(data: unknown, path: string | undefined): unknown {
    if (!path) {
        return data;
    }
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    let cursor: unknown = data;
    for (const segment of normalized.split(/[./]/)) {
        if (segment.length === 0) {
            continue;
        }
        const record = asRecord(cursor);
        if (!record || !(segment in record)) {
            return undefined;
        }
        cursor = record[segment];
    }
    return cursor;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function failure(
    kind: PluginUiActionDescriptorV1['kind'],
    errorCode: string,
): ExecutePluginUiActionResult {
    return { ok: false, kind, errorCode, error: errorCode };
}

export async function executePluginUiAction(
    input: ExecutePluginUiActionInput,
): Promise<ExecutePluginUiActionResult> {
    const { action, data, host } = input;

    switch (action.kind) {
        case 'executeAction': {
            if (!input.executor) {
                return failure('executeAction', 'plugin_ui_action_executor_unavailable');
            }
            const actionId = readString(action.target.actionId);
            if (!actionId) {
                return failure('executeAction', 'plugin_ui_action_invalid_action_id');
            }
            const payload = action.target.payloadPath
                ? readPath(data, action.target.payloadPath)
                : undefined;
            const resourceId = action.target.resourceIdPath
                ? readPath(data, action.target.resourceIdPath)
                : undefined;
            const result = await input.executor.execute(
                actionId as ActionId,
                {
                    ...(payload !== undefined ? { payload } : {}),
                    ...(resourceId !== undefined ? { resourceId } : {}),
                },
                input.context,
            );
            return result.ok
                ? { ok: true, kind: 'executeAction', result: result.result }
                : { ok: false, kind: 'executeAction', errorCode: result.errorCode, error: result.error };
        }

        case 'copy': {
            const value = readString(readPath(data, action.target.valuePath));
            if (value === null) {
                return failure('copy', 'plugin_ui_action_copy_value_unresolved');
            }
            if (!host?.copy) {
                return failure('copy', 'plugin_ui_action_copy_handler_unavailable');
            }
            await host.copy(value);
            return { ok: true, kind: 'copy' };
        }

        case 'openExternal': {
            const url = readString(readPath(data, action.target.urlPath));
            if (url === null) {
                return failure('openExternal', 'plugin_ui_action_open_external_url_unresolved');
            }
            if (!host?.openExternal) {
                return failure('openExternal', 'plugin_ui_action_open_external_handler_unavailable');
            }
            await host.openExternal(url, action.target.policyId);
            return { ok: true, kind: 'openExternal' };
        }

        case 'openSurface': {
            const surfaceId = readString(action.target.surfaceId);
            if (surfaceId === null) {
                return failure('openSurface', 'plugin_ui_action_open_surface_invalid');
            }
            if (!host?.openSurface) {
                return failure('openSurface', 'plugin_ui_action_open_surface_handler_unavailable');
            }
            await host.openSurface(surfaceId);
            return { ok: true, kind: 'openSurface' };
        }

        case 'refresh':
        case 'retry': {
            if (!host?.refresh) {
                return failure(action.kind, 'plugin_ui_action_refresh_handler_unavailable');
            }
            const resourceId = action.target.resourceIdPath
                ? readString(readPath(data, action.target.resourceIdPath))
                : null;
            await host.refresh({
                ...(action.target.resourceKind ? { resourceKind: action.target.resourceKind } : {}),
                ...(resourceId ? { resourceId } : {}),
                ...(action.target.surfaceId ? { surfaceId: action.target.surfaceId } : {}),
            });
            return { ok: true, kind: action.kind };
        }

        default: {
            // Exhaustive guard: an unknown future kind fails closed.
            const exhaustiveKind: never = action;
            void exhaustiveKind;
            return failure((action as PluginUiActionDescriptorV1).kind, 'plugin_ui_action_unsupported_kind');
        }
    }
}
