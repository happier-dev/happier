import { compilePluginJsonSchema } from '../actions/jsonSchemaValidation.js';
import type { PluginUiWidgetAreaDeclarationV1 } from '../contributions/ui/widgetAreas.js';
import { PluginUiWidgetAreaRequestV1Schema, PluginUiWidgetAreaResultV1Schema, pluginUiWidgetAreaOperationHasOutwardEffectV1, type PluginUiWidgetAreaResultV1 } from './widgetArea.js';
import type { ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { WidgetInstanceActionIdV1 } from '../../widgets/actionIdsV1.js';
import type { WidgetSurfaceRefV1 } from '../../widgets/widgetInstanceV1.js';

/** Mounted native and declarative pages enter this shared data/Action adapter; hosted HTML does not embed areas. */
export function createPluginWidgetAreaHostPortV1(host: Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>; pluginId: string; pageId: string;
    declarations: readonly PluginUiWidgetAreaDeclarationV1[];
    isCurrent(): boolean;
    execute(actionId: WidgetInstanceActionIdV1, input: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult>;
}>) {
    const validators = new Map(host.declarations.map(area => [area.name, compilePluginJsonSchema(area.contextSchema)]));
    const failed = (errorCode: string): PluginUiWidgetAreaResultV1 => ({ ok: false, errorCode, error: errorCode });
    return { async execute(raw: unknown, signal?: AbortSignal, actionRequestId?: string): Promise<PluginUiWidgetAreaResultV1> {
        if (!host.isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
        const request = PluginUiWidgetAreaRequestV1Schema.safeParse(raw);
        if (!request.success) return failed('invalid_widget_area_request');
        const validate = validators.get(request.data.area);
        if (!validate) return failed('widget_area_not_declared');
        const context = request.data.context ?? {};
        if (!validate(context)) return failed('widget_area_context_invalid');
        const surface: WidgetSurfaceRefV1 = { ...host.scope, owner: { kind: 'pluginArea', pluginId: host.pluginId, pageId: host.pageId, area: request.data.area } };
        const { actionId, ...authored } = request.data.operation;
        const input = (() => {
            if (!('instanceId' in authored)) return { ...authored, surface };
            const { instanceId, ...fields } = authored;
            return { ...fields, ref: { surface, instanceId } };
        })();
        const result = await host.execute(actionId, input, { signal, serverId: host.scope.serverId, ...(actionRequestId ? { actionRequestId } : {}),
            widgetAreaContext: { surface, values: Object.fromEntries(Object.entries(context).map(([slot, value]) => [slot, [value]])) } });
        if ((!host.isCurrent() || signal?.aborted) && !(result.ok && pluginUiWidgetAreaOperationHasOutwardEffectV1(request.data.operation))) return failed('widget_area_scope_retired');
        const admitted = PluginUiWidgetAreaResultV1Schema.safeParse(result);
        return admitted.success ? admitted.data : failed('invalid_widget_area_result');
    } };
}
