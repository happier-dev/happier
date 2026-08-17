import type { ExecService } from '@happier-dev/plugin-sdk/exec';

type GrokPreflightModel = Readonly<{
  id: string;
  name: string;
}>;

const GROK_MODELS_COMMAND_ARGS = ['models'] as const;
const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 250;
const PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,255}$/u;

function isSafeModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value)
    && value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function formatModelName(modelId: string): string {
  return modelId
    .split(/[-_/:]+/u)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'grok'
      ? 'Grok'
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function parseGrokModelsOutput(outputRaw: string): readonly GrokPreflightModel[] | null {
  const lines = outputRaw.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line.trim() === 'Available models:');
  if (sectionIndex < 0) return null;

  const models: GrokPreflightModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines.slice(sectionIndex + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(?:\*\s+)?([^\s]+)(?:\s+\(default\))?$/u.exec(line);
    const modelId = match?.[1] ?? '';
    if (!isSafeModelId(modelId) || seen.has(modelId)) return null;
    seen.add(modelId);
    models.push(Object.freeze({ id: modelId, name: formatModelName(modelId) }));
  }
  return models.length > 0 ? Object.freeze(models) : null;
}

export async function probeGrokPreflightModelsRaw(params: Readonly<{
  exec: ExecService;
  cwd: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<readonly GrokPreflightModel[] | null> {
  const env = params.env
    ? Object.fromEntries(Object.entries(params.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ))
    : null;
  const resolved = await params.exec.systemTools.resolve({
    toolId: 'grok-cli',
    purpose: 'Probe Grok models',
    cwd: params.cwd,
  });
  const result = await params.exec.run({
    executable: resolved.executable,
    args: GROK_MODELS_COMMAND_ARGS,
    cwd: { root: 'workspace', relativePath: '' },
    ...(env ? { env } : {}),
    maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
  });
  if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) return null;
  const decoder = new TextDecoder();
  return parseGrokModelsOutput(decoder.decode(result.stdout))
    ?? parseGrokModelsOutput(decoder.decode(result.stderr));
}

export const GROK_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeGrokPreflightModelsRaw,
} as const);
