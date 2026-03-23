import { isAbsolute, relative, resolve } from 'node:path';

import { detectWorkspacePathTraits } from '@/scm/sourceController/workspaceExportPackaging/detectWorkspacePathTraits';

export type ResolveWorkspaceRelativePathResult = Readonly<
  | { ok: true; relativePath: string }
  | { ok: false; errorCode: 'workspace_path_outside_root' }
>;

export function resolveWorkspaceRelativePath(params: Readonly<{
  workspaceRoot: string;
  candidatePath: string;
}>): ResolveWorkspaceRelativePathResult {
  const root = resolve(params.workspaceRoot);
  const absoluteCandidate = isAbsolute(params.candidatePath)
    ? resolve(params.candidatePath)
    : resolve(root, params.candidatePath);
  const traits = detectWorkspacePathTraits(relative(root, absoluteCandidate));
  if (traits.isAbsolute || traits.hasParentTraversal) {
    return { ok: false, errorCode: 'workspace_path_outside_root' };
  }
  return { ok: true, relativePath: traits.normalizedPath };
}
