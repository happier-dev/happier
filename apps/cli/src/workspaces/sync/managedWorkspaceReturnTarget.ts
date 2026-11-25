import { basename, dirname, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';

import { logger } from '@/ui/logger';
import { runWithWorkspaceSourceDemand, workspaceTargetUnavailable, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { ManagedWorkspaceReturnTarget } from './managedWorkspaceReturn';
import { applyCapturedWorkspaceSyncEntryAtRoot } from './workspaceSyncConflicts';
import { runNativeConfinedWorkspaceSyncApply } from './workspaceSyncNativeConfinedFileSystem';

async function runHolderStagingCommand(
  source: WorkspaceSource, args: readonly string[], signal?: AbortSignal, material?: Readable,
): Promise<string> {
  signal?.throwIfAborted();
  const child = source.spawn({ command: 'sh', args });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.resume();
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(workspaceTargetUnavailable());
    });
  });
  try {
    if (material) await Promise.all([completed, pipeline(material, child.stdin, { signal })]);
    else {
      child.stdin.end();
      await completed;
    }
    return output.trim();
  } catch (error) {
    await child.terminateTree().catch(() => {});
    throw error;
  }
}

/** Stage only the reviewed entry in guest-private storage. The native Apply owns all destination effects. */
export async function runManagedWorkspaceReturnTarget(input: Readonly<{
  source: WorkspaceSource;
  rootPath: string;
  signal: AbortSignal;
  assertCurrentAuthority: () => Promise<void>;
  apply: Parameters<ManagedWorkspaceReturnTarget>[1];
}>): Promise<void> {
  const { source, signal } = input;
  const helperPath = source.nativeHelperPath;
  const paths = source.commandPaths;
  if (!helperPath || !paths) throw workspaceTargetUnavailable();
  await runWithWorkspaceSourceDemand(source, () => input.apply(async ({ materialPath, ...entry }) => {
    signal.throwIfAborted();
    const directory = await runHolderStagingCommand(source, ['-c',
      'set -eu; umask 077; parent="$HOME/.happier/workspace-sync"; mkdir -p "$parent"; mktemp -d "$parent/return-XXXXXXXX"']);
    if (!posix.isAbsolute(directory)) throw workspaceTargetUnavailable();
    let preserveRecovery = false;
    try {
      signal.throwIfAborted();
      let guestMaterialPath: string | null = null;
      if (materialPath) {
        const name = basename(materialPath);
        const archive = Readable.from(createTar({ cwd: dirname(materialPath), portable: true }, [`./${name}`]));
        await runHolderStagingCommand(source, ['-c', 'umask 077; exec tar -xpf - -C "$1"', 'workspace-return', directory],
          signal, archive);
        guestMaterialPath = posix.join(directory, name);
      }
      signal.throwIfAborted();
      const outcome = await applyCapturedWorkspaceSyncEntryAtRoot({
        ...entry, rootPath: paths.toCommandPath(input.rootPath), materialPath: guestMaterialPath, recoveryDirectory: directory,
        assertCurrentAuthority: async () => {
          signal.throwIfAborted();
          await input.assertCurrentAuthority();
        },
      }, { runNativeConfinedApply: request => runNativeConfinedWorkspaceSyncApply(request, {
        resolveExecutable: () => helperPath,
        spawnChild: (command, args) => source.spawn({ command, args }),
      }) });
      preserveRecovery = outcome.status === 'recovery_needed';
      return outcome;
    } finally {
      if (!preserveRecovery) {
        await runHolderStagingCommand(source, ['-c', 'exec rm -rf -- "$1"', 'workspace-return', directory])
          .catch(() => { logger.warn('[workspace-return] Could not remove guest staging directory'); });
      }
    }
  }));
}
