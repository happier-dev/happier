import {
  AGENT_PROVIDER_IDS,
  type AgentId,
  type AgentProviderId,
} from '../types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from '../definitions/generatedFacts.js';

function readBooleanEnvWithDefault(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export type AgentCliSourcePreference = 'system-first' | 'managed-first';
export type AgentCliManualInstallKind = 'command' | 'vendor_recipe' | 'none';
export type AgentCliInstallPlatform = 'darwin' | 'linux' | 'win32';

export type AgentCliSetupRecommendation = Readonly<{
  order: number;
}>;

export type AgentCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  requiresAdmin?: boolean;
  note?: string | null;
}>;

export type AgentCliManualInstallRecipes =
  | Partial<Record<AgentCliInstallPlatform, ReadonlyArray<AgentCliInstallCommand>>>
  | null;

export type AgentCliManagedInstallSpec =
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

export type AgentCliRuntimeSpec = Readonly<{
  id: AgentId;
  title: string;
  binaryName: string;
  alternativeBinaryNames?: ReadonlyArray<string>;
  alternativeBinaryFallbackEnabledEnvVar?: string | null;
  knownUserBinDirSuffixes?: ReadonlyArray<string> | null;
  sourcePreferenceDefault: AgentCliSourcePreference;
  managedInstall: AgentCliManagedInstallSpec | null;
  manualInstallKind: AgentCliManualInstallKind;
  manualInstallRecipes: AgentCliManualInstallRecipes;
  acceptsJavaScriptFileOverride: boolean;
  setupRecommendation?: AgentCliSetupRecommendation | null;
  installGuideUrl?: string | null;
  docsUrl?: string | null;
}>;

function bashCurlPipe(url: string): AgentCliInstallCommand {
  return { cmd: 'bash', args: ['-lc', `curl -fsSL ${url} | bash`] };
}

function powershellInstall(command: string): AgentCliInstallCommand {
  return {
    cmd: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
  };
}

function bunGlobalAdd(packageName: string): AgentCliInstallCommand {
  return {
    cmd: 'bun',
    args: ['install', '-g', packageName],
  };
}

const AUTHORED_AGENT_CLI_RUNTIME_SPECS = {
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
    setupRecommendation: { order: 10 },
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
    setupRecommendation: { order: 20 },
    installGuideUrl: null,
    docsUrl: 'https://github.com/openai/codex',
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
    setupRecommendation: { order: 30 },
    docsUrl: 'https://goo.gle/gemini-cli-auth-docs',
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
  cursor: {
    id: 'cursor',
    title: 'Cursor Agent CLI',
    binaryName: 'cursor-agent',
    alternativeBinaryNames: ['agent'],
    alternativeBinaryFallbackEnabledEnvVar: 'HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED',
    knownUserBinDirSuffixes: ['.local/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: null,
    acceptsJavaScriptFileOverride: false,
    installGuideUrl: 'https://cursor.com/docs/cli/installation',
    docsUrl: 'https://cursor.com/docs/cli',
  },
  ohMyPi: {
    id: 'ohMyPi',
    title: 'oh-my-pi CLI',
    binaryName: 'omp',
    knownUserBinDirSuffixes: ['.bun/bin'],
    sourcePreferenceDefault: 'system-first',
    managedInstall: {
      kind: 'github_release_binary',
      githubRepo: 'can1357/oh-my-pi',
      binaryName: 'omp',
    },
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [bunGlobalAdd('@oh-my-pi/pi-coding-agent')],
      linux: [bunGlobalAdd('@oh-my-pi/pi-coding-agent')],
      win32: [bunGlobalAdd('@oh-my-pi/pi-coding-agent')],
    },
    acceptsJavaScriptFileOverride: true,
    installGuideUrl: 'https://github.com/can1357/oh-my-pi#via-bun-recommended',
    docsUrl: 'https://github.com/can1357/oh-my-pi',
  },
  pi: {
    id: 'pi',
    title: 'Pi Coding Agent CLI',
    binaryName: 'pi',
    knownUserBinDirSuffixes: null,
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
} as const satisfies Partial<Record<AgentProviderId, AgentCliRuntimeSpec>>;

export const CANONICAL_AGENT_CLI_RUNTIME_SPECS: Readonly<Record<AgentProviderId, AgentCliRuntimeSpec>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentCliRuntimeSpec>({
    authored: AUTHORED_AGENT_CLI_RUNTIME_SPECS,
    label: 'agent CLI runtime spec',
    readGenerated: (definition) => definition.agentCliRuntime,
  });

export const AGENT_CLI_RUNTIME_SPECS: Readonly<Record<AgentProviderId, AgentCliRuntimeSpec>> = CANONICAL_AGENT_CLI_RUNTIME_SPECS;

export function getAgentCliRuntimeSpec(id: AgentId): AgentCliRuntimeSpec {
  return AGENT_CLI_RUNTIME_SPECS[id];
}

export function getAgentCliBinaryNames(
  id: AgentId,
  processEnv: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<string> {
  const runtimeSpec = getAgentCliRuntimeSpec(id);
  const fallbackEnabled = runtimeSpec.alternativeBinaryFallbackEnabledEnvVar
    ? readBooleanEnvWithDefault(processEnv[runtimeSpec.alternativeBinaryFallbackEnabledEnvVar], true)
    : true;
  return [
    runtimeSpec.binaryName,
    ...(fallbackEnabled ? (runtimeSpec.alternativeBinaryNames ?? []) : []),
  ];
}

const AGENT_CLI_SETUP_SUPPORTED_IDS: ReadonlyArray<AgentProviderId> = AGENT_PROVIDER_IDS;

export function getAgentCliSetupSupportedIds(): ReadonlyArray<AgentId> {
  return [...AGENT_CLI_SETUP_SUPPORTED_IDS];
}

export function getAgentCliSetupRecommendedIds(): ReadonlyArray<AgentId> {
  return AGENT_CLI_SETUP_SUPPORTED_IDS
    .map((agentId) => ({
      agentId,
      order: AGENT_CLI_RUNTIME_SPECS[agentId].setupRecommendation?.order,
    }))
    .filter((entry): entry is { agentId: AgentProviderId; order: number } =>
      typeof entry.order === 'number',
    )
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.agentId);
}
