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
    const frame = await readAgentLaunchFrame(process.stdin);
    if (!frame.nativeIdentity || !['agent-install-effect', 'filesystem-effect'].includes(frame.args[0])) throw new Error('Unexpected native effect');
    const backing = process.env.HAPPIER_TEST_MEMBER_BACKING;
    const map = value => typeof value === 'string' ? value.split(frame.nativeIdentity.home).join(backing) : value;
    for (const key of Object.keys(process.env)) if (!key.startsWith('HAPPIER_TEST_') && key !== 'TSX_TSCONFIG_PATH') delete process.env[key];
    Object.assign(process.env, Object.fromEntries(Object.entries(frame.environment).map(([key, value]) => [key, map(value)])));
    const fs = await import('node:fs/promises');
    await fs.mkdir(map(frame.runtimeHome), { recursive: true });
    if (frame.args[0] === 'agent-install-effect') {
      const { runMemberAgentInstallEffect } = await import(process.env.HAPPIER_TEST_INSTALL_ENTRY);
      setImmediate(() => process.stdin.resume());
      await runMemberAgentInstallEffect(process.stdin, process.stdout, new AbortController().signal);
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
        HAPPIER_TEST_FRAME_ENTRY: entry(
          'src/daemon/agentIsolation/agentLaunchFrame.ts',
        ),
        HAPPIER_TEST_INSTALL_ENTRY: entry(
          'src/capabilities/installJobs/memberInstallEffect.ts',
        ),
        HAPPIER_TEST_FILESYSTEM_ENTRY: entry(
          'src/rpc/handlers/fileSystem/filesystemEffectInternal.ts',
        ),
      },
    },
  );
}
