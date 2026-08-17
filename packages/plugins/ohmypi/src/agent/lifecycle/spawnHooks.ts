import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { buildOhMyPiPreflightModelsFromListModelsOutput } from '../preflight/models.js';
import { OH_MY_PI_SYSTEM_TOOL_ID } from '../systemTool.js';

const OH_MY_PI_LIST_MODELS_ARGS = ['--list-models'] as const;
const OH_MY_PI_PREFLIGHT_TIMEOUT_MS = 10_000;
const OH_MY_PI_PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;

type OhMyPiDaemonRunToolResult =
  | Readonly<{
    ok: true;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>
  | Readonly<{
    ok: false;
    errorMessage: string;
  }>;

type OhMyPiDaemonSpawnToolContext = Readonly<{
  runSystemTool(input: Readonly<{
    toolId: string;
    lookupNames?: readonly string[];
    sourcePreference?: 'system-first' | 'managed-first';
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    reason: string;
  }>): Promise<OhMyPiDaemonRunToolResult>;
}>;

type OhMyPiDaemonSpawnHookContext = Partial<PluginInvocationContext> & Readonly<{
  tools?: Partial<OhMyPiDaemonSpawnToolContext>;
}>;

type OhMyPiDaemonSpawnPrerequisiteResult = PluginHookDecisionResultV1;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCwd(payload: JsonValue): string | undefined {
  const payloadRecord = readRecord(payload);
  return readString(payloadRecord?.cwd) ?? readString(payloadRecord?.directory) ?? undefined;
}

function readRuntimeSelectionEnv(payload: JsonValue): Readonly<Record<string, string>> {
  const payloadRecord = readRecord(payload);
  const runtimeSelection = readRecord(payloadRecord?.runtimeSelection);
  const env = readRecord(runtimeSelection?.env);
  if (!env) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0) {
      output[key] = value;
    }
  }
  return output;
}

function firstDiagnosticLine(...outputs: readonly string[]): string | null {
  for (const output of outputs) {
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find(Boolean);
    if (line) return line;
  }
  return null;
}

function denyOhMyPiSpawn(reasonCode: string, errorMessage: string): OhMyPiDaemonSpawnPrerequisiteResult {
  return {
    decision: 'deny',
    reasonCode,
    errorMessage,
  };
}

export async function resolveOhMyPiDaemonSpawnPrerequisites(
  payload: JsonValue,
  context?: OhMyPiDaemonSpawnHookContext,
): Promise<OhMyPiDaemonSpawnPrerequisiteResult> {
  const runSystemTool = context?.tools?.runSystemTool;
  if (!runSystemTool) {
    return denyOhMyPiSpawn(
      'ohmypi_cli_unavailable',
      'OhMyPi daemon spawn requires the daemon tool execution context.',
    );
  }

  const result = await runSystemTool({
    toolId: OH_MY_PI_SYSTEM_TOOL_ID,
    lookupNames: ['omp'],
    sourcePreference: 'system-first',
    args: OH_MY_PI_LIST_MODELS_ARGS,
    cwd: readCwd(payload),
    env: { ...readRuntimeSelectionEnv(payload), CI: '1' },
    timeoutMs: OH_MY_PI_PREFLIGHT_TIMEOUT_MS,
    maxStdoutBytes: OH_MY_PI_PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStderrBytes: OH_MY_PI_PREFLIGHT_OUTPUT_MAX_BYTES,
    reason: 'OhMyPi daemon spawn requires at least one configured model.',
  });

  if (!result.ok) {
    return denyOhMyPiSpawn('ohmypi_cli_unavailable', result.errorMessage);
  }

  const models = buildOhMyPiPreflightModelsFromListModelsOutput(result.stdout)
    ?? buildOhMyPiPreflightModelsFromListModelsOutput(result.stderr);
  if (result.exitCode === 0 && models && models.length > 0) {
    return { decision: 'allow' };
  }

  const rawDiagnostic = firstDiagnosticLine(result.stdout, result.stderr);
  const diagnostic = rawDiagnostic?.toLowerCase().startsWith('provider')
    ? 'OhMyPi has no chat-capable models. Configure a chat model or provider API key before starting a session.'
    : rawDiagnostic
    ?? 'OhMyPi has no available models. Set provider API keys before starting a session.';
  return denyOhMyPiSpawn('ohmypi_models_unavailable', diagnostic);
}
import type { PluginHookDecisionResult as PluginHookDecisionResultV1 } from '@happier-dev/plugin-sdk/hooks';
