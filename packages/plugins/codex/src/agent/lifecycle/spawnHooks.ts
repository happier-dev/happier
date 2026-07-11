import { validateCodexAcpSpawnAvailability } from '../acp/availability.js';
import { resolveCodexProviderBindingRuntimeVersionV1 } from '../providerBinding/version.js';

import { resolveCodexAcpSpawnPrerequisiteFailure } from './acpSpawnPrerequisites.js';
import { resolveCanonicalCodexBackendMode } from './backendMode.js';

type CodexDaemonResolvedTool =
  | Readonly<{
    ok: true;
    command: string;
    args: readonly string[];
  }>
  | Readonly<{
    ok: false;
    errorMessage: string;
  }>;

type CodexDaemonSpawnToolResolutionContext = Readonly<{
  resolveManagedInstallable(input: Readonly<{
    installableId: string;
    sourcePreference?: 'system-first' | 'managed-first';
    reason: string;
  }>): Promise<CodexDaemonResolvedTool>;
  runSystemTool?(input: Readonly<{
    toolId: string;
    sourcePreference?: 'system-first' | 'managed-first';
    args?: readonly string[];
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    reason: string;
  }>): Promise<Readonly<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
  }>>;
}>;

type CodexDaemonSpawnHookContext = Readonly<{
  tools?: CodexDaemonSpawnToolResolutionContext;
}>;

type CodexDaemonSpawnPrerequisiteResult = Readonly<{
  allowed: boolean;
  reasonCode?: string;
  errorMessage?: string;
}>;

type CodexDaemonHookEvent = Readonly<{
  payload?: unknown;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readCodexRuntimeSelection(event: CodexDaemonHookEvent): Readonly<Record<string, unknown>> {
  return readRecord(readRecord(event.payload)?.runtimeSelection) ?? {};
}

function resolveCodexDaemonBackendMode(event: CodexDaemonHookEvent): 'acp' | 'appServer' | null {
  const runtimeSelection = readCodexRuntimeSelection(event);
  const providerRuntimeSelection = readRecord(runtimeSelection.providerRuntimeSelection);
  return resolveCanonicalCodexBackendMode({
    codexBackendMode: providerRuntimeSelection?.codexBackendMode,
    runtimeDescriptorV1: runtimeSelection.runtimeDescriptorV1,
  }) ?? null;
}

function hasCodexProviderBinding(event: CodexDaemonHookEvent): boolean {
  return readRecord(readCodexRuntimeSelection(event).providerBinding)?.agentTargetKey === 'codex';
}

export async function resolveCodexDaemonSpawnPrerequisites(
  event: CodexDaemonHookEvent,
  context?: CodexDaemonSpawnHookContext,
): Promise<CodexDaemonSpawnPrerequisiteResult> {
  if (hasCodexProviderBinding(event)) {
    const runSystemTool = context?.tools?.runSystemTool;
    if (!runSystemTool) {
      return {
        allowed: false,
        reasonCode: 'codex_provider_runtime_unsupported',
        errorMessage: 'External providers require an installed Codex CLI version check before launch.',
      };
    }
    const command = await runSystemTool({
      toolId: 'codex',
      sourcePreference: 'system-first',
      args: ['--version'],
      timeoutMs: 5_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      reason: 'External providers require a verified Codex CLI version.',
    });
    const version = resolveCodexProviderBindingRuntimeVersionV1(
      command.ok ? `${command.stdout ?? ''}\n${command.stderr ?? ''}` : '',
    );
    if (!version.ok) {
      return {
        allowed: false,
        reasonCode: version.reasonCode,
        errorMessage: version.errorMessage,
      };
    }
  }
  if (resolveCodexDaemonBackendMode(event) !== 'acp') {
    return { allowed: true };
  }

  const tools = context?.tools;
  if (!tools) {
    return {
      allowed: false,
      ...toDaemonSpawnPrerequisiteDenial(resolveCodexAcpSpawnPrerequisiteFailure({
        resolveErrorMessage: 'Codex ACP daemon spawn requires the daemon tool-resolution context.',
      })),
    };
  }

  const resolvedTool = await tools.resolveManagedInstallable({
    installableId: 'codex-acp',
    sourcePreference: 'system-first',
    reason: 'Codex ACP daemon spawn requires the codex-acp command.',
  });
  if (!resolvedTool.ok) {
    return {
      allowed: false,
      ...toDaemonSpawnPrerequisiteDenial(resolveCodexAcpSpawnPrerequisiteFailure({
        availabilityErrorMessage: resolvedTool.errorMessage,
      })),
    };
  }

  const availability = validateCodexAcpSpawnAvailability({
    command: resolvedTool.command,
    args: [...resolvedTool.args],
  });
  if (availability.ok) {
    return { allowed: true };
  }

  return {
    allowed: false,
    ...toDaemonSpawnPrerequisiteDenial(resolveCodexAcpSpawnPrerequisiteFailure({
      command: resolvedTool.command,
      availabilityErrorMessage: availability.errorMessage,
    })),
  };
}

function toDaemonSpawnPrerequisiteDenial(input: ReturnType<typeof resolveCodexAcpSpawnPrerequisiteFailure>): Omit<
  CodexDaemonSpawnPrerequisiteResult,
  'allowed'
> {
  return {
    reasonCode: input.reasonCode,
    errorMessage: input.errorMessage,
  };
}

export function augmentCodexDaemonSpawnEnv(event: CodexDaemonHookEvent): Record<string, string> {
  const backendMode = resolveCodexDaemonBackendMode(event);
  if (backendMode === 'acp' || backendMode === 'appServer') {
    return { HAPPIER_CODEX_BACKEND_MODE: backendMode };
  }
  return {};
}
