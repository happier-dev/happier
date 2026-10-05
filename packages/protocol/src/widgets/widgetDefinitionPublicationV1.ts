import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { SessionSurfaceItemV1Schema } from '../sessions/board/item.js';
import { WidgetInstanceActionInputSchemasV1 } from './actionsV1.js';
import { admitWidgetActionSurfaceV1 } from './widgetActionScopeV1.js';
import { projectWidgetDefinitionForSharedPublicationV1 } from './widgetDefinitionV1.js';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Explicit shared copies enter approval custody with their exact admitted body, not a private pointer. */
export async function prepareWidgetDefinitionPublicationV1(
  deps: Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetDefinitionArtifacts'>,
  input: unknown, context: ActionExecutorContext,
): Promise<Readonly<{ ok: true; input: unknown }> | ActionExecuteFailure> {
  const parsed = WidgetInstanceActionInputSchemasV1['widgets.instance.add'].safeParse(input);
  if (!parsed.success) return failure('invalid_parameters');
  const args = parsed.data;
  if (args.surface.owner.kind !== 'sessionBoard') return { ok: true, input: args };
  const scopeFailure = admitWidgetActionSurfaceV1(deps, args.surface, context);
  if (scopeFailure) return scopeFailure;
  let instance = args.instance;
  if (instance.definition.kind === 'artifact') {
    if (!deps.widgetDefinitionArtifacts) return failure('widget_definition_unavailable');
    try {
      const definition = await deps.widgetDefinitionArtifacts.get(instance.definition.artifactId, context.signal);
      const retired = admitWidgetActionSurfaceV1(deps, args.surface, context);
      if (retired) return retired;
      if (!definition) return failure('widget_definition_not_found');
      instance = { ...instance, definition: { kind: 'inline', definition: projectWidgetDefinitionForSharedPublicationV1(definition) } };
    } catch (error) {
      if (context.signal?.aborted) return failure('cancelled');
      return failure(error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'widget_definition_failed');
    }
  }
  // The same Board grammar owns the privacy boundary at preview and at final upsert.
  const item = SessionSurfaceItemV1Schema.safeParse({ v: 1, title: instance.displayName ?? '',
    frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } });
  if (!item.success) return failure('invalid_widget_shared_content');
  return { ok: true, input: { ...args, instance } };
}
