import { spawn } from 'node:child_process';

import { readSharedManagedOpenCodeServerStateBestEffort } from '@/backends/opencode/server/sharedManagedServer';
import { readOpenCodeSessionAffinityFromMetadata } from '@/backends/opencode/utils/opencodeSessionAffinity';
import { createOpenCodeAttachArgs } from '@/backends/opencode/localControl/createOpenCodeAttachArgs';
import { resolveOpenCodeCliCommand } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';

type SpawnedProcess = Readonly<{
  once: {
    (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    (event: 'error', handler: (error: Error) => void): void;
  };
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function runOpenCodeProviderAttach(params: Readonly<{
  sessionId: string;
  metadata: Record<string, unknown>;
  spawnProcess?: typeof spawn;
  command?: string;
  env?: NodeJS.ProcessEnv;
  readManagedServerStateFn?: typeof readSharedManagedOpenCodeServerStateBestEffort;
  resolveCommandFn?: typeof resolveOpenCodeCliCommand;
}>): Promise<number> {
  const vendorSessionId = normalizeNonEmptyString(params.metadata.opencodeSessionId);
  const directory = normalizeNonEmptyString(params.metadata.path);
  const affinity = readOpenCodeSessionAffinityFromMetadata(params.metadata);
  const managedState = await (params.readManagedServerStateFn ?? readSharedManagedOpenCodeServerStateBestEffort)().catch(() => null);
  const baseUrl = affinity.serverBaseUrl ?? managedState?.baseUrl ?? null;

  if (!vendorSessionId || !directory || affinity.backendMode !== 'server' || !baseUrl) {
    return 1;
  }

  const spawnProcess = params.spawnProcess ?? spawn;
  const env = params.env ?? process.env;
  const command = params.command ?? (params.resolveCommandFn ?? resolveOpenCodeCliCommand)(env);

  return await new Promise<number>((resolve) => {
    const child = spawnProcess(command, createOpenCodeAttachArgs({
      baseUrl,
      directory,
      sessionId: vendorSessionId,
    }), {
      stdio: 'inherit',
      shell: false,
      env,
    }) as unknown as SpawnedProcess;

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}
