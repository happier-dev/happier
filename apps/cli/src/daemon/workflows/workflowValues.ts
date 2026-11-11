import type { WorkflowValueReference } from '@happier-dev/protocol/workflows';

export type WorkflowJsonValue = Extract<WorkflowValueReference, { kind: 'literal' }>['value'];

export function isWorkflowJsonObject(value: unknown): value is Readonly<Record<string, WorkflowJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
