export type CliCommandSurfaceEntry = Readonly<{
  command: string | null;
  rootHelpLabel?: string;
  rootHelpDescription?: string;
  rootHelpDetail?: string;
  allowTmux: boolean;
}>;

const COMMAND_SURFACE_MANIFEST: readonly CliCommandSurfaceEntry[] = [
  {
    command: null,
    rootHelpLabel: 'happier [options]',
    rootHelpDescription: 'Start the default backend with mobile control',
    allowTmux: true,
  },
  {
    command: 'auth',
    rootHelpLabel: 'happier auth',
    rootHelpDescription: 'Manage authentication',
    allowTmux: false,
  },
  {
    command: 'codex',
    rootHelpLabel: 'happier codex',
    rootHelpDescription: 'Start Codex mode',
    allowTmux: true,
  },
  {
    command: 'opencode',
    rootHelpLabel: 'happier opencode',
    rootHelpDescription: 'Start OpenCode mode (ACP)',
    allowTmux: true,
  },
  {
    command: 'gemini',
    rootHelpLabel: 'happier gemini',
    rootHelpDescription: 'Start Gemini mode (ACP)',
    allowTmux: true,
  },
  {
    command: 'connect',
    rootHelpLabel: 'happier connect',
    rootHelpDescription: 'Connect AI vendor API keys',
    allowTmux: false,
  },
  {
    command: 'notify',
    rootHelpLabel: 'happier notify',
    rootHelpDescription: 'Send push notification',
    allowTmux: false,
  },
  {
    command: 'install',
    rootHelpLabel: 'happier install',
    rootHelpDescription: 'Install provider CLIs and helpers',
    allowTmux: false,
  },
  {
    command: 'daemon',
    rootHelpLabel: 'happier daemon',
    rootHelpDescription: 'Manage background service that allows',
    rootHelpDetail: 'to spawn new sessions away from your computer',
    allowTmux: false,
  },
  {
    command: 'doctor',
    rootHelpLabel: 'happier doctor',
    rootHelpDescription: 'System diagnostics & troubleshooting',
    allowTmux: false,
  },
  {
    command: 'uninstall',
    allowTmux: false,
  },
  {
    command: 'logout',
    allowTmux: false,
  },
  {
    command: 'attach',
    allowTmux: false,
  },
  {
    command: 'self',
    allowTmux: false,
  },
  {
    command: 'server',
    allowTmux: false,
  },
  {
    command: 'session',
    allowTmux: false,
  },
];

export function listRootHelpCommands(): readonly CliCommandSurfaceEntry[] {
  return COMMAND_SURFACE_MANIFEST.filter((entry) => typeof entry.rootHelpLabel === 'string');
}

export function isTmuxAllowedCommand(command: string | null | undefined): boolean {
  if (!command) return true;
  const entry = COMMAND_SURFACE_MANIFEST.find((candidate) => candidate.command === command);
  return entry ? entry.allowTmux : true;
}
