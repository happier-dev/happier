import type { BuiltInRoleIdV1 } from '../../prompts/roles/builtInRolesV1.js';
import { SECOND_OPINION_RESULT_SCHEMA_V1 } from '../../prompts/roles/builtInRolesV1.js';
import type { JsonValue } from '../../json/strictJsonValue.js';
import type { WorkflowAuthoredResultReference, WorkflowReferenceScope, WorkflowValueReference } from '../workflowReferenceV1.js';
import { WorkflowResultContractSchema, type WorkflowStep } from '../workflowV1.js';

export const literal = (value: JsonValue): WorkflowValueReference => ({ kind: 'literal', value });
export const input = (name: string): WorkflowValueReference => ({ kind: 'input', name });
export const result = (blockId: string, path: (string | number)[] = [],
  scope: WorkflowReferenceScope = { kind: 'current' }): WorkflowAuthoredResultReference => ({
  kind: 'result', producer: { blockId, scope }, path,
});
export const document = (text: string): WorkflowStep['document'] => ({ text, references: [], attachments: [] });

export function agent(id: string, name: string, role: BuiltInRoleIdV1, text: string,
  values: WorkflowValueReference[] = [], readOnly = false): WorkflowStep {
  return {
    kind: 'step', id, name, document: document(text), input: values, result: { kind: 'text' },
    execution: { engine: { role }, ...(readOnly ? { permissionMode: 'read-only' as const } : {}) },
  };
}

export const SECOND_OPINION_RESULT_V1 = WorkflowResultContractSchema.parse({
  kind: 'json',
  schema: SECOND_OPINION_RESULT_SCHEMA_V1,
});
