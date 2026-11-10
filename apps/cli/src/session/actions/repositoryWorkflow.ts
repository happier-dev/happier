import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { resolveWorkspaceRelativePath } from '@/scm/workspace/workspaceExportPackaging/resolveWorkspaceRelativePath';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';

/** Read once at admission; the shared start owner parses and freezes the document. */
export async function readRepositoryWorkflow(input: Readonly<{
  path: string;
  projectTarget: WorkflowProjectTargetV1;
  signal?: AbortSignal;
}>, deps: Readonly<{
  inspectLocation?: typeof inspectWorkspaceLocationWithScmWorkspace;
}> = {}): Promise<Readonly<{ json: string; commit: string }>> {
  const directory = resolveCanonicalAbsolutePath(input.projectTarget.directory)?.path;
  if (!directory) throw Object.assign(new Error('workspace_unavailable'), { code: 'workspace_unavailable' });
  const relative = resolveWorkspaceRelativePath({ workspaceRoot: directory, candidatePath: input.path });
  if (!relative.ok) throw Object.assign(new Error(relative.errorCode), { code: relative.errorCode });
  const [root, file] = await Promise.all([realpath(directory), realpath(resolve(directory, relative.relativePath))]);
  // Resolve symlinks at the filesystem boundary before opening repository content.
  const contained = resolveWorkspaceRelativePath({ workspaceRoot: root, candidatePath: file });
  if (!contained.ok) throw Object.assign(new Error(contained.errorCode), { code: contained.errorCode });
  const inspected = await (deps.inspectLocation ?? inspectWorkspaceLocationWithScmWorkspace)({
    candidatePath: root, ...(input.signal ? { signal: input.signal } : {}),
  });
  const commit = inspected?.inspection.committedRevision;
  if (!commit) throw Object.assign(new Error('committed_revision_unavailable'), { code: 'committed_revision_unavailable' });
  const json = await readFile(file, { encoding: 'utf8', ...(input.signal ? { signal: input.signal } : {}) });
  return { json, commit };
}
