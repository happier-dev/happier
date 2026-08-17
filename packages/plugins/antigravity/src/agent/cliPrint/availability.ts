import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from '../systemTool.js';
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

function readExitCode(result: PluginProcessResult): number | null {
  return result.termination.observed.kind === 'exit'
    ? result.termination.observed.exitCode
    : null;
}

function readDiagnostic(result: PluginProcessResult): string {
  const stderr = new TextDecoder().decode(result.stderr).trim();
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const exitCode = readExitCode(result);
  return stderr || stdout || `agy models exited with code ${exitCode ?? 'unknown'}.`;
}

export function clearAntigravityCliPrintAvailabilityCache(): void {
  availabilityCache.clear();
}

export async function probeAntigravityCliPrintAvailability(params: Readonly<{
  exec: ExecService;
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
    const resolved = await params.exec.systemTools.resolve({
      toolId: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID,
      purpose: 'Check whether Antigravity CLI print model discovery is available.',
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const run = await params.exec.run({
      executable: resolved.executable,
      args: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
      ...(params.env ? { env: params.env } : {}),
      timeoutMs: ANTIGRAVITY_CLI_MODELS_READINESS_TIMEOUT_MS,
      maxStdoutBytes: ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
      maxStderrBytes: ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
    }, params.signal ? { signal: params.signal } : undefined);
    result = readExitCode(run) === 0
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
