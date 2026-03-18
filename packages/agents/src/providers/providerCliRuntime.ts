import type { AgentId } from '../types.js';

export type ProviderCliSourcePreference = 'system-first' | 'managed-first';
export type ProviderCliManualInstallKind = 'command' | 'vendor_recipe' | 'none';
export type ProviderCliInstallPlatform = 'darwin' | 'linux' | 'win32';

export type ProviderCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  requiresAdmin?: boolean;
  note?: string | null;
}>;

export type ProviderCliManualInstallRecipes =
  | Partial<Record<ProviderCliInstallPlatform, ReadonlyArray<ProviderCliInstallCommand>>>
  | null;

export type ProviderCliManagedInstallSpec =
  | Readonly<{
      kind: 'github_release_binary';
      githubRepo: string;
      binaryName: string;
    }>
  | Readonly<{
      kind: 'managed_package';
      packageName: string;
      binaryName: string;
    }>;

export type ProviderCliRuntimeSpec = Readonly<{
  id: AgentId;
  title: string;
  binaryName: string;
  knownUserBinDirSuffixes?: ReadonlyArray<string> | null;
  sourcePreferenceDefault: ProviderCliSourcePreference;
  managedInstall: ProviderCliManagedInstallSpec | null;
  manualInstallKind: ProviderCliManualInstallKind;
  manualInstallRecipes: ProviderCliManualInstallRecipes;
  acceptsJavaScriptFileOverride: boolean;
  installGuideUrl?: string | null;
  docsUrl?: string | null;
}>;

function bashCurlPipe(url: string): ProviderCliInstallCommand {
  return { cmd: 'bash', args: ['-lc', `curl -fsSL ${url} | bash`] };
}

function powershellInstall(command: string): ProviderCliInstallCommand {
  return {
    cmd: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
  };
}

function cmdInstall(command: string, opts: Readonly<{ requiresAdmin?: boolean; note?: string | null }> = {}): ProviderCliInstallCommand {
  return {
    cmd: 'cmd.exe',
    args: ['/c', command],
    requiresAdmin: opts.requiresAdmin,
    note: opts.note ?? null,
  };
}

export const PROVIDER_CLI_RUNTIME_SPECS: Readonly<Record<AgentId, ProviderCliRuntimeSpec>> = Object.freeze({
  claude: {
    id: 'claude',
    title: 'Claude Code CLI',
    binaryName: 'claude',
    knownUserBinDirSuffixes: ['.local/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [bashCurlPipe('https://claude.ai/install.sh')],
      linux: [bashCurlPipe('https://claude.ai/install.sh')],
      win32: [powershellInstall('irm https://claude.ai/install.ps1 | iex')],
    },
    acceptsJavaScriptFileOverride: true,
    installGuideUrl: 'https://code.claude.com/docs/en/setup',
    docsUrl: 'https://claude.ai',
  },
  codex: {
    id: 'codex',
    title: 'OpenAI Codex CLI',
    binaryName: 'codex',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'github_release_binary',
      githubRepo: 'openai/codex',
      binaryName: 'codex',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: null,
    docsUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    title: 'OpenCode CLI',
    binaryName: 'opencode',
    knownUserBinDirSuffixes: ['.opencode/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [bashCurlPipe('https://opencode.ai/install')],
      linux: [bashCurlPipe('https://opencode.ai/install')],
    },
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://opencode.ai/docs',
    docsUrl: 'https://opencode.ai',
  },
  gemini: {
    id: 'gemini',
    title: 'Google Gemini CLI',
    binaryName: 'gemini',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@google/gemini-cli',
      binaryName: 'gemini',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: 'https://goo.gle/gemini-cli-auth-docs',
  },
  auggie: {
    id: 'auggie',
    title: 'Auggie CLI',
    binaryName: 'auggie',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@augmentcode/auggie',
      binaryName: 'auggie',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: 'https://augmentcode.com',
  },
  qwen: {
    id: 'qwen',
    title: 'Qwen CLI',
    binaryName: 'qwen',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@qwen-code/qwen-code',
      binaryName: 'qwen',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://qwenlm.github.io/qwen-code-docs/',
    docsUrl: null,
  },
  kimi: {
    id: 'kimi',
    title: 'Kimi CLI',
    binaryName: 'kimi',
    knownUserBinDirSuffixes: ['.local/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [bashCurlPipe('https://code.kimi.com/install.sh')],
      linux: [bashCurlPipe('https://code.kimi.com/install.sh')],
      win32: [powershellInstall('Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression')],
    },
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://kimi.moonshot.cn/docs/cli',
    docsUrl: 'https://code.kimi.com',
  },
  kiro: {
    id: 'kiro',
    title: 'Kiro CLI',
    binaryName: 'kiro-cli',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: 'https://kiro.dev/docs/cli/acp/',
  },
  customAcp: {
    id: 'customAcp',
    title: 'Custom ACP',
    binaryName: 'custom-acp',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'none',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: null,
  },
  kilo: {
    id: 'kilo',
    title: 'Kilo CLI',
    binaryName: 'kilo',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@kilocode/cli',
      binaryName: 'kilo',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: 'https://kilo.ai/docs/cli',
  },
  pi: {
    id: 'pi',
    title: 'Pi Coding Agent CLI',
    binaryName: 'pi',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@mariozechner/pi-coding-agent',
      binaryName: 'pi',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://github.com/badlogic/pi-mono',
    docsUrl: null,
  },
  copilot: {
    id: 'copilot',
    title: 'GitHub Copilot CLI',
    binaryName: 'copilot',
    knownUserBinDirSuffixes: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@github/copilot',
      binaryName: 'copilot',
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
  },
} as const);

export function getProviderCliRuntimeSpec(id: AgentId): ProviderCliRuntimeSpec {
  return PROVIDER_CLI_RUNTIME_SPECS[id];
}
