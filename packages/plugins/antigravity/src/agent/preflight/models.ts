import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import { buildAntigravityCliModelsProbeEnv } from '../lifecycle/runtimeEnv.js';
import { ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS } from '../cliPrint/modelsProbePolicy.js';

export type AntigravityPreflightModel = Readonly<{
  id: string;
  name: string;
}>;

const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 250;
const PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;
function normalizeModelLine(line: string): string | null {
  const normalized = line
    .trim()
    .replace(/^[-*]\s+/u, '')
    .replace(/\s+/gu, ' ');
  if (!normalized) return null;
  if (/^(available models:?|models:?|no models available|none)$/iu.test(normalized)) return null;
  if (/^(error|warning|usage):/iu.test(normalized)) return null;
  return /[a-z0-9]/iu.test(normalized) ? normalized : null;
}

export function buildAntigravityPreflightModelsFromModelsOutput(
  outputRaw: string,
): readonly AntigravityPreflightModel[] | null {
  const seen = new Set<string>();
  const models: AntigravityPreflightModel[] = [];
  for (const line of outputRaw.split('\n')) {
    const label = normalizeModelLine(line);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    models.push({ id: label, name: label });
  }
  return models.length > 0 ? models : null;
}

export async function probeAntigravityPreflightModelsRaw(params: Readonly<{
  exec: ExecRuntimeServiceV1;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly AntigravityPreflightModel[] | null> {
  const result = await params.exec.run({
    kind: 'agent-cli',
    agentId: 'antigravity',
    args: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
    cwd: params.cwd,
    env: buildAntigravityCliModelsProbeEnv(params.env),
  }, {
    maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
  });
  if (result.exitCode !== 0) return null;
  return buildAntigravityPreflightModelsFromModelsOutput(result.stdout)
    ?? buildAntigravityPreflightModelsFromModelsOutput(result.stderr);
}

export const ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeAntigravityPreflightModelsRaw,
  cliModelsCommandArgs: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
} as const);
