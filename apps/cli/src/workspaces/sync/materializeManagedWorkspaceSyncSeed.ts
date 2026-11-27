import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { text as readStreamText } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { WorkspaceContentPolicyV1 } from '@happier-dev/protocol';
import type { ActionOperationProgressUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import type { ManagedSessionTarget } from '@/machines/managed/acquire';
import { logger } from '@/ui/logger';

import type { ScmBackendRegistry } from '@/scm/registry';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { resolveWorkspaceTransferRootWithScmWorkspace } from '@/scm/workspace/workspaceTransferResolution';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { materializeLocalWorkspaceSyncSeed, resolveWorkspaceSyncSeedTransfer, WORKSPACE_SYNC_SEED_COPY_PROGRESS } from './workspaceSyncSeedTransfer';

export type ManagedWorkspaceSyncSeedTarget = Pick<ManagedSessionTarget, 'exec' | 'openChannel'>;

/** Shared-kept targets keep their own work; source transport runs only for an empty target. */
export async function inspectManagedWorkspaceSyncSeedTarget(input: Readonly<{
  target: Pick<ManagedWorkspaceSyncSeedTarget, 'exec'>; targetPath: string; signal: AbortSignal;
}>): Promise<'copy' | 'reused'> {
  const q = safeBashSingleQuote;
  input.signal.throwIfAborted();
  const result = await input.target.exec(`if [ -L ${q(input.targetPath)} ] || { [ -e ${q(input.targetPath)} ] && [ ! -d ${q(input.targetPath)} ]; }; then exit 1; fi; `
    + `for p in ${q(input.targetPath)}/* ${q(input.targetPath)}/.[!.]* ${q(input.targetPath)}/..?*; do `
    + 'if [ -e "$p" ] || [ -L "$p" ]; then printf reused; exit 0; fi; done; printf copy', input.signal);
  if (result.status !== 0) throw Object.assign(new Error('Project files target could not be inspected'), { code: 'project_files_copy_failed' });
  return result.stdout === 'reused' ? 'reused' : 'copy';
}

export async function materializeManagedWorkspaceSyncSeed(input: Readonly<{
  target: ManagedWorkspaceSyncSeedTarget;
  sourcePath: string;
  targetPath: string | ((sourceRoot: string) => string);
  activeServerDir: string;
  signal: AbortSignal;
  registry?: ScmBackendRegistry;
  contentPolicy?: WorkspaceContentPolicyV1;
  onProgress?(progress: ActionOperationProgressUpdate): void;
}>): Promise<Readonly<{ targetRoot: string; workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
  baseline?: WorkspaceManifest; outcome: 'copied' | 'reused' }>> {
  const q = safeBashSingleQuote;
  const run = async (command: string) => {
    input.signal.throwIfAborted();
    const result = await input.target.exec(command, input.signal);
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Managed workspace transfer command failed');
    return result.stdout;
  };
  let directory: string | undefined;
  let stagedTarget: string | undefined;
  try {
    return await runWithWorkspaceSource(localWorkspaceSource, () => runWithScmBackendRegistryLease(input.registry, async registry => {
      const transferRoot = await resolveWorkspaceTransferRootWithScmWorkspace({ sessionCwd: input.sourcePath, registry });
      const hostRoot = transferRoot?.repositoryRoot ?? input.sourcePath;
      const targetPath = typeof input.targetPath === 'function' ? input.targetPath(hostRoot) : input.targetPath;
      const workspace = { hostRoot, targetRoot: targetPath };
      const targetRoot = transferRoot?.sessionRelativeCwd
        ? posix.join(targetPath, transferRoot.sessionRelativeCwd) : targetPath;
      // A shared-kept target is already its own working copy. Session startup
      // never grants replacement of its contents, including its Git directory.
      const state = await inspectManagedWorkspaceSyncSeedTarget({ target: input.target, targetPath, signal: input.signal });
      if (state === 'reused') return { targetRoot, workspace, outcome: 'reused' as const };
      input.onProgress?.(WORKSPACE_SYNC_SEED_COPY_PROGRESS);
      directory = await mkdtemp(join(tmpdir(), 'happier-managed-seed-'));
      const stagedSource = join(directory, 'workspace');
      const custody = await materializeLocalWorkspaceSyncSeed({ operationId: randomUUID(),
        activeServerDir: input.activeServerDir, sourcePath: input.sourcePath, targetPath: stagedSource,
        workspaceTransfer: input.contentPolicy ? resolveWorkspaceSyncSeedTransfer(input.contentPolicy)
          : { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] }, registry });
      await custody.commit();

      // Git's portable export is reconciled by the same SCM materialization
      // owner as handoff before any bytes are delivered. Only this private,
      // independent tree is copied. Publication follows both the producer's
      // completion and the guest's unpack acknowledgement.
      input.signal.throwIfAborted();
      const targetParent = posix.dirname(targetPath);
      stagedTarget = posix.join(targetParent, `.happier-project-${randomUUID()}`);
      const stage = q(stagedTarget);
      const unpack = [
        `set -eu; umask 077; mkdir -p ${q(targetParent)}; mkdir ${stage}`,
        `cleanup() { rm -rf ${stage}; }; trap cleanup EXIT; trap 'exit 1' HUP INT TERM`,
        `tar --no-same-owner -xpf - -C ${stage}; chmod 700 ${stage}`,
        `trap - EXIT; printf 'staged\n'`,
      ].join('\n');
      const channel = input.target.openChannel(['sh', '-c', unpack], input.signal);
      try {
        const archive = Readable.from(createTar({ cwd: stagedSource, follow: false, portable: true, strict: true }, ['.']));
        const [reply] = await Promise.all([readStreamText(channel), pipeline(archive, channel, { signal: input.signal })]);
        if (reply !== 'staged\n') throw new Error('Managed workspace archive did not finish unpacking');
      } finally {
        channel.destroy();
      }
      // An empty destination can have been created by the native target. rmdir
      // refuses newly populated work, keeping the person's copy recoverable.
      await run(`if [ -d ${q(targetPath)} ]; then rmdir ${q(targetPath)} || exit 1; fi; mv ${stage} ${q(targetPath)}`);
      stagedTarget = undefined;
      return { targetRoot, workspace, baseline: custody.manifest, outcome: 'copied' as const };
    }, { includeHostingProviders: false }));
  } catch (cause) {
    input.signal.throwIfAborted();
    throw Object.assign(new Error('Project files could not be copied into the target', { cause }), {
      code: 'project_files_copy_failed',
      failureCause: projectActionFailureCauseV1(cause, 'session.target.prepare'),
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => logger.warn('[managed] Local Project files staging cleanup failed'));
    if (stagedTarget) {
      try {
        // The copy's cancellation and the target's admission are separate.
        const result = await input.target.exec(`rm -rf ${q(stagedTarget)}`, new AbortController().signal);
        if (result.status !== 0) throw new Error('Guest cleanup refused');
      } catch {
        logger.warn('[managed] Guest Project files staging cleanup failed');
      }
    }
  }
}
