import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

const KIMI_ACP_PREFLIGHT_TIMEOUT_MS = 5_000;
const KIMI_ACP_PREFLIGHT_OUTPUT_MAX_BYTES = 16 * 1024;

type KimiDaemonRunToolResult =
  | Readonly<{
    ok: true;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>
  | Readonly<{
    ok: false;
    reasonCode?: string;
    errorMessage: string;
    stdout?: string;
    stderr?: string;
  }>;

type KimiDaemonSpawnToolContext = Readonly<{
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
  }>): Promise<KimiDaemonRunToolResult>;
}>;

type KimiDaemonSpawnHookContext = Partial<PluginInvocationContext> & Readonly<{
  tools?: Partial<KimiDaemonSpawnToolContext>;
}>;

type KimiDaemonSpawnPrerequisiteResult =
  | Readonly<{ decision: 'allow' }>
  | Readonly<{ decision: 'deny'; reasonCode: string; errorMessage: string }>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readHookPayload(event: unknown): Readonly<Record<string, unknown>> {
  const record = readRecord(event);
  return readRecord(record?.payload) ?? record ?? {};
}

function readCwd(event: unknown): string | undefined {
  const payload = readHookPayload(event);
  const runtimeSelection = readRecord(payload?.runtimeSelection) ?? payload;
  return readString(runtimeSelection?.cwd)
    ?? readString(runtimeSelection?.directory)
    ?? readString(payload?.cwd)
    ?? readString(payload?.directory)
    ?? undefined;
}

function readRuntimeSelectionEnv(event: unknown): Readonly<Record<string, string>> {
  const payload = readHookPayload(event);
  const runtimeSelection = readRecord(payload?.runtimeSelection)
    ?? payload;
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

function denyKimiSpawn(reasonCode: string, errorMessage: string): KimiDaemonSpawnPrerequisiteResult {
  return {
    decision: 'deny',
    reasonCode,
    errorMessage,
  };
}

function buildKimiAcpUnavailableMessage(result?: Readonly<{
  stdout?: string;
  stderr?: string;
}>): string {
  const diagnostic = result
    ? firstDiagnosticLine(result.stderr ?? '', result.stdout ?? '')
    : null;
  return [
    'Kimi ACP requires an ACP-compatible Kimi CLI that accepts the `--work-dir <dir> acp` launch contract.',
    'Update or install an ACP-compatible Kimi CLI before starting a Kimi session.',
    diagnostic ? `CLI reported: ${diagnostic}` : null,
  ].filter((value): value is string => value !== null).join(' ');
}

export async function resolveKimiDaemonSpawnPrerequisites(
  event: unknown,
  context?: KimiDaemonSpawnHookContext,
): Promise<KimiDaemonSpawnPrerequisiteResult> {
  const runSystemTool = context?.tools?.runSystemTool;
  if (!runSystemTool) {
    return denyKimiSpawn(
      'kimi_acp_unavailable',
      'Kimi ACP daemon spawn requires the daemon tool execution context.',
    );
  }

  const cwd = readCwd(event);
  const result = await runSystemTool({
    toolId: 'kimi',
    lookupNames: ['kimi'],
    sourcePreference: 'system-first',
    args: ['--work-dir', cwd ?? '.', 'acp'],
    ...(cwd ? { cwd } : {}),
    env: { ...readRuntimeSelectionEnv(event), CI: '1' },
    timeoutMs: KIMI_ACP_PREFLIGHT_TIMEOUT_MS,
    maxStdoutBytes: KIMI_ACP_PREFLIGHT_OUTPUT_MAX_BYTES,
    maxStderrBytes: KIMI_ACP_PREFLIGHT_OUTPUT_MAX_BYTES,
    reason: 'Kimi daemon spawn requires a usable ACP-compatible Kimi CLI.',
  });

  if (!result.ok) {
    if (result.reasonCode === 'timeout') {
      return { decision: 'allow' };
    }
    return denyKimiSpawn('kimi_acp_unavailable', result.errorMessage);
  }
  if (result.exitCode !== null) {
    return denyKimiSpawn('kimi_acp_unavailable', buildKimiAcpUnavailableMessage(result));
  }
  return { decision: 'allow' };
}
