import { z } from 'zod';
import { WorkflowDefinitionRefV1StringSchema } from '../workflowDefinitionRefV1.js';
import { WorkflowDefinitionV1Schema } from '../workflowV1.js';
import { AutomationStoredWorkflowDefinitionV2ReadSchema } from '../../automations/automationWorkflowRecipeV2.js';

export const TriggerTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow'), ref: WorkflowDefinitionRefV1StringSchema }).strict(),
  z.object({ kind: z.literal('inline'), definition: WorkflowDefinitionV1Schema }).strict(),
]);
export type TriggerTargetV1 = z.infer<typeof TriggerTargetV1Schema>;
export type ReadTriggerTargetV1Result =
  | Readonly<{ kind: 'available'; target: TriggerTargetV1 }>
  | Readonly<{ kind: 'unavailable'; code: 'source_unavailable' }>;

/** The row selects the target arm; the sealed payload owns only inline content and run context. */
export function readTriggerTargetV1(
  automation: Readonly<{ workflowDefinitionId?: string | null; scopeSessionId?: string | null }>,
  openedPayload: unknown,
): ReadTriggerTargetV1Result {
  const payload = AutomationStoredWorkflowDefinitionV2ReadSchema.safeParse(openedPayload);
  if (!payload.success || (payload.data.onComplete !== undefined && !automation.scopeSessionId)) {
    return { kind: 'unavailable', code: 'source_unavailable' };
  }
  const ref = automation.workflowDefinitionId;
  const inlineDefinition = payload.data.inlineDefinition;
  if (ref !== null && ref !== undefined) {
    if (inlineDefinition !== undefined || !WorkflowDefinitionRefV1StringSchema.safeParse(ref).success) {
      return { kind: 'unavailable', code: 'source_unavailable' };
    }
    return { kind: 'available', target: { kind: 'workflow', ref } };
  }
  return inlineDefinition === undefined || payload.data.visibleTeamId != null
    ? { kind: 'unavailable', code: 'source_unavailable' }
    : { kind: 'available', target: { kind: 'inline', definition: inlineDefinition } };
}
