function normalizeOpenCodeBackendMode(value: unknown): 'server' | 'acp' {
  return value === 'acp' ? 'acp' : 'server';
}

export function resolveOpenCodeExecutionRunBackendMode(args: Readonly<{
  env: NodeJS.ProcessEnv | undefined;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): 'server' | 'acp' {
  const raw = typeof args.env?.HAPPIER_OPENCODE_BACKEND_MODE === 'string'
    ? args.env.HAPPIER_OPENCODE_BACKEND_MODE.trim().toLowerCase()
    : '';
  if (raw === 'acp') return 'acp';
  if (args.accountSettings) {
    return normalizeOpenCodeBackendMode(args.accountSettings.opencodeBackendMode);
  }
  return 'server';
}
