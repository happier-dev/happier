export type ConnectParsedOptions = Readonly<{
  profileId: string;
  accountId: string | null;
  modeId: string | null;
  paste: boolean;
  device: boolean;
  noOpen: boolean;
  timeoutSeconds: number | null;
  setupToken: boolean;
  oauth: boolean;
  apiKey: boolean;
  token?: boolean;
}>;

export function parseConnectArgs(args: ReadonlyArray<string>): Readonly<{
  includeExperimental: boolean;
  subcommand: string | null;
  options: ConnectParsedOptions;
}> {
  const includeExperimental = args.includes('--all') || args.includes('--experimental');
  const paste = args.includes('--paste');
  const device = args.includes('--device');
  const noOpen = args.includes('--no-open');
  const setupToken = args.includes('--setup-token') || args.includes('--setup_token');
  const oauth = args.includes('--oauth');
  const apiKey = args.includes('--api-key') || args.includes('--api_key');
  const token = args.includes('--token');

  const profileFlagIdx = args.findIndex((a) => a === '--profile');
  const profileId = profileFlagIdx !== -1 ? String(args[profileFlagIdx + 1] ?? '').trim() : '';
  const accountFlagIdx = args.findIndex((a) => a === '--account');
  const accountId = accountFlagIdx !== -1 ? String(args[accountFlagIdx + 1] ?? '').trim() : '';
  const modeFlagIdx = args.findIndex((a) => a === '--mode');
  const modeId = modeFlagIdx !== -1 ? String(args[modeFlagIdx + 1] ?? '').trim() : '';

  const timeoutFlagIdx = args.findIndex((a) => a === '--timeout');
  const timeoutRaw = timeoutFlagIdx !== -1 ? String(args[timeoutFlagIdx + 1] ?? '').trim() : '';
  const timeoutSeconds = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutSecondsValue = Number.isFinite(timeoutSeconds) ? Math.max(1, Math.trunc(timeoutSeconds)) : null;

  const knownFlags = new Set([
    '--all',
    '--experimental',
    '--paste',
    '--device',
    '--no-open',
    '--setup-token',
    '--setup_token',
    '--oauth',
    '--api-key',
    '--api_key',
    '--token',
    '--profile',
    '--account',
    '--mode',
    '--timeout',
  ]);
  const valuesConsumedByFlags = new Set<number>([
    profileFlagIdx !== -1 ? profileFlagIdx + 1 : -1,
    accountFlagIdx !== -1 ? accountFlagIdx + 1 : -1,
    modeFlagIdx !== -1 ? modeFlagIdx + 1 : -1,
    timeoutFlagIdx !== -1 ? timeoutFlagIdx + 1 : -1,
  ]);

  const positional = args
    .filter((_a, idx) => !valuesConsumedByFlags.has(idx))
    .filter((a) => !knownFlags.has(a))
    .filter((a) => !a.startsWith('--'));

  const subcommand = positional[0] ?? null;
  return {
    includeExperimental,
    subcommand,
    options: {
      profileId: profileId || 'default',
      accountId: accountId || null,
      modeId: modeId || null,
      paste,
      device,
      noOpen,
      timeoutSeconds: timeoutSecondsValue,
      setupToken,
      oauth,
      apiKey,
      token,
    },
  };
}
