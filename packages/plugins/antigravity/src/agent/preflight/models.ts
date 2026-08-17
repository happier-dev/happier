import type { ExecService } from '@happier-dev/plugin-sdk/exec';
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
  exec: ExecService;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly AntigravityPreflightModel[] | null> {
  const resolved = await params.exec.systemTools.resolve({
    toolId: 'antigravity-cli',
    purpose: 'Probe Antigravity models',
    cwd: params.cwd,
  });
  const result = await params.exec.run({
    executable: resolved.executable,
    args: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
    cwd: { root: 'workspace', relativePath: '' },
    env: { ...buildAntigravityCliModelsProbeEnv(params.env), CI: '1' },
    maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
  });
  if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) return null;
  const decoder = new TextDecoder();
  return buildAntigravityPreflightModelsFromModelsOutput(decoder.decode(result.stdout))
    ?? buildAntigravityPreflightModelsFromModelsOutput(decoder.decode(result.stderr));
}

export const ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeAntigravityPreflightModelsRaw,
  cliModelsCommandArgs: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
} as const);
