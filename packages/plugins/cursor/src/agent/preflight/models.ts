import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { parseCursorCliModelsOutput } from '../cli/models.js';

export type CursorPreflightModel = Readonly<{
  id: string;
  name: string;
}>;

const CURSOR_CLI_MODELS_COMMAND_ARGS = ['models'] as const;
const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 250;
const PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;

function buildCursorPreflightEnv(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> | undefined {
  if (!env) return undefined;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

export function buildCursorPreflightModelsFromModelsOutput(output: string): readonly CursorPreflightModel[] | null {
  const models = parseCursorCliModelsOutput(output).map((model) => ({
    id: model.id,
    name: model.name,
  }));
  return models.length > 0 ? models : null;
}

export async function probeCursorPreflightModelsRaw(params: Readonly<{
  exec: ExecRuntimeServiceV1;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly CursorPreflightModel[] | null> {
  const result = await params.exec.run({
    kind: 'agent-cli',
    agentId: 'cursor',
    args: CURSOR_CLI_MODELS_COMMAND_ARGS,
    cwd: params.cwd,
    ...(params.env ? { env: buildCursorPreflightEnv(params.env) } : {}),
  }, {
    maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
  });
  if (result.exitCode !== 0) return null;
  return buildCursorPreflightModelsFromModelsOutput(result.stdout)
    ?? buildCursorPreflightModelsFromModelsOutput(result.stderr);
}

export const CURSOR_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeCursorPreflightModelsRaw,
  cliModelsCommandArgs: CURSOR_CLI_MODELS_COMMAND_ARGS,
} as const);
