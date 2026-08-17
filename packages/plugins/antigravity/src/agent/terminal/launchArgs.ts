import type { AgentTerminalSurface } from '@happier-dev/plugin-sdk/agents/runtime';

export const ANTIGRAVITY_PRINT_MODE_SUPPORTED = false;

export type AntigravityTerminalLaunchArgsInput = Readonly<{
  promptInteractive?: boolean;
  conversationId?: string | null;
  continueLatest?: boolean;
  sandbox?: boolean;
  logFile?: string | null;
  print?: boolean;
  unsafeSkipPermissions?: boolean;
  modelId?: string | null;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === 'string' ? value : undefined;
}

function readModelIdCandidate(value: unknown): string | null | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  const normalized = raw?.trim();
  if (!normalized || normalized === 'default') return null;
  return normalized;
}

export function resolveAntigravityTerminalLaunchArgsInput(
  metadata: Readonly<Record<string, unknown>>,
  modelSelection: Parameters<AgentTerminalSurface['resolveLaunch']>[0]['modelSelection'],
): AntigravityTerminalLaunchArgsInput {
  const terminalRuntime = readRecord(metadata.terminalRuntime) ?? {};
  const antigravity = readRecord(metadata.antigravity) ?? {};
  return {
    promptInteractive: readBoolean(terminalRuntime.promptInteractive ?? antigravity.promptInteractive),
    conversationId: readString(
      metadata.providerSessionId
      ?? terminalRuntime.conversationId
      ?? antigravity.conversationId,
    ),
    continueLatest: readBoolean(terminalRuntime.continueLatest ?? antigravity.continueLatest),
    sandbox: readBoolean(terminalRuntime.sandbox ?? antigravity.sandbox),
    logFile: readString(terminalRuntime.logFile ?? antigravity.logFile),
    print: readBoolean(terminalRuntime.print ?? antigravity.print),
    unsafeSkipPermissions: readBoolean(terminalRuntime.unsafeSkipPermissions ?? antigravity.unsafeSkipPermissions),
    modelId: readModelIdCandidate(modelSelection?.modelId) ?? null,
  };
}

function readNonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function readSelectedModelId(value: string | null | undefined): string | null {
  const normalized = readNonEmpty(value);
  return normalized && normalized !== 'default' ? normalized : null;
}

export function buildAntigravityTerminalLaunchArgs(input: AntigravityTerminalLaunchArgsInput = {}): string[] {
  if (input.unsafeSkipPermissions) {
    throw new Error('Antigravity terminal runtime does not enable unsafe permission skipping.');
  }
  if (input.print) {
    throw new Error('Antigravity print mode is not a production terminal runtime path.');
  }

  const args: string[] = [];
  if (input.promptInteractive) {
    args.push('--prompt-interactive');
  }

  const conversationId = readNonEmpty(input.conversationId);
  if (conversationId) {
    args.push('--conversation', conversationId);
  }

  if (input.continueLatest) {
    args.push('--continue');
  }
  if (input.sandbox) {
    args.push('--sandbox');
  }

  const logFile = readNonEmpty(input.logFile);
  if (logFile) {
    args.push('--log-file', logFile);
  }

  const modelId = readSelectedModelId(input.modelId);
  if (modelId) {
    args.push('--model', modelId);
  }

  return args;
}
