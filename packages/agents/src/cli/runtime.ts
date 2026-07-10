import {
  AGENT_IDS,
  type AgentId,
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
      packageBinarySetup?: Readonly<{ kind: 'opencode_platform_binary' }> | null;
    }>;

export type AgentCliRuntimeSpec = Readonly<{
  id: AgentId;
  title: string;
  binaryName: string;
  alternativeBinaryNames?: ReadonlyArray<string>;
  alternativeBinaryFallbackEnabledEnvVar?: string | null;
  knownUserBinDirSuffixes?: ReadonlyArray<string> | null;
  systemCommandResolutionStrategy?: 'path-first' | 'known-user-first-runnable';
  sourcePreferenceDefault: AgentCliSourcePreference;
  managedInstall: AgentCliManagedInstallSpec | null;
  manualInstallKind: AgentCliManualInstallKind;
  manualInstallRecipes: AgentCliManualInstallRecipes;
  acceptsJavaScriptFileOverride: boolean;
  setupRecommendation?: AgentCliSetupRecommendation | null;
  installGuideUrl?: string | null;
  docsUrl?: string | null;
}>;

const AUTHORED_AGENT_CLI_RUNTIME_SPECS = {
} as const satisfies Partial<Record<AgentId, AgentCliRuntimeSpec>>;

export const CANONICAL_AGENT_CLI_RUNTIME_SPECS: Readonly<Record<AgentId, AgentCliRuntimeSpec>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentCliRuntimeSpec>({
    authored: AUTHORED_AGENT_CLI_RUNTIME_SPECS,
    label: 'agent CLI runtime spec',
    readGenerated: (definition) => definition.agentCliRuntime,
  });

export const AGENT_CLI_RUNTIME_SPECS: Readonly<Record<AgentId, AgentCliRuntimeSpec>> = CANONICAL_AGENT_CLI_RUNTIME_SPECS;

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

const AGENT_CLI_SETUP_SUPPORTED_IDS: ReadonlyArray<AgentId> = AGENT_IDS;

export function getAgentCliSetupSupportedIds(): ReadonlyArray<AgentId> {
  return [...AGENT_CLI_SETUP_SUPPORTED_IDS];
}

export function getAgentCliSetupRecommendedIds(): ReadonlyArray<AgentId> {
  return AGENT_CLI_SETUP_SUPPORTED_IDS
    .map((agentId) => ({
      agentId,
      order: AGENT_CLI_RUNTIME_SPECS[agentId].setupRecommendation?.order,
    }))
    .filter((entry): entry is { agentId: AgentId; order: number } =>
      typeof entry.order === 'number',
    )
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.agentId);
}
