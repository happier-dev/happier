import {
  AGENT_IDS,
  type AgentId,
  type BundledAgentId,
} from '../types.js';
import { mergeAuthoredWithGeneratedAgentFacts, readBundledAgentFact } from '../definitions/generatedFacts.js';
import type { AgentDefinitionCliMetadata } from '../definitions/agentDefinition.js';

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

export type AgentCliArchiveExtractionLimits = Readonly<{
  maxFileBytes: number;
  maxExpandedBytes: number;
}>;

export type AgentCliManagedArchiveEntry = Readonly<{
  archivePath: string;
  destinationPath: string;
}>;

export type AgentCliManagedAssetNameByPlatform = Readonly<
  Record<AgentCliInstallPlatform, Readonly<Record<'arm64' | 'x64', string>>>
>;

export type AgentCliManagedInstallSpec =
  | Readonly<{
      kind: 'github_release_binary';
      githubRepo: string;
      binaryName: string;
      assetNameByPlatform?: AgentCliManagedAssetNameByPlatform;
      archiveEntriesByPlatform?: Readonly<
        Record<AgentCliInstallPlatform, ReadonlyArray<AgentCliManagedArchiveEntry>>
      >;
      archiveExtractionLimits?: AgentCliArchiveExtractionLimits;
    }>
  | Readonly<{
      kind: 'managed_package';
      packageName: string;
      binaryName: string;
      packageBinarySetup?: Readonly<{ kind: 'opencode_platform_binary' }> | null;
    }>;

export type AgentCliRuntimeSpec = Readonly<{
  id: BundledAgentId;
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

export function projectAgentCliRuntimeSpec(
  agentId: BundledAgentId,
  cli: AgentDefinitionCliMetadata,
): AgentCliRuntimeSpec {
  const { executable, install } = cli;
  return Object.freeze({
    id: agentId,
    title: cli.displayName ?? agentId,
    binaryName: executable.binaryName,
    ...(executable.alternativeBinaryNames ? { alternativeBinaryNames: executable.alternativeBinaryNames } : {}),
    ...(executable.alternativeBinaryFallbackEnabledEnvVar
      ? { alternativeBinaryFallbackEnabledEnvVar: executable.alternativeBinaryFallbackEnabledEnvVar }
      : {}),
    ...(executable.knownUserBinDirSuffixes !== undefined
      ? { knownUserBinDirSuffixes: executable.knownUserBinDirSuffixes }
      : {}),
    ...(executable.systemCommandResolutionStrategy
      ? { systemCommandResolutionStrategy: executable.systemCommandResolutionStrategy }
      : {}),
    sourcePreferenceDefault: executable.sourcePreference,
    managedInstall: install.managed ?? null,
    manualInstallKind: install.manual.kind,
    manualInstallRecipes: install.manual.kind === 'none' ? null : (install.manual.recipes ?? null),
    acceptsJavaScriptFileOverride: executable.acceptsJavaScriptFileOverride ?? false,
    ...(install.recommendationOrder !== undefined
      ? { setupRecommendation: { order: install.recommendationOrder } }
      : {}),
    ...(install.guideUrl !== undefined ? { installGuideUrl: install.guideUrl } : {}),
    ...(install.docsUrl !== undefined ? { docsUrl: install.docsUrl } : {}),
  });
}

const AUTHORED_AGENT_CLI_RUNTIME_SPECS = {
} as const satisfies Partial<Record<BundledAgentId, AgentCliRuntimeSpec>>;

export const CANONICAL_AGENT_CLI_RUNTIME_SPECS: Readonly<Record<BundledAgentId, AgentCliRuntimeSpec>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentCliRuntimeSpec>({
    authored: AUTHORED_AGENT_CLI_RUNTIME_SPECS,
    label: 'agent CLI runtime spec',
    readGenerated: (definition, agentId) => projectAgentCliRuntimeSpec(agentId, definition.cli),
  });

export const AGENT_CLI_RUNTIME_SPECS: Readonly<Record<BundledAgentId, AgentCliRuntimeSpec>> = CANONICAL_AGENT_CLI_RUNTIME_SPECS;

/**
 * Read the generated CLI runtime spec of a bundled Agent.
 *
 * The record is exhaustive over `AGENT_IDS` only. An externally installed Agent
 * ships its own CLI metadata in its plugin manifest, so this accessor reports a
 * typed unavailable for it rather than pretending a bundled spec exists.
 */
export function getAgentCliRuntimeSpec(id: BundledAgentId): AgentCliRuntimeSpec;
export function getAgentCliRuntimeSpec(id: AgentId): AgentCliRuntimeSpec | null;
export function getAgentCliRuntimeSpec(id: AgentId): AgentCliRuntimeSpec | null {
  return readBundledAgentFact(AGENT_CLI_RUNTIME_SPECS, id);
}

export function getAgentCliBinaryNames(
  id: AgentId,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<string> {
  const runtimeSpec = getAgentCliRuntimeSpec(id);
  if (runtimeSpec == null) return [];
  const fallbackEnabled = runtimeSpec.alternativeBinaryFallbackEnabledEnvVar
    ? readBooleanEnvWithDefault(processEnv[runtimeSpec.alternativeBinaryFallbackEnabledEnvVar], true)
    : true;
  return [
    runtimeSpec.binaryName,
    ...(fallbackEnabled ? (runtimeSpec.alternativeBinaryNames ?? []) : []),
  ];
}

const AGENT_CLI_SETUP_SUPPORTED_IDS: ReadonlyArray<BundledAgentId> = AGENT_IDS;

export function getAgentCliSetupSupportedIds(): ReadonlyArray<BundledAgentId> {
  return [...AGENT_CLI_SETUP_SUPPORTED_IDS];
}

export function getAgentCliSetupRecommendedIds(): ReadonlyArray<BundledAgentId> {
  return AGENT_CLI_SETUP_SUPPORTED_IDS
    .map((agentId) => ({
      agentId,
      order: AGENT_CLI_RUNTIME_SPECS[agentId].setupRecommendation?.order,
    }))
    .filter((entry): entry is { agentId: BundledAgentId; order: number } =>
      typeof entry.order === 'number',
    )
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.agentId);
}
