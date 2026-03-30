import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { readOpenCodeSessionAffinityFromMetadata } from '../utils/opencodeSessionAffinity';
import { resolveOpenCodeCliLaunchSpec } from '../utils/resolveOpenCodeCliCommand';
import type { OpenCodeSessionBundle } from '../../../session/handoff/types';
import { OPEN_CODE_EXPORT_MAX_BUFFER_BYTES, OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES } from './opencodeHandoffLimits';

type ExecFileAsync = (command: string, args: readonly string[]) => Promise<Readonly<{ stdout: string; stderr: string }>>;

const execFileAsync: ExecFileAsync = async (command, args) =>
  await new Promise((resolve, reject) => {
    execFileCallback(
      command,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: OPEN_CODE_EXPORT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr),
        });
      },
    );
  });

export async function exportOpenCodeSessionBundle(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  execFile?: ExecFileAsync;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<OpenCodeSessionBundle> {
  const execFile = params.execFile ?? execFileAsync;
  const launch = resolveOpenCodeCliLaunchSpec(params.processEnv);
  const result = await execFile(launch.command, [...launch.args, 'export', params.remoteSessionId]);
  if (Buffer.byteLength(result.stdout, 'utf8') > OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES) {
    throw new Error(`OpenCode handoff export payload exceeds size limit (${OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES} bytes)`);
  }
  const affinity = readOpenCodeSessionAffinityFromMetadata(params.metadata);

  return {
    providerId: 'opencode',
    remoteSessionId: params.remoteSessionId,
    exportJsonBase64: Buffer.from(result.stdout, 'utf8').toString('base64'),
    affinity,
  };
}
