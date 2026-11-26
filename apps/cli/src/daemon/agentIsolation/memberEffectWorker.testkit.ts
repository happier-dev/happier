import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

// The OS boundary maps a guest UID/home onto a disposable host directory. It
// reads the actual production frame, then executes the real finite entrypoint;
// it never supplies an install result or changes the admitted operation.
const worker = String.raw`
void (async () => {
    const { readAgentLaunchFrame } = await import(process.env.HAPPIER_TEST_FRAME_ENTRY);
    const frame = await readAgentLaunchFrame(process.stdin, undefined, true);
    if (!frame.nativeIdentity) throw new Error('Missing native identity');
    const backing = process.env.HAPPIER_TEST_MEMBER_BACKING;
    const map = value => typeof value === 'string' ? value.split(frame.nativeIdentity.home).join(backing) : value;
    if (frame.action === 'retire_operation') {
      const { retireAgentLaunchOperationRuntime } = await import(process.env.HAPPIER_TEST_RUNTIME_ENTRY);
      await retireAgentLaunchOperationRuntime(backing, map(frame.runtimeHome));
      process.stdin.destroy();
      return;
    }
    if (!['agent-install-effect', 'filesystem-effect', 'workspace-effect'].includes(frame.args[0])) throw new Error('Unexpected native effect');
    // The member workspace root is a logical OS path; its disposable backing stands in for it.
    const workspaceRoot = process.env.HAPPIER_TEST_MEMBER_WORKSPACE_ROOT, workspaceBacking = process.env.HAPPIER_TEST_MEMBER_WORKSPACE_BACKING;
    if (frame.args[0] === 'workspace-effect' && workspaceRoot && workspaceBacking) {
      const promises = require('node:fs/promises');
      const swap = (value, from, to) => typeof value === 'string' && (value === from || value.startsWith(from + '/')) ? to + value.slice(from.length) : value;
      for (const name of ['readFile', 'stat', 'lstat', 'readdir', 'open', 'access']) {
        const original = promises[name];
        promises[name] = (path, ...rest) => original(swap(path, workspaceRoot, workspaceBacking), ...rest);
      }
      const realpath = promises.realpath;
      promises.realpath = async (path, ...rest) => swap(await realpath(swap(path, workspaceRoot, workspaceBacking), ...rest), workspaceBacking, workspaceRoot);
      require('node:module').syncBuiltinESMExports();
    }
    for (const key of Object.keys(process.env)) if (!key.startsWith('HAPPIER_TEST_') && key !== 'TSX_TSCONFIG_PATH') delete process.env[key];
    Object.assign(process.env, Object.fromEntries(Object.entries(frame.environment).map(([key, value]) => [key, map(value)])));
    const fs = await import('node:fs/promises');
    await fs.mkdir(map(frame.runtimeHome), { recursive: true });
    if (frame.args[0] === 'agent-install-effect') {
      const { runMemberAgentInstallEffect } = await import(process.env.HAPPIER_TEST_INSTALL_ENTRY);
      setImmediate(() => process.stdin.resume());
      await runMemberAgentInstallEffect(process.stdin, process.stdout, new AbortController().signal);
    } else if (frame.args[0] === 'workspace-effect') {
      const { runWorkspaceEffectWorker } = await import(process.env.HAPPIER_TEST_WORKSPACE_EFFECT_ENTRY);
      setImmediate(() => process.stdin.resume());
      await runWorkspaceEffectWorker([], { input: process.stdin, output: process.stdout, signal: new AbortController().signal,
        currentDirectory: () => frame.cwd });
    } else {
      const { runFilesystemEffectInternal } = await import(process.env.HAPPIER_TEST_FILESYSTEM_ENTRY);
      setImmediate(() => process.stdin.resume());
      await runFilesystemEffectInternal(process.stdin, process.stdout);
    }
})().catch(error => { process.stderr.write(JSON.stringify({ code: error?.code ?? 'member_worker_failed', name: error?.name, message: error?.message, stack: error?.stack }) + '\n'); process.exitCode = 1; process.stdin.destroy(); });
`;

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = (path: string) => pathToFileURL(resolve(cliRoot, path)).href;

/** Whether this OS spawn is a native member effect (`sudo … <managed CLI> agent-launch`). */
export function isMemberAgentLaunchSpawn(
  command: string,
  args: readonly string[] | undefined,
): boolean {
  return command === 'sudo' && args?.at(-1) === 'agent-launch';
}

/** Runs the real member effect entrypoint for a disposable member home backing. */
export function spawnMemberEffectWorker(
  input: Readonly<{
    actualSpawn: typeof spawn;
    options: SpawnOptions | undefined;
    backing: string;
    /** Logical member workspace root and its disposable backing, for member workspace reads. */
    workspace?: Readonly<{ root: string; backing: string }>;
  }>,
): ChildProcess {
  return input.actualSpawn(
    process.execPath,
    [
      '--conditions=happier-source',
      '--import',
      createRequire(import.meta.url).resolve('tsx/esm'),
      '-e',
      worker,
    ],
    {
      ...input.options,
      cwd: cliRoot,
      env: {
        PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
        HAPPIER_TEST_MEMBER_BACKING: input.backing,
        ...(input.workspace ? { HAPPIER_TEST_MEMBER_WORKSPACE_ROOT: input.workspace.root,
          HAPPIER_TEST_MEMBER_WORKSPACE_BACKING: input.workspace.backing } : {}),
        HAPPIER_TEST_WORKSPACE_EFFECT_ENTRY: entry(
          'src/workspaces/activation/workspaceEffectWorker.ts',
        ),
        HAPPIER_TEST_FRAME_ENTRY: entry(
          'src/daemon/agentIsolation/agentLaunchFrame.ts',
        ),
        HAPPIER_TEST_INSTALL_ENTRY: entry(
          'src/capabilities/installJobs/memberInstallEffect.ts',
        ),
        HAPPIER_TEST_FILESYSTEM_ENTRY: entry(
          'src/rpc/handlers/fileSystem/filesystemEffectInternal.ts',
        ),
        HAPPIER_TEST_RUNTIME_ENTRY: entry(
          'src/daemon/agentIsolation/agentLaunchRuntime.ts',
        ),
      },
    },
  );
}
