import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export function resolveExpoCliPath(params: Readonly<{
  rootDir: string;
  uiWorkspaceDir: string;
}>): string {
  const rootCandidate = resolvePath(params.rootDir, 'node_modules', 'expo', 'bin', 'cli');
  if (existsSync(rootCandidate)) return rootCandidate;

  const workspaceCandidate = resolvePath(params.uiWorkspaceDir, 'node_modules', 'expo', 'bin', 'cli');
  if (existsSync(workspaceCandidate)) return workspaceCandidate;

  return rootCandidate;
}
