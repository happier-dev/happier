import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/publicTypes.js';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { AutomationActionRunEvidenceV1Schema, type AutomationActionRunEvidenceV1 } from '../automations/automationActionOccurrenceV1.js';
import { WorkflowTriggerEventReferenceV1Schema } from './workflowReferenceV1.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { readWorkflowValuePathV1, type WorkflowTriggerEventReferenceV1, type WorkflowTriggerEventIdentityV1 } from './workflowReferenceV1.js';
import type { WorkflowBlock, WorkflowDefinitionV1 } from './workflowV1.js';
import { rewriteWorkflowBlockReferences } from './workflowDefinitionEditV1.js';
import { listWorkflowActionFieldReferencesV1 } from './workflowActionTextV1.js';

export const WorkflowTriggerEventDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  event: WorkflowTriggerEventReferenceV1Schema.shape.event,
  payloadSchema: z.nullable(PluginJsonSchemaV2Schema),
}));

export type WorkflowTriggerEventDeclarationV1 = Readonly<{
  event: WorkflowTriggerEventIdentityV1;
  payloadSchema: PluginJsonSchemaV2 | null;
}>;
export type WorkflowTriggerEventOccurrenceV1 = Readonly<{
  event: WorkflowTriggerEventIdentityV1;
  payload: JsonValue;
}>;
export type WorkflowTriggerEventValueV1 = Readonly<{
  event: WorkflowTriggerEventIdentityV1;
  path: (string | number)[];
  value: JsonValue;
}>;

/** Both Action phases expose the same canonical safe evidence fields. */
export function createWorkflowActionTriggerEventDeclarationV1(phase: AutomationActionRunEvidenceV1['phase']): WorkflowTriggerEventDeclarationV1 {
  return { event: { kind: 'action', phase }, payloadSchema: PluginJsonSchemaV2Schema.parse(
    zodSchemaToJsonSchemaObject(AutomationActionRunEvidenceV1Schema, { target: 'draft-7' }),
  ) };
}

/** The cause was parsed at Run admission; raw Action operands never enter this projection. */
export function projectWorkflowActionTriggerEventOccurrenceV1(evidence: AutomationActionRunEvidenceV1): WorkflowTriggerEventOccurrenceV1 {
  return { event: { kind: 'action', phase: evidence.phase }, payload: evidence };
}

export function formatWorkflowTriggerEventIdentityV1(event: WorkflowTriggerEventIdentityV1): string {
  return 'kind' in event ? `action/${event.phase}` : `${event.pluginId}/${event.localId}`;
}

/** Reference eligibility follows its authored operand, never the incoming payload's shape. */
function visitWorkflowTriggerEventReferencesV1(
  definition: WorkflowDefinitionV1,
  consume: (reference: WorkflowTriggerEventReferenceV1, allowStructured: boolean) => void,
): void {
  const keep = <T>(value: T): T => value;
  const visit = (block: WorkflowBlock): WorkflowBlock => {
    const jsonOperands = block.kind === 'action' ? new Set(Object.values(block.input).flatMap(binding =>
      binding.kind === 'text' ? [] : listWorkflowActionFieldReferencesV1(binding))) : undefined;
    return rewriteWorkflowBlockReferences(block, {
      producer: keep, inputName: keep, child: visit,
      reference: reference => {
        if (reference.kind === 'trigger_event') consume(reference, jsonOperands?.has(reference) === true);
        return reference;
      },
    });
  };
  for (const block of definition.blocks) visit(block);
}

/** Uses the definition owner's reference map, including nested control-flow operands. */
export function collectWorkflowTriggerEventReferencesV1(definition: WorkflowDefinitionV1): readonly WorkflowTriggerEventReferenceV1[] {
  const references: WorkflowTriggerEventReferenceV1[] = [];
  visitWorkflowTriggerEventReferencesV1(definition, reference => references.push(reference));
  return references;
}

/** Copies demanded scalars and selected Action JSON subtrees into the private accepted snapshot. */
export function sealWorkflowTriggerEventValuesV1(
  definitions: Iterable<WorkflowDefinitionV1>, occurrence: WorkflowTriggerEventOccurrenceV1 | undefined,
): readonly WorkflowTriggerEventValueV1[] {
  if (!occurrence) return [];
  const values = new Map<string, WorkflowTriggerEventValueV1>();
  for (const definition of definitions) visitWorkflowTriggerEventReferencesV1(definition, (reference, allowStructured) => {
    if (!sameStrictJsonValue(reference.event, occurrence.event)) return;
    const key = JSON.stringify([reference.event, reference.path]);
    if (values.has(key)) return;
    const value = readWorkflowValuePathV1(occurrence.payload, reference.path);
    if (value !== undefined && (allowStructured || value === null || typeof value !== 'object')) {
      values.set(key, { event: reference.event, path: reference.path, value: structuredClone(value) });
    }
  });
  return [...values.values()];
}
