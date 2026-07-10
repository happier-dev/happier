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
