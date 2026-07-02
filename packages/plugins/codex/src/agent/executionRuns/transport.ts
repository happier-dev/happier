export type CodexExecutionRunTransport = 'acp' | 'appServer';

export type CodexExecutionRunStartContext = Readonly<{
  intentInput?: unknown;
  retentionPolicy?: string;
  intent?: string;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

export function readCodexExecutionRunPreferredTransport(params: Readonly<{
  env: Environment;
  runtimeExtras?: Readonly<Record<string, unknown>> | null;
}>): string | undefined {
  return typeof params.env.HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT === 'string'
    ? params.env.HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT
    : typeof params.runtimeExtras?.codexBackendMode === 'string'
      ? params.runtimeExtras.codexBackendMode
      : undefined;
}

export function resolveCodexExecutionRunTransport(args: Readonly<{
  hasInteractiveTty?: boolean;
  preferredTransport?: string | null;
  start?: CodexExecutionRunStartContext | null;
}>): CodexExecutionRunTransport {
  const preferredTransport = String(args.preferredTransport ?? '').trim().toLowerCase();
  if (preferredTransport === 'acp') return 'acp';
  if (preferredTransport === 'mcp') return 'appServer';
  if (preferredTransport === 'appserver' || preferredTransport === 'app-server') return 'appServer';

  void args.hasInteractiveTty;
  void args.start;
  return 'appServer';
}
