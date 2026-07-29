import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

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
  exec: PluginExecService;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly CursorPreflightModel[] | null> {
  const resolved = await params.exec.systemTools.resolve({
    toolId: 'cursor-agent',
    purpose: 'Probe Cursor models',
    cwd: params.cwd,
  });
  const result = await params.exec.run({
    executable: resolved.executable,
    args: CURSOR_CLI_MODELS_COMMAND_ARGS,
    cwd: { root: 'workspace', relativePath: '' },
    ...(params.env ? { env: buildCursorPreflightEnv(params.env) } : {}),
    maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
  });
  if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) return null;
  const decoder = new TextDecoder();
  return buildCursorPreflightModelsFromModelsOutput(decoder.decode(result.stdout))
    ?? buildCursorPreflightModelsFromModelsOutput(decoder.decode(result.stderr));
}

export const CURSOR_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeCursorPreflightModelsRaw,
  cliModelsCommandArgs: CURSOR_CLI_MODELS_COMMAND_ARGS,
} as const);
