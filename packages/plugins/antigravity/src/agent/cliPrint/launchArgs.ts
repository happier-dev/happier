export type AntigravityCliPrintLaunchArgsInput = Readonly<{
  cwd: string;
  prompt?: string;
  modelId?: string | null;
  sandbox?: boolean;
  conversationId?: string | null;
  includeWorkspaceScope?: boolean;
}>;

function readNonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function readSelectedModelId(value: string | null | undefined): string | null {
  const normalized = readNonEmpty(value);
  return normalized && normalized !== 'default' ? normalized : null;
}

export function buildAntigravityCliPrintLaunchArgs(input: AntigravityCliPrintLaunchArgsInput): string[] {
  const prompt = readNonEmpty(input.prompt);
  if (!prompt) {
    throw new Error('Antigravity CLI print mode requires a non-empty prompt.');
  }
  const args = ['-p', prompt];
  const modelId = readSelectedModelId(input.modelId);
  if (modelId) args.push('--model', modelId);
  if (input.sandbox) args.push('--sandbox');
  const conversationId = readNonEmpty(input.conversationId);
  if (conversationId) args.push('--conversation', conversationId);
  if (input.includeWorkspaceScope) args.push('--add-dir', input.cwd);
  return args;
}
