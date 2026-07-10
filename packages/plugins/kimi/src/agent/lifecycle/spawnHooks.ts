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

type KimiDaemonSpawnHookContext = Readonly<{
  tools?: Partial<KimiDaemonSpawnToolContext>;
}>;

type KimiDaemonSpawnPrerequisiteResult = Readonly<{
  allowed: boolean;
  reasonCode?: string;
  errorMessage?: string;
}>;

type KimiDaemonHookEvent = Readonly<{
  payload?: unknown;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCwd(event: KimiDaemonHookEvent): string | undefined {
  const payload = readRecord(event.payload);
  const runtimeSelection = readRecord(payload?.runtimeSelection) ?? readRecord(event);
  return readString(runtimeSelection?.cwd)
    ?? readString(runtimeSelection?.directory)
    ?? readString(payload?.cwd)
    ?? readString(payload?.directory)
    ?? undefined;
}

function readRuntimeSelectionEnv(event: KimiDaemonHookEvent): Readonly<Record<string, string>> {
  const payload = readRecord(event.payload);
  const directEvent = readRecord(event);
  const runtimeSelection = readRecord(payload?.runtimeSelection)
    ?? readRecord(directEvent?.runtimeSelection);
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
    allowed: false,
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
  event: KimiDaemonHookEvent,
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
      return { allowed: true };
    }
    return denyKimiSpawn('kimi_acp_unavailable', result.errorMessage);
  }
  if (result.exitCode !== null) {
    return denyKimiSpawn('kimi_acp_unavailable', buildKimiAcpUnavailableMessage(result));
  }
  return { allowed: true };
}
