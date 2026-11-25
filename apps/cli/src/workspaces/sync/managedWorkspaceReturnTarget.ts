import { runWithWorkspaceSourceDemand, workspaceTargetUnavailable, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { ManagedWorkspaceReturnTarget } from './managedWorkspaceReturn';
import { applyCapturedWorkspaceSyncEntryAtRoot } from './workspaceSyncConflicts';
import { runNativeConfinedWorkspaceSyncApply } from './workspaceSyncNativeConfinedFileSystem';

/** The admitted holder's native writer owns staging, confinement and recovery. */
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
  await runWithWorkspaceSourceDemand(source, () => input.apply(entry =>
    applyCapturedWorkspaceSyncEntryAtRoot({
      ...entry, rootPath: paths.toCommandPath(input.rootPath), stageOnTarget: signal,
      assertCurrentAuthority: async () => {
        signal.throwIfAborted();
        await input.assertCurrentAuthority();
      },
    }, { runNativeConfinedApply: request => runNativeConfinedWorkspaceSyncApply(request, {
      resolveExecutable: () => helperPath,
      spawnChild: (command, args) => source.spawn({ command, args }),
    }) })));
}
