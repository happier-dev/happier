import { ActionIdSchema } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { prepareTeamCredentialSources, type TeamCredentialSourceSelection } from '../specs/teamCredentialApproval.js';
import type { WorkflowAcceptedSnapshotV1 } from '../../workflows/workflowDefinitionV1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

/** Review the materializer's effective operands, never a second authored-input binding. */
export async function prepareWorkflowRunApprovalPreview(snapshot: {
  materializedLeaves: readonly WorkflowAcceptedSnapshotV1['materializedLeaves'][number][];
},
  deps: Pick<ActionExecutorDeps, 'homeDomainAction'>, context: ActionExecutorContext) {
  const selections = new Map<string | undefined, TeamCredentialSourceSelection['resources'][number][]>();
  for (const leaf of snapshot.materializedLeaves) {
    if (leaf.kind !== 'action' || leaf.actionInput === undefined) continue;
    const id = ActionIdSchema.safeParse(leaf.actionId);
    if (!id.success) continue;
    const selection = getActionSpec(id.data).approvalPresentation?.teamCredentialSources?.(leaf.actionInput);
    if (!selection?.resources.length) continue;
    const home = selection.serverId ?? context.serverId ?? undefined;
    const refs = selections.get(home) ?? [];
    for (const ref of selection.resources) {
      if (!refs.some(known => known.resourceId === ref.resourceId && known.teamId === ref.teamId)) refs.push(ref);
    }
    selections.set(home, refs);
  }
  const sources = (await Promise.all([...selections].map(([serverId, resources]) =>
    prepareTeamCredentialSources({ deps, context, selection: { ...(serverId ? { serverId } : {}), resources } })))).flat();
  return { teamCredentialSources: sources };
}
