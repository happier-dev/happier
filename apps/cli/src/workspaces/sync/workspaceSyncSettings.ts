import { computeWorkspaceSyncPolicyDigest, type WorkspaceContentPolicyV1, type WorkspaceSyncRelationshipV1 } from './workspaceSyncTypes';

export const WORKSPACE_SYNC_SETTINGS_KEY = 'workspaceSyncRelationshipsV1' as const;
export const MAX_WORKSPACE_SYNC_RELATIONSHIPS = 32;
export const MAX_WORKSPACE_SYNC_PATTERNS = 256;
export const MAX_WORKSPACE_SYNC_PATTERN_BYTES = 512;

function fail(message: string): never { throw new Error(`Invalid workspace sync settings: ${message}`); }
function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${name} must be a non-empty string`);
  return value.trim();
}
function patterns(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_SYNC_PATTERNS) fail(`${name} exceeds bounded patterns limit`);
  const out = value.map((item) => stringField(item, name));
  if (out.some((item) => Buffer.byteLength(item, 'utf8') > MAX_WORKSPACE_SYNC_PATTERN_BYTES)) fail(`${name} contains an oversized pattern`);
  return [...new Set(out)].sort();
}

export function validateWorkspaceSyncContentPolicy(value: unknown): WorkspaceContentPolicyV1 {
  if (!value || typeof value !== 'object') fail('contentPolicy must be an object');
  const input = value as Record<string, unknown>;
  if (input.v !== 1) fail('contentPolicy.v must be 1');
  if (input.selection !== 'git_worktree' && input.selection !== 'all_files') fail('unsupported content selection');
  if (typeof input.includeGitDirectory !== 'boolean') fail('includeGitDirectory must be boolean');
  const extraIgnorePatterns = patterns(input.extraIgnorePatterns, 'extraIgnorePatterns');
  const extraIncludePatterns = patterns(input.extraIncludePatterns, 'extraIncludePatterns');
  const policyDigest = stringField(input.policyDigest, 'policyDigest');
  if (!/^[a-f0-9]{64}$/u.test(policyDigest)) fail('policyDigest must be a sha256 hex digest');
  const expected = computeWorkspaceSyncPolicyDigest({ v: 1, selection: input.selection as WorkspaceContentPolicyV1['selection'], extraIgnorePatterns, extraIncludePatterns, includeGitDirectory: input.includeGitDirectory });
  if (policyDigest !== expected) fail('policyDigest does not match content policy');
  return { v: 1, selection: input.selection, extraIgnorePatterns, extraIncludePatterns, includeGitDirectory: input.includeGitDirectory, policyDigest };
}

export function validateWorkspaceSyncRelationship(value: unknown): WorkspaceSyncRelationshipV1 {
  if (!value || typeof value !== 'object') fail('relationship must be an object');
  const input = value as Record<string, unknown>;
  if (input.v !== 1) fail('relationship.v must be 1');
  const relationshipId = stringField(input.relationshipId, 'relationshipId');
  const controllerMachineId = stringField(input.controllerMachineId, 'controllerMachineId');
  const alphaWorkspaceRefId = stringField(input.alphaWorkspaceRefId, 'alphaWorkspaceRefId');
  const betaWorkspaceRefId = stringField(input.betaWorkspaceRefId, 'betaWorkspaceRefId');
  if (alphaWorkspaceRefId === betaWorkspaceRefId) fail('endpoint references must be distinct');
  if (!['keep_synced', 'mirror_exactly', 'keep_both_in_sync'].includes(input.mode as string)) fail('unsupported relationship mode');
  if (typeof input.enabled !== 'boolean') fail('enabled must be boolean');
  if (!Number.isSafeInteger(input.createdAtMs) || !Number.isSafeInteger(input.updatedAtMs)) fail('timestamps must be safe integers');
  return { v: 1, relationshipId, controllerMachineId, alphaWorkspaceRefId, betaWorkspaceRefId, mode: input.mode as WorkspaceSyncRelationshipV1['mode'], contentPolicy: validateWorkspaceSyncContentPolicy(input.contentPolicy), enabled: input.enabled, createdAtMs: input.createdAtMs, updatedAtMs: input.updatedAtMs };
}

export function validateWorkspaceSyncRelationships(value: unknown): readonly WorkspaceSyncRelationshipV1[] {
  if (!Array.isArray(value)) fail('relationships must be an array');
  if (value.length > MAX_WORKSPACE_SYNC_RELATIONSHIPS) fail('relationship count exceeds limit');
  const relationships = value.map(validateWorkspaceSyncRelationship);
  const ids = new Set<string>();
  for (const relationship of relationships) {
    if (ids.has(relationship.relationshipId)) fail(`duplicate relationshipId ${relationship.relationshipId}`);
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
