function quoteShellArg(value: string): string {
  const raw = String(value ?? '');
  return raw === '' ? "''" : `'${raw.replaceAll("'", `'"'"'`)}'`;
}

function quoteRemotePathWithHomeExpansion(path: string): string {
  if (path === '$HOME') return '"$HOME"';
  if (path.startsWith('$HOME/')) {
    return `"$HOME"/${quoteShellArg(path.slice('$HOME/'.length))}`;
  }
  return quoteShellArg(path);
}

export function buildRemoteRelayRuntimeMigrationCommand(params: Readonly<{
  serverBinaryPath: string;
  env?: Readonly<Record<string, unknown>>;
}>): string | null {
  const env = params.env ?? {};
  const rawProvider = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();
  const provider = rawProvider === 'postgresql' ? 'postgres' : rawProvider;
  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  if (!databaseUrl || (provider !== 'postgres' && provider !== 'mysql')) {
    return null;
  }

  return [
    `server_binary=${quoteRemotePathWithHomeExpansion(params.serverBinaryPath)}`,
    'payload_root="$(dirname -- "$server_binary")"',
    [
      `DATABASE_URL=${quoteShellArg(databaseUrl)}`,
      `HAPPIER_DB_PROVIDER=${quoteShellArg(provider)}`,
      '"$payload_root/happier-server-migrate"',
    ].join(' '),
  ].join('; ');
}

export function buildRemoteRelayRuntimeInstallCommand(params: Readonly<{
  cliBinaryPath: string;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  env?: Readonly<Record<string, unknown>>;
  serverBinaryPath?: string;
}>): string {
  const envArgs = Object.entries(params.env ?? {}).flatMap(([key, value]) => {
    const normalizedKey = key.trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalizedKey)) return [];
    return [`--env ${quoteShellArg(`${normalizedKey}=${String(value ?? '')}`)}`];
  });
  const serverBinaryPath = String(params.serverBinaryPath ?? '').trim();
  const cliInvocation = params.mode === 'system'
    ? `sudo -n ${params.cliBinaryPath}`
    : params.cliBinaryPath;
  return [
    `${cliInvocation} relay host install`,
    `--channel ${quoteShellArg(params.channel)}`,
    `--mode ${params.mode}`,
    ...envArgs,
    ...(serverBinaryPath ? [`--self-host-server-binary ${quoteRemotePathWithHomeExpansion(serverBinaryPath)}`] : []),
    '--json',
  ].join(' ');
}
