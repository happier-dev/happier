import type { ExecService } from '@happier-dev/plugin-sdk/exec';

export type AuggiePreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

const AUGGIE_CLI_MODELS_COMMAND_ARGS = ['model', 'list', '--json'] as const;
const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 250;
const PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;

function buildAuggiePreflightEnv(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') output[key] = value;
  }
  output.CI = '1';
  return output;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAuggieModel(value: unknown): AuggiePreflightModel | null {
  if (!isRecord(value)) return null;
  const id = readString(value.shortName) ?? readString(value.id);
  const name = readString(value.displayName) ?? id;
  if (!id || !name) return null;
  const description = readString(value.description);
  return {
    id,
    name,
    ...(description ? { description } : {}),
  };
}

export function buildAuggiePreflightModelsFromModelListJson(outputRaw: string): readonly AuggiePreflightModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputRaw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const models = parsed.models.flatMap((model): AuggiePreflightModel[] => {
    const parsedModel = parseAuggieModel(model);
    return parsedModel ? [parsedModel] : [];
  });
  return models.length > 0 ? models : null;
}

export async function probeAuggiePreflightModelsRaw(params: Readonly<{
  exec: ExecService;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly AuggiePreflightModel[] | null> {
  const resolved = await params.exec.systemTools.resolve({
    toolId: 'auggie-cli',
    purpose: 'Probe Auggie models',
    cwd: params.cwd,
  });
  const result = await params.exec.run({
    executable: resolved.executable,
    args: AUGGIE_CLI_MODELS_COMMAND_ARGS,
    cwd: { root: 'workspace', relativePath: '' },
    env: { ...buildAuggiePreflightEnv(params.env), CI: '1' },
    maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
    timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
  });
  if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) return null;
  const decoder = new TextDecoder();
  return buildAuggiePreflightModelsFromModelListJson(decoder.decode(result.stdout))
    ?? buildAuggiePreflightModelsFromModelListJson(decoder.decode(result.stderr));
}

export const AUGGIE_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeAuggiePreflightModelsRaw,
  cliModelsCommandArgs: AUGGIE_CLI_MODELS_COMMAND_ARGS,
} as const);
