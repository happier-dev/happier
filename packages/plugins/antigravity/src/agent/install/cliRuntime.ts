export const ANTIGRAVITY_AGENT_ID = 'antigravity';
export const ANTIGRAVITY_BACKEND_ID = ANTIGRAVITY_AGENT_ID;
export const ANTIGRAVITY_RUNTIME_CORE = 'localharness';
export const ANTIGRAVITY_TERMINAL_RUNTIME_BACKEND_MODE = 'terminal';
export const ANTIGRAVITY_BINARY_NAME = 'agy';

export const ANTIGRAVITY_AGENT_CLI_RUNTIME = Object.freeze({
  id: ANTIGRAVITY_AGENT_ID,
  title: 'Antigravity CLI',
  binaryName: ANTIGRAVITY_BINARY_NAME,
  knownUserBinDirSuffixes: null,
  sourcePreferenceDefault: 'system-first',
  managedInstall: null,
  manualInstallKind: 'vendor_recipe',
  manualInstallRecipes: {
    darwin: [
      {
        cmd: 'bash',
        args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
      },
    ],
    linux: [
      {
        cmd: 'bash',
        args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
      },
    ],
    win32: [
      {
        cmd: 'powershell',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://antigravity.google/cli/install.ps1 | iex',
        ],
      },
    ],
  },
  acceptsJavaScriptFileOverride: false,
  installGuideUrl: 'https://antigravity.google/docs/cli-install',
  docsUrl: 'https://antigravity.google/docs/cli-install',
} as const);
