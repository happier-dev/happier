import { normalizeWorkspacePath } from '@/scm/sourceController/workspaceExportPackaging/normalizeWorkspacePath';

export const workspaceReplicationModes = ['one_way_safe', 'one_way_replica', 'two_way_safe'] as const;
export type WorkspaceReplicationMode = (typeof workspaceReplicationModes)[number];

export type WorkspaceReplicationRelationshipScope = Readonly<{
  sourceMachineId: string;
  sourceWorkspaceRoot: string;
  targetMachineId: string;
  targetWorkspaceRoot: string;
  mode?: WorkspaceReplicationMode;
  ignorePatterns?: readonly string[];
}>;

export type WorkspaceReplicationDirectionScope = WorkspaceReplicationRelationshipScope & Readonly<{
  mode: WorkspaceReplicationMode;
}>;

export type WorkspaceReplicationRelationshipEndpoint = Readonly<{
  machineId: string;
  rootPath: string;
}>;

function normalizeWorkspaceRoot(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  if (normalized === '/' || normalized === '') {
    return normalized;
  }
  return normalized.replace(/\/+$/u, '');
}

function normalizeIgnorePatterns(ignorePatterns: readonly string[] | undefined): readonly string[] | undefined {
  if (!ignorePatterns) {
    return undefined;
  }
  const normalized = [...new Set(
    ignorePatterns
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0),
  )].sort((left, right) => left.localeCompare(right));
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeWorkspaceReplicationRelationshipScope(
  scope: WorkspaceReplicationRelationshipScope,
): WorkspaceReplicationRelationshipScope {
  const ignorePatterns = normalizeIgnorePatterns(scope.ignorePatterns);
  return {
    sourceMachineId: scope.sourceMachineId.trim(),
    sourceWorkspaceRoot: normalizeWorkspaceRoot(scope.sourceWorkspaceRoot),
    targetMachineId: scope.targetMachineId.trim(),
    targetWorkspaceRoot: normalizeWorkspaceRoot(scope.targetWorkspaceRoot),
    ...(scope.mode ? { mode: scope.mode } : {}),
    ...(ignorePatterns ? { ignorePatterns } : {}),
  };
}

export function normalizeWorkspaceReplicationDirectionScope(
  scope: WorkspaceReplicationDirectionScope,
): WorkspaceReplicationDirectionScope {
  return {
    ...normalizeWorkspaceReplicationRelationshipScope(scope),
    mode: scope.mode,
  };
}

function compareEndpoints(
  left: WorkspaceReplicationRelationshipEndpoint,
  right: WorkspaceReplicationRelationshipEndpoint,
): number {
  const machineComparison = left.machineId.localeCompare(right.machineId);
  if (machineComparison !== 0) {
    return machineComparison;
  }
  return left.rootPath.localeCompare(right.rootPath);
}

export function resolveWorkspaceReplicationRelationshipEndpoints(
  scope: WorkspaceReplicationRelationshipScope,
): readonly [WorkspaceReplicationRelationshipEndpoint, WorkspaceReplicationRelationshipEndpoint] {
  const normalized = normalizeWorkspaceReplicationRelationshipScope(scope);
  return [
    {
      machineId: normalized.sourceMachineId,
      rootPath: normalized.sourceWorkspaceRoot,
    },
    {
      machineId: normalized.targetMachineId,
      rootPath: normalized.targetWorkspaceRoot,
    },
  ].sort(compareEndpoints) as [WorkspaceReplicationRelationshipEndpoint, WorkspaceReplicationRelationshipEndpoint];
}

export function serializeWorkspaceReplicationRelationshipScope(
  scope: WorkspaceReplicationRelationshipScope,
): string {
  const normalized = normalizeWorkspaceReplicationRelationshipScope(scope);
  return JSON.stringify({
    endpoints: resolveWorkspaceReplicationRelationshipEndpoints(normalized),
    ...(normalized.mode ? { mode: normalized.mode } : {}),
    ...(normalized.ignorePatterns ? { ignorePatterns: normalized.ignorePatterns } : {}),
  });
}

export function serializeWorkspaceReplicationDirectionScope(
  scope: WorkspaceReplicationDirectionScope,
): string {
  const normalized = normalizeWorkspaceReplicationDirectionScope(scope);
  return JSON.stringify({
    sourceMachineId: normalized.sourceMachineId,
    sourceWorkspaceRoot: normalized.sourceWorkspaceRoot,
    targetMachineId: normalized.targetMachineId,
    targetWorkspaceRoot: normalized.targetWorkspaceRoot,
    mode: normalized.mode,
    ...(normalized.ignorePatterns ? { ignorePatterns: normalized.ignorePatterns } : {}),
  });
}
