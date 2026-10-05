import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1,
    type WidgetDefinitionActionDepsV1, type WidgetDefinitionActionIdV1 } from './definitionActionsV1.js';
import { WidgetDefinitionV1Schema } from './widgetDefinitionV1.js';
import { admitWidgetActionSurfaceV1 } from './widgetActionScopeV1.js';

const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
/** The Action front door and captured Account port share this admission, prior to any read. */
export async function executeWidgetDefinitionActionV1(deps: WidgetDefinitionActionDepsV1,
    actionId: WidgetDefinitionActionIdV1, rawInput: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult> {
    const parsed = WidgetDefinitionActionInputSchemasV1[actionId].safeParse(rawInput);
    if (!parsed.success) return failure('invalid_input');
    const input = parsed.data;
    const refused = admitWidgetActionSurfaceV1(deps, { ...input.account, owner: { kind: 'home' } }, context);
    if (refused) return refused;
    const scope = input.account;
    const port = deps.widgetDefinitionArtifacts;
    if (!port) return failure('widget_definition_unavailable');
    const accept = (value: unknown): ActionExecuteResult => {
        const result = WidgetDefinitionActionOutputSchemasV1[actionId].safeParse(value);
        return result.success ? { ok: true, result: result.data } : failure('widget_definition_ack_unknown');
    };
    try {
        switch (actionId) {
            case 'widgets.definition.list': return accept({ definitions: await port.list(context.signal) });
            case 'widgets.definition.get': {
                const args = WidgetDefinitionActionInputSchemasV1[actionId].parse(input);
                const definition = await port.get(args.artifactId, context.signal);
                if (!definition) return failure('widget_definition_not_found');
                const placementSummary = await deps.describeWidgetDefinitionPlacements?.(args.artifactId, context);
                return accept({ definition, ...(placementSummary ? { placementSummary } : {}) });
            }
            case 'widgets.definition.create': {
                const args = WidgetDefinitionActionInputSchemasV1[actionId].parse(input);
                return accept({ definition: await port.create(WidgetDefinitionV1Schema.parse({ v: 1, id: args.artifactId,
                    ...args.definition, provenance: { authorAccountId: scope.accountId, source: { kind: 'authored' } } }), context.signal) });
            }
            case 'widgets.definition.update': {
                const args = WidgetDefinitionActionInputSchemasV1[actionId].parse(input);
                return accept({ definition: await port.update(args.artifactId, args.patch, context.signal) });
            }
            case 'widgets.definition.duplicate': {
                const args = WidgetDefinitionActionInputSchemasV1[actionId].parse(input);
                return accept({ definition: await port.duplicate(args.artifactId, args.newArtifactId, args.name, context.signal) });
            }
            case 'widgets.definition.delete': {
                const args = WidgetDefinitionActionInputSchemasV1[actionId].parse(input);
                await port.delete(args.artifactId, context.signal);
                return accept({ artifactId: args.artifactId, status: 'deleted' });
            }
            case 'widgets.definition.saveFromSession': {
                const args = WidgetDefinitionActionInputSchemasV1[actionId].parse(input);
                if (args.session.serverId !== scope.serverId) return failure('server_target_mismatch');
                if (!deps.readSessionWidgetDefinitionSource) return failure('widget_definition_promotion_unavailable');
                const source = await deps.readSessionWidgetDefinitionSource({ session: args.session, itemId: args.itemId, context, signal: context.signal });
                if ('ok' in source) return source;
                // Promotion copies the current admitted declaration. Its Session
                // field is configurable rather than a hard-coded execution target.
                const sessionPath = source.definition.sessionInputPath;
                const suggestedBindings = { ...source.bindings };
                if (sessionPath) suggestedBindings[sessionPath] = { kind: 'context', slot: 'session' };
                const definition = await port.create(WidgetDefinitionV1Schema.parse({ v: 1, id: args.artifactId, ...source.definition,
                    ...(args.name ? { name: args.name } : {}), provenance: { source: { kind: 'session', ...args.session, itemId: args.itemId } } }), context.signal);
                return accept({ definition, suggestedBindings });
            }
        }
    } catch (error) {
        if (context.signal?.aborted) return failure('cancelled');
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'widget_definition_failed';
        return failure(code);
    }
}
