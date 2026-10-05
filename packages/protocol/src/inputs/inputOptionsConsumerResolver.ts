import { parseWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionRefV1.js';
import { workflowInputToFieldHint, WorkflowDefinitionV1Schema } from '../workflows/workflowV1.js';
import { resolveWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionResolverV1.js';
import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema } from '../workflows/actionsV1.js';
import { WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { admitWidgetActionSurfaceV1 } from '../widgets/widgetActionScopeV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import type { InputFieldHint } from './inputFields.js';
import type { InputOptionsConsumerV1 } from './inputOptionsConsumer.js';

/** Domain adapters only: the shared resolver still owns all source reads. */
export async function resolveInputOptionsConsumerField(params: Readonly<{
  consumer: InputOptionsConsumerV1; fieldPath: string; deps: ActionExecutorDeps; context: ActionExecutorContext;
}>): Promise<InputFieldHint | ActionExecuteFailure | null> {
  const { consumer, fieldPath, deps, context } = params;
  if (consumer.kind === 'widget') {
    const native = readBuiltinWidgetDescriptorV1(consumer.definition);
    if (native) {
      const refused = admitWidgetActionSurfaceV1(deps, consumer.surface, context);
      if (refused) return refused;
      if (consumer.selectedSession && consumer.selectedSession.serverId !== consumer.surface.serverId)
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      return native.inputs?.fields.find(field => field.path === fieldPath) ?? null;
    }
    const { createActionExecutor } = await import('../actions/actionExecutor.js');
    const read = await createActionExecutor(deps).execute('widgets.catalog.list', { surface: consumer.surface,
      ...(consumer.selectedSession ? { boundSession: consumer.selectedSession } : {}) }, context);
    if (!read.ok) return read;
    const catalog = WidgetInstanceActionOutputSchemasV1['widgets.catalog.list'].safeParse(read.result);
    if (!catalog.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    const key = createCanonicalJsonSigningInput(consumer.definition);
    const entry = catalog.data.entries.find(candidate => createCanonicalJsonSigningInput(candidate.definition) === key);
    if (!entry || entry.availability !== 'available') return null;
    return entry.fields.find(field => field.path === fieldPath) ?? null;
  }
  const ref = parseWorkflowDefinitionRefV1(consumer.workflow);
  let refused: ActionExecuteFailure | null = null;
  const resolved = await resolveWorkflowDefinitionRefV1(consumer.workflow, {
    signal: context.signal,
    readArtifact: async () => {
      if (!deps.workflowAction) return null;
      const result = await deps.workflowAction({ actionId: 'workflow.definition.get', input: { definitionId: consumer.workflow }, context });
      const failure = ActionExecuteFailureSchema.safeParse(result);
      if (failure.success) { refused = failure.data; return null; }
      return WorkflowDefinitionGetResultV1Schema.parse(result);
    },
    readPluginWorkflows: async () => {
      if (!deps.workflowAction) return [];
      const entries = [];
      let cursor: string | undefined;
      do {
        context.signal?.throwIfAborted();
        const result = await deps.workflowAction({ actionId: 'workflow.definition.list', input: cursor ? { cursor } : {}, context });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) { refused = failure.data; return []; }
        const page = WorkflowDefinitionListResultV1Schema.parse(result);
        entries.push(...page.pluginWorkflows ?? []);
        cursor = page.nextCursor;
      } while (cursor);
      return entries;
    },
  });
  if (refused) return refused;
  if (!ref || !resolved) return null;
  const definition = WorkflowDefinitionV1Schema.parse(resolved.definition);
  const input = definition.inputs.find(input => input.name === fieldPath);
  return input ? workflowInputToFieldHint(input) : null;
}
