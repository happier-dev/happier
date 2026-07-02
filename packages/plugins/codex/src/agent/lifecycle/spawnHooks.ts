import { validateCodexAcpSpawnAvailability } from '../acp/availability.js';

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

export async function resolveCodexDaemonSpawnPrerequisites(
  event: CodexDaemonHookEvent,
  context?: CodexDaemonSpawnHookContext,
): Promise<CodexDaemonSpawnPrerequisiteResult> {
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
