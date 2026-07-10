import { ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY } from '../localharness/installable.js';
import {
  ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
  ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
  ANTIGRAVITY_CLI_MODELS_READINESS_TIMEOUT_MS,
} from '../cliPrint/modelsProbePolicy.js';
import {
  resolveAntigravityRuntimeModeRequest,
  type AntigravityRuntimeMode,
} from './runtimeMode.js';
import {
  hasAntigravitySdkCredentialEnv,
  isolateAntigravityCliPrintEnv,
} from './runtimeEnv.js';

type AntigravityDaemonResolvedTool =
  | Readonly<{
    ok: true;
    command: string;
    args: readonly string[];
  }>
  | Readonly<{
    ok: false;
    errorMessage: string;
  }>;

type AntigravityDaemonSpawnToolContext = Readonly<{
  runSystemTool?(input: Readonly<{
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
  }>): Promise<
    | Readonly<{
      ok: true;
      command: string;
      args: readonly string[];
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }>
    | Readonly<{
      ok: false;
      errorMessage: string;
      exitCode?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    }>
  >;
  resolveManagedInstallable(input: Readonly<{
    installableId: string;
    sourcePreference?: 'system-first' | 'managed-first';
    reason: string;
  }>): Promise<AntigravityDaemonResolvedTool>;
}>;

type AntigravityDaemonSpawnHookContext = Readonly<{
  tools?: Partial<AntigravityDaemonSpawnToolContext>;
}>;

type AntigravityDaemonSpawnPrerequisiteResult = Readonly<{
  allowed: boolean;
  reasonCode?: string;
  errorMessage?: string;
}>;

type AntigravityDaemonHookEvent = Readonly<{
  payload?: unknown;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readRuntimeMode(value: unknown): AntigravityRuntimeMode | null {
  return value === 'auto' || value === 'cliPrint' || value === 'sdk' ? value : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string | undefined>> | null {
  const record = readRecord(value);
  if (!record) return null;
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function readRuntimeSelectionRecord(event: AntigravityDaemonHookEvent): Readonly<Record<string, unknown>> {
  const payload = readRecord(event.payload);
  return readRecord(payload?.runtimeSelection)
    ?? readRecord(event)
    ?? {};
}

function readAntigravityRuntimeModeSelection(event: AntigravityDaemonHookEvent): Readonly<{
  mode: AntigravityRuntimeMode;
  cwd?: string;
  env: Readonly<Record<string, string | undefined>>;
}> {
  const payload = readRecord(event.payload);
  const runtimeSelection = readRuntimeSelectionRecord(event);
  const providerRuntimeSelection = readRecord(runtimeSelection.providerRuntimeSelection);
  const env = readStringRecord(runtimeSelection.env)
    ?? readStringRecord(payload?.env)
    ?? {};
  const accountSettings = readRecord(runtimeSelection.accountSettings) ?? readRecord(payload?.accountSettings);
  const request = resolveAntigravityRuntimeModeRequest({
    runtimeDescriptorV1: runtimeSelection.runtimeDescriptorV1,
    metadata: providerRuntimeSelection,
    accountSettings,
    env,
  });
  const cwd = typeof runtimeSelection.cwd === 'string' && runtimeSelection.cwd.trim()
    ? runtimeSelection.cwd.trim()
    : typeof runtimeSelection.directory === 'string' && runtimeSelection.directory.trim()
      ? runtimeSelection.directory.trim()
      : typeof payload?.cwd === 'string' && payload.cwd.trim()
        ? payload.cwd.trim()
        : typeof payload?.directory === 'string' && payload.directory.trim()
          ? payload.directory.trim()
          : undefined;
  return {
    mode: readRuntimeMode(request.requestedMode) ?? 'auto',
    ...(cwd ? { cwd } : {}),
    env,
  };
}

function denyAntigravitySpawn(
  reasonCode: string,
  errorMessage: string,
): AntigravityDaemonSpawnPrerequisiteResult {
  return {
    allowed: false,
    reasonCode,
    errorMessage,
  };
}

async function resolveSdkSpawnPrerequisites(
  selection: Readonly<{ env: Readonly<Record<string, string | undefined>> }>,
  context?: AntigravityDaemonSpawnHookContext,
): Promise<AntigravityDaemonSpawnPrerequisiteResult> {
  if (!hasAntigravitySdkCredentialEnv(selection.env)) {
    return denyAntigravitySpawn(
      'antigravity_sdk_credentials_unavailable',
      'Antigravity SDK mode requires Gemini API-key or Vertex credentials before daemon spawn.',
    );
  }
  const resolveManagedInstallable = context?.tools?.resolveManagedInstallable;
  if (!resolveManagedInstallable) {
    return denyAntigravitySpawn(
      'antigravity_localharness_unavailable',
      'Antigravity localharness daemon spawn requires the daemon managed-installable resolution context.',
    );
  }

  const resolved = await resolveManagedInstallable({
    installableId: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
    sourcePreference: 'managed-first',
    reason: 'Antigravity localharness daemon spawn requires the localharness runtime.',
  });

  return resolved.ok
    ? { allowed: true }
    : denyAntigravitySpawn('antigravity_localharness_unavailable', resolved.errorMessage);
}

async function resolveCliPrintSpawnPrerequisites(
  selection: Readonly<{
    cwd?: string;
    env: Readonly<Record<string, string | undefined>>;
  }>,
  context?: AntigravityDaemonSpawnHookContext,
): Promise<AntigravityDaemonSpawnPrerequisiteResult> {
  const runSystemTool = context?.tools?.runSystemTool;
  if (!runSystemTool) {
    return denyAntigravitySpawn(
      'antigravity_cli_print_unavailable',
      'Antigravity CLI print daemon spawn requires the daemon system-tool execution context.',
    );
  }

  const env = isolateAntigravityCliPrintEnv(selection.env);
  const result = await runSystemTool({
    toolId: 'antigravity',
    lookupNames: ['agy'],
    sourcePreference: 'system-first',
    args: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
    ...(selection.cwd ? { cwd: selection.cwd } : {}),
    ...(env ? { env } : {}),
    timeoutMs: ANTIGRAVITY_CLI_MODELS_READINESS_TIMEOUT_MS,
    maxStdoutBytes: ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
    maxStderrBytes: ANTIGRAVITY_CLI_MODELS_READINESS_OUTPUT_MAX_BYTES,
    reason: 'Antigravity CLI print daemon spawn requires a usable agy CLI login.',
  });

  if (!result.ok) {
    return denyAntigravitySpawn('antigravity_cli_print_unavailable', result.errorMessage);
  }
  if (result.exitCode !== 0) {
    return denyAntigravitySpawn(
      'antigravity_cli_print_unavailable',
      result.stderr.trim() || result.stdout.trim() || `agy models exited with code ${result.exitCode ?? 'unknown'}.`,
    );
  }
  return { allowed: true };
}

function combineAutoFailure(
  cliPrint: AntigravityDaemonSpawnPrerequisiteResult,
  sdk: AntigravityDaemonSpawnPrerequisiteResult,
): AntigravityDaemonSpawnPrerequisiteResult {
  return denyAntigravitySpawn(
    'antigravity_runtime_unavailable',
    [
      cliPrint.errorMessage ? `cliPrint: ${cliPrint.errorMessage}` : null,
      sdk.errorMessage ? `sdk: ${sdk.errorMessage}` : null,
    ].filter((value): value is string => value !== null).join(' '),
  );
}

export async function resolveAntigravityDaemonSpawnPrerequisites(
  event: AntigravityDaemonHookEvent,
  context?: AntigravityDaemonSpawnHookContext,
): Promise<AntigravityDaemonSpawnPrerequisiteResult> {
  const selection = readAntigravityRuntimeModeSelection(event);
  if (selection.mode === 'sdk') return await resolveSdkSpawnPrerequisites(selection, context);
  if (selection.mode === 'cliPrint') return await resolveCliPrintSpawnPrerequisites(selection, context);

  const cliPrint = await resolveCliPrintSpawnPrerequisites(selection, context);
  if (cliPrint.allowed) return cliPrint;
  const sdk = await resolveSdkSpawnPrerequisites(selection, context);
  if (sdk.allowed) return sdk;
  return combineAutoFailure(cliPrint, sdk);
}
