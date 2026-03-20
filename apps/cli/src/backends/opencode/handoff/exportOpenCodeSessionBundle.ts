import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { readOpenCodeSessionAffinityFromMetadata } from '../utils/opencodeSessionAffinity';
import { resolveOpenCodeCliLaunchSpec } from '../utils/resolveOpenCodeCliCommand';
import type { OpenCodeSessionBundle } from '../../../session/handoff/types';

type ExecFileAsync = (command: string, args: readonly string[]) => Promise<Readonly<{ stdout: string; stderr: string }>>;

const execFileAsync = promisify(execFileCallback) as unknown as ExecFileAsync;

export async function exportOpenCodeSessionBundle(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  execFile?: ExecFileAsync;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<OpenCodeSessionBundle> {
  const execFile = params.execFile ?? execFileAsync;
  const launch = resolveOpenCodeCliLaunchSpec(params.processEnv);
  const result = await execFile(launch.command, [...launch.args, 'export', params.remoteSessionId]);
  const affinity = readOpenCodeSessionAffinityFromMetadata(params.metadata);

  return {
    providerId: 'opencode',
    remoteSessionId: params.remoteSessionId,
    exportJsonBase64: Buffer.from(result.stdout, 'utf8').toString('base64'),
    affinity,
  };
}
