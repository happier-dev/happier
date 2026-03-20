export function selectCodexExecutionRunTransport(args: Readonly<{
  hasInteractiveTty: boolean;
  preferredTransport?: string | null;
  start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): 'acp' | 'mcp' | 'appServer' {
  const preferredTransport = String(args.preferredTransport ?? '').trim().toLowerCase();
  if (preferredTransport === 'acp') return 'acp';
  if (preferredTransport === 'mcp') return 'mcp';
  if (preferredTransport === 'appserver' || preferredTransport === 'app-server') return 'appServer';
  void args.hasInteractiveTty;
  void args.start;
  return 'appServer';
}
