import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { resolve } from 'node:path';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { ScmFileAtRevisionRequest, ScmFileAtRevisionResponse } from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';

import type { ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { resolveWorkspaceRelativePath } from '@/scm/workspace/workspaceExportPackaging/resolveWorkspaceRelativePath';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';

/** Read once at admission; the shared start owner parses and freezes the document. */
export async function readRepositoryWorkflow(input: Readonly<{
  path: string;
  projectTarget: WorkflowProjectTargetV1;
  signal?: AbortSignal;
}>, deps: Readonly<{
  registry?: ScmBackendRegistry;
}> = {}): Promise<Readonly<{ json: string; commit: string }>> {
  const directory = resolveCanonicalAbsolutePath(input.projectTarget.directory)?.path;
  if (!directory) throw Object.assign(new Error('workspace_unavailable'), { code: 'workspace_unavailable' });
  const relative = resolveWorkspaceRelativePath({ workspaceRoot: directory, candidatePath: input.path });
  if (!relative.ok) throw Object.assign(new Error(relative.errorCode), { code: relative.errorCode });
  const [root, file] = await Promise.all([currentWorkspaceSource().realpath(directory), currentWorkspaceSource().realpath(resolve(directory, relative.relativePath))]);
  // Resolve symlinks at the filesystem boundary before opening repository content.
  const contained = resolveWorkspaceRelativePath({ workspaceRoot: root, candidatePath: file });
  if (!contained.ok) throw Object.assign(new Error(contained.errorCode), { code: contained.errorCode });
  const inspected = await inspectWorkspaceLocationWithScmWorkspace({
    candidatePath: root, registry: deps.registry, ...(input.signal ? { signal: input.signal } : {}),
  });
  const commit = inspected?.inspection.committedRevision;
  if (!inspected || !commit) throw Object.assign(new Error('committed_revision_unavailable'), { code: 'committed_revision_unavailable' });
  const repositoryPath = resolveWorkspaceRelativePath({
    workspaceRoot: inspected.inspection.rootPath, candidatePath: resolve(root, relative.relativePath),
  });
  if (!repositoryPath.ok) throw Object.assign(new Error(repositoryPath.errorCode), { code: repositoryPath.errorCode });
  const request: ScmFileAtRevisionRequest = { cwd: root, path: repositoryPath.relativePath, selector: { commit } };
  const content = await runScmRoute<ScmFileAtRevisionRequest, ScmFileAtRevisionResponse>({
    request, workingDirectory: root, registry: deps.registry, signal: input.signal,
    onNonRepository: () => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY }),
    runWithBackend: ({ context, selection }) => selection.backend.fileAtRevision
      ? selection.backend.fileAtRevision({ context, request })
      : Promise.resolve({ success: false, errorCode: 'unsupported' }),
  });
  if (!content.success) throw Object.assign(new Error(content.errorCode), { code: content.errorCode });
  return { json: Buffer.from(content.contentBase64, 'base64').toString('utf8'), commit };
}
