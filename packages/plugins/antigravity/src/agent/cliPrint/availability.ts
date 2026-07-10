import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { ANTIGRAVITY_AGENT_ID } from '../install/cliRuntime.js';
import {
  ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
  ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
  ANTIGRAVITY_CLI_MODELS_READINESS_TIMEOUT_MS,
} from './modelsProbePolicy.js';

export type AntigravityCliPrintAvailabilityProbeResult =
  | Readonly<{ available: true }>
  | Readonly<{
      available: false;
      reasonCode: 'antigravity_cliprint_models_failed' | 'antigravity_cliprint_probe_failed';
      diagnostic: string;
    }>;

type CachedAvailability = Readonly<{
  expiresAtMs: number;
  result: AntigravityCliPrintAvailabilityProbeResult;
}>;

const availabilityCache = new Map<string, CachedAvailability>();

function cacheKey(params: Readonly<{
  cwd?: string | null;
  env?: Readonly<Record<string, string>> | undefined;
}>): string {
  const env = params.env ?? {};
  return JSON.stringify({
    cwd: params.cwd ?? '',
    home: env.HOME ?? '',
    userprofile: env.USERPROFILE ?? '',
    geminiCliHome: env.GEMINI_CLI_HOME ?? '',
    path: env.PATH ?? '',
  });
}

function readDiagnostic(result: Readonly<{ stdout: string; stderr: string; exitCode: number | null }>): string {
  return result.stderr.trim()
    || result.stdout.trim()
    || `agy models exited with code ${result.exitCode ?? 'unknown'}.`;
}

export function clearAntigravityCliPrintAvailabilityCache(): void {
  availabilityCache.clear();
}

export async function probeAntigravityCliPrintAvailability(params: Readonly<{
  exec: ExecRuntimeServiceV1;
  cwd?: string | null;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  now?: () => number;
  cacheTtlMs?: number;
}>): Promise<AntigravityCliPrintAvailabilityProbeResult> {
  const now = params.now?.() ?? Date.now();
  const ttlMs = params.cacheTtlMs ?? 30_000;
  const key = cacheKey(params);
  const cached = availabilityCache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.result;

  let result: AntigravityCliPrintAvailabilityProbeResult;
  try {
    const run = await params.exec.run({
      kind: 'agent-cli',
      agentId: ANTIGRAVITY_AGENT_ID,
      args: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.env ? { env: params.env } : {}),
    }, {
      signal: params.signal,
      timeoutMs: ANTIGRAVITY_CLI_MODELS_READINESS_TIMEOUT_MS,
      maxStdoutBytes: ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
      maxStderrBytes: ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
    });
    result = run.exitCode === 0
      ? { available: true }
      : {
          available: false,
          reasonCode: 'antigravity_cliprint_models_failed',
          diagnostic: readDiagnostic(run),
        };
  } catch (error) {
    result = {
      available: false,
      reasonCode: 'antigravity_cliprint_probe_failed',
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  availabilityCache.set(key, { expiresAtMs: now + ttlMs, result });
  return result;
}
