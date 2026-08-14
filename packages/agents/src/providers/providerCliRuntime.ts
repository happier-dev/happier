import type { AgentId } from '../types.js';
import { parseBooleanEnv } from '@happier-dev/protocol';

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

export type ProviderCliArchiveExtractionLimits = Readonly<{
  maxFileBytes: number;
  maxExpandedBytes: number;
}>;

export type ProviderCliManagedArchiveEntry = Readonly<{
  archivePath: string;
  destinationPath: string;
}>;

export type ProviderCliManagedInstallSpec =
  | Readonly<{
      kind: 'github_release_binary';
      githubRepo: string;
      binaryName: string;
      archiveEntriesByPlatform: Readonly<
        Record<ProviderCliInstallPlatform, ReadonlyArray<ProviderCliManagedArchiveEntry>>
      >;
      archiveExtractionLimits?: ProviderCliArchiveExtractionLimits;
    }>
  | Readonly<{
      kind: 'managed_package';
      packageName: string;
      binaryName: string;
      packageBinarySetup?: Readonly<{ kind: 'opencode_platform_binary' }> | null;
    }>;

export type ProviderCliKnownCommandCandidate =
  | Readonly<{
      kind: 'homeBinDir';
      relativeDir: string;
    }>
  | Readonly<{
      kind: 'homePath';
      relativePath: string;
    }>
  | Readonly<{
      kind: 'absolutePath';
      path: string;
    }>
  | Readonly<{
      kind: 'homeVersionedDir';
      relativeDir: string;
    }>;

export type ProviderCliAlternativeBinaryIdentityProbe = Readonly<{
  args: ReadonlyArray<string>;
  timeoutMs: number;
  stdoutJsonStringField: string;
}>;

export type ProviderCliRuntimeSpec = Readonly<{
  id: AgentId;
  title: string;
  binaryName: string;
  alternativeBinaryNames?: ReadonlyArray<string>;
  alternativeBinaryFallbackEnabledEnvVar?: string | null;
  alternativeBinaryIdentityProbe?: ProviderCliAlternativeBinaryIdentityProbe | null;
  knownCommandCandidates?: ReadonlyArray<ProviderCliKnownCommandCandidate> | null;
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

export const PROVIDER_CLI_RUNTIME_SPECS: Readonly<Record<AgentId, ProviderCliRuntimeSpec>> = {
  claude: {
    id: 'claude',
    title: 'Claude Code CLI',
    binaryName: 'claude',
    knownCommandCandidates: [
      { kind: 'homeBinDir', relativeDir: '.local/bin' },
      { kind: 'homeVersionedDir', relativeDir: '.local/share/claude/versions' },
      { kind: 'homePath', relativePath: '.claude/local/cli.js' },
      { kind: 'absolutePath', path: '/opt/homebrew/bin/claude' },
      { kind: 'absolutePath', path: '/usr/local/bin/claude' },
      { kind: 'absolutePath', path: '/home/linuxbrew/.linuxbrew/bin/claude' },
      { kind: 'homePath', relativePath: '.bun/bin/claude' },
      { kind: 'homePath', relativePath: 'AppData/Local/Claude/claude.exe' },
      { kind: 'homeVersionedDir', relativeDir: 'AppData/Local/Claude/versions' },
      { kind: 'homePath', relativePath: '.claude/claude.exe' },
      { kind: 'homeVersionedDir', relativeDir: '.claude/versions' },
      { kind: 'homePath', relativePath: '.local/bin/claude.exe' },
    ],
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
    knownCommandCandidates: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'github_release_binary',
      githubRepo: 'openai/codex',
      binaryName: 'codex',
      // OpenAI Codex rust-v0.147.0's canonical package layout. Keep this an
      // explicit runtime allowlist: package metadata, rg, and other bundled
      // files are not part of Happier's managed provider installation.
      archiveEntriesByPlatform: {
        darwin: [
          { archivePath: 'bin/codex', destinationPath: 'bin/codex' },
          { archivePath: 'bin/codex-code-mode-host', destinationPath: 'bin/codex-code-mode-host' },
        ],
        linux: [
          { archivePath: 'bin/codex', destinationPath: 'bin/codex' },
          { archivePath: 'bin/codex-code-mode-host', destinationPath: 'bin/codex-code-mode-host' },
        ],
        win32: [
          { archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' },
          { archivePath: 'bin/codex-code-mode-host.exe', destinationPath: 'bin/codex-code-mode-host.exe' },
          {
            archivePath: 'codex-resources/codex-command-runner.exe',
            destinationPath: 'codex-resources/codex-command-runner.exe',
          },
          {
            archivePath: 'codex-resources/codex-windows-sandbox-setup.exe',
            destinationPath: 'codex-resources/codex-windows-sandbox-setup.exe',
          },
        ],
      },
      // OpenAI Codex rust-v0.147.0's checksum-pinned x64 Windows package
      // expands to 370,442,135 bytes, including one 298,668,336-byte
      // executable. A 384 MiB ceiling leaves bounded headroom while retaining
      // generic archive, entry-count, path, and compression-ratio protections.
      archiveExtractionLimits: {
        maxFileBytes: 384 * 1024 * 1024,
        maxExpandedBytes: 384 * 1024 * 1024,
      },
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
    knownCommandCandidates: [
      { kind: 'homeBinDir', relativeDir: '.opencode/bin' },
      { kind: 'homePath', relativePath: 'AppData/Roaming/npm/opencode.cmd' },
    ],
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: 'opencode-ai',
      binaryName: 'opencode',
      packageBinarySetup: { kind: 'opencode_platform_binary' },
    },
    manualInstallKind: 'command',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://opencode.ai/docs',
    docsUrl: 'https://opencode.ai',
  },
  gemini: {
    id: 'gemini',
    title: 'Google Gemini CLI',
    binaryName: 'gemini',
    knownCommandCandidates: null,
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
    knownCommandCandidates: null,
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
    knownCommandCandidates: null,
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
    knownCommandCandidates: [{ kind: 'homeBinDir', relativeDir: '.local/bin' }],
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
    knownCommandCandidates: null,
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
    knownCommandCandidates: null,
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
    knownCommandCandidates: null,
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
    knownCommandCandidates: null,
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'managed_package',
      packageName: '@earendil-works/pi-coding-agent',
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
    knownCommandCandidates: null,
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
  cursor: {
    id: 'cursor',
    title: 'Cursor Agent CLI',
    binaryName: 'cursor-agent',
    alternativeBinaryNames: ['agent'],
    alternativeBinaryFallbackEnabledEnvVar: 'HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED',
    alternativeBinaryIdentityProbe: {
      args: ['about', '--format', 'json'],
      timeoutMs: 2000,
      stdoutJsonStringField: 'cliVersion',
    },
    knownCommandCandidates: [
      { kind: 'homeBinDir', relativeDir: '.local/bin' },
      { kind: 'homeVersionedDir', relativeDir: '.local/share/cursor-agent/versions' },
      { kind: 'homePath', relativePath: 'AppData/Local/Programs/cursor-agent/cursor-agent.exe' },
    ],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [bashCurlPipe('https://cursor.com/install')],
      linux: [bashCurlPipe('https://cursor.com/install')],
      win32: [powershellInstall('iwr https://cursor.com/install.ps1 -useb | iex')],
    },
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://cursor.com/docs/cli/installation',
    docsUrl: 'https://cursor.com/docs/cli',
  },
  grok: {
    id: 'grok',
    title: 'Grok Build CLI',
    binaryName: 'grok',
    knownCommandCandidates: [
      { kind: 'homeBinDir', relativeDir: '.grok/bin' },
      { kind: 'homePath', relativePath: '.grok/bin/grok.exe' },
      { kind: 'homeBinDir', relativeDir: '.local/bin' },
      { kind: 'absolutePath', path: '/opt/homebrew/bin/grok' },
      { kind: 'absolutePath', path: '/usr/local/bin/grok' },
    ],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [bashCurlPipe('https://x.ai/cli/install.sh')],
      linux: [bashCurlPipe('https://x.ai/cli/install.sh')],
      win32: [powershellInstall('irm https://x.ai/cli/install.ps1 | iex')],
    },
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://x.ai/cli',
    docsUrl: 'https://x.ai',
  },
} as const;

export function getProviderCliRuntimeSpec(id: AgentId): ProviderCliRuntimeSpec {
  return PROVIDER_CLI_RUNTIME_SPECS[id];
}

export function getProviderCliBinaryNames(
  id: AgentId,
  processEnv: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<string> {
  const runtimeSpec = getProviderCliRuntimeSpec(id);
  const fallbackEnabled = runtimeSpec.alternativeBinaryFallbackEnabledEnvVar
    ? parseBooleanEnv(processEnv[runtimeSpec.alternativeBinaryFallbackEnabledEnvVar], true)
    : true;
  return [
    runtimeSpec.binaryName,
    ...(fallbackEnabled ? (runtimeSpec.alternativeBinaryNames ?? []) : []),
  ];
}
