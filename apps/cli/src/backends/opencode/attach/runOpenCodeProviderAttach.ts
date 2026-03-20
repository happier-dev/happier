import { spawn } from 'node:child_process';

import { readSharedManagedOpenCodeServerStateBestEffort } from '@/backends/opencode/server/sharedManagedServer';
import { createOpenCodeAttachArgs } from '@/backends/opencode/localControl/createOpenCodeAttachArgs';
import { resolveOpenCodeCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveOpenCodeProviderAttachTargetWithManagedServerFallback } from './evaluateOpenCodeProviderAttachEligibility';

type SpawnedProcess = Readonly<{
  once: {
    (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    (event: 'error', handler: (error: Error) => void): void;
  };
}>;

export async function runOpenCodeProviderAttach(params: Readonly<{
  sessionId: string;
  metadata: Record<string, unknown>;
  spawnProcess?: typeof spawn;
  command?: string;
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  readManagedServerStateFn?: typeof readSharedManagedOpenCodeServerStateBestEffort;
  resolveCommandFn?: (env?: NodeJS.ProcessEnv) => ProviderCliLaunchSpec;
}>): Promise<number> {
  const target = await resolveOpenCodeProviderAttachTargetWithManagedServerFallback({
    metadata: params.metadata,
    readManagedServerStateFn: params.readManagedServerStateFn ?? readSharedManagedOpenCodeServerStateBestEffort,
  });
  if (!target.eligible) {
    return 1;
  }

  const spawnProcess = params.spawnProcess ?? spawn;
  const env = params.env ?? process.env;
  const launch = params.command && params.commandArgs
    ? null
    : (params.resolveCommandFn ?? resolveOpenCodeCliLaunchSpec)(env);
  const command = params.command ?? launch?.command ?? resolveOpenCodeCliLaunchSpec(env).command;
  const commandArgs = params.commandArgs ?? launch?.args ?? resolveOpenCodeCliLaunchSpec(env).args;

  return await new Promise<number>((resolve) => {
    const child = spawnProcess(command, [...commandArgs, ...createOpenCodeAttachArgs({
      baseUrl: target.baseUrl,
      directory: target.directory,
      sessionId: target.vendorSessionId,
    })], {
      stdio: 'inherit',
      shell: false,
      env,
    }) as unknown as SpawnedProcess;

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}
