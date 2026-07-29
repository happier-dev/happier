import type {
    ActionExecuteResult,
    ActionExecutorContext,
    ActionId,
} from '@happier-dev/protocol';
import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import { createPluginSurfaceHostApi } from '@happier-dev/plugin-ui';

import type { PluginSurfaceHostApi } from '@/components/plugins/surfaces';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

type JsonRecord = Readonly<Record<string, PluginUiJsonValueV1>>;
type AppScopeInspectorActionId = Extract<ActionId, 'plugins.list' | 'plugins.reload'>;

export type AppScopePluginActionExecute = (
    actionId: AppScopeInspectorActionId,
    input: unknown,
    context?: ActionExecutorContext,
) => Promise<ActionExecuteResult>;

const INSPECTOR_PLUGIN_ID = 'happier.inspector';
const APP_SCOPE_ALLOWED_ACTION_IDS = new Set(['plugins.list', 'plugins.reload']);

function unavailable(reason: string): PluginUiJsonValueV1 {
    return {
        code: 'unavailable',
        diagnostics: [reason],
    };
}

function readJsonRecord(value: PluginUiJsonValueV1 | undefined): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isAppScopeInspectorActionId(value: string): value is AppScopeInspectorActionId {
    return value === 'plugins.list' || value === 'plugins.reload';
}

export function createAppScopePluginSurfaceHostApi(params: Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    platform?: LocalServicePreviewPlatform;
    executeAction?: AppScopePluginActionExecute;
    actionExecutorContext?: ActionExecutorContext;
}>): PluginSurfaceHostApi {
    return createPluginSurfaceHostApi({
        surfaceContext: {
            pluginId: params.placement.pluginId,
            contributionId: params.placement.descriptorId,
            surfaceId: params.placement.id,
            placement: 'appSurface',
            platform: params.platform ?? 'web',
            channel: 'internal',
            resourceScope: [],
            diagnostics: [],
        },
        handlers: {
            async dispatchAction(request: PluginUiHostApiRequestEnvelopeV1): Promise<PluginUiJsonValueV1> {
                const payload = readJsonRecord(request.payload);
                const canonicalActionId = readString(payload?.action);
                const legacyActionId = readString(payload?.actionId);
                const actionId = canonicalActionId ?? legacyActionId;
                if (!payload || !actionId) {
                    return unavailable('app_scope_host_action_invalid_payload');
                }
                if (canonicalActionId && legacyActionId && canonicalActionId !== legacyActionId) {
                    return unavailable('app_scope_host_action_invalid_payload');
                }
                if (!APP_SCOPE_ALLOWED_ACTION_IDS.has(actionId)) {
                    return unavailable('app_scope_host_action_not_allowed');
                }
                if (params.placement.pluginId !== INSPECTOR_PLUGIN_ID) {
                    return unavailable('app_scope_host_action_plugin_not_allowed');
                }
                if (!params.executeAction || !isAppScopeInspectorActionId(actionId)) {
                    return unavailable('app_scope_host_action_handler_unavailable');
                }

                const result = await params.executeAction(
                    actionId,
                    payload.input ?? {},
                    {
                        ...params.actionExecutorContext,
                        surface: 'ui',
                    },
                );
                return (result.ok ? result.result : result) as PluginUiJsonValueV1;
            },
        },
    });
}
