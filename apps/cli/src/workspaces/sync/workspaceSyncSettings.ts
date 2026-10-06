import { WorkspaceContentPolicyV1Schema, WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceContentPolicyV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';

export const WORKSPACE_SYNC_SETTINGS_KEY = 'workspaceSyncRelationshipsV1' as const;

function validationError(name: string, issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[]): Error {
  const details = issues.map((issue) => `${issue.path.join('.') || name}: ${issue.message}`).join('; ');
  return new Error(`Invalid workspace sync settings: ${details}`);
}

/** Protocol schemas are the sole field/bounds/digest authority. */
export function validateWorkspaceSyncContentPolicy(value: unknown): WorkspaceContentPolicyV1 {
  const parsed = WorkspaceContentPolicyV1Schema.safeParse(value);
  if (!parsed.success) throw validationError('contentPolicy', parsed.error.issues);
  return parsed.data;
}

/** Protocol schemas are the sole field/bounds/digest/timestamp authority. */
export function validateWorkspaceSyncRelationship(value: unknown): WorkspaceSyncRelationshipV1 {
  const parsed = WorkspaceSyncRelationshipV1Schema.safeParse(value);
  if (!parsed.success) throw validationError('relationship', parsed.error.issues);
  return parsed.data;
}

export function validateWorkspaceSyncRelationships(value: unknown): readonly WorkspaceSyncRelationshipV1[] {
  if (!Array.isArray(value)) throw new Error('Invalid workspace sync settings: relationships must be an array');
  const relationships = value.map(validateWorkspaceSyncRelationship);
  const ids = new Set<string>();
  for (const relationship of relationships) {
    if (ids.has(relationship.relationshipId)) throw new Error(`Invalid workspace sync settings: duplicate relationshipId ${relationship.relationshipId}`);
    ids.add(relationship.relationshipId);
  }
  return relationships;
}

export function parseWorkspaceSyncRelationships(value: unknown): readonly WorkspaceSyncRelationshipV1[] {
  return validateWorkspaceSyncRelationships(value ?? []);
}

export function serializeWorkspaceSyncRelationships(value: readonly WorkspaceSyncRelationshipV1[]): string {
  return JSON.stringify(validateWorkspaceSyncRelationships(value));
}
