import { createRequire } from 'node:module';
import { execFileWithDeadline, windowsSystemToolCommand, type ExecFileChild } from '@happier-dev/cli-common/process';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

/** Process-spawn boundary; injected in tests so no real `taskkill` is ever invoked. */
export type TaskkillExecFile = (command: string, args: readonly string[], options: Readonly<{
  timeout?: number;
  terminateOnAbort: (child: ExecFileChild) => Promise<void>;
}>) => Promise<unknown>;

type TaskkillInput = Readonly<{
  pid: number;
  force: boolean;
  /** The terminator signals its identity-validated members individually. */
  tree?: boolean;
  /** Supplied by the containing teardown when it owns a deadline. Startup custody has no deadline. */
  timeoutMs?: number;
  execFile?: TaskkillExecFile;
}>;
type TaskkillOwner = {
  taskkillWindowsProcessTree(input: TaskkillInput, resolveCommand: typeof windowsSystemToolCommand, run: typeof execFileWithDeadline): Promise<void>;
};

export async function taskkillWindowsProcessTree(input: TaskkillInput): Promise<void> {
  // The shipped owner is a large bundle; only an actual taskkill needs it.
  const owner = createRequire(import.meta.url)(resolveCliRuntimeAssetPath('scripts', 'process_tree.cjs')) as TaskkillOwner;
  await owner.taskkillWindowsProcessTree(input, windowsSystemToolCommand, execFileWithDeadline);
}
