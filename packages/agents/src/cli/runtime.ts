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

/**
 * The vendor's own updater (manifest `cli.install.nativeUpdate`): run against the resolved
 * executable only when it lives under one of `installPaths` (home-relative, `/`-separated).
 */
export type AgentCliNativeUpdateSpec = Readonly<{
  args: ReadonlyArray<string>;
  installPaths: ReadonlyArray<string>;
}>;

export type AgentCliRuntimeSpec = Readonly<{
  id: BundledAgentId;
  title: string;
  binaryName: string;
  alternativeBinaryNames?: ReadonlyArray<string>;
  alternativeBinaryFallbackEnabledEnvVar?: string | null;
  knownUserBinDirSuffixes?: ReadonlyArray<string> | null;
  knownEnvironmentBinDirs?: ReadonlyArray<Readonly<{ envVar: string; relativeDir: string }>>;
  systemCommandResolutionStrategy?: 'path-first' | 'known-user-first-runnable';
  sourcePreferenceDefault: AgentCliSourcePreference;
  managedInstall: AgentCliManagedInstallSpec | null;
  manualInstallKind: AgentCliManualInstallKind;
  manualInstallRecipes: AgentCliManualInstallRecipes;
  acceptsJavaScriptFileOverride: boolean;
  setupRecommendation?: AgentCliSetupRecommendation | null;
  installGuideUrl?: string | null;
  docsUrl?: string | null;
  /** The vendor's npm package when it is not already the managed package (manifest `cli.install.npmPackageName`). */
  npmPackageName?: string | null;
  nativeUpdate?: AgentCliNativeUpdateSpec | null;
}>;

export function projectAgentCliRuntimeSpec(
  agentId: BundledAgentId,
  cli: AgentDefinitionCliMetadata | undefined,
): AgentCliRuntimeSpec | null {
  if (!cli) return null;
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
    ...(executable.knownEnvironmentBinDirs
      ? { knownEnvironmentBinDirs: executable.knownEnvironmentBinDirs }
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
    ...(install.npmPackageName !== undefined ? { npmPackageName: install.npmPackageName } : {}),
    ...(install.nativeUpdate !== undefined ? { nativeUpdate: install.nativeUpdate } : {}),
  });
}

const AUTHORED_AGENT_CLI_RUNTIME_SPECS = {
} as const satisfies Partial<Record<BundledAgentId, AgentCliRuntimeSpec>>;

export const CANONICAL_AGENT_CLI_RUNTIME_SPECS: Readonly<Record<BundledAgentId, AgentCliRuntimeSpec | null>> =
  mergeAuthoredWithGeneratedAgentFacts<AgentCliRuntimeSpec, null>({
    authored: AUTHORED_AGENT_CLI_RUNTIME_SPECS,
    label: 'agent CLI runtime spec',
    readGenerated: (definition, agentId) => projectAgentCliRuntimeSpec(agentId, definition.cli),
    resolveMissing: () => null,
  });

export const AGENT_CLI_RUNTIME_SPECS = CANONICAL_AGENT_CLI_RUNTIME_SPECS;

/**
 * Read the generated CLI runtime spec of a bundled Agent.
 *
 * Catalog-driven Agents do not declare a fixed native CLI. An externally
 * installed Agent has no bundled facts. Both report typed unavailable.
 */
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

const AGENT_CLI_SETUP_SUPPORTED_IDS: ReadonlyArray<BundledAgentId> = AGENT_IDS.filter(id => AGENT_CLI_RUNTIME_SPECS[id] !== null);

export function getAgentCliSetupSupportedIds(): ReadonlyArray<BundledAgentId> {
  return [...AGENT_CLI_SETUP_SUPPORTED_IDS];
}

export function getAgentCliSetupRecommendedIds(): ReadonlyArray<BundledAgentId> {
  return AGENT_CLI_SETUP_SUPPORTED_IDS
    .map((agentId) => ({
      agentId,
      order: AGENT_CLI_RUNTIME_SPECS[agentId]?.setupRecommendation?.order,
    }))
    .filter((entry): entry is { agentId: BundledAgentId; order: number } =>
      typeof entry.order === 'number',
    )
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.agentId);
}
