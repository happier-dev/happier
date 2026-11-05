import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { LocalActRunResultV1Schema, LocalRunSelectionV1Schema, type LocalActRunResultV1 } from './contracts.js';
import { buildLocalActCommandV1, validateLocalActWorkflowSelectionV1 } from './command.js';
import { inspectLocalActV1 } from './inspect.js';

/** One finite Project invocation. Acceptance, output and Stop remain host-owned. */
export async function runLocalActV1(input: unknown, context: PluginInvocationContext): Promise<LocalActRunResultV1> {
  const selection = LocalRunSelectionV1Schema.parse(input);
  if (!selection.workflowPath.trim() || !selection.event.trim() || !selection.architecture.trim()) throw new PluginError({ code: 'local_act_selection_incomplete' });
  const inspection = await inspectLocalActV1({ workspace: selection.workspace, workflowPath: selection.workflowPath }, context);
  if (isPluginActionApprovalRequestCreated(inspection)) return inspection;
  if (inspection.tool.kind !== 'ready') throw new PluginError({ code: inspection.tool.code });
  if (!inspection.workflow) throw new PluginError({ code: inspection.workflowError ?? 'workflow_unavailable' });
  const validation = validateLocalActWorkflowSelectionV1(selection, inspection.workflow);
  if (validation.kind === 'refused') throw new PluginError({ code: validation.code });
  // The ordinary owner freshly checks preference, requester secret references,
  // executable, setup/trust and placement. Never replay after possible acceptance.
  return LocalActRunResultV1Schema.parse(await context.services.actions.execute('projects.compute.exec',
    buildLocalActCommandV1(selection, inspection.tool.executablePath), { signal: context.signal }));
}
