/**
 * BUNDLED-PLUGIN PROJECTION PUBLISHER — SINGLE PRODUCER, SINGLE OWNER.
 *
 * Owner: `apps/cli` build-owned scripts. This module is the ONLY producer of the
 * generated bundled-plugin and bundled-Voice projection files listed below. They are emitted
 * artifacts, not source.
 *
 * Emitted artifacts (never hand-edit any of these). The COMPLETE set is the one
 * this module writes — read the `…OutPath` declarations in `main` for it, never
 * a prose list, which has already drifted once. The set spans `apps/cli`,
 * `apps/ui`, `packages/agents` and `packages/protocol`; these are the ones most
 * often reached for:
 *   - apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts
 *   - apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts
 *   - apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts
 *   - apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts{,.web,.ios,.android}.ts
 *   - apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts (plus its
 *     .agentSettings/.sessionAgentBehaviors/.uiBehaviorOverrides/.visibleMessageResolvers siblings)
 *   - apps/ui/sources/text/bundledPluginTranslations.generated.ts
 *   - apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts
 *   - apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries{,.ios,.android}.ts
 *   - packages/agents/src/generated/** and packages/protocol/src/agents/generated/**
 *
 * RULE 1 — change the generator, never the emitted file. A hand edit to any
 * emitted artifact above is erased by the next run and is a review finding. If an
 * artifact is wrong, the defect is in this module, in a bundled plugin's
 * manifest, or in the bundled-plugin membership list.
 *
 * RULE 2 — regeneration is the LAST step of a batch, run ONCE. Several programs
 * add, rename or re-manifest bundled plugins; each such change invalidates the
 * complete emitted set. Two concurrent regenerations clobber each other, so land every
 * manifest/membership source change in the batch first, then regenerate once:
 *
 *   node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode write
 *
 * (`scripts/migrations/extensions/generateBundledPluginEntries.ts` is a thin
 * compatibility entrypoint that re-exports `main` from this module.)
 *
 * RULE 3 — the drift gate already exists; do not add a second one. It runs this
 * same publisher in check mode, under one of two scopes, and fails when an
 * emitted artifact differs from a fresh run:
 *
 *   yarn test:migration:bundled-plugin-projections           # --mode check --scope projections
 *   yarn test:migration:bundled-plugin-runtime-determinism   # --mode check --scope all
 *
 * Both are reached in CI through `test:migration:governance`
 * (`.github/workflows/tests.yml`). `apps/cli/scripts/verifyBundledPluginArtifacts.mjs`
 * prints the RULE 2 write command as its remediation. See `GeneratorScope` below
 * for why the two questions are not the same question.
 *
 * RULE 4 — the producer and everything it emits are ONE publication closure;
 * land them in one commit. Splitting them breaks `test:migration:governance` in
 * CI: either the tracked compatibility entrypoint re-exports a producer CI does
 * not have, or the tracked artifacts record bytes no tracked producer can emit.
 * Establish the closure's membership from `git ls-tree -r --name-only HEAD
 * <path>` at the moment you commit — never from a filename, an artifact count,
 * or an earlier note in a comment, each of which has already drifted here.
 *
 * `apps/cli/AGENTS.md` ("Generated bundled-plugin artifacts") owns this rule;
 * this note points at it rather than restating a second copy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentId } from '@happier-dev/agents';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import {
  pluginPackageNameToPackageId,
  readBundledPluginPackageNames,
  syncCliBundledPluginMembership,
} from './bundledPluginMembership.ts';
import { requiresBundledImmutableArtifact } from './bundledImmutableArtifactEligibility.ts';
import { readAndAssertBundledProviderVerificationsV1 } from './bundledProviderVerification.ts';
import {
  assertGeneratedOutputMatches,
  publishCoherentProjectionOutputs,
  removeRetiredGeneratedOutput,
  writeFileAtomic,
  type GeneratorMode,
} from './bundledPlugins/outputs.ts';
import { mapWithConcurrency } from './bundledPlugins/concurrency.ts';
import { createBundledPluginTimingReporter } from './bundledPlugins/timing.ts';
import {
  inspectTypescriptModule as importTypescriptModule,
  withTypescriptModuleInspectionSession,
} from './bundledPlugins/typescriptModuleInspection.ts';
import {
  parseGeneratorCliArgs,
  resolvePluginAuthorRuntimeLoadScope,
  resolveSelectedBundledPluginPackageNames,
  shouldEvaluateBundledRuntimeSource,
  shouldHoldGeneratorWorkspaceLockDuringGeneration,
  type PluginAuthorRuntimeLoadScope,
  type GeneratorOptions,
  type GeneratorScope,
} from './bundledPlugins/options.ts';
import {
  resolveCliBundledWorkspacePackageNames,
  syncSharedDepsForSourceDev,
} from '../buildSharedDeps.mjs';

type Mode = GeneratorMode;

/**
 * `--mode check` answers two independent questions that used to share one name.
 *
 * `projections` compares the generated projections against the bundled plugin
 * sources and the bundle bytes **as installed on disk**. Every input is owned by
 * `packages/plugins/*`, so a failure names a plugin-source or projection defect.
 *
 * `all` additionally re-stages every bundled daemon runtime with esbuild and
 * requires the installed bytes to equal that fresh build. That staging runs
 * `bundle: true, packages: 'bundle'`
 * (`apps/cli/src/plugins/authoring/bundleDaemonRuntime.ts`), so the current
 * `plugin-sdk`/`protocol` output is inlined into every bundle: rebuilding one
 * shared workspace dependency changes all bundled runtimes at once, and the
 * recorded artifact digests with them. That is a whole-repo build-determinism
 * fact, not a plugin-projection fact, and it cannot be stable while a shared
 * inlined dependency is regenerating.
 *
 * `--mode write` is the producer and always publishes the full scope.
 */
export { shouldHoldGeneratorWorkspaceLockDuringGeneration };
type AgentsWorkspaceModule = typeof import('@happier-dev/agents');
type CliCommonWorkspacesModule = typeof import('@happier-dev/cli-common/workspaces');
type ProtocolWorkspaceModule = typeof import('@happier-dev/protocol');
type PluginUiProtocolWorkspaceModule = typeof import('@happier-dev/protocol/plugins/ui');
type PluginDaemonRuntimeStagingModule = typeof import(
  '../../src/plugins/authoring/bundleDaemonRuntime.ts'
);
type PluginRuntimeStagingSourceModule = typeof import(
  '../../src/plugins/authoring/runtimeStagingSource.ts'
);
type PluginManifestSerializerModule = typeof import(
  '../../src/plugins/manifest/serialize.ts'
);
type GeneratorWorkspaceDependencies = Readonly<{
  agents: Readonly<Pick<
    AgentsWorkspaceModule,
    | 'CANONICAL_AGENTS_CORE'
    | 'getAllAgentDefinitionContracts'
    | 'getAllBackendCatalogDefinitions'
    | 'getAllBackendDefinitionContracts'
    | 'getAgentCatalogDefinition'
    | 'getAgentCliRuntimeSpec'
  >>;
  cliCommonWorkspaces: Readonly<Pick<
    CliCommonWorkspacesModule,
    | 'bundleWorkspacePackage'
    | 'resolveWorkspaceBundlesFromPackageJson'
    | 'sanitizeBundledPackageJson'
  >>;
  protocol: Readonly<Pick<
    ProtocolWorkspaceModule,
    | 'BackendSurfaceOperationCatalogV1'
    | 'ConnectedServiceIdSchema'
    | 'buildQualifiedPluginContributionKey'
    | 'derivePluginDaemonContributionRegistrationRights'
    | 'ingestPluginManifestV2'
    | 'isDynamicPluginResourceContributionV2'
  >>;
  pluginUi: Readonly<Pick<
    PluginUiProtocolWorkspaceModule,
    | 'PluginUiArtifactsManifestV1Schema'
    | 'computePluginUiArtifactFileSetSha256DigestV1'
    | 'computePluginUiArtifactSha256DigestV1'
  >>;
}>;

const CANONICAL_GENERATOR_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GENERATOR_BUILD_PREP_STAMP_PATH = resolve(
  CANONICAL_GENERATOR_REPO_ROOT,
  '.project/tmp/cli-generator-authoring-build-prep.json',
);
const GENERATOR_STAGE_PREP_STAMP_PATH = resolve(
  CANONICAL_GENERATOR_REPO_ROOT,
  '.project/tmp/cli-generator-authoring-stage-prep.json',
);
const CANONICAL_WORKSPACE_PACKAGE_DIRS = Object.freeze({
  '@happier-dev/agents': 'packages/agents',
  '@happier-dev/cli-common': 'packages/cli-common',
  '@happier-dev/protocol': 'packages/protocol',
} as const);

function selectCanonicalExportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  for (const condition of ['import', 'default', 'node']) {
    const selected = selectCanonicalExportTarget(record[condition]);
    if (selected) return selected;
  }
  return null;
}

function resolveCanonicalWorkspaceModulePath(
  packageName: keyof typeof CANONICAL_WORKSPACE_PACKAGE_DIRS,
  subpath = '.',
): string {
  const packageRoot = resolve(CANONICAL_GENERATOR_REPO_ROOT, CANONICAL_WORKSPACE_PACKAGE_DIRS[packageName]);
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: unknown;
  };
  const exportsMap = packageJson.exports;
  const exportKey = subpath === '.' ? '.' : `./${subpath}`;
  const exportValue = exportsMap && typeof exportsMap === 'object' && !Array.isArray(exportsMap)
    && Object.prototype.hasOwnProperty.call(exportsMap, exportKey)
    ? (exportsMap as Readonly<Record<string, unknown>>)[exportKey]
    : exportKey === '.'
      ? exportsMap
      : undefined;
  const relativeTarget = selectCanonicalExportTarget(exportValue);
  if (!relativeTarget) {
    throw new Error(`Canonical workspace package ${packageName}/${subpath} has no runtime export target`);
  }
  const resolvedPath = resolve(packageRoot, relativeTarget);
  const packageRelativePath = relative(packageRoot, resolvedPath);
  if (packageRelativePath.startsWith('..') || packageRelativePath.includes(`..${sep}`)) {
    throw new Error(`Canonical workspace package ${packageName}/${subpath} export escaped its package root`);
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Canonical workspace package ${packageName}/${subpath} runtime output is missing: ${resolvedPath}`);
  }
  return resolvedPath;
}

async function importCanonicalWorkspaceModule(
  packageName: keyof typeof CANONICAL_WORKSPACE_PACKAGE_DIRS,
  subpath = '.',
): Promise<unknown> {
  return await import(pathToFileURL(resolveCanonicalWorkspaceModulePath(packageName, subpath)).href);
}

// Actual-root generation is a one-shot CLI operation. Programmatic `main` callers
// are temp-root tests and do not rebuild workspace dist within their process.
// If an in-process caller ever needs to rebuild dist between invocations, that
// lifecycle must use a fresh CLI process so Node's ESM cache cannot retain the
// prior dependency snapshot.
async function loadGeneratorWorkspaceDependencies(): Promise<GeneratorWorkspaceDependencies> {
  const [agents, cliCommonWorkspaces, protocol, pluginUi] = await Promise.all([
    importCanonicalWorkspaceModule('@happier-dev/agents'),
    importCanonicalWorkspaceModule('@happier-dev/cli-common', 'workspaces'),
    importCanonicalWorkspaceModule('@happier-dev/protocol'),
    importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/ui'),
  ]) as [
    AgentsWorkspaceModule,
    CliCommonWorkspacesModule,
    ProtocolWorkspaceModule,
    PluginUiProtocolWorkspaceModule,
  ];
  return Object.freeze({
    agents: Object.freeze({
      CANONICAL_AGENTS_CORE: agents.CANONICAL_AGENTS_CORE,
      getAllAgentDefinitionContracts: agents.getAllAgentDefinitionContracts,
      getAllBackendCatalogDefinitions: agents.getAllBackendCatalogDefinitions,
      getAllBackendDefinitionContracts: agents.getAllBackendDefinitionContracts,
      getAgentCatalogDefinition: agents.getAgentCatalogDefinition,
      getAgentCliRuntimeSpec: agents.getAgentCliRuntimeSpec,
    }),
    cliCommonWorkspaces: Object.freeze({
      bundleWorkspacePackage: cliCommonWorkspaces.bundleWorkspacePackage,
      resolveWorkspaceBundlesFromPackageJson: cliCommonWorkspaces.resolveWorkspaceBundlesFromPackageJson,
      sanitizeBundledPackageJson: cliCommonWorkspaces.sanitizeBundledPackageJson,
    }),
    protocol: Object.freeze({
      BackendSurfaceOperationCatalogV1: protocol.BackendSurfaceOperationCatalogV1,
      ConnectedServiceIdSchema: protocol.ConnectedServiceIdSchema,
      buildQualifiedPluginContributionKey: protocol.buildQualifiedPluginContributionKey,
      derivePluginDaemonContributionRegistrationRights:
        protocol.derivePluginDaemonContributionRegistrationRights,
      ingestPluginManifestV2: protocol.ingestPluginManifestV2,
      isDynamicPluginResourceContributionV2: protocol.isDynamicPluginResourceContributionV2,
    }),
    pluginUi: Object.freeze({
      PluginUiArtifactsManifestV1Schema: pluginUi.PluginUiArtifactsManifestV1Schema,
      computePluginUiArtifactFileSetSha256DigestV1:
        pluginUi.computePluginUiArtifactFileSetSha256DigestV1,
      computePluginUiArtifactSha256DigestV1: pluginUi.computePluginUiArtifactSha256DigestV1,
    }),
  });
}

async function synchronizeGeneratorAuthoringRuntimeClosure(
  mode: Mode,
  inheritedLockValue: string | undefined,
): Promise<void> {
  // `sourceModule.ts` is loaded through tsx below and therefore resolves its
  // public Protocol/SDK imports from the CLI's materialized dependency tree.
  // Use the shared source-dev owner to make that complete closure current
  // before either canonical generator imports or authoring source imports run.
  // This invocation is the canonical bundled-plugin publisher, so it asks the
  // shared owner to synchronize without recursively publishing itself.
  const sync = async (
    preserveBundledPluginArtifacts: boolean,
    stampPath: string,
    workspaceNames: readonly string[],
  ): Promise<void> => {
    await syncSharedDepsForSourceDev({
      repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
      workspaceNames,
      // Preparation is the same canonical materialization operation for write
      // and check. Passing check mode here produced a distinct rebuilt plugin
      // closure after publication (different chunks/daemon bytes), so the
      // checker invalidated the artifacts it was about to compare. Drift is
      // still read-only at the projection/output boundary below.
      generatedCompilerInputMode: 'write',
      includeRuntimeDependencies: true,
      publishBundledPluginArtifacts: false,
      preserveBundledPluginArtifacts,
      // Generator preflight deliberately does not publish immutable plugin
      // artifacts. Its readiness must never make `build:shared` reuse an
      // unpublishable closure.
      stampPath,
      quiet: true,
      ...(inheritedLockValue
        ? { lockOptions: { heldLockValue: inheritedLockValue } }
        : {}),
    });
  };

  // First make ordinary declarations and non-runtime package outputs current.
  // Checks must prepare the same authoring declaration closure as writes before
  // loading manifests; otherwise a newly added public manifest field can be
  // present for publication and then disappear from the immediately following
  // drift projection through a stale materialized Plugin SDK parser.
  await sync(false, GENERATOR_BUILD_PREP_STAMP_PATH, ['plugin-sdk']);
  // Both write and check must stage under the exact same materialized runtime
  // closure. This second bounded pass preserves generator-owned plugin bundles
  // while synchronizing the host/runtime dependencies used by esbuild.
  const hostWorkspaceNames = resolveCliBundledWorkspacePackageNames({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
  }).filter((workspaceName) => !workspaceName.startsWith('plugins-'));
  await sync(true, GENERATOR_STAGE_PREP_STAMP_PATH, hostWorkspaceNames);
}

type PluginAuthorRuntimeModules = Readonly<{
  staging: PluginDaemonRuntimeStagingModule;
  source: PluginRuntimeStagingSourceModule;
  manifestSerializer: PluginManifestSerializerModule;
}>;

type PluginAuthorRuntimeSupportModules = Pick<PluginAuthorRuntimeModules, 'staging' | 'source'>;

let pluginManifestSerializerPromise: Promise<PluginManifestSerializerModule> | null = null;
let pluginAuthorRuntimeSupportModulesPromise: Promise<PluginAuthorRuntimeSupportModules> | null = null;

async function importPluginAuthorRuntimeModules<T>(
  operation: (tsImport: typeof import('tsx/esm/api')['tsImport']) => Promise<T>,
): Promise<T> {
  const previousTsconfigPath = process.env.TSX_TSCONFIG_PATH;
  try {
    process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL(
      '../../tsconfig.json',
      import.meta.url,
    ));
    const { tsImport } = await import('tsx/esm/api');
    return await operation(tsImport);
  } finally {
    if (previousTsconfigPath === undefined) {
      delete process.env.TSX_TSCONFIG_PATH;
    } else {
      process.env.TSX_TSCONFIG_PATH = previousTsconfigPath;
    }
  }
}

async function loadPluginManifestSerializerModule(): Promise<PluginManifestSerializerModule> {
  pluginManifestSerializerPromise ??= importPluginAuthorRuntimeModules(async (tsImport) => (
    await tsImport(new URL(
      '../../src/plugins/manifest/serialize.ts',
      import.meta.url,
    ).href, import.meta.url) as PluginManifestSerializerModule
  ));
  return await pluginManifestSerializerPromise;
}

async function loadPluginAuthorRuntimeSupportModules(): Promise<PluginAuthorRuntimeSupportModules> {
  pluginAuthorRuntimeSupportModulesPromise ??= importPluginAuthorRuntimeModules(async (tsImport) => {
    const [staging, source] = await Promise.all([
      tsImport(new URL(
        '../../src/plugins/authoring/bundleDaemonRuntime.ts',
        import.meta.url,
      ).href, import.meta.url) as Promise<PluginDaemonRuntimeStagingModule>,
      tsImport(new URL(
        '../../src/plugins/authoring/runtimeStagingSource.ts',
        import.meta.url,
      ).href, import.meta.url) as Promise<PluginRuntimeStagingSourceModule>,
    ]);
    return Object.freeze({ staging, source });
  });
  return await pluginAuthorRuntimeSupportModulesPromise;
}

async function loadPluginAuthorRuntimeModules(): Promise<PluginAuthorRuntimeModules> {
  const manifestSerializer = await loadPluginManifestSerializerModule();
  const { staging, source } = await loadPluginAuthorRuntimeSupportModules();
  return Object.freeze({ staging, source, manifestSerializer });
}

async function loadPluginAuthorRuntimeForScope(scope: PluginAuthorRuntimeLoadScope): Promise<void> {
  if (scope === 'none') return;
  if (scope === 'manifest') {
    await loadPluginManifestSerializerModule();
    return;
  }
  await loadPluginAuthorRuntimeModules();
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Readonly<{ [key: string]: JsonValue }>;
type BundledPluginManifestJson = Parameters<
  PluginManifestSerializerModule['serializeCanonicalPluginManifest']
>[0] & Readonly<{ id: string }>;
type PluginManifestJson = BundledPluginManifestJson;
type BundledPluginManifestParser = Readonly<Pick<
  ProtocolWorkspaceModule,
  'ingestPluginManifestV2'
>>;
type BundledManifestContribution = Readonly<{
  id: string;
  definition: JsonValue;
  metadata: BundledFirstPartyPluginMetadataSource;
}>;
type BundledFirstPartyPluginMetadataSource = Readonly<{
  activationEvents?: readonly string[];
  agentId?: string;
  manifestPath: string;
  packageName: string;
  packageVersion: string;
  pluginId: string;
  pluginPackageId: string;
}>;
type BundledPluginPackage = Readonly<{
  pluginPackageId: string;
  pluginId: string;
  packageName: string;
  packageVersion: string;
  manifest: PluginManifestJson;
  agentId?: string;
  agentDefinition?: JsonValue;
  agentUiDescriptor?: AgentUiDescriptor;
  agentPredecessorMessageMetaWriter?: AgentPredecessorMessageMetaWriterImportSource;
  releasedFlatSessionMetadataRuntimeDescriptorReader?: ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor;
  promptAssetContributions?: PromptAssetContributionSource;
  builtInLegacyConnectedAccountCompatibility?:
    readonly BuiltInLegacyConnectedAccountCompatibilitySource[];
  // Source-authoring collection populates this pack-time payload for every
  // bundled package. Aggregate publication only reads serialized manifest
  // metadata, so it intentionally does not construct a package tree here.
  sourceArtifactIntegrity?: BundledFirstPartySourceArtifactIntegrity;
  immutableArtifact?: BundledImmutableArtifactSource;
}>;
type BundledPluginSourceProjectionFacts = Readonly<{
  agentId?: string;
  agentDefinition?: JsonValue;
  agentUiDescriptor?: AgentUiDescriptor;
  agentPredecessorMessageMetaWriter?: AgentPredecessorMessageMetaWriterImportSource;
  releasedFlatSessionMetadataRuntimeDescriptorReader?: ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor;
  promptAssetContributions?: PromptAssetContributionSource;
  builtInLegacyConnectedAccountCompatibility?:
    readonly BuiltInLegacyConnectedAccountCompatibilitySource[];
}>;
type BuiltInLegacyConnectedAccountCompatibilitySource = Readonly<{
  legacyServiceId: string;
  serviceLocalId: string;
  peerOperations: BuiltInLegacyConnectedAccountPeerOperations;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
  unsupportedAuthenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
}>;
const BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS = Object.freeze([
  'account_list',
  'credential_read',
  'credential_write',
  'credential_delete',
  'credential_health',
  'refresh_lease',
  'oauth_refresh',
  'one_shot_materialization',
  'request_auth',
  'quota_read',
  'quota_refresh',
  'quota_poll',
  'recovery_credit_consume',
  'provider_account_usage_write',
] as const);
type BuiltInLegacyConnectedAccountOperation =
  typeof BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS[number];
type BuiltInLegacyConnectedAccountPeerOperations = Readonly<{
  exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];
  revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];
}>;
type BuiltInLegacyConnectedAccountCompatibilityProjection = Readonly<{
  legacyServiceId: string;
  service: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  peerOperations: BuiltInLegacyConnectedAccountPeerOperations;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
  unsupportedAuthenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
}>;
type BundledImmutableArtifactFileSource = Readonly<{
  relativePath: string;
  byteLength: number;
}>;
type BundledFirstPartySourceArtifactIntegrityFile = BundledImmutableArtifactFileSource & Readonly<{
  digest: string;
}>;
type BundledFirstPartySourceArtifactIntegrity = Readonly<{
  packageName: string;
  files: readonly BundledFirstPartySourceArtifactIntegrityFile[];
}>;
type BundledImmutableArtifactSource = Readonly<{
  packageEntryRelativePath: string;
  daemonEntryRelativePath: string | null;
  sourceArtifactIntegrity: BundledFirstPartySourceArtifactIntegrity;
  record: Readonly<{
    t: 'happier_plugin_generation_v1';
    schemaVersion: 1;
    pluginId: string;
    immutableGenerationId: string;
    createdAtMs: number;
    files: readonly BundledImmutableArtifactFileSource[];
    manifestRelativePath: string;
  }>;
}>;
type PriorBundledImmutableArtifactIdentity = Readonly<{
  packageName: string;
  pluginId: string;
  immutableGenerationId: string;
  sourceArtifactIntegrity: BundledFirstPartySourceArtifactIntegrity;
}>;
type BundledPluginUiAppArtifactPlatform = 'web' | 'ios' | 'android';
type BundledPluginUiAppArtifactFileSource = Readonly<{
  relativePath: string;
}>;
type BundledPluginUiAppArtifactSource = Readonly<{
  packageName: string;
  packageVersion: string;
  pluginId: string;
  contributionId: string;
  tier: 'hostedWeb' | 'reactNative';
  platform: BundledPluginUiAppArtifactPlatform;
  digest: string;
  files: readonly BundledPluginUiAppArtifactFileSource[];
}>;
type AgentBundledPluginPackage = BundledPluginPackage & Readonly<{
  agentId: string;
  agentDefinition: JsonValue;
}>;
type AgentUiDescriptor = Readonly<{
  kind: 'plugin.ui.v1';
  pluginId: string;
  agentId: string;
  version: number;
  display: Readonly<{
    nameKey: string;
    subtitleKey: string;
    permissionModeI18nPrefix: string;
    availability: Readonly<{ experimental: boolean }>;
    connectedService: Readonly<{
      serviceId: string | null;
      labelKey: string;
      connectRoute: string | null;
    }>;
    flavorAliases: readonly string[];
    permissions: Readonly<{
      modeGroup: string;
      promptProtocol: string;
    }>;
    sessionModes?: Readonly<{
      staticOptions?: readonly AgentUiSessionModeOption[];
    }>;
    runtimeInput?: Readonly<{
      inFlightSteerSupported: boolean;
    }>;
    resume: Readonly<{
      uiVendorResumeIdLabelKey: string | null;
      uiVendorResumeIdCopiedKey: string | null;
    }>;
    localControl?: boolean;
    toolRendering: Readonly<{ hideUnknownToolsByDefault: boolean }>;
    picker: Readonly<{
      iconName: string;
      iconScale?: number;
      cliGlyph: string;
      cliGlyphScale: number;
      profileCompatibilityGlyphScale: number;
    }>;
    avatarOverlay: Readonly<{
      circleScale: number;
      iconScaleRatio: number;
    }>;
    icon?: Readonly<{ assetId: string | null }>;
  }>;
  behavior?: JsonObject;
  session?: JsonObject;
  message?: JsonObject;
  components?: JsonObject;
  assets?: JsonObject;
}>;
type ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerSessionId';
  agentId: string;
  runtimeHandle: 'providerSessionId';
}>;
type ProviderRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerRuntimeDescriptorReader';
  agentId: string;
  source?: string;
  exportName?: string;
  generatedReader: JsonObject;
}>;
type RuntimeDescriptorReaderContributionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;
type ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor =
  RuntimeDescriptorReaderContributionDescriptor;
type ReleasedFlatSessionMetadataRuntimeDescriptorReaderProjectionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;
type ExternalSessionSchemaFieldDescriptor = Readonly<{
  name: string;
  kind: 'literal' | 'string' | 'enum' | 'unknown';
  value?: string;
  values?: readonly string[];
  min?: number;
  max?: number;
  optional?: boolean;
  nullish?: boolean;
}>;
type ExternalSessionSchemaRefinementDescriptor =
  | Readonly<{
    kind: 'requiresWhenEquals';
    field: string;
    when: Readonly<{ field: string; equals: string }>;
  }>
  | Readonly<{
    kind: 'forbidsWhenEquals';
    fields: readonly string[];
    when: Readonly<{ field: string; equals: string }>;
  }>;
type ExternalSessionKeySegmentDescriptor =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'field'; field: string }>
  | Readonly<{ kind: 'homeMode'; field: string }>
  | Readonly<{ kind: 'conditionalField'; field: string; when: Readonly<{ field: string; equals: string }> }>
  | Readonly<{
    kind: 'connectedServiceScope';
    groupField: string;
    profileField: string;
    when: Readonly<{ field: string; equals: string }>;
  }>;
type ExternalSessionInstanceConstantDescriptor = string | number | boolean | null;
type ExternalSessionInstanceDescriptor =
  | Readonly<{
    kind: 'default';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>
  | Readonly<{
    kind: 'connectedServiceProfiles';
    serviceId: string;
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
    fields: Readonly<{ serviceId: string; profileId: string }>;
  }>
  | Readonly<{
    kind: 'agentSetting';
    settingId: string;
    byServerIdSettingId?: string;
    field: string;
    normalization: 'httpOrigin';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>
  | Readonly<{
    kind: 'agentSettingOverride';
    settingId: string;
    byServerIdSettingId?: string;
    field: string;
    // Whether a configured source REPLACES the paired default is independent of
    // how its raw setting value is normalized, exactly as the protocol
    // declaration schema admits both.
    normalization: 'httpOrigin' | 'configuredPath';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>;
type ExternalSessionSourceDeclaration = Readonly<{
  agentId: string;
  sourceKind: string;
  schema: Readonly<{
    fields: readonly ExternalSessionSchemaFieldDescriptor[];
    refinements?: readonly ExternalSessionSchemaRefinementDescriptor[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDescriptor[];
  }>;
  instances?: readonly ExternalSessionInstanceDescriptor[];
}>;
type ProtocolExternalSessionSourceProjectionDescriptor = Readonly<{
  agentId: string;
  declaration: ExternalSessionSourceDeclaration;
}>;
type AgentCommandSurfaceSource = Readonly<{
  rootHelpLabel?: string;
  rootHelpDescription?: string;
  rootHelpDetail?: string;
  allowTmux?: boolean;
}>;
type AgentCommandPolicySource = Readonly<{
  daemonAutostartDefault?: 'preferLocalTui';
}>;
type BuiltInProviderContributionSource = Readonly<{
  id: string;
  definition: JsonValue;
  runtimeSpec: JsonValue;
  cliSubcommand: string;
  vendorResumeSupport: string;
  commandSurface?: AgentCommandSurfaceSource;
  commandPolicy?: AgentCommandPolicySource;
}>;
type BuiltInBackendContributionSource = Readonly<{
  id: string;
  agentId: string;
  definition: JsonValue;
  runtimeKind: string;
}>;
type AgentUiSessionModeOption = Readonly<{
  id: string;
  nameKey: string;
  descriptionKey?: string;
}>;
type GeneratedAgentUiProjectionSource = Readonly<{
  agentId: string;
  coreConst: string;
  uiConst: string;
  renderLines: () => readonly string[];
}>;
type DescriptorAgentUiProjectionSource = Readonly<{
  agentId: string;
  coreConst: string;
  uiConst: string;
  descriptor: AgentUiDescriptor;
  providerOwnedEnvironmentKeys: readonly string[];
  svgIcon?: DescriptorGeneratedSvgIconSource;
}>;
type DescriptorGeneratedSvgIconPathSource = Readonly<{
  d: string;
  fillToken?: string;
  fillOpacity?: number;
  fillRule?: 'evenodd' | 'nonzero';
  clipRule?: 'evenodd' | 'nonzero';
}>;
type DescriptorGeneratedSvgIconSource = Readonly<{
  constName: string;
  viewBox: string;
  paths: readonly DescriptorGeneratedSvgIconPathSource[];
}>;
type AgentUiBehaviorDescriptorSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
  predecessorMessageMetaWriter?: AgentPredecessorMessageMetaWriterImportSource;
}>;
type AgentPredecessorMessageMetaWriterImportSource = Readonly<{
  importName: string;
  importPath: string;
}>;
type AgentSessionBehaviorSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type SessionSubagentVisibleMessageResolverSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;
type PromptAssetContributionSource = Readonly<{
  importName: string;
  importPath: string;
  pluginPackageId: string;
}>;
type BundledFirstPartyVoiceProjectionSource = Readonly<{
  manifest: PluginManifestJson;
  packageName: string;
  packageVersion: string;
  pluginId: string;
  pluginPackageId: BundledFirstPartyVoicePackageId;
  hasConversationProvider: boolean;
  conversationPlatforms: readonly BundledVoiceRuntimePlatform[];
}>;
type BundledFirstPartyVoicePackageId = 'codex' | 'elevenlabs' | 'google' | 'openai' | 'openai-compat' | 'xai';
type BundledVoiceRuntimePlatform = 'web' | 'ios' | 'android';

const BUNDLED_VOICE_RUNTIME_PLATFORMS = Object.freeze([
  'web',
  'ios',
  'android',
] as const satisfies readonly BundledVoiceRuntimePlatform[]);

const BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS: Readonly<Record<BundledFirstPartyVoicePackageId, string>> = Object.freeze({
  codex: 'happier.agent.codex',
  elevenlabs: 'happier.voice.elevenlabs',
  google: 'happier.voice.google',
  openai: 'happier.voice.openai',
  'openai-compat': 'happier.voice.openai-compat',
  xai: 'happier.voice.xai',
});
const BUNDLED_FIRST_PARTY_VOICE_PACKAGE_IDS = Object.freeze(
  Object.keys(BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS) as BundledFirstPartyVoicePackageId[],
);

const GENERATED_AGENT_UI_PROJECTION_SOURCES: readonly GeneratedAgentUiProjectionSource[] = Object.freeze([
  // Remove this legacy host projection once Qwen ships a first-party plugin.ui.v1 descriptor.
  { agentId: 'qwen', coreConst: 'QWEN_CORE', uiConst: 'QWEN_UI', renderLines: renderQwenGeneratedUiProjectionLines },
]);
const AGENT_UI_PROJECTION_ORDER = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'pi',
  'ohMyPi',
  'copilot',
  'coderabbit',
  'deepsec',
]);
const STABLE_AGENT_ID_ORDER = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
  'coderabbit',
  'deepsec',
] as const);
const PROTOCOL_AGENT_PROVIDER_IDS_V1 = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'pi',
  'ohMyPi',
] as const);
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isBundledFirstPartyVoicePackageId(value: string): value is BundledFirstPartyVoicePackageId {
  return Object.prototype.hasOwnProperty.call(BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonSerializable(value: unknown, path: string[] = []): asserts value is JsonValue {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (t === 'undefined' || t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new Error(`Non-JSON value at ${path.join('.') || '<root>'}: ${t}`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertJsonSerializable(value[i], [...path, String(i)]);
    }
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`Non-JSON object at ${path.join('.') || '<root>'}`);
  }
  for (const [k, v] of Object.entries(value)) {
    assertJsonSerializable(v, [...path, k]);
  }
}

function normalizeJsonSerializableValue(value: unknown, path: string[] = []): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new Error(`Non-JSON value at ${path.join('.') || '<root>'}: ${t}`);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => (
      normalizeJsonSerializableValue(entry, [...path, String(index)]) ?? null
    ));
  }
  if (!isRecord(value)) {
    throw new Error(`Non-JSON object at ${path.join('.') || '<root>'}`);
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeJsonSerializableValue(entry, [...path, key]);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

function readJsonSerializableValue(value: unknown, subject: string): JsonValue {
  const normalized = normalizeJsonSerializableValue(value, [subject]);
  if (normalized === undefined) {
    throw new Error(`Non-JSON value at ${subject}: undefined`);
  }
  return normalized;
}

function deepSortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => deepSortJson(entry)) as JsonValue;
  }
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of entries) {
    out[k] = deepSortJson(v);
  }
  return out;
}

function renderJsonLiteral(value: JsonValue, indent = 2): string {
  return JSON.stringify(deepSortJson(value), null, indent) ?? 'null';
}

/**
 * Locator manifests are consumed as canonical data at daemon cold start. Keep
 * their generated representation compact: pretty-printing every nested
 * manifest inflated this one projection from 1,208 to more than 169,000 lines
 * without changing the serialized data or its ingestion owner.
 */
function renderCompactJsonLiteral(value: JsonValue): string {
  return JSON.stringify(deepSortJson(value)) ?? 'null';
}

function readManifestContributionArray(manifest: PluginManifestJson, family: string): readonly JsonValue[] {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];
  const value = contributes[family];
  return Array.isArray(value) ? value : [];
}

function readManifestNestedContributionArray(
  manifest: PluginManifestJson,
  family: string,
  nestedFamily: string,
): readonly JsonValue[] {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];
  const familyContributions = contributes[family];
  if (!isRecord(familyContributions)) return [];
  const value = familyContributions[nestedFamily];
  return Array.isArray(value) ? value : [];
}

function readRequiredContributionId(value: JsonValue, family: string, pluginPackageId: string): string {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: expected object with non-empty string id`);
  }
  return value.id;
}

function readRequiredContributionString(
  value: JsonValue,
  key: string,
  family: string,
  pluginPackageId: string,
): string {
  if (!isJsonObject(value) || typeof value[key] !== 'string' || value[key].trim().length === 0) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: expected object with non-empty string ${key}`);
  }
  return value[key];
}

function readBackendContributionProviderId(
  value: JsonValue,
  family: string,
  pluginPackageId: string,
): string {
  const providerId = readOptionalJsonStringProperty(value, 'providerId');
  const legacyAgentId = readOptionalJsonStringProperty(value, 'agentId');
  if (providerId && legacyAgentId && providerId !== legacyAgentId) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: providerId and legacy agentId must match`);
  }
  const resolvedProviderId = providerId ?? legacyAgentId;
  if (!resolvedProviderId) {
    throw new Error(`Invalid ${family} contribution in ${pluginPackageId}: expected object with non-empty string providerId`);
  }
  return resolvedProviderId;
}

function assertUniqueBundledContributionIds(
  family: string,
  contributions: readonly BundledManifestContribution[],
): void {
  const seen = new Map<string, BundledManifestContribution>();
  for (const contribution of contributions) {
    const existing = seen.get(contribution.id);
    if (existing) {
      throw new Error(
        `Duplicate bundled first-party ${family} contribution '${contribution.id}'`
        + ` from ${contribution.metadata.pluginPackageId}; already declared by ${existing.metadata.pluginPackageId}`,
      );
    }
    seen.set(contribution.id, contribution);
  }
}

function readOptionalJsonStringProperty(value: JsonValue, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const property = value[key];
  return typeof property === 'string' && property.trim().length > 0 ? property : null;
}

function readJsonObjectProperty(value: JsonValue, key: string): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const property = value[key];
  return isJsonObject(property) ? property : null;
}

function readJsonArrayProperty(value: JsonValue, key: string): readonly JsonValue[] {
  if (!isJsonObject(value)) return [];
  const property = value[key];
  return Array.isArray(property) ? property : [];
}

function hasTerminalRuntimeLaunchSurfaceContribution(
  definition: JsonValue,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  return readJsonArrayProperty(definition, 'surfaceHandlers').some((surfaceHandler) => (
    isJsonObject(surfaceHandler)
    && surfaceHandler.kind === 'terminalRuntime'
    && surfaceHandler.operation === dependencies.protocol.BackendSurfaceOperationCatalogV1.terminalRuntime.launch
  ));
}

function isProviderlessReviewExecutionRunBackendContribution(
  definition: JsonValue,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  const capabilities = readJsonObjectProperty(definition, 'capabilities');
  const session = capabilities ? readJsonObjectProperty(capabilities, 'session') : null;
  const executionRun = capabilities ? readJsonObjectProperty(capabilities, 'executionRun') : null;
  return session?.supported === false
    && executionRun !== null
    && executionRun.supported !== false
    && isJsonObject(executionRun.review)
    && !hasTerminalRuntimeLaunchSurfaceContribution(definition, dependencies);
}

function readRequiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected object`);
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected non-empty string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected non-empty string when present`);
  }
  return value;
}

function readRequiredBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected boolean`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected finite number`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected boolean`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected finite number`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string, path: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected string or null`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string, path: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${key}: expected string array`);
  }
  return value;
}

function readOptionalAgentUiSessionModes(
  record: Record<string, unknown>,
  path: string,
): AgentUiDescriptor['display']['sessionModes'] {
  const value = record.sessionModes;
  if (value === undefined) return undefined;
  const sessionModes = readRequiredRecord(value, `${path}.sessionModes`);
  const staticOptions = sessionModes.staticOptions;
  if (staticOptions === undefined) return {};
  if (!Array.isArray(staticOptions)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.sessionModes.staticOptions: expected array`);
  }
  return {
    staticOptions: staticOptions.map((entry, index) => {
      const option = readRequiredRecord(entry, `${path}.sessionModes.staticOptions[${String(index)}]`);
      const descriptionKey = option.descriptionKey;
      if (descriptionKey !== undefined && typeof descriptionKey !== 'string') {
        throw new Error(
          `Invalid agent UI descriptor at ${path}.sessionModes.staticOptions[${String(index)}].descriptionKey: expected string`,
        );
      }
      return {
        id: readRequiredString(option, 'id', `${path}.sessionModes.staticOptions[${String(index)}]`),
        nameKey: readRequiredString(option, 'nameKey', `${path}.sessionModes.staticOptions[${String(index)}]`),
        ...(descriptionKey === undefined ? {} : { descriptionKey }),
      };
    }),
  };
}

function readOptionalJsonObjectDescriptor(
  record: Record<string, unknown>,
  key: string,
  path: string,
): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const descriptor = readRequiredRecord(value, `${path}.${String(key)}`);
  const normalized = readJsonSerializableValue(descriptor, `${path}.${String(key)}`);
  if (!isJsonObject(normalized)) {
    throw new Error(`Invalid agent UI descriptor at ${path}.${String(key)}: expected object`);
  }
  return normalized;
}

function readOptionalReleasedFlatSessionMetadataRuntimeDescriptorReaderContribution(
  record: Record<string, unknown>,
  path: string,
): ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor | undefined {
  const key = 'releasedFlatSessionMetadataRuntimeDescriptorReader';
  const value = record[key];
  if (value === undefined) return undefined;
  const contribution = readRequiredRecord(value, `${path}.${key}`);
  const kind = readRequiredString(contribution, 'kind', `${path}.${key}`);
  if (kind === 'providerRuntimeDescriptorReader') {
    const source = readOptionalString(contribution, 'source', `${path}.${key}`);
    const exportName = readOptionalString(contribution, 'exportName', `${path}.${key}`);
    if ((source === undefined) !== (exportName === undefined)) {
      throw new Error(`Invalid Agent definition at ${path}.${key}: source and exportName must be provided together`);
    }
    return {
      kind,
      agentId: readRequiredString(contribution, 'providerId', `${path}.${key}`),
      ...(source === undefined ? {} : { source, exportName }),
      generatedReader: readOptionalJsonObjectDescriptor(
        contribution,
        'generatedReader',
        `${path}.${key}`,
      ) ?? (() => {
        throw new Error(`Invalid Agent definition at ${path}.${key}.generatedReader: expected object`);
      })(),
    };
  }
  if (kind !== 'providerSessionId') {
    throw new Error(
      `Invalid Agent definition at ${path}.${key}.kind: expected providerSessionId or providerRuntimeDescriptorReader`,
    );
  }
  const runtimeHandle = readRequiredString(contribution, 'runtimeHandle', `${path}.${key}`);
  if (runtimeHandle !== 'providerSessionId') {
    throw new Error(`Invalid Agent definition at ${path}.${key}.runtimeHandle: expected providerSessionId`);
  }
  return {
    kind,
    agentId: readRequiredString(contribution, 'providerId', `${path}.${key}`),
    runtimeHandle,
  };
}

function rejectRetiredAgentRuntimeContributionsAggregate(
  value: JsonValue,
  definitionPath: string,
): void {
  if (!isRecord(value) || value.runtimeContributions === undefined) return;
  throw new Error(
    `Invalid Agent definition at ${definitionPath}.runtimeContributions: the private runtime-contribution aggregate is retired; declare each retained fact at its canonical Agent or Protocol owner`,
  );
}

function rejectRetiredProtocolExternalSessionSourceContribution(
  record: Record<string, unknown>,
  path: string,
): void {
  if (record.protocolExternalSessionSource === undefined) return;
  throw new Error(
    `Invalid agent runtime contribution at ${path}.protocolExternalSessionSource: declare external-session source schemas at manifest.contributes.agents[].surfaces.externalSession.sources[]`,
  );
}

function readOptionalAgentUiRuntimeInput(
  record: Record<string, unknown>,
  path: string,
): AgentUiDescriptor['display']['runtimeInput'] {
  const value = record.runtimeInput;
  if (value === undefined) return undefined;
  const runtimeInput = readRequiredRecord(value, `${path}.runtimeInput`);
  return {
    inFlightSteerSupported: readRequiredBoolean(
      runtimeInput,
      'inFlightSteerSupported',
      `${path}.runtimeInput`,
    ),
  };
}

function readAgentUiDescriptorExport(mod: Record<string, unknown>, descriptorPath: string): unknown {
  if ('AGENT_UI_DESCRIPTOR' in mod) return mod.AGENT_UI_DESCRIPTOR;
  if ('PLUGIN_UI_DESCRIPTOR' in mod) return mod.PLUGIN_UI_DESCRIPTOR;

  const descriptorExports = Object.entries(mod).filter(([name]) => name.endsWith('_UI_DESCRIPTOR'));
  if (descriptorExports.length === 1) {
    return descriptorExports[0]?.[1];
  }
  if (descriptorExports.length > 1) {
    throw new Error(`Expected one agent UI descriptor export in ${descriptorPath}, found ${descriptorExports.length}`);
  }
  throw new Error(`Expected AGENT_UI_DESCRIPTOR export in ${descriptorPath}`);
}

function normalizeAgentUiDescriptor(value: unknown, descriptorPath: string): AgentUiDescriptor {
  assertJsonSerializable(value);

  const root = readRequiredRecord(value, descriptorPath);
  if (root.projection !== undefined) {
    throw new Error(
      `Invalid agent UI descriptor at ${descriptorPath}.projection: projection import descriptors are not allowed; UI descriptors must be plugin.ui.v1 data-only envelopes`,
    );
  }
  const kind = readRequiredString(root, 'kind', descriptorPath);
  if (kind !== 'plugin.ui.v1') {
    throw new Error(`Invalid agent UI descriptor at ${descriptorPath}.kind: expected plugin.ui.v1`);
  }
  const display = readRequiredRecord(root.display, `${descriptorPath}.display`);
  const availability = readRequiredRecord(display.availability, `${descriptorPath}.display.availability`);
  const connectedService = readRequiredRecord(
    display.connectedService,
    `${descriptorPath}.display.connectedService`,
  );
  const permissions = readRequiredRecord(display.permissions, `${descriptorPath}.display.permissions`);
  const resume = readRequiredRecord(display.resume, `${descriptorPath}.display.resume`);
  const toolRendering = readRequiredRecord(display.toolRendering, `${descriptorPath}.display.toolRendering`);
  const picker = readRequiredRecord(display.picker, `${descriptorPath}.display.picker`);
  const avatarOverlay = readRequiredRecord(display.avatarOverlay, `${descriptorPath}.display.avatarOverlay`);
  const sessionModes = readOptionalAgentUiSessionModes(display, `${descriptorPath}.display`);
  const runtimeInput = readOptionalAgentUiRuntimeInput(display, `${descriptorPath}.display`);
  const icon = readOptionalJsonObjectDescriptor(display, 'icon', `${descriptorPath}.display`);
  const settings = readOptionalJsonObjectDescriptor(root, 'settings', descriptorPath);
  const behavior = readOptionalJsonObjectDescriptor(root, 'behavior', descriptorPath);
  const session = readOptionalJsonObjectDescriptor(root, 'session', descriptorPath);
  for (const retiredKey of [
    'providerBehaviorDescriptorId',
    'visibleMessageFilterDescriptorId',
  ] as const) {
    if (session?.[retiredKey] !== undefined) {
      throw new Error(
        `Invalid agent UI descriptor at ${descriptorPath}.session.${retiredKey}: retired compiled Session adapter ids are not public authoring declarations; use the inline session.providerBehavior or session.visibleMessages declaration`,
      );
    }
  }
  const message = readOptionalJsonObjectDescriptor(root, 'message', descriptorPath);
  const components = readOptionalJsonObjectDescriptor(root, 'components', descriptorPath);
  const assets = readOptionalJsonObjectDescriptor(root, 'assets', descriptorPath);
  const nameKey = readRequiredString(display, 'nameKey', `${descriptorPath}.display`);
  const connectedServiceLabelKey = readRequiredString(
    connectedService,
    'labelKey',
    `${descriptorPath}.display.connectedService`,
  );
  const cliGlyph = readRequiredString(picker, 'cliGlyph', `${descriptorPath}.display.picker`);
  if (
    cliGlyph.trim() !== cliGlyph
    || Array.from(cliGlyph).length < 1
    || Array.from(cliGlyph).length > 8
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(cliGlyph)
  ) {
    throw new Error(
      `Invalid agent UI descriptor at ${descriptorPath}.display.picker.cliGlyph: expected 1 to 8 Unicode code points without surrounding whitespace or control characters`,
    );
  }

  return {
    kind,
    pluginId: readRequiredString(root, 'pluginId', descriptorPath),
    agentId: readRequiredString(root, 'agentId', descriptorPath),
    version: readRequiredNumber(root, 'version', descriptorPath),
    display: {
      nameKey,
      subtitleKey: readRequiredString(display, 'subtitleKey', `${descriptorPath}.display`),
      permissionModeI18nPrefix: readRequiredString(display, 'permissionModeI18nPrefix', `${descriptorPath}.display`),
      availability: {
        experimental: readRequiredBoolean(availability, 'experimental', `${descriptorPath}.display.availability`),
      },
      connectedService: {
        serviceId: readNullableString(connectedService, 'serviceId', `${descriptorPath}.display.connectedService`),
        labelKey: connectedServiceLabelKey,
        connectRoute: readNullableString(
          connectedService,
          'connectRoute',
          `${descriptorPath}.display.connectedService`,
        ),
      },
      flavorAliases: readStringArray(display, 'flavorAliases', `${descriptorPath}.display`),
      permissions: {
        modeGroup: readRequiredString(permissions, 'modeGroup', `${descriptorPath}.display.permissions`),
        promptProtocol: readRequiredString(permissions, 'promptProtocol', `${descriptorPath}.display.permissions`),
      },
      ...(sessionModes === undefined ? {} : { sessionModes }),
      ...(runtimeInput === undefined ? {} : { runtimeInput }),
      resume: {
        uiVendorResumeIdLabelKey: readNullableString(resume, 'uiVendorResumeIdLabelKey', `${descriptorPath}.display.resume`),
        uiVendorResumeIdCopiedKey: readNullableString(resume, 'uiVendorResumeIdCopiedKey', `${descriptorPath}.display.resume`),
      },
      ...(readOptionalBoolean(display, 'localControl', `${descriptorPath}.display`) === undefined
        ? {}
        : { localControl: readOptionalBoolean(display, 'localControl', `${descriptorPath}.display`) }),
      toolRendering: {
        hideUnknownToolsByDefault: readRequiredBoolean(
          toolRendering,
          'hideUnknownToolsByDefault',
          `${descriptorPath}.display.toolRendering`,
        ),
      },
      picker: {
        iconName: readRequiredString(picker, 'iconName', `${descriptorPath}.display.picker`),
        ...(readOptionalNumber(picker, 'iconScale', `${descriptorPath}.display.picker`) === undefined
          ? {}
          : { iconScale: readOptionalNumber(picker, 'iconScale', `${descriptorPath}.display.picker`) }),
        cliGlyph,
        cliGlyphScale: readRequiredNumber(picker, 'cliGlyphScale', `${descriptorPath}.display.picker`),
        profileCompatibilityGlyphScale: readRequiredNumber(
          picker,
          'profileCompatibilityGlyphScale',
          `${descriptorPath}.display.picker`,
        ),
      },
      avatarOverlay: {
        circleScale: readRequiredNumber(avatarOverlay, 'circleScale', `${descriptorPath}.display.avatarOverlay`),
        iconScaleRatio: readRequiredNumber(avatarOverlay, 'iconScaleRatio', `${descriptorPath}.display.avatarOverlay`),
      },
      ...(icon === undefined ? {} : { icon: { assetId: readNullableString(icon, 'assetId', `${descriptorPath}.display.icon`) } }),
    },
    ...(settings === undefined ? {} : { settings }),
    ...(behavior === undefined ? {} : { behavior }),
    ...(session === undefined ? {} : { session }),
    ...(message === undefined ? {} : { message }),
    ...(components === undefined ? {} : { components }),
    ...(assets === undefined ? {} : { assets }),
  };
}

async function loadPluginAgentDefinition(repoRoot: string, pluginPackageId: string): Promise<JsonValue> {
  const definitionPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/agent/definition.ts');
  if (!existsSync(definitionPath)) {
    throw new Error(`Missing required agent definition at ${definitionPath}`);
  }

  const mod = await importTypescriptModule(definitionPath) as { AGENT_DEFINITION?: unknown };
  if (!('AGENT_DEFINITION' in mod)) {
    throw new Error(`Expected AGENT_DEFINITION export in ${definitionPath}`);
  }

  const definition = mod.AGENT_DEFINITION;
  assertJsonSerializable(definition);

  if (!isRecord(definition) || typeof definition.id !== 'string') {
    throw new Error(`Invalid AGENT_DEFINITION in ${definitionPath} (expected object with string id)`);
  }

  return normalizeAgentDefinitionForAgentsOutput(definition);
}

async function loadBuiltInLegacyConnectedAccountCompatibility(
  repoRoot: string,
  pluginPackageId: string,
): Promise<readonly BuiltInLegacyConnectedAccountCompatibilitySource[] | undefined> {
  const sourcePath = resolve(
    repoRoot,
    'packages/plugins',
    pluginPackageId,
    'src/connectedAccounts/builtInLegacyCompatibility.ts',
  );
  if (!existsSync(sourcePath)) return undefined;

  const mod = await importTypescriptModule(sourcePath) as Record<string, unknown>;
  if (
    Reflect.ownKeys(mod).length !== 1
    || !Object.prototype.hasOwnProperty.call(
      mod,
      'BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY',
    )
  ) {
    throw new Error(
      `Invalid built-in legacy Connected Account compatibility in ${sourcePath}: expected exactly BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY`,
    );
  }
  const raw = mod.BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Invalid built-in legacy Connected Account compatibility in ${sourcePath}: expected a non-empty array`,
    );
  }
  const seen = new Set<string>();
  const operationIds = new Set<string>(
    BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS,
  );
  const readPeerOperations = (
    value: unknown,
  ): BuiltInLegacyConnectedAccountPeerOperations | null => {
    if (
      !isRecord(value)
      || Reflect.ownKeys(value).some((key) =>
        typeof key !== 'string'
        || !['exactV0_2_1', 'revisionedV2V3'].includes(key))
      || Reflect.ownKeys(value).length !== 2
      || !Array.isArray(value.exactV0_2_1)
      || !Array.isArray(value.revisionedV2V3)
    ) {
      return null;
    }
    const normalize = (
      operations: unknown[],
    ): readonly BuiltInLegacyConnectedAccountOperation[] | null => {
      if (
        operations.some((operation) =>
          typeof operation !== 'string'
          || !operationIds.has(operation))
        || new Set(operations).size !== operations.length
      ) {
        return null;
      }
      return Object.freeze(
        [...operations] as BuiltInLegacyConnectedAccountOperation[],
      );
    };
    const exactV0_2_1 = normalize(value.exactV0_2_1);
    const revisionedV2V3 = normalize(value.revisionedV2V3);
    return exactV0_2_1 && revisionedV2V3
      ? Object.freeze({ exactV0_2_1, revisionedV2V3 })
      : null;
  };
  return Object.freeze(raw.map((entry, index) => {
    const peerOperations =
      isRecord(entry)
        ? readPeerOperations(entry.peerOperations)
        : null;
    if (
      !isRecord(entry)
      || Reflect.ownKeys(entry).some((key) =>
        typeof key !== 'string'
        || ![
          'legacyServiceId',
          'serviceLocalId',
          'peerOperations',
          'exactV0_2_1ReaderQuotaProjection',
          'defaultAuthenticationModeId',
          'authenticationModeByCredentialKind',
          'unsupportedAuthenticationModeByCredentialKind',
        ].includes(key))
      || typeof entry.legacyServiceId !== 'string'
      || typeof entry.serviceLocalId !== 'string'
      || peerOperations === null
      || typeof entry.exactV0_2_1ReaderQuotaProjection !== 'boolean'
      || typeof entry.defaultAuthenticationModeId !== 'string'
      || !isRecord(entry.authenticationModeByCredentialKind)
      || Reflect.ownKeys(entry.authenticationModeByCredentialKind)
        .some((kind) => kind !== 'oauth' && kind !== 'token')
      || Reflect.ownKeys(entry.authenticationModeByCredentialKind).length === 0
      || Object.values(entry.authenticationModeByCredentialKind)
        .some((modeId) => typeof modeId !== 'string'
          || modeId.length === 0
          || modeId.trim() !== modeId)
      || (
        entry.unsupportedAuthenticationModeByCredentialKind !== undefined
        && (
          !isRecord(entry.unsupportedAuthenticationModeByCredentialKind)
          || Reflect.ownKeys(entry.unsupportedAuthenticationModeByCredentialKind)
            .some((kind) => kind !== 'oauth' && kind !== 'token')
          || Reflect.ownKeys(entry.unsupportedAuthenticationModeByCredentialKind)
            .length === 0
          || Object.values(entry.unsupportedAuthenticationModeByCredentialKind)
            .some((modeId) => typeof modeId !== 'string'
              || modeId.length === 0
              || modeId.trim() !== modeId)
          || Reflect.ownKeys(entry.unsupportedAuthenticationModeByCredentialKind)
            .some((kind) =>
              Object.prototype.hasOwnProperty.call(
                entry.authenticationModeByCredentialKind,
                kind,
              ))
        )
      )
      || entry.legacyServiceId.trim() !== entry.legacyServiceId
      || entry.serviceLocalId.trim() !== entry.serviceLocalId
      || entry.defaultAuthenticationModeId.trim()
        !== entry.defaultAuthenticationModeId
      || entry.legacyServiceId.length === 0
      || entry.serviceLocalId.length === 0
      || entry.defaultAuthenticationModeId.length === 0
      || seen.has(entry.legacyServiceId)
    ) {
      throw new Error(
        `Invalid built-in legacy Connected Account compatibility entry ${index} in ${sourcePath}`,
      );
    }
    seen.add(entry.legacyServiceId);
    return Object.freeze({
      legacyServiceId: entry.legacyServiceId,
      serviceLocalId: entry.serviceLocalId,
      peerOperations,
      exactV0_2_1ReaderQuotaProjection:
        entry.exactV0_2_1ReaderQuotaProjection,
      defaultAuthenticationModeId: entry.defaultAuthenticationModeId,
      authenticationModeByCredentialKind: Object.freeze({
        ...(typeof entry.authenticationModeByCredentialKind.oauth === 'string'
          ? { oauth: entry.authenticationModeByCredentialKind.oauth }
          : {}),
        ...(typeof entry.authenticationModeByCredentialKind.token === 'string'
          ? { token: entry.authenticationModeByCredentialKind.token }
          : {}),
      }),
      unsupportedAuthenticationModeByCredentialKind: Object.freeze({
        ...(isRecord(entry.unsupportedAuthenticationModeByCredentialKind)
          && typeof entry.unsupportedAuthenticationModeByCredentialKind.oauth
            === 'string'
          ? { oauth: entry.unsupportedAuthenticationModeByCredentialKind.oauth }
          : {}),
        ...(isRecord(entry.unsupportedAuthenticationModeByCredentialKind)
          && typeof entry.unsupportedAuthenticationModeByCredentialKind.token
            === 'string'
          ? { token: entry.unsupportedAuthenticationModeByCredentialKind.token }
          : {}),
      }),
    });
  }));
}

function normalizeAgentDefinitionForAgentsOutput(definition: JsonValue): JsonValue {
  if (!isRecord(definition)) return definition;
  const legacyCliAuthorityFields = [
    'providerCliRuntime',
    'agentCliRuntime',
    'authProbeConfig',
    'localCli',
  ].filter((field) => definition[field] !== undefined);
  if (legacyCliAuthorityFields.length > 0) {
    throw new Error(
      `AGENT_DEFINITION.${legacyCliAuthorityFields.join(', AGENT_DEFINITION.')} `
      + 'is no longer accepted; use contributes.agents[].cli',
    );
  }
  return definition;
}

function readNativeAgentCliMetadata(
  manifest: JsonValue,
  agentId: string,
): JsonObject | null {
  const contributions = readManifestContributionArray(manifest, 'agents');
  const contribution = contributions.find((entry) => (
    isJsonObject(entry) && entry.id === agentId
  )) ?? (contributions.length === 1 ? contributions[0] : null);
  return contribution ? readJsonObjectProperty(contribution, 'cli') : null;
}

function readNativeAgentContributionTitle(
  manifest: JsonValue,
  agentId: string,
  pluginPackageId: string,
): string {
  const contributions = readManifestContributionArray(manifest, 'agents');
  const contribution = contributions.find((entry) => (
    isJsonObject(entry) && entry.id === agentId
  )) ?? (contributions.length === 1 ? contributions[0] : null);
  if (!contribution) {
    throw new Error(`Missing native Agent contribution for ${pluginPackageId}.${agentId}`);
  }

  if (typeof contribution.title === 'string' && contribution.title.trim().length > 0) {
    return contribution.title;
  }
  const localizedTitle = readJsonObjectProperty(contribution, 'title');
  if (localizedTitle && typeof localizedTitle.fallback === 'string' && localizedTitle.fallback.trim().length > 0) {
    return localizedTitle.fallback;
  }
  throw new Error(
    `Invalid Agent title at ${pluginPackageId}.contributes.agents.${agentId}.title: expected a non-empty string or localized fallback`,
  );
}

function projectNativeAgentCliDefinitionFacts(
  definition: JsonValue,
  manifest: JsonValue,
  pluginPackageId: string,
): JsonValue {
  if (!isJsonObject(definition) || typeof definition.id !== 'string') return definition;
  const cli = readNativeAgentCliMetadata(manifest, definition.id);
  if (!cli) {
    throw new Error(
      `Invalid ${pluginPackageId}.${definition.id}: strict native Agent CLI/auth metadata is required`,
    );
  }
  return {
    ...definition,
    cli: {
      ...cli,
      displayName: typeof cli.displayName === 'string'
        ? cli.displayName
        : readNativeAgentContributionTitle(manifest, definition.id, pluginPackageId),
    },
  };
}

function readOptionalAgentCommandSurfaceSource(
  definition: JsonValue,
  pluginPackageId: string,
): AgentCommandSurfaceSource | undefined {
  const commandSurface = readJsonObjectProperty(definition, 'commandSurface');
  if (!commandSurface) return undefined;

  const rootHelpLabel = readOptionalJsonStringProperty(commandSurface, 'rootHelpLabel') ?? undefined;
  const rootHelpDescription = readOptionalJsonStringProperty(commandSurface, 'rootHelpDescription') ?? undefined;
  const rootHelpDetail = readOptionalJsonStringProperty(commandSurface, 'rootHelpDetail') ?? undefined;
  const allowTmux = commandSurface.allowTmux;
  if (allowTmux !== undefined && typeof allowTmux !== 'boolean') {
    throw new Error(
      `Invalid AGENT_DEFINITION.commandSurface for ${pluginPackageId}: allowTmux must be boolean when present`,
    );
  }

  if (
    rootHelpLabel === undefined
    && rootHelpDescription === undefined
    && rootHelpDetail === undefined
    && allowTmux === undefined
  ) {
    return undefined;
  }

  return {
    ...(rootHelpLabel === undefined ? {} : { rootHelpLabel }),
    ...(rootHelpDescription === undefined ? {} : { rootHelpDescription }),
    ...(rootHelpDetail === undefined ? {} : { rootHelpDetail }),
    ...(allowTmux === undefined ? {} : { allowTmux }),
  };
}

function readOptionalAgentCommandPolicySource(
  definition: JsonValue,
  pluginPackageId: string,
): AgentCommandPolicySource | undefined {
  const commandPolicy = readJsonObjectProperty(definition, 'commandPolicy');
  if (!commandPolicy) return undefined;

  const daemonAutostartDefault = readOptionalJsonStringProperty(commandPolicy, 'daemonAutostartDefault') ?? undefined;
  if (
    daemonAutostartDefault !== undefined
    && daemonAutostartDefault !== 'preferLocalTui'
  ) {
    throw new Error(
      `Invalid AGENT_DEFINITION.commandPolicy for ${pluginPackageId}: daemonAutostartDefault must be 'preferLocalTui' when present`,
    );
  }

  if (daemonAutostartDefault === undefined) {
    return undefined;
  }

  return { daemonAutostartDefault };
}

function collectAgentCommandSurfaceSources(
  pluginPackages: readonly BundledPluginPackage[],
): ReadonlyMap<string, AgentCommandSurfaceSource> {
  return new Map(
    pluginPackages.flatMap((entry) => {
      const definition = entry.agentDefinition;
      if (!isJsonObject(definition)) return [];

      const agentId = typeof definition.id === 'string' ? definition.id : entry.agentId;
      if (!agentId) return [];

      const commandSurface = readOptionalAgentCommandSurfaceSource(definition, entry.pluginPackageId);
      return commandSurface ? [[agentId, commandSurface] as const] : [];
    }),
  );
}

function collectAgentCommandPolicySources(
  pluginPackages: readonly BundledPluginPackage[],
): ReadonlyMap<string, AgentCommandPolicySource> {
  return new Map(
    pluginPackages.flatMap((entry) => {
      const definition = entry.agentDefinition;
      if (!isJsonObject(definition)) return [];

      const agentId = typeof definition.id === 'string' ? definition.id : entry.agentId;
      if (!agentId) return [];

      const commandPolicy = readOptionalAgentCommandPolicySource(definition, entry.pluginPackageId);
      return commandPolicy ? [[agentId, commandPolicy] as const] : [];
    }),
  );
}

function collectBuiltInProviderContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly BuiltInProviderContributionSource[] {
  const commandSurfaceByAgentId = collectAgentCommandSurfaceSources(pluginPackages);
  const commandPolicyByAgentId = collectAgentCommandPolicySources(pluginPackages);
  const manifestAgentContributionsById = new Map<string, Readonly<{
    definition: JsonValue;
    pluginPackageId: string;
  }>>();
  for (const entry of pluginPackages) {
    for (const agentContribution of readManifestContributionArray(entry.manifest, 'agents')) {
      const agentId = readRequiredContributionId(agentContribution, 'agents', entry.pluginPackageId);
      const existing = manifestAgentContributionsById.get(agentId);
      if (existing) {
        throw new Error(
          `Duplicate bundled plugin agent contribution '${agentId}' from ${entry.pluginPackageId}; already declared by ${existing.pluginPackageId}`,
        );
      }
      manifestAgentContributionsById.set(agentId, {
        definition: agentContribution,
        pluginPackageId: entry.pluginPackageId,
      });
    }
  }
  const existingSources = dependencies.agents.getAllAgentDefinitionContracts()
    .map((definition) => {
    const providerId = definition.id as AgentId;
    const richDefinition = dependencies.agents.getAgentCatalogDefinition(providerId);
    if (!richDefinition) {
      throw new Error(`Missing built-in provider catalog definition '${definition.id}'`);
    }
    const canonicalDefinition = readJsonSerializableValue(
      definition,
      `provider.${definition.id}.definition`,
    );
    if (!isJsonObject(canonicalDefinition)) {
      throw new Error(`Invalid built-in agent definition '${definition.id}'`);
    }
    if (Object.prototype.hasOwnProperty.call(canonicalDefinition, 'providerRequirements')) {
      throw new Error(
        `Built-in agent definition '${definition.id}' must not duplicate manifest-owned providerRequirements`,
      );
    }
    const manifestSource = manifestAgentContributionsById.get(definition.id);
    let generatedDefinition: JsonObject = canonicalDefinition;
    if (manifestSource) {
      const providerRequirements = readJsonObjectProperty(manifestSource.definition, 'providerRequirements');
      if (providerRequirements) {
        generatedDefinition = {
          ...canonicalDefinition,
          providerRequirements: readJsonSerializableValue(
            providerRequirements,
            `${manifestSource.pluginPackageId}.contributes.agents.${definition.id}.providerRequirements`,
          ),
        };
      }
    }
    return {
      id: definition.id,
      definition: generatedDefinition,
      runtimeSpec: readJsonSerializableValue(
        dependencies.agents.getAgentCliRuntimeSpec(providerId),
        `provider.${definition.id}.runtimeSpec`,
      ),
      cliSubcommand: richDefinition.core.cliSubcommand,
      vendorResumeSupport: richDefinition.core.resume.vendorResume,
      ...(commandSurfaceByAgentId.has(definition.id)
        ? { commandSurface: commandSurfaceByAgentId.get(definition.id) }
        : {}),
      ...(commandPolicyByAgentId.has(definition.id)
        ? { commandPolicy: commandPolicyByAgentId.get(definition.id) }
        : {}),
    };
  });
  const existingIds = new Set(existingSources.map((source) => source.id));
  const pluginSources = collectPluginAgentContributionSources(
    pluginPackages,
    existingIds,
    commandSurfaceByAgentId,
    commandPolicyByAgentId,
  );
  return [...existingSources, ...pluginSources];
}

function collectPluginAgentContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
  existingIds: ReadonlySet<string>,
  commandSurfaceByAgentId: ReadonlyMap<string, AgentCommandSurfaceSource>,
  commandPolicyByAgentId: ReadonlyMap<string, AgentCommandPolicySource>,
): readonly BuiltInProviderContributionSource[] {
  const out: BuiltInProviderContributionSource[] = [];
  const seen = new Set<string>();

  for (const entry of pluginPackages) {
    for (const agentContribution of readManifestContributionArray(entry.manifest, 'agents')) {
      const agentId = readRequiredContributionId(agentContribution, 'agents', entry.pluginPackageId);
      if (existingIds.has(agentId)) continue;
      if (seen.has(agentId)) {
        throw new Error(`Duplicate bundled plugin agent contribution '${agentId}'`);
      }

      const richDefinition = entry.agentId === agentId && isJsonObject(entry.agentDefinition)
        ? entry.agentDefinition
        : null;
      const runtimeSpec = readPluginAgentRuntimeSpec(agentContribution, richDefinition, entry.pluginPackageId, agentId);
      const core = richDefinition ? readJsonObjectProperty(richDefinition, 'core') : null;
      const resume = core ? readJsonObjectProperty(core, 'resume') : null;

      out.push({
        id: agentId,
        definition: readJsonSerializableValue(
          agentContribution,
          `${entry.pluginPackageId}.contributes.agents.${agentId}`,
        ),
        runtimeSpec,
        cliSubcommand: readOptionalJsonStringProperty(core ?? {}, 'cliSubcommand') ?? agentId,
        vendorResumeSupport: readOptionalJsonStringProperty(resume ?? {}, 'vendorResume') ?? 'unsupported',
        ...(commandSurfaceByAgentId.has(agentId)
          ? { commandSurface: commandSurfaceByAgentId.get(agentId) }
          : {}),
        ...(commandPolicyByAgentId.has(agentId)
          ? { commandPolicy: commandPolicyByAgentId.get(agentId) }
          : {}),
      });
      seen.add(agentId);
    }
  }

  out.sort((a, b) => compareStableProviderIdOrder(a.id, b.id));
  return out;
}

function readPluginAgentRuntimeSpec(
  agentContribution: JsonValue,
  agentDefinition: JsonObject | null,
  pluginPackageId: string,
  agentId: string,
): JsonValue {
  const cli = readJsonObjectProperty(agentDefinition ?? {}, 'cli')
    ?? readJsonObjectProperty(agentContribution, 'cli');
  if (!cli) {
    throw new Error(
      `Invalid agent contribution in ${pluginPackageId}: agent '${agentId}' must project strict native CLI/auth metadata`,
    );
  }
  const normalized = normalizeJsonSerializableValue(cli, [
    pluginPackageId,
    'contributes',
    'agents',
    agentId,
    'cli',
  ]);
  if (!isJsonObject(normalized)) throw new Error(`Invalid native CLI metadata for ${pluginPackageId}.${agentId}`);
  return projectNativeCliMetadataToRuntimeSpec(normalized, agentId);
}

function projectNativeCliMetadataToRuntimeSpec(
  cli: JsonObject,
  agentId: string,
): JsonObject {
  const executable = readJsonObjectProperty(cli, 'executable');
  const install = readJsonObjectProperty(cli, 'install');
  const manualInstall = readJsonObjectProperty(install ?? {}, 'manual');
  if (!executable || !install || !manualInstall) {
    throw new Error(`Invalid native CLI metadata for ${agentId}: executable and install metadata are required`);
  }

  const binaryName = readOptionalJsonStringProperty(executable, 'binaryName');
  const sourcePreferenceDefault = readOptionalJsonStringProperty(executable, 'sourcePreference');
  const manualInstallKind = readOptionalJsonStringProperty(manualInstall, 'kind');
  if (!binaryName || !sourcePreferenceDefault || !manualInstallKind) {
    throw new Error(`Invalid native CLI metadata for ${agentId}: executable and manual-install facts are required`);
  }

  return {
    id: agentId,
    title: readOptionalJsonStringProperty(cli, 'displayName') ?? agentId,
    binaryName,
    ...(executable.alternativeBinaryNames !== undefined
      ? { alternativeBinaryNames: executable.alternativeBinaryNames }
      : {}),
    ...(executable.alternativeBinaryFallbackEnabledEnvVar !== undefined
      ? { alternativeBinaryFallbackEnabledEnvVar: executable.alternativeBinaryFallbackEnabledEnvVar }
      : {}),
    ...(executable.knownUserBinDirSuffixes !== undefined
      ? { knownUserBinDirSuffixes: executable.knownUserBinDirSuffixes }
      : {}),
    ...(executable.systemCommandResolutionStrategy !== undefined
      ? { systemCommandResolutionStrategy: executable.systemCommandResolutionStrategy }
      : {}),
    sourcePreferenceDefault,
    managedInstall: install.managed ?? null,
    manualInstallKind,
    manualInstallRecipes: manualInstallKind === 'none'
      ? null
      : (manualInstall.recipes ?? null),
    acceptsJavaScriptFileOverride: executable.acceptsJavaScriptFileOverride ?? false,
    ...(install.recommendationOrder !== undefined
      ? { setupRecommendation: { order: install.recommendationOrder } }
      : {}),
    ...(install.guideUrl !== undefined ? { installGuideUrl: install.guideUrl } : {}),
    ...(install.docsUrl !== undefined ? { docsUrl: install.docsUrl } : {}),
  };
}

function collectBuiltInBackendContributionSources(
  dependencies: GeneratorWorkspaceDependencies,
): readonly BuiltInBackendContributionSource[] {
  const backendCatalogDefinitionsById = new Map(
    dependencies.agents.getAllBackendCatalogDefinitions()
      .map((definition) => [definition.id, definition] as const),
  );
  return dependencies.agents.getAllBackendDefinitionContracts().map((definition) => {
    const backendId = definition.id as AgentId;
    const richDefinition = backendCatalogDefinitionsById.get(backendId);
    if (!richDefinition) {
      throw new Error(`Missing built-in backend catalog definition '${definition.id}'`);
    }
    return {
      id: definition.id,
      agentId: definition.agentId,
      definition: readJsonSerializableValue(definition, `backend.${definition.id}.definition`),
      runtimeKind: richDefinition.engine?.defaultRuntimeKind ?? 'native',
    };
  });
}

async function loadPluginAgentUiDescriptor(
  repoRoot: string,
  pluginPackageId: string,
): Promise<AgentUiDescriptor | undefined> {
  const descriptorPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/ui/descriptor.ts');
  if (!existsSync(descriptorPath)) return undefined;

  const mod = await importTypescriptModule(descriptorPath) as Record<string, unknown>;
  return normalizeAgentUiDescriptor(readAgentUiDescriptorExport(mod, descriptorPath), descriptorPath);
}

async function loadPluginAgentPredecessorMessageMetaWriter(
  repoRoot: string,
  pluginPackageId: string,
  packageName: string,
  agentId: string,
): Promise<AgentPredecessorMessageMetaWriterImportSource | undefined> {
  // This is not an extension convention. Claude is the sole observed
  // predecessor metadata consumer; adding another writer needs its own
  // provenance and generator change instead of silently widening this bridge.
  if (pluginPackageId !== 'claude' || agentId !== 'claude') return undefined;
  const predecessorMessageMetaPath = resolve(
    repoRoot,
    'packages/plugins',
    pluginPackageId,
    'src/ui/predecessorMessageMeta.ts',
  );
  if (!existsSync(predecessorMessageMetaPath)) return undefined;

  const exportName = `${toAgentConstPrefix(agentId)}_PREDECESSOR_MESSAGE_META_WRITER`;
  const source = readFileSync(predecessorMessageMetaPath, 'utf8');
  const exportPattern = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b`);
  if (!exportPattern.test(source)) return undefined;
  return {
    importName: exportName,
    importPath: `${packageName}/ui/predecessor-message-meta`,
  };
}

const PLUGIN_PROMPT_ASSET_EXPORT_NAME = 'PLUGIN_PROMPT_ASSET_DESCRIPTORS';

function assertPluginPromptAssetAdapterDescriptor(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Invalid prompt asset adapter descriptor ${path}: expected object`);
  }
  if (value.adapterKind !== 'markdownDoc' && value.adapterKind !== 'skillMd') {
    throw new Error(`Invalid prompt asset adapter descriptor ${path}.adapterKind`);
  }
  for (const key of [
    'assetTypeId',
    'providerId',
    'title',
    'description',
    'projectRootDisplayPath',
    'userRootDisplayPath',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      throw new Error(`Invalid prompt asset adapter descriptor ${path}.${key}: expected non-empty string`);
    }
  }
  for (const key of ['projectRootPath', 'userRootPath'] as const) {
    if (!Array.isArray(value[key]) || value[key].some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error(`Invalid prompt asset adapter descriptor ${path}.${key}: expected string array`);
    }
  }
  if (value.capabilities !== undefined) {
    assertJsonSerializable(value.capabilities, [path, 'capabilities']);
  }
  if (value.skillNamePattern !== undefined && !(value.skillNamePattern instanceof RegExp)) {
    throw new Error(`Invalid prompt asset adapter descriptor ${path}.skillNamePattern: expected RegExp`);
  }
}

async function loadPluginPromptAssetContributions(
  repoRoot: string,
  pluginPackageId: string,
  packageName: string,
): Promise<PromptAssetContributionSource | undefined> {
  const contributionPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/agent/promptAssets/index.ts');
  if (!existsSync(contributionPath)) return undefined;

  const mod = await importTypescriptModule(contributionPath) as Record<string, unknown>;
  const rawContributions = mod[PLUGIN_PROMPT_ASSET_EXPORT_NAME];
  if (!Array.isArray(rawContributions)) {
    throw new Error(
      `Expected ${PLUGIN_PROMPT_ASSET_EXPORT_NAME} array export in ${contributionPath}`,
    );
  }
  for (const [index, contribution] of rawContributions.entries()) {
    assertPluginPromptAssetAdapterDescriptor(contribution, `${pluginPackageId}[${index}]`);
  }

  return {
    importName: `${toAgentConstPrefix(pluginPackageId)}_PROMPT_ASSET_DESCRIPTORS`,
    importPath: `${packageName}/agent/promptAssets`,
    pluginPackageId,
  };
}

function normalizePluginManifest(
  rawManifest: unknown,
  manifestPath: string,
  parser: BundledPluginManifestParser,
): PluginManifestJson {
  const ingestion = parser.ingestPluginManifestV2(rawManifest);
  if (!ingestion.ok) {
    throw new Error(`Invalid PLUGIN_MANIFEST in ${manifestPath}: ${ingestion.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
  }
  const manifest = ingestion.manifest;
  if (!isRecord(manifest) || typeof manifest.id !== 'string' || !manifest.id.startsWith('happier.')) {
    throw new Error(
      `Invalid PLUGIN_MANIFEST in ${manifestPath}: bundled plugins must use a canonical first-party plugin owner id under happier.*`,
    );
  }

  return manifest;
}

/**
 * Reads one bundled plugin's authored manifest. Every first-party package —
 * voice included — is authored through the plugin authoring API, so the manifest
 * is computed rather than a static literal and is evaluated here in an isolated
 * child process. The no-execute contract belongs to installed discovery, which
 * reads the packed `.happier-plugin/plugin.json` this pack step produces.
 */
async function loadPluginManifest(
  repoRoot: string,
  pluginPackageId: string,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<PluginManifestJson> {
  const manifestPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/manifest.ts');
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing required plugin manifest for shippable plugin package ${pluginPackageId}: ${manifestPath}`);
  }

  const mod = await importTypescriptModule(manifestPath) as { PLUGIN_MANIFEST?: unknown };
  if (!('PLUGIN_MANIFEST' in mod)) {
    throw new Error(`Expected PLUGIN_MANIFEST export in ${manifestPath}`);
  }
  return normalizePluginManifest(mod.PLUGIN_MANIFEST, manifestPath, dependencies.protocol);
}

/**
 * Reads the shipped manifest bytes through the same Protocol ingress used for
 * installed plugins. Generated declaration projections consume this normalized
 * JSON rather than importing a plugin's authored manifest module.
 */
function readCommittedBundledPluginManifest(
  packageRoot: string,
  packageName: string,
  parser: BundledPluginManifestParser,
): BundledPluginManifestJson {
  const manifestPath = resolve(packageRoot, BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing bundled plugin manifest artifact for '${packageName}': ${manifestPath}. `
      + 'Run the explicit bundled-plugin publisher before aggregate validation.',
    );
  }
  let manifest: BundledPluginManifestJson;
  try {
    manifest = normalizePluginManifest(readFileSync(manifestPath), manifestPath, parser);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid bundled plugin manifest artifact for '${packageName}': ${detail}`);
  }
  assertNoBundledAgentManifestUiBehavior(manifest, packageName);
  return manifest;
}

/**
 * `contributes.agents[].ui` is the runtime channel an *installed* Agent uses to
 * reach the client's behavior interpreter. The client resolves every bundled
 * Agent id from its build-time `src/ui/descriptor.ts` projection instead, so a
 * block declared here would be carried through the projection and then silently
 * dropped. Reject it where every bundled manifest enters the generator.
 */
function assertNoBundledAgentManifestUiBehavior(
  manifest: BundledPluginManifestJson,
  packageName: string,
): void {
  for (const agentContribution of readManifestContributionArray(manifest, 'agents')) {
    if (!isJsonObject(agentContribution) || agentContribution.ui === undefined) continue;
    const agentId = typeof agentContribution.id === 'string' ? agentContribution.id : '<unknown>';
    throw new Error(
      `Invalid bundled Agent contribution at ${packageName}.contributes.agents.${agentId}.ui: `
      + 'a bundled Agent declares its client UI behavior in src/ui/descriptor.ts, '
      + 'and the client never reads manifest ui for a bundled Agent id',
    );
  }
}

async function synchronizeSerializedPluginManifest(params: Readonly<{
  packageRoot: string;
  manifest: PluginManifestJson;
  mode: Mode;
}>): Promise<void> {
  const manifestSerializer = await loadPluginManifestSerializerModule();
  const serializedManifest = manifestSerializer.serializeCanonicalPluginManifest(params.manifest);
  const manifestPath = resolve(params.packageRoot, BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH);
  if (params.mode === 'check') {
    assertGeneratedOutputMatches(manifestPath, serializedManifest);
    return;
  }
  writeFileAtomic(manifestPath, serializedManifest);
}

function manifestDeclaresAgentRuntime(
  manifest: JsonValue,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  if (!isRecord(manifest)) return false;

  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return false;
  return Array.isArray(contributes.agents) && contributes.agents.some(
    (definition) => !isProviderlessReviewExecutionRunBackendContribution(
      definition as JsonValue,
      dependencies,
    ),
  );
}

function manifestRequiresSessionRunnerFactory(
  manifest: PluginManifestJson,
  dependencies: GeneratorWorkspaceDependencies,
): boolean {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return false;
  return dependencies.protocol
    .derivePluginDaemonContributionRegistrationRights(contributes)
    .some((right) => (
      right.family === 'agents'
      && right.requiredFields?.includes('sessionRunnerFactory') === true
    ));
}

function manifestDeclaresManagedProviderRuntime(manifest: PluginManifestJson): boolean {
  return readManifestContributionArray(manifest, 'providers').some((definition) => (
    isJsonObject(definition)
    && isJsonObject(definition.managedRuntime)
    && definition.managedRuntime.kind === 'managed'
  ));
}

function manifestDeclaresDaemonEntrypoint(manifest: JsonValue): boolean {
  const entrypoints = readJsonObjectProperty(manifest, 'entrypoints');
  return typeof entrypoints?.daemon === 'string' && entrypoints.daemon.trim().length > 0;
}

function sha256Digest(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeBundledArtifactRelativePath(packageRoot: string, path: string): string {
  const relativePath = relative(packageRoot, path).split(sep).join('/');
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || relativePath.includes('\\')
    || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Bundled artifact path escapes package root: ${path}`);
  }
  return relativePath;
}

function comparePortablePathCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectBundledArtifactFiles(
  packageRoot: string,
  packageFileEntries: readonly string[],
  installedBytesByRelativePath: ReadonlyMap<string, Uint8Array> = new Map(),
): readonly BundledFirstPartySourceArtifactIntegrityFile[] {
  const files = new Map<string, BundledFirstPartySourceArtifactIntegrityFile>();
  const visit = (path: string): void => {
    const relativePath = normalizeBundledArtifactRelativePath(packageRoot, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Bundled artifact cannot contain symbolic link '${relativePath}'`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => (
        comparePortablePathCodeUnits(left.name, right.name)
      ))) {
        visit(resolve(path, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Bundled artifact contains unsupported file type '${relativePath}'`);
    // TypeScript's incremental compiler cache is not a shipped runtime input.
    // Binding it would let an otherwise byte-identical rebuild disable the
    // plugin even though every executable and declared resource stayed exact.
    if (relativePath.endsWith('.tsbuildinfo')) return;
    const bytes = installedBytesByRelativePath.get(relativePath) ?? readFileSync(path);
    files.set(relativePath, Object.freeze({
      relativePath,
      byteLength: bytes.byteLength,
      digest: sha256Digest(bytes),
    }));
  };
  for (const entry of packageFileEntries) {
    if (
      !entry
      || entry.includes('\\')
      || entry.startsWith('/')
      || entry.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || /[*?{}[\]]/u.test(entry)
    ) {
      throw new Error(`Bundled artifact package files entry must be an exact portable path: '${entry}'`);
    }
    const path = resolve(packageRoot, entry);
    if (!existsSync(path)) throw new Error(`Bundled artifact package file is missing: '${entry}'`);
    visit(path);
  }
  return Object.freeze([...files.values()].sort((left, right) => (
    comparePortablePathCodeUnits(left.relativePath, right.relativePath)
  )));
}

function createBundledPluginSourceArtifactIntegrity(params: Readonly<{
  packageRoot: string;
  packageJson: Readonly<Record<string, unknown>>;
  dependencies: GeneratorWorkspaceDependencies;
}>): BundledFirstPartySourceArtifactIntegrity {
  const packageName = readRequiredString(params.packageJson, 'name', 'bundled package.json');
  const stagingRoot = mkdtempSync(join(tmpdir(), 'happier-bundled-plugin-source-artifact-'));
  const stagedPackageRoot = resolve(stagingRoot, 'package');
  try {
    // The pack-time inventory must bind the exact tree that publication later
    // verifies. Reuse the workspace bundler's copy and package-json
    // normalization owner instead of reimplementing its file selection here.
    params.dependencies.cliCommonWorkspaces.bundleWorkspacePackage({
      packageName,
      srcDir: params.packageRoot,
      destDir: stagedPackageRoot,
    });
    return Object.freeze({
      packageName,
      files: collectBundledArtifactFiles(
        stagedPackageRoot,
        readdirSync(stagedPackageRoot, { withFileTypes: true })
          .map((entry) => entry.name)
          .sort(comparePortablePathCodeUnits),
      ),
    });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function normalizeDeclaredBundledPackagePath(value: string, label: string): string {
  const normalized = value.replace(/^\.\//u, '');
  if (
    !normalized
    || value.includes('\\')
    || value.startsWith('/')
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Bundled artifact ${label} must be an exact portable package path: '${value}'`);
  }
  return normalized;
}

function readBundledPackageRootExport(packageJson: Readonly<Record<string, unknown>>): string | undefined {
  if (packageJson.exports === undefined) return undefined;
  let rootExport: unknown = packageJson.exports;
  if (isRecord(rootExport) && Object.hasOwn(rootExport, '.')) rootExport = rootExport['.'];
  if (isRecord(rootExport)) rootExport = rootExport.default;
  if (typeof rootExport !== 'string') {
    throw new Error('Immutable bundled package must declare one exact default package root export');
  }
  return normalizeDeclaredBundledPackagePath(rootExport, 'package root export');
}

function resolveBundledPackageEntryRelativePath(
  packageJson: Readonly<Record<string, unknown>>,
  pluginId: string,
): string {
  const mainRelativePath = typeof packageJson.main === 'string'
    ? normalizeDeclaredBundledPackagePath(packageJson.main, 'main entry')
    : undefined;
  const packageRootExport = readBundledPackageRootExport(packageJson);
  if (mainRelativePath && packageRootExport && mainRelativePath !== packageRootExport) {
    throw new Error(
      `Bundled package '${pluginId}' package root export must match its main and daemon entry`,
    );
  }
  return packageRootExport ?? mainRelativePath ?? 'dist/index.js';
}

const BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH = '.happier-plugin/plugin.json';

/**
 * The directory every bundled plugin's TypeScript project emits into
 * (`packages/plugins/*\/tsconfig.json#compilerOptions.outDir`, and the directory
 * `scripts/workspaces/buildTypeScriptPackageDist.mjs` renames away wholesale when it
 * promotes a staged build). The publisher below installs the plugin's daemon runtime
 * into the package tree too, so any daemon entry declared inside this directory would
 * give one path two producers: a compiler emit replaces the multi-megabyte bundle with a
 * re-export module, and a staged-build promotion deletes the sibling chunk directory.
 */
const BUNDLED_PLUGIN_COMPILER_OUTPUT_DIR = 'dist';

function assertBundledDaemonEntryOutsideCompilerOutput(params: Readonly<{
  pluginId: string;
  daemonRelativePath: string;
}>): void {
  if (
    params.daemonRelativePath === BUNDLED_PLUGIN_COMPILER_OUTPUT_DIR
    || params.daemonRelativePath.startsWith(`${BUNDLED_PLUGIN_COMPILER_OUTPUT_DIR}/`)
  ) {
    throw new Error(
      `Bundled package '${params.pluginId}' daemon entry '${params.daemonRelativePath}' must live outside `
      + `the TypeScript output directory '${BUNDLED_PLUGIN_COMPILER_OUTPUT_DIR}/': the compiler and this `
      + 'publisher would both own it',
    );
  }
}

function bundledPackageFileEntryCoversPath(entry: string, relativePath: string): boolean {
  const normalized = normalizeDeclaredBundledPackagePath(entry, 'package files entry');
  return normalized === relativePath || relativePath.startsWith(`${normalized}/`);
}

function resolveBundledDaemonChunksRelativePath(daemonRelativePath: string): string {
  return `${dirname(daemonRelativePath).replaceAll('\\', '/')}/.happier-chunks`
    .replace(/^\.\//u, '');
}

/**
 * Every path this publisher installs into the plugin package tree. The daemon runtime
 * is not one file: staging emits the activation bundle, a `.happier-chunks/` directory
 * that exists only when the bundle is code-split, and one leaf per session-runner
 * factory at an author-declared relative path — all under the daemon entry's directory.
 * Selecting that directory covers the whole published set without naming a chunk
 * directory that a single-file bundle never produces. A daemon at the package root has
 * no such directory, so only the entry itself is required there.
 */
function bundledPluginPublishedPackagePaths(
  daemonRelativePath: string | null,
): readonly string[] {
  if (daemonRelativePath === null) return [BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH];
  const daemonDirectory = dirname(daemonRelativePath).replaceAll('\\', '/');
  const daemonSelection = daemonDirectory === '.' ? daemonRelativePath : daemonDirectory;
  // A bundled plugin publishes its daemon into the same reserved directory as its
  // canonical manifest, so that one entry already selects both.
  return bundledPackageFileEntryCoversPath(daemonSelection, BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH)
    ? [daemonSelection]
    : [BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH, daemonSelection];
}

function addBundledPluginPublishedPathsToPackageFiles(
  packageFiles: readonly string[],
  publishedPaths: readonly string[],
): readonly string[] {
  const missing = publishedPaths.filter((publishedPath) => !packageFiles.some(
    (entry) => bundledPackageFileEntryCoversPath(entry, publishedPath),
  ));
  if (missing.length === 0) return packageFiles;
  const packageJsonIndex = packageFiles.indexOf('package.json');
  if (packageJsonIndex < 0) {
    return Object.freeze([...packageFiles, ...missing]);
  }
  return Object.freeze([
    ...packageFiles.slice(0, packageJsonIndex),
    ...missing,
    ...packageFiles.slice(packageJsonIndex),
  ]);
}

async function readBundledSessionRunnerFactories(params: Readonly<{
  packageRoot: string;
  manifest: PluginManifestJson;
}>): Promise<Awaited<ReturnType<
  PluginRuntimeStagingSourceModule['evaluatePluginAuthorRuntimeStagingSource']
>>['sessionRunnerFactories']> {
  const sourceEntryPath = resolve(params.packageRoot, 'src', 'index.ts');
  const manifestSerializer = await loadPluginManifestSerializerModule();
  const { source } = await loadPluginAuthorRuntimeSupportModules();
  const runtimeSource = await source.evaluatePluginAuthorRuntimeStagingSource({
    locator: sourceEntryPath,
    rootPath: params.packageRoot,
    immutableGenerationId: `bundled-generator-${sha256Digest(readFileSync(sourceEntryPath))}`,
    authority: {
      kind: 'bundled_first_party',
      pluginId: params.manifest.id,
      packageRootPath: params.packageRoot,
    },
  });
  const staticCanonicalManifest = manifestSerializer.serializeCanonicalPluginManifest(params.manifest);
  if (runtimeSource.evaluated.canonicalManifestJson !== staticCanonicalManifest) {
    throw new Error(
      `Bundled plugin source manifest differs from the statically projected canonical manifest: '${params.manifest.id}'`,
    );
  }
  return runtimeSource.sessionRunnerFactories;
}

async function stageBundledPluginDaemonRuntime(params: Readonly<{
  packageRoot: string;
  manifest: PluginManifestJson;
  mode: Mode;
  scope: GeneratorScope;
  dependencies: GeneratorWorkspaceDependencies;
  getCanonicalWorkspacePackageRoots: () => Readonly<Record<string, string>> | undefined;
}>): Promise<ReadonlyMap<string, Buffer>> {
  const declaredDaemon = readJsonObjectProperty(params.manifest, 'entrypoints')?.daemon;
  if (typeof declaredDaemon !== 'string') return new Map();
  const daemonRelativePath = normalizeDeclaredBundledPackagePath(
    declaredDaemon,
    'daemon entry',
  );
  assertBundledDaemonEntryOutsideCompilerOutput({
    pluginId: params.manifest.id,
    daemonRelativePath,
  });
  const sourceEntryPath = resolve(params.packageRoot, 'src', 'index.ts');
  if (!existsSync(sourceEntryPath) || !lstatSync(sourceEntryPath).isFile()) {
    throw new Error(
      `Bundled executable package '${params.manifest.id}' must provide src/index.ts for canonical runtime staging`,
    );
  }

  if (!shouldEvaluateBundledRuntimeSource(params.scope)) {
    // Returning no override makes the caller measure this package's artifact
    // integrity from the installed bytes. Re-staging here would inline the
    // current shared workspace output into every bundle and turn a plugin
    // question into a whole-repo build-determinism question; `--scope all`
    // owns that one.
    return new Map();
  }
  const sessionRunnerFactories = await readBundledSessionRunnerFactories(params);
  const stagingRoot = mkdtempSync(resolve(tmpdir(), 'happier-first-party-runtime-stage-'));
  try {
    const { staging } = await loadPluginAuthorRuntimeSupportModules();
    const { stagePluginDaemonRuntime } = staging;
    const canonicalWorkspacePackageRoots = params.getCanonicalWorkspacePackageRoots();
    const staged = await stagePluginDaemonRuntime({
      sourceRootPath: params.packageRoot,
      sourceEntryPath,
      stagedRootPath: stagingRoot,
      daemonEntrypoint: declaredDaemon,
      sessionRunnerFactories,
      ...(canonicalWorkspacePackageRoots ? { canonicalWorkspacePackageRoots } : {}),
    });
    const stagedBytes = new Map<string, Buffer>(staged.outputRelativePaths.map((relativePath) => [
      relativePath,
      readFileSync(resolve(stagingRoot, ...relativePath.split('/'))),
    ]));
    const chunksRelativePath = resolveBundledDaemonChunksRelativePath(daemonRelativePath);
    const expectedChunkPaths = staged.outputRelativePaths
      .filter((relativePath) => relativePath.startsWith(`${chunksRelativePath}/`))
      .sort(comparePortablePathCodeUnits);
    const installedChunksPath = resolve(
      params.packageRoot,
      ...chunksRelativePath.split('/'),
    );
    if (params.mode === 'check') {
      for (const [relativePath, expectedBytes] of stagedBytes) {
        const installedPath = resolve(params.packageRoot, ...relativePath.split('/'));
        const installedBytes = existsSync(installedPath) ? readFileSync(installedPath) : null;
        if (installedBytes === null || !installedBytes.equals(expectedBytes)) {
          throw new Error(
            `Bundled plugin runtime artifact differs: ${installedPath} `
            + `(expected ${sha256Digest(expectedBytes)} ${expectedBytes.byteLength} bytes, `
            + `received ${installedBytes === null ? 'missing' : `${sha256Digest(installedBytes)} ${installedBytes.byteLength} bytes`})`,
          );
        }
      }
      const installedChunkPaths = existsSync(installedChunksPath)
        ? collectBundledArtifactFiles(
            params.packageRoot,
            [chunksRelativePath],
            new Map(),
          ).map((file) => file.relativePath)
        : [];
      if (JSON.stringify(installedChunkPaths) !== JSON.stringify(expectedChunkPaths)) {
        throw new Error(
          `Bundled plugin runtime chunk inventory differs: ${installedChunksPath}`,
        );
      }
    } else {
      rmSync(installedChunksPath, { recursive: true, force: true });
      for (const [relativePath, bytes] of stagedBytes) {
        const installedPath = resolve(params.packageRoot, ...relativePath.split('/'));
        mkdirSync(dirname(installedPath), { recursive: true });
        writeFileSync(installedPath, bytes);
      }
    }
    return stagedBytes;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function createBundledImmutableArtifactSource(params: Readonly<{
  packageRoot: string;
  packageJson: Readonly<Record<string, unknown>>;
  manifest: PluginManifestJson;
  mode: Mode;
  scope: GeneratorScope;
  dependencies: GeneratorWorkspaceDependencies;
  getCanonicalWorkspacePackageRoots: () => Readonly<Record<string, string>> | undefined;
}>): Promise<BundledImmutableArtifactSource | undefined> {
  const resources = readManifestContributionArray(params.manifest, 'resources');
  const requiresImmutableArtifact = requiresBundledImmutableArtifact({
    hasDaemonEntrypoint: manifestDeclaresDaemonEntrypoint(params.manifest),
    hasResources: resources.length > 0,
    requiresSessionRunnerFactory: manifestRequiresSessionRunnerFactory(
      params.manifest,
      params.dependencies,
    ),
    hasManagedProviderRuntime: manifestDeclaresManagedProviderRuntime(params.manifest),
    hasConnectedAccountDescriptors: readManifestContributionArray(
      params.manifest,
      'connectedAccountDescriptors',
    ).length > 0,
  });
  if (!requiresImmutableArtifact) {
    return undefined;
  }
  const packageFiles = params.packageJson.files;
  if (!Array.isArray(packageFiles) || packageFiles.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Immutable bundled package '${params.manifest.id}' must declare an exact package.json files inventory`);
  }
  const declaredDaemonEntry = readJsonObjectProperty(params.manifest, 'entrypoints')?.daemon;
  const daemonRelativePath = typeof declaredDaemonEntry === 'string'
    ? normalizeDeclaredBundledPackagePath(declaredDaemonEntry, 'daemon entry')
    : null;
  if (daemonRelativePath) {
    assertBundledDaemonEntryOutsideCompilerOutput({
      pluginId: params.manifest.id,
      daemonRelativePath,
    });
  }
  const publishedPackagePaths = bundledPluginPublishedPackagePaths(daemonRelativePath);
  const packageFilesWithManifest = addBundledPluginPublishedPathsToPackageFiles(
    packageFiles as readonly string[],
    publishedPackagePaths,
  );
  const packageJsonForArtifact = packageFilesWithManifest === packageFiles
    ? params.packageJson
    : { ...params.packageJson, files: packageFilesWithManifest };
  if (packageFilesWithManifest !== packageFiles) {
    if (params.mode === 'check') {
      throw new Error(
        `Immutable bundled package '${params.manifest.id}' must ship `
        + publishedPackagePaths.map((publishedPath) => `'${publishedPath}'`).join(', '),
      );
    }
    writeFileAtomic(
      resolve(params.packageRoot, 'package.json'),
      `${JSON.stringify(packageJsonForArtifact, null, 2)}\n`,
    );
  }
  const manifestSerializer = await loadPluginManifestSerializerModule();
  const installedManifestBytes = Buffer.from(
    manifestSerializer.serializeCanonicalPluginManifest(params.manifest),
    'utf8',
  );
  const installedManifestPath = resolve(
    params.packageRoot,
    BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH,
  );
  if (params.mode === 'check') {
    if (
      !existsSync(installedManifestPath)
      || !readFileSync(installedManifestPath).equals(installedManifestBytes)
    ) {
      throw new Error(
        `Bundled plugin manifest artifact differs: ${installedManifestPath}`,
      );
    }
  } else {
    writeFileAtomic(installedManifestPath, installedManifestBytes.toString('utf8'));
  }
  const selectedEntries = [...new Set([
    ...packageFilesWithManifest,
    // The bundled-workspace installer copies this package-root file when it
    // exists even when package.json#files omits it. Bind the inventory to the
    // installed tree rather than only to the explicit manifest selection.
    ...(existsSync(resolve(params.packageRoot, 'README.md')) ? ['README.md'] : []),
    'package.json',
  ])];
  const installedPackageJsonBytes = Buffer.from(
    `${JSON.stringify(
      params.dependencies.cliCommonWorkspaces.sanitizeBundledPackageJson(packageJsonForArtifact),
      null,
      2,
    )}\n`,
    'utf8',
  );
  const packageEntryRelativePath = resolveBundledPackageEntryRelativePath(
    params.packageJson,
    params.manifest.id,
  );
  const stagedRuntimeFiles = await stageBundledPluginDaemonRuntime({
    packageRoot: params.packageRoot,
    manifest: params.manifest,
    mode: params.mode,
    scope: params.scope,
    dependencies: params.dependencies,
    getCanonicalWorkspacePackageRoots: params.getCanonicalWorkspacePackageRoots,
  });
  const installedFileOverrides = new Map<string, Buffer>([
    ['package.json', installedPackageJsonBytes],
    ...stagedRuntimeFiles,
  ]);
  const files = collectBundledArtifactFiles(
    params.packageRoot,
    selectedEntries,
    installedFileOverrides,
  );
  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  const packageJsonFile = fileByPath.get('package.json');
  if (!packageJsonFile) throw new Error(`Bundled package '${params.manifest.id}' artifact omits package.json`);
  const installedManifestFile = fileByPath.get(BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH);
  if (!installedManifestFile) {
    throw new Error(
      `Bundled package '${params.manifest.id}' artifact omits '${BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH}'`,
    );
  }
  if (!fileByPath.has(packageEntryRelativePath)) {
    throw new Error(`Bundled package '${params.manifest.id}' artifact omits package root export '${packageEntryRelativePath}'`);
  }
  if (daemonRelativePath && !fileByPath.has(daemonRelativePath)) {
    throw new Error(`Bundled package '${params.manifest.id}' artifact omits daemon entry '${daemonRelativePath}'`);
  }
  for (const [index, resource] of resources.entries()) {
    if (!isJsonObject(resource)) {
      throw new Error(`Bundled package '${params.manifest.id}' has invalid resource path at index ${String(index)}`);
    }
    if (params.dependencies.protocol.isDynamicPluginResourceContributionV2(resource)) continue;
    if (typeof resource.path !== 'string') {
      throw new Error(`Bundled package '${params.manifest.id}' has invalid resource path at index ${String(index)}`);
    }
    const resourcePath = resource.path.replace(/^\.\//u, '');
    if (!fileByPath.has(resourcePath)) {
      throw new Error(`Bundled package '${params.manifest.id}' artifact omits resource '${resourcePath}'`);
    }
  }
  // Publisher- and pack-time code compare this separately generated source
  // artifact integrity payload. The runtime generation record below
  // deliberately carries only structural generation facts.
  return Object.freeze({
    packageEntryRelativePath,
    // The package root export stays the compiler's `dist/index.js` so `require.resolve`
    // identity and workspace type resolution keep working. The activation module the
    // daemon actually imports is this separately published bundle, which lives outside
    // the compiler's output directory.
    daemonEntryRelativePath: daemonRelativePath,
    sourceArtifactIntegrity: Object.freeze({
      packageName: readRequiredString(params.packageJson, 'name', 'bundled package.json'),
      files,
    }),
    record: Object.freeze({
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: params.manifest.id,
      // The generated artifact publication below assigns the opaque immutable
      // identity for its publication occurrence. Pack-time integrity remains a
      // separate verifier input and never decides whether this identity rotates.
      // This unpublished construction record never reaches the runtime store.
      immutableGenerationId: 'bundled-unpublished',
      createdAtMs: 0,
      files: files.map(({ relativePath, byteLength }) => Object.freeze({ relativePath, byteLength })),
      manifestRelativePath: BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH,
    }),
  });
}

function bundledGenerationIdentityKey(packageName: string, pluginId: string): string {
  return JSON.stringify([packageName, pluginId]);
}

function readGeneratedJsonExportLiteral(
  source: string,
  exportName: string,
  sourcePath: string,
): unknown | undefined {
  const prefix = `export const ${exportName} = Object.freeze(`;
  const start = source.indexOf(prefix);
  if (start === -1) return undefined;
  const end = source.indexOf(' satisfies ', start + prefix.length);
  if (end === -1) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: missing '${exportName}' type boundary`);
  }
  try {
    return JSON.parse(source.slice(start + prefix.length, end)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: cannot parse '${exportName}'${detail}`);
  }
}

function readPriorBundledSourceArtifactIntegrity(
  value: unknown,
  sourcePath: string,
  index: number,
): BundledFirstPartySourceArtifactIntegrity {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} must be an object`);
  }
  const packageName = value.packageName;
  if (typeof packageName !== 'string' || packageName.trim().length === 0) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} has no packageName`);
  }
  if (!Array.isArray(value.files)) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} has no files`);
  }
  const files = value.files.map((file, fileIndex) => {
    if (!isRecord(file) || Array.isArray(file)) {
      throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} file ${String(fileIndex)} must be an object`);
    }
    const relativePath = file.relativePath;
    const byteLength = file.byteLength;
    const digest = file.digest;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} file ${String(fileIndex)} has no relativePath`);
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} file ${String(fileIndex)} has invalid byteLength`);
    }
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
      throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: source integrity ${String(index)} file ${String(fileIndex)} has invalid digest`);
    }
    return Object.freeze({ relativePath, byteLength, digest });
  });
  return Object.freeze({ packageName, files: Object.freeze(files) });
}

function readPriorBundledImmutableArtifactIdentity(
  value: unknown,
  sourcePath: string,
  index: number,
  sourceArtifactIntegrity: BundledFirstPartySourceArtifactIntegrity,
): PriorBundledImmutableArtifactIdentity {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: immutable artifact ${String(index)} must be an object`);
  }
  const packageName = value.packageName;
  const record = value.record;
  if (typeof packageName !== 'string' || packageName.trim().length === 0) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: immutable artifact ${String(index)} has no packageName`);
  }
  if (!isRecord(record) || Array.isArray(record)) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: immutable artifact ${String(index)} has no record`);
  }
  const pluginId = record.pluginId;
  const immutableGenerationId = record.immutableGenerationId;
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: immutable artifact ${String(index)} has no pluginId`);
  }
  if (typeof immutableGenerationId !== 'string' || immutableGenerationId.trim().length === 0) {
    throw new Error(`Invalid generated bundled artifact publication at ${sourcePath}: immutable artifact ${String(index)} has no immutableGenerationId`);
  }
  return Object.freeze({ packageName, pluginId, immutableGenerationId, sourceArtifactIntegrity });
}

function readPriorBundledImmutableArtifactIdentities(
  artifactsOutPath: string,
): ReadonlyMap<string, PriorBundledImmutableArtifactIdentity> {
  if (!existsSync(artifactsOutPath)) return new Map();
  const source = readFileSync(artifactsOutPath, 'utf8');
  const rawArtifacts = readGeneratedJsonExportLiteral(
    source,
    'BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS',
    artifactsOutPath,
  );
  const rawIntegrities = readGeneratedJsonExportLiteral(
    source,
    'BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES',
    artifactsOutPath,
  );
  if (rawArtifacts === undefined && rawIntegrities === undefined) return new Map();
  if (!Array.isArray(rawArtifacts) || !Array.isArray(rawIntegrities)) {
    throw new Error(`Invalid generated bundled artifact publication at ${artifactsOutPath}: immutable artifacts and source integrities must both be arrays`);
  }

  const integrityByPackageName = new Map<string, BundledFirstPartySourceArtifactIntegrity>();
  for (const [index, value] of rawIntegrities.entries()) {
    const integrity = readPriorBundledSourceArtifactIntegrity(value, artifactsOutPath, index);
    if (integrityByPackageName.has(integrity.packageName)) {
      throw new Error(`Invalid generated bundled artifact publication at ${artifactsOutPath}: duplicate source integrity for '${integrity.packageName}'`);
    }
    integrityByPackageName.set(integrity.packageName, integrity);
  }

  const identities = new Map<string, PriorBundledImmutableArtifactIdentity>();
  const seenGenerationIds = new Set<string>();
  for (const [index, value] of rawArtifacts.entries()) {
    if (!isRecord(value) || Array.isArray(value) || typeof value.packageName !== 'string') {
      throw new Error(`Invalid generated bundled artifact publication at ${artifactsOutPath}: immutable artifact ${String(index)} has no packageName`);
    }
    const sourceArtifactIntegrity = integrityByPackageName.get(value.packageName);
    if (!sourceArtifactIntegrity) {
      throw new Error(`Invalid generated bundled artifact publication at ${artifactsOutPath}: immutable artifact ${String(index)} has no matching source integrity`);
    }
    integrityByPackageName.delete(value.packageName);
    const identity = readPriorBundledImmutableArtifactIdentity(
      value,
      artifactsOutPath,
      index,
      sourceArtifactIntegrity,
    );
    const identityKey = bundledGenerationIdentityKey(identity.packageName, identity.pluginId);
    if (identities.has(identityKey)) {
      throw new Error(`Invalid generated bundled artifact publication at ${artifactsOutPath}: duplicate immutable artifact identity for '${identity.packageName}'`);
    }
    if (seenGenerationIds.has(identity.immutableGenerationId)) {
      throw new Error(`Invalid generated bundled artifact publication at ${artifactsOutPath}: duplicate immutableGenerationId '${identity.immutableGenerationId}'`);
    }
    identities.set(identityKey, identity);
    seenGenerationIds.add(identity.immutableGenerationId);
  }
  // Every immutable artifact must retain one source integrity above. Additional
  // entries bind bundled packages that do not own immutable runtime state, so
  // they are valid and intentionally have no immutable-artifact counterpart.
  return identities;
}

function createOpaqueBundledImmutableGenerationId(occupiedGenerationIds: Set<string>): string {
  let immutableGenerationId = `bundled-${randomUUID()}`;
  while (occupiedGenerationIds.has(immutableGenerationId)) {
    immutableGenerationId = `bundled-${randomUUID()}`;
  }
  occupiedGenerationIds.add(immutableGenerationId);
  return immutableGenerationId;
}

function assignBundledImmutableArtifactGenerationIds(input: Readonly<{
  mode: Mode;
  pluginPackages: readonly BundledPluginPackage[];
  priorIdentities: ReadonlyMap<string, PriorBundledImmutableArtifactIdentity>;
}>): readonly BundledPluginPackage[] {
  // Reserve every previously published identity so an H revision cannot reuse
  // G even while a retained session still depends on G's immutable root.
  const occupiedGenerationIds = new Set(
    [...input.priorIdentities.values()].map((identity) => identity.immutableGenerationId),
  );
  const seenCurrentIdentityKeys = new Set<string>();

  return input.pluginPackages.map((pluginPackage) => {
    const immutableArtifact = pluginPackage.immutableArtifact;
    if (!immutableArtifact) return pluginPackage;
    const identityKey = bundledGenerationIdentityKey(
      pluginPackage.packageName,
      pluginPackage.pluginId,
    );
    if (seenCurrentIdentityKeys.has(identityKey)) {
      throw new Error(`Duplicate bundled immutable artifact identity for '${pluginPackage.packageName}'`);
    }
    seenCurrentIdentityKeys.add(identityKey);
    const priorIdentity = input.priorIdentities.get(identityKey);
    const canReusePriorGeneration = input.mode === 'check'
      && priorIdentity !== undefined;
    // Check mode retains the already-published opaque identity so drift is
    // decided by the emitted artifact bytes, not by a second identity rule.
    // A write publication is a new host-custody occurrence and therefore
    // rotates the opaque identity regardless of content equality.
    const immutableGenerationId = canReusePriorGeneration
      ? priorIdentity.immutableGenerationId
      : createOpaqueBundledImmutableGenerationId(occupiedGenerationIds);
    return Object.freeze({
      ...pluginPackage,
      immutableArtifact: Object.freeze({
        ...immutableArtifact,
        record: Object.freeze({
          ...immutableArtifact.record,
          immutableGenerationId,
        }),
      }),
    });
  });
}

function createCanonicalWorkspacePackageRootsReader(
  repoRoot: string,
  dependencies: GeneratorWorkspaceDependencies,
): () => Readonly<Record<string, string>> | undefined {
  const cliPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'package.json');
  let canonicalWorkspacePackageRoots: Readonly<Record<string, string>> | undefined;
  return (): Readonly<Record<string, string>> | undefined => {
    if (!existsSync(cliPackageJsonPath)) return undefined;
    if (canonicalWorkspacePackageRoots) return canonicalWorkspacePackageRoots;
    const roots: Record<string, string> = {};
    for (const bundle of dependencies.cliCommonWorkspaces.resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
    })) {
      if (Object.hasOwn(roots, bundle.packageName)) {
        throw new Error(`Duplicate canonical workspace package root for '${bundle.packageName}'`);
      }
      roots[bundle.packageName] = bundle.srcDir;
    }
    canonicalWorkspacePackageRoots = Object.freeze(roots);
    return canonicalWorkspacePackageRoots;
  };
}

async function readSourceProjectionFacts(params: Readonly<{
  repoRoot: string;
  pluginPackageId: string;
  packageName: string;
  manifest: PluginManifestJson;
  dependencies: GeneratorWorkspaceDependencies;
}>): Promise<BundledPluginSourceProjectionFacts> {
  const definitionPath = resolve(
    params.repoRoot,
    'packages/plugins',
    params.pluginPackageId,
    'src/agent/definition.ts',
  );
  const loadedAgentDefinition = existsSync(definitionPath)
    ? await loadPluginAgentDefinition(params.repoRoot, params.pluginPackageId)
    : undefined;
  const agentDefinition = loadedAgentDefinition
    ? projectNativeAgentCliDefinitionFacts(
      loadedAgentDefinition,
      params.manifest,
      params.pluginPackageId,
    )
    : undefined;
  if (agentDefinition) {
    rejectRetiredAgentRuntimeContributionsAggregate(agentDefinition, definitionPath);
  }
  const releasedFlatSessionMetadataRuntimeDescriptorReader = agentDefinition
    ? readOptionalReleasedFlatSessionMetadataRuntimeDescriptorReaderContribution(
      agentDefinition,
      definitionPath,
    )
    : undefined;
  const agentUiDescriptor = agentDefinition
    ? await loadPluginAgentUiDescriptor(params.repoRoot, params.pluginPackageId)
    : undefined;
  const agentPredecessorMessageMetaWriter = agentUiDescriptor
    ? await loadPluginAgentPredecessorMessageMetaWriter(
      params.repoRoot,
      params.pluginPackageId,
      params.packageName,
      agentUiDescriptor.agentId,
    )
    : undefined;
  const promptAssetContributions = await loadPluginPromptAssetContributions(
    params.repoRoot,
    params.pluginPackageId,
    params.packageName,
  );
  const builtInLegacyConnectedAccountCompatibility =
    await loadBuiltInLegacyConnectedAccountCompatibility(
      params.repoRoot,
      params.pluginPackageId,
    );
  if (!agentDefinition && manifestDeclaresAgentRuntime(params.manifest, params.dependencies)) {
    throw new Error(
      `Missing required agent definition for agent-capable plugin package ${params.pluginPackageId}: ${definitionPath}`,
    );
  }
  if (agentUiDescriptor && agentUiDescriptor.agentId !== agentDefinition?.id) {
    throw new Error(
      `Invalid agent UI descriptor for ${params.pluginPackageId}: descriptor agentId '${agentUiDescriptor.agentId}' does not match AGENT_DEFINITION.id '${String(agentDefinition?.id)}'`,
    );
  }

  return Object.freeze({
    ...(agentDefinition ? { agentDefinition, agentId: agentDefinition.id } : {}),
    ...(agentUiDescriptor ? { agentUiDescriptor } : {}),
    ...(agentPredecessorMessageMetaWriter ? { agentPredecessorMessageMetaWriter } : {}),
    ...(releasedFlatSessionMetadataRuntimeDescriptorReader
      ? { releasedFlatSessionMetadataRuntimeDescriptorReader }
      : {}),
    ...(promptAssetContributions ? { promptAssetContributions } : {}),
    ...(builtInLegacyConnectedAccountCompatibility
      ? { builtInLegacyConnectedAccountCompatibility }
      : {}),
  });
}

async function readBundledPluginPackages(
  repoRoot: string,
  bundledPluginPackageNames: readonly string[],
  mode: Mode,
  scope: GeneratorScope,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<readonly BundledPluginPackage[]> {
  const result = await collectBundledPluginPackages(
    repoRoot,
    bundledPluginPackageNames,
    mode,
    scope,
    dependencies,
  );
  if (result.failures.length > 0) {
    throwBundledPluginPackageFailures(result.failures);
  }
  return result.pluginPackages;
}

type BundledPluginPackageFailure = Readonly<{
  packageName: string;
  message: string;
}>;

function throwBundledPluginPackageFailures(
  failures: readonly BundledPluginPackageFailure[],
): never {
  throw new Error(
    `Bundled plugin package validation failed:\n${failures
      .map((failure) => `- ${failure.packageName}: ${failure.message}`)
      .join('\n')}`,
  );
}

async function collectBundledPluginPackages(
  repoRoot: string,
  bundledPluginPackageNames: readonly string[],
  mode: Mode,
  scope: GeneratorScope,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
  failures: readonly BundledPluginPackageFailure[];
}>> {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) {
    return Object.freeze({ pluginPackages: Object.freeze([]), failures: Object.freeze([]) });
  }

  const getCanonicalWorkspacePackageRoots = createCanonicalWorkspacePackageRootsReader(
    repoRoot,
    dependencies,
  );

  const collected = await mapWithConcurrency(
    bundledPluginPackageNames,
    2,
    async (packageName): Promise<Readonly<{
      pluginPackage?: BundledPluginPackage;
      failure?: BundledPluginPackageFailure;
    }>> => await withTypescriptModuleInspectionSession(async () => {
    try {
      const pluginPackageId = pluginPackageNameToPackageId(packageName);
      const packageRoot = resolve(pluginsRoot, pluginPackageId);
      const pkgJsonPath = resolve(packageRoot, 'package.json');
      if (!existsSync(pkgJsonPath)) return Object.freeze({});
      const pkgJson = readJson(pkgJsonPath) as Record<string, unknown>;
      if (pkgJson.name !== packageName) {
        throw new Error(`Invalid plugin package name for ${pluginPackageId}: expected ${packageName}, got ${String(pkgJson.name)}`);
      }
      if (typeof pkgJson.version !== 'string' || pkgJson.version.trim().length === 0) {
        throw new Error(`Invalid plugin package version for ${pluginPackageId}: expected non-empty string`);
      }

      const sourceManifest = await loadPluginManifest(repoRoot, pluginPackageId, dependencies);
      await synchronizeSerializedPluginManifest({
        packageRoot,
        manifest: sourceManifest,
        mode,
      });
      const manifest = readCommittedBundledPluginManifest(
        packageRoot,
        packageName,
        dependencies.protocol,
      );
      const immutableArtifact = await createBundledImmutableArtifactSource({
        packageRoot,
        packageJson: pkgJson,
        manifest,
        mode,
        scope,
        dependencies,
        getCanonicalWorkspacePackageRoots,
      });
      const sourceArtifactIntegrity = immutableArtifact?.sourceArtifactIntegrity
        ?? createBundledPluginSourceArtifactIntegrity({
          packageRoot,
          packageJson: pkgJson,
          dependencies,
        });
      const sourceProjectionFacts = await readSourceProjectionFacts({
        repoRoot,
        pluginPackageId,
        packageName,
        manifest,
        dependencies,
      });

      return Object.freeze({ pluginPackage: Object.freeze({
        pluginPackageId,
        pluginId: manifest.id,
        packageName,
        packageVersion: pkgJson.version,
        manifest,
        sourceArtifactIntegrity,
        ...(sourceProjectionFacts.agentId && sourceProjectionFacts.agentDefinition
          ? {
            agentId: sourceProjectionFacts.agentId,
            agentDefinition: sourceProjectionFacts.agentDefinition,
          }
          : {}),
        ...(sourceProjectionFacts.agentUiDescriptor
          ? { agentUiDescriptor: sourceProjectionFacts.agentUiDescriptor }
          : {}),
        ...(sourceProjectionFacts.agentPredecessorMessageMetaWriter
          ? { agentPredecessorMessageMetaWriter: sourceProjectionFacts.agentPredecessorMessageMetaWriter }
          : {}),
        ...(sourceProjectionFacts.releasedFlatSessionMetadataRuntimeDescriptorReader
          ? {
            releasedFlatSessionMetadataRuntimeDescriptorReader:
              sourceProjectionFacts.releasedFlatSessionMetadataRuntimeDescriptorReader,
          }
          : {}),
        ...(sourceProjectionFacts.promptAssetContributions
          ? { promptAssetContributions: sourceProjectionFacts.promptAssetContributions }
          : {}),
        ...(sourceProjectionFacts.builtInLegacyConnectedAccountCompatibility
          ? { builtInLegacyConnectedAccountCompatibility: sourceProjectionFacts.builtInLegacyConnectedAccountCompatibility }
          : {}),
        ...(immutableArtifact ? { immutableArtifact } : {}),
      }) });
    } catch (error) {
      return Object.freeze({ failure: Object.freeze({
        packageName,
        message: error instanceof Error ? error.message : String(error),
      }) });
    }
    }),
  );

  const out = collected.flatMap((entry) => entry.pluginPackage ? [entry.pluginPackage] : []);
  const failures = collected.flatMap((entry) => entry.failure ? [entry.failure] : []);

  out.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return Object.freeze({
    pluginPackages: Object.freeze(out),
    failures: Object.freeze(failures),
  });
}

/**
 * The aggregate publisher intentionally treats a plugin's serialized manifest
 * and package metadata as its input boundary. It never imports a plugin's
 * authored TypeScript merely to re-check a final artifact graph.
 */
function readSerializedBundledPluginPackages(
  repoRoot: string,
  bundledPluginPackageNames: readonly string[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly BundledPluginPackage[] {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  const out: BundledPluginPackage[] = [];
  const pluginOwnerById = new Map<string, string>();
  const agentOwnerById = new Map<string, string>();
  for (const packageName of bundledPluginPackageNames) {
    const pluginPackageId = pluginPackageNameToPackageId(packageName);
    const packageRoot = resolve(pluginsRoot, pluginPackageId);
    const packageJsonPath = resolve(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
    if (packageJson.name !== packageName) {
      throw new Error(
        `Invalid plugin package name for ${pluginPackageId}: expected ${packageName}, got ${String(packageJson.name)}`,
      );
    }
    if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
      throw new Error(`Invalid plugin package version for ${pluginPackageId}: expected non-empty string`);
    }

    const manifest = readCommittedBundledPluginManifest(
      packageRoot,
      packageName,
      dependencies.protocol,
    );

    const previousPluginOwner = pluginOwnerById.get(manifest.id);
    if (previousPluginOwner) {
      throw new Error(
        `Duplicate bundled plugin id '${manifest.id}' from '${previousPluginOwner}' and '${packageName}'`,
      );
    }
    pluginOwnerById.set(manifest.id, packageName);
    const agentContributions = readManifestContributionArray(manifest, 'agents');
    let agentId: string | undefined;
    for (const agentContribution of agentContributions) {
      const contributionAgentId = readRequiredContributionId(
        agentContribution,
        'agents',
        pluginPackageId,
      );
      const previousAgentOwner = agentOwnerById.get(contributionAgentId);
      if (previousAgentOwner) {
        throw new Error(
          `Duplicate bundled agent provider id '${contributionAgentId}' from '${previousAgentOwner}' and '${packageName}'`,
        );
      }
      agentOwnerById.set(contributionAgentId, packageName);
      agentId ??= contributionAgentId;
    }

    out.push(Object.freeze({
      pluginPackageId,
      pluginId: manifest.id,
      packageName,
      packageVersion: packageJson.version,
      manifest,
      ...(agentId ? { agentId } : {}),
    }));
  }
  return Object.freeze(out.sort((left, right) => left.packageName.localeCompare(right.packageName)));
}

function collectBuiltInLegacyConnectedAccountCompatibility(
  repoRoot: string,
  pluginPackages: readonly BundledPluginPackage[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly BuiltInLegacyConnectedAccountCompatibilityProjection[] {
  const reservedLegacyServiceIds = [
    ...dependencies.protocol.ConnectedServiceIdSchema.options,
  ];
  const reservedLegacyServiceIdSet = new Set<string>(reservedLegacyServiceIds);
  if (reservedLegacyServiceIdSet.size !== reservedLegacyServiceIds.length) {
    throw new Error(
      'ConnectedServiceIdSchema contains duplicate reserved legacy Connected Account ids',
    );
  }
  const descriptors = pluginPackages.flatMap((pluginPackage) =>
    readManifestContributionArray(
      pluginPackage.manifest,
      'connectedAccountDescriptors',
    ).map((definition) => ({
      definition,
      pluginPackage,
      serviceLocalId: readRequiredContributionId(
        definition,
        'connectedAccountDescriptors',
        pluginPackage.pluginPackageId,
      ),
    })));
  const ownershipByLegacyServiceId =
    new Map<string, BuiltInLegacyConnectedAccountCompatibilityProjection>();

  for (const pluginPackage of pluginPackages) {
    for (
      const source
      of pluginPackage.builtInLegacyConnectedAccountCompatibility ?? []
    ) {
      if (
        !reservedLegacyServiceIdSet.has(source.legacyServiceId)
        || ownershipByLegacyServiceId.has(source.legacyServiceId)
      ) {
        throw new Error(
          `Invalid or ambiguous built-in legacy Connected Account ownership for '${source.legacyServiceId}'`,
        );
      }
      const candidates = descriptors.filter((candidate) =>
        candidate.pluginPackage === pluginPackage
        && candidate.serviceLocalId === source.serviceLocalId);
      if (candidates.length !== 1) {
        throw new Error(
          `Built-in legacy Connected Account mapping '${source.legacyServiceId}' must name one descriptor '${pluginPackage.pluginId}/${source.serviceLocalId}'`,
        );
      }
      const authentication = isRecord(candidates[0]?.definition)
        && isRecord(candidates[0].definition.authentication)
        ? candidates[0].definition.authentication
        : undefined;
      const declaredModeIds = new Set(
        Array.isArray(authentication?.modes)
          ? authentication.modes.flatMap((mode) =>
            isRecord(mode) && typeof mode.id === 'string' ? [mode.id] : [])
          : [],
      );
      const referencedModeIds = new Set([
        source.defaultAuthenticationModeId,
        ...Object.values(source.authenticationModeByCredentialKind),
      ]);
      if (
        referencedModeIds.size === 0
        || [...referencedModeIds].some((modeId) => !declaredModeIds.has(modeId))
      ) {
        throw new Error(
          `Built-in legacy Connected Account mapping '${source.legacyServiceId}' in '${pluginPackage.pluginId}' must reference only declared authentication modes`,
        );
      }
      if (
        Object.values(source.unsupportedAuthenticationModeByCredentialKind)
          .some((modeId) => declaredModeIds.has(modeId))
      ) {
        throw new Error(
          `Built-in legacy Connected Account mapping '${source.legacyServiceId}' in '${pluginPackage.pluginId}' must not expose an unsupported legacy sentinel as a declared authentication mode`,
        );
      }
      ownershipByLegacyServiceId.set(source.legacyServiceId, Object.freeze({
        legacyServiceId: source.legacyServiceId,
        service: Object.freeze({
          pluginId: pluginPackage.pluginId,
          localId: source.serviceLocalId,
        }),
        peerOperations: source.peerOperations,
        exactV0_2_1ReaderQuotaProjection:
          source.exactV0_2_1ReaderQuotaProjection,
        defaultAuthenticationModeId: source.defaultAuthenticationModeId,
        authenticationModeByCredentialKind:
          source.authenticationModeByCredentialKind,
        unsupportedAuthenticationModeByCredentialKind:
          source.unsupportedAuthenticationModeByCredentialKind,
      }));
    }
  }

  // Small generator fixtures without the Connected Services domain may omit this
  // projection. A repository with the legacy bindings or their consumed identity
  // translator must own the complete supported closed legacy set.
  const ownsLegacyConnectedServicesDomain = existsSync(resolve(
    repoRoot,
    'packages/protocol/src/connect/connectedServiceBindings.ts',
  )) || existsSync(resolve(
    repoRoot,
    'apps/server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity.ts',
  ));
  if (ownsLegacyConnectedServicesDomain) {
    for (const legacyServiceId of reservedLegacyServiceIds) {
      if (!ownershipByLegacyServiceId.has(legacyServiceId)) {
        throw new Error(
          `Missing built-in legacy Connected Account compatibility for '${legacyServiceId}'`,
        );
      }
    }
  }

  return Object.freeze(reservedLegacyServiceIds.flatMap((legacyServiceId) => {
    const ownership = ownershipByLegacyServiceId.get(legacyServiceId);
    return ownership ? [ownership] : [];
  }));
}

function renderProtocolBuiltInLegacyConnectedAccountCompatibilityTs(
  entries: readonly BuiltInLegacyConnectedAccountCompatibilityProjection[],
): string {
  const lines = [
    '/**',
    ' * GENERATED FILE. DO NOT EDIT.',
    ' *',
    ' * Built-in-only host-private compatibility for supported legacy Connected Service ids.',
    ' * Public manifests and external plugins cannot add or claim entries in this projection.',
    ' *',
    ' * Immutable released bases: server-v0.2.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2',
    ' * and cli-v0.2.1 at b1d15a8a9c241737d1ca9b167459901e6259173a.',
    ' * The prospective Remote at e67f3751f1ab5dc13e40a583a28f3962111154aa is the',
    ' * legacy GitHub credential producer consumed during Dev activation. Dev preactivation at',
    ' * 877ee97a0df346a1daaa541632dc42643d533120 produced persisted Bitbucket credentials.',
    ' * Remove this compatibility projection only after exact 0.2.1 support ends, the Remote',
    ' * predecessor no longer produces a required shape, and persisted legacy rows no longer',
    ' * require migration or reverse projection.',
    ' */',
    '',
    'export type BuiltInLegacyConnectedAccountOperation =',
    ...BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS.map(
      (operation) => `  | ${JSON.stringify(operation)}`,
    ),
    ';',
    '',
    'export type BuiltInLegacyConnectedAccountCompatibility = Readonly<{',
    '  service: Readonly<{',
    '    pluginId: string;',
    '    localId: string;',
    '  }>;',
    '  peerOperations: Readonly<{',
    '    exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];',
    '    revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];',
    '  }>;',
    '  exactV0_2_1ReaderQuotaProjection: boolean;',
    '  defaultAuthenticationModeId: string;',
    '  authenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;',
    '  unsupportedAuthenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;',
    '}>;',
    '',
    'export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID = Object.freeze({',
  ];
  for (const entry of entries) {
    lines.push(
      `  ${JSON.stringify(entry.legacyServiceId)}: Object.freeze({`,
      '    service: Object.freeze({',
      `      pluginId: ${JSON.stringify(entry.service.pluginId)},`,
      `      localId: ${JSON.stringify(entry.service.localId)},`,
      '    }),',
      '    peerOperations: Object.freeze({',
      `      exactV0_2_1: Object.freeze(${JSON.stringify(entry.peerOperations.exactV0_2_1)} as const),`,
      `      revisionedV2V3: Object.freeze(${JSON.stringify(entry.peerOperations.revisionedV2V3)} as const),`,
      '    }),',
      `    exactV0_2_1ReaderQuotaProjection: ${JSON.stringify(entry.exactV0_2_1ReaderQuotaProjection)},`,
      `    defaultAuthenticationModeId: ${JSON.stringify(entry.defaultAuthenticationModeId)},`,
      '    authenticationModeByCredentialKind: Object.freeze({',
      ...(entry.authenticationModeByCredentialKind.oauth
        ? [`      oauth: ${JSON.stringify(entry.authenticationModeByCredentialKind.oauth)},`]
        : []),
      ...(entry.authenticationModeByCredentialKind.token
        ? [`      token: ${JSON.stringify(entry.authenticationModeByCredentialKind.token)},`]
        : []),
      '    }),',
      '    unsupportedAuthenticationModeByCredentialKind: Object.freeze({',
      ...(entry.unsupportedAuthenticationModeByCredentialKind.oauth
        ? [`      oauth: ${JSON.stringify(entry.unsupportedAuthenticationModeByCredentialKind.oauth)},`]
        : []),
      ...(entry.unsupportedAuthenticationModeByCredentialKind.token
        ? [`      token: ${JSON.stringify(entry.unsupportedAuthenticationModeByCredentialKind.token)},`]
        : []),
      '    }),',
      '  }),',
    );
  }
  lines.push(
    '} as const satisfies Readonly<Record<string, BuiltInLegacyConnectedAccountCompatibility>>);',
    '',
    'export type BuiltInLegacyConnectedServiceId =',
    '  keyof typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID;',
    '',
  );
  return lines.join('\n');
}

/**
 * The one public module a bundled Voice plugin exposes its `activate` through.
 *
 * `assertBundledVoicePackageExport` proves the package really exports it with
 * the platform conditions a native host needs. A conversation contribution's
 * `client.modulePath` is the *host-facing* half of the same fact: it is what a
 * packed install imports, and nothing else in the repository reads it, so a
 * value naming some other module stays green until packed-external Voice
 * loading goes live and then fails as a missing artifact module — or, worse,
 * resolves to a web-only sibling and silently drops the native session
 * strategy. Binding the two here keeps the declared public path and the
 * validated export from drifting apart in the first place.
 */
const BUNDLED_VOICE_CLIENT_MODULE_PATH = './ui/voice';

function assertBundledVoiceClientModulePath(
  contribution: Readonly<Record<string, unknown>>,
  pluginPackageId: string,
): void {
  const client = contribution.client;
  if (!isRecord(client)) {
    throw new Error(
      `Invalid voiceProviders contribution in ${pluginPackageId}: conversation client execution is required`,
    );
  }
  if (client.modulePath !== BUNDLED_VOICE_CLIENT_MODULE_PATH) {
    throw new Error(
      `Invalid voiceProviders contribution in ${pluginPackageId}: conversation client.modulePath must be `
      + `'${BUNDLED_VOICE_CLIENT_MODULE_PATH}' (the validated bundled Voice package export), received `
      + `'${String(client.modulePath)}'`,
    );
  }
}

function assertBundledVoicePackageExport(
  packageJson: Record<string, unknown>,
  packageName: string,
  exportSubpath: './ui/voice',
): void {
  const exportsMap = packageJson.exports;
  const exportTarget = isRecord(exportsMap) ? exportsMap[exportSubpath] : undefined;
  if (exportTarget === undefined) {
    throw new Error(`Missing required bundled voice export '${packageName}/${exportSubpath.slice(2)}'`);
  }
  if (!isRecord(exportTarget)) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected typed built artifact export`,
    );
  }

  const typesPath = exportTarget.types;
  const defaultPath = exportTarget.default;
  const nativePath = exportTarget['react-native'];
  const expectedConditionOrder = nativePath !== undefined
    ? ['types', 'react-native', 'default']
    : ['types', 'default'];
  if (JSON.stringify(Object.keys(exportTarget)) !== JSON.stringify(expectedConditionOrder)) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected ordered conditions ${expectedConditionOrder.join(', ')}`,
    );
  }
  const builtArtifactRoot = './dist/ui/voice/';
  const isSafeBuiltArtifactPath = (value: unknown, extension: '.d.ts' | '.js'): value is string => {
    if (typeof value !== 'string' || !value.startsWith(builtArtifactRoot) || !value.endsWith(extension)) {
      return false;
    }
    const relativePath = value.slice(builtArtifactRoot.length);
    return relativePath.length > extension.length
      && /^[A-Za-z0-9._/-]+$/.test(relativePath)
      && relativePath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  };
  const isBuiltTypesPath = typeof typesPath === 'string'
    && isSafeBuiltArtifactPath(typesPath, '.d.ts');
  const isBuiltRuntimePath = (value: unknown): boolean => isSafeBuiltArtifactPath(value, '.js');
  if (!isBuiltTypesPath || !isBuiltRuntimePath(defaultPath) || (nativePath !== undefined && !isBuiltRuntimePath(nativePath))) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected typed built artifact export`,
    );
  }
}

function collectBundledFirstPartyVoiceProjectionSources(
  repoRoot: string,
  pluginPackages: readonly BundledPluginPackage[],
): readonly BundledFirstPartyVoiceProjectionSource[] {
  const sources: BundledFirstPartyVoiceProjectionSource[] = [];
  const seenPluginIds = new Map<string, string>();

  for (const pluginPackage of pluginPackages) {
    const pluginPackageId = pluginPackage.pluginPackageId;
    const isReservedVoicePackage = isBundledFirstPartyVoicePackageId(pluginPackageId);
    const expectedPluginId = isReservedVoicePackage
      ? BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS[pluginPackageId]
      : null;
    const declaresVoiceIdentity = pluginPackage.pluginId.startsWith('happier.voice.');

    if (expectedPluginId === null) {
      if (!declaresVoiceIdentity) continue;
      const reservedOwner = BUNDLED_FIRST_PARTY_VOICE_PACKAGE_IDS.find(
        (packageId) => BUNDLED_FIRST_PARTY_VOICE_PLUGIN_IDS[packageId] === pluginPackage.pluginId,
      );
      if (reservedOwner) {
        throw new Error(
          `Reserved first-party voice plugin identity '${pluginPackage.pluginId}' belongs to package '${reservedOwner}'`,
        );
      }
      throw new Error(`Unreserved first-party voice plugin identity '${pluginPackage.pluginId}'`);
    }
    if (!isBundledFirstPartyVoicePackageId(pluginPackageId)) {
      throw new Error(`Invariant violation: reserved voice package '${pluginPackageId}' was not narrowed`);
    }

    if (pluginPackage.pluginId !== expectedPluginId) {
      throw new Error(
        `Bundled first-party voice package '${pluginPackage.pluginPackageId}' must use plugin identity '${expectedPluginId}', got '${pluginPackage.pluginId}'`,
      );
    }
    const existingOwner = seenPluginIds.get(pluginPackage.pluginId);
    if (existingOwner) {
      throw new Error(
        `Duplicate bundled first-party voice plugin identity '${pluginPackage.pluginId}' from '${pluginPackage.pluginPackageId}'; already declared by '${existingOwner}'`,
      );
    }
    seenPluginIds.set(pluginPackage.pluginId, pluginPackage.pluginPackageId);

    const packageJsonPath = resolve(
      repoRoot,
      'packages',
      'plugins',
      pluginPackage.pluginPackageId,
      'package.json',
    );
    const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
    assertBundledVoicePackageExport(packageJson, pluginPackage.packageName, BUNDLED_VOICE_CLIENT_MODULE_PATH);
    const conversationContributions = readManifestContributionArray(
      pluginPackage.manifest,
      'voiceProviders',
    ).filter((contribution) => isRecord(contribution) && contribution.kind === 'conversation');
    const conversationPlatforms = new Set<BundledVoiceRuntimePlatform>();
    for (const contribution of conversationContributions) {
      if (!isRecord(contribution) || !Array.isArray(contribution.platforms)) {
        throw new Error(
          `Invalid voiceProviders contribution in ${pluginPackageId}: conversation platforms are required`,
        );
      }
      assertBundledVoiceClientModulePath(contribution, pluginPackageId);
      for (const platform of contribution.platforms) {
        if (
          typeof platform !== 'string'
          || !BUNDLED_VOICE_RUNTIME_PLATFORMS.includes(platform as BundledVoiceRuntimePlatform)
        ) {
          throw new Error(
            `Invalid voiceProviders contribution in ${pluginPackageId}: unsupported conversation platform '${String(platform)}'`,
          );
        }
        conversationPlatforms.add(platform as BundledVoiceRuntimePlatform);
      }
    }
    sources.push({
      manifest: pluginPackage.manifest,
      packageName: pluginPackage.packageName,
      packageVersion: pluginPackage.packageVersion,
      pluginId: pluginPackage.pluginId,
      pluginPackageId,
      hasConversationProvider: conversationContributions.length > 0,
      conversationPlatforms: BUNDLED_VOICE_RUNTIME_PLATFORMS.filter(
        (platform) => conversationPlatforms.has(platform),
      ),
    });
  }

  return sources.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

function syncBundledVoiceUiPackageDependencies(params: Readonly<{
  rootDir: string;
  mode: Mode;
  sources: readonly BundledFirstPartyVoiceProjectionSource[];
}>): void {
  const expectedVersions = new Map(params.sources.map((source) => [source.packageName, source.packageVersion] as const));
  const reservedPackageNames = new Set(
    BUNDLED_FIRST_PARTY_VOICE_PACKAGE_IDS.map((packageId) => `@happier-dev/plugins-${packageId}`),
  );

  const packageJsonPath = resolve(params.rootDir, 'apps', 'ui', 'package.json');
  if (!existsSync(packageJsonPath)) return;
  const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
  const currentDependencies = isRecord(packageJson.dependencies)
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  const nextDependencies: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(currentDependencies)) {
    if (!reservedPackageNames.has(name)) nextDependencies[name] = version;
  }
  for (const source of params.sources) {
    nextDependencies[source.packageName] = source.packageVersion;
  }

  const currentVoiceDependencies = Object.fromEntries(
    Object.entries(currentDependencies)
      .filter(([name]) => reservedPackageNames.has(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const expectedVoiceDependencies = Object.fromEntries(
    [...expectedVersions.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  if (params.mode === 'check') {
    if (JSON.stringify(currentVoiceDependencies) !== JSON.stringify(expectedVoiceDependencies)) {
      throw new Error('apps/ui voice plugin dependencies are out of sync');
    }
    return;
  }
  if (JSON.stringify(currentDependencies) === JSON.stringify(nextDependencies)) return;
  packageJson.dependencies = nextDependencies;
  writeFileAtomic(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

const BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS = Object.freeze([
  'web',
  'ios',
  'android',
] as const satisfies readonly BundledPluginUiAppArtifactPlatform[]);

function isBundledPluginUiAppArtifactPlatform(
  value: string | undefined,
): value is BundledPluginUiAppArtifactPlatform {
  return value === 'web' || value === 'ios' || value === 'android';
}

function assertBundledPluginUiArtifactFilePath(
  artifactsRoot: string,
  relativePath: string,
  packageName: string,
): string {
  const absolutePath = resolve(artifactsRoot, ...relativePath.split('/'));
  const rootPrefix = artifactsRoot.endsWith(sep) ? artifactsRoot : `${artifactsRoot}${sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error(
      `bundled Plugin UI artifact path escapes its artifact root for '${packageName}': '${relativePath}'`,
    );
  }
  return absolutePath;
}

/**
 * Reads the only app-exact byte source: built files and their canonical
 * `ui-artifacts.json` manifest in an already-bundled plugin package. This
 * generator validates every declared byte before it writes a static app asset
 * reference, so a stale build tree cannot silently become an app source.
 */
function collectBundledPluginUiAppArtifactSources(
  repoRoot: string,
  pluginPackages: readonly BundledPluginPackage[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly BundledPluginUiAppArtifactSource[] {
  const sources: BundledPluginUiAppArtifactSource[] = [];
  const coordinateOwners = new Map<string, string>();

  for (const pluginPackage of pluginPackages) {
    const artifactsRoot = resolve(
      repoRoot,
      'packages',
      'plugins',
      pluginPackage.pluginPackageId,
      'dist',
      'happier-plugin-ui',
    );
    const manifestPath = resolve(artifactsRoot, 'ui-artifacts.json');
    if (!existsSync(manifestPath)) continue;

    let rawManifest: unknown;
    try {
      rawManifest = readJson(manifestPath);
    } catch (error) {
      throw new Error(
        `Invalid bundled Plugin UI artifact manifest for '${pluginPackage.packageName}': ${String(error)}`,
      );
    }
    const parsedManifest = dependencies.pluginUi.PluginUiArtifactsManifestV1Schema.safeParse(rawManifest);
    if (!parsedManifest.success) {
      throw new Error(`Invalid bundled Plugin UI artifact manifest for '${pluginPackage.packageName}'`);
    }

    for (const entry of parsedManifest.data.entries) {
      const verifiedFiles: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
      for (const file of entry.files) {
        const absolutePath = assertBundledPluginUiArtifactFilePath(
          artifactsRoot,
          file.relativePath,
          pluginPackage.packageName,
        );
        let bytes: Uint8Array;
        try {
          if (!lstatSync(absolutePath).isFile()) {
            throw new Error('not a regular file');
          }
          bytes = new Uint8Array(readFileSync(absolutePath));
        } catch (error) {
          throw new Error(
            `Missing bundled Plugin UI artifact file for '${pluginPackage.packageName}': '${file.relativePath}' (${String(error)})`,
          );
        }
        if (dependencies.pluginUi.computePluginUiArtifactSha256DigestV1(bytes) !== file.digest) {
          throw new Error(
            `bundled Plugin UI artifact file digest mismatch for '${pluginPackage.packageName}': '${file.relativePath}'`,
          );
        }
        if (bytes.byteLength !== file.byteSize) {
          throw new Error(
            `bundled Plugin UI artifact file byte size mismatch for '${pluginPackage.packageName}': '${file.relativePath}'`,
          );
        }
        verifiedFiles.push(Object.freeze({ relativePath: file.relativePath, bytes }));
      }
      if (dependencies.pluginUi.computePluginUiArtifactFileSetSha256DigestV1(verifiedFiles) !== entry.digest) {
        throw new Error(
          `bundled Plugin UI artifact graph digest mismatch for '${pluginPackage.packageName}/${entry.contributionId}'`,
        );
      }

      if (
        (entry.tier !== 'hostedWeb' && entry.tier !== 'reactNative')
        || !isBundledPluginUiAppArtifactPlatform(entry.platform)
      ) {
        continue;
      }
      const coordinate = [
        pluginPackage.pluginId,
        entry.contributionId,
        entry.tier,
        entry.platform,
        pluginPackage.packageVersion,
      ].join('\u001f');
      const previousOwner = coordinateOwners.get(coordinate);
      if (previousOwner) {
        throw new Error(
          `Ambiguous bundled Plugin UI app artifact '${pluginPackage.pluginId}/${entry.contributionId}/${entry.tier}/${entry.platform}/${pluginPackage.packageVersion}' from '${previousOwner}' and '${pluginPackage.packageName}'`,
        );
      }
      coordinateOwners.set(coordinate, pluginPackage.packageName);
      sources.push(Object.freeze({
        packageName: pluginPackage.packageName,
        packageVersion: pluginPackage.packageVersion,
        pluginId: pluginPackage.pluginId,
        contributionId: entry.contributionId,
        tier: entry.tier,
        platform: entry.platform,
        digest: entry.digest,
        files: Object.freeze(
          [...entry.files]
            .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
            .map((file) => Object.freeze({ relativePath: file.relativePath })),
        ),
      }));
    }
  }

  return Object.freeze(sources.sort((left, right) => (
    left.packageName.localeCompare(right.packageName)
    || left.contributionId.localeCompare(right.contributionId)
    || left.tier.localeCompare(right.tier)
    || left.platform.localeCompare(right.platform)
    || left.digest.localeCompare(right.digest)
  )));
}

function syncBundledPluginUiAppArtifactPackageDependencies(params: Readonly<{
  rootDir: string;
  mode: Mode;
  sources: readonly BundledPluginUiAppArtifactSource[];
}>): void {
  const expectedVersions = new Map<string, string>();
  for (const source of params.sources) {
    const existingVersion = expectedVersions.get(source.packageName);
    if (existingVersion && existingVersion !== source.packageVersion) {
      throw new Error(
        `Ambiguous bundled Plugin UI app package version for '${source.packageName}': '${existingVersion}' and '${source.packageVersion}'`,
      );
    }
    expectedVersions.set(source.packageName, source.packageVersion);
  }

  const packageJsonPath = resolve(params.rootDir, 'apps', 'ui', 'package.json');
  if (!existsSync(packageJsonPath)) return;
  const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
  const currentDependencies = isRecord(packageJson.dependencies)
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  const missingOrMismatched = [...expectedVersions].some(
    ([packageName, packageVersion]) => currentDependencies[packageName] !== packageVersion,
  );
  if (params.mode === 'check') {
    if (missingOrMismatched) {
      throw new Error('apps/ui bundled Plugin UI artifact dependencies are out of sync');
    }
    return;
  }
  if (!missingOrMismatched) return;
  packageJson.dependencies = Object.fromEntries([
    ...Object.entries(currentDependencies),
    ...[...expectedVersions.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ]);
  writeFileAtomic(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function appliesToBundledPluginUiAppPlatform(
  source: BundledPluginUiAppArtifactSource,
  appPlatform: BundledPluginUiAppArtifactPlatform,
): boolean {
  // A hosted-web Artifact's declared `web` platform runs inside the browser
  // frame on every app platform. Native React Native artifacts remain exact to
  // their app platform and are never substituted across it.
  return source.tier === 'hostedWeb'
    ? source.platform === 'web'
    : source.platform === appPlatform;
}

function renderBundledPluginUiAppArtifactInventoryTs(
  sources: readonly BundledPluginUiAppArtifactSource[],
  appPlatform: BundledPluginUiAppArtifactPlatform | null,
): string {
  const applicableSources = appPlatform === null
    ? []
    : sources.filter((source) => appliesToBundledPluginUiAppPlatform(source, appPlatform));
  const lines = [
    '/**',
    ' * GENERATED FILE CONTRACT (APP-BUNDLED-PLUGIN-UI-ARTIFACTS)',
    ' *',
    ' * This file is emitted by:',
    ' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`',
    ' *',
    ' * Static module values below are immutable packaged bytes only. Artifact',
    ' * selection, currentness, cache custody, graph validation, and integrity',
    ' * remain owned by the Availability Artifact lease.',
    ' */',
    '',
    "import type { BundledPluginUiAppArtifactInventory } from './bundledPluginUiArtifactInventory';",
    '',
  ];
  const assetSymbolByFile = new Map<string, string>();
  let nextAssetIndex = 0;
  for (const source of applicableSources) {
    for (const file of source.files) {
      const specifier = `${source.packageName}/happier-plugin-ui/${file.relativePath}`;
      if (assetSymbolByFile.has(specifier)) continue;
      const symbol = `BUNDLED_PLUGIN_UI_APP_ASSET_${nextAssetIndex}`;
      nextAssetIndex += 1;
      assetSymbolByFile.set(specifier, symbol);
      lines.push(`const ${symbol} = require(${JSON.stringify(specifier)});`);
    }
  }
  if (assetSymbolByFile.size > 0) lines.push('');
  lines.push('export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([');
  for (const source of applicableSources) {
    lines.push('  Object.freeze({');
    lines.push(`    pluginId: ${JSON.stringify(source.pluginId)},`);
    lines.push(`    contributionId: ${JSON.stringify(source.contributionId)},`);
    lines.push(`    tier: ${JSON.stringify(source.tier)},`);
    lines.push(`    platform: ${JSON.stringify(source.platform)},`);
    lines.push(`    digest: ${JSON.stringify(source.digest)},`);
    lines.push(`    releaseVersion: ${JSON.stringify(source.packageVersion)},`);
    lines.push('    files: Object.freeze([');
    for (const file of source.files) {
      const specifier = `${source.packageName}/happier-plugin-ui/${file.relativePath}`;
      const assetSymbol = assetSymbolByFile.get(specifier);
      if (!assetSymbol) {
        throw new Error(`Missing generated app asset symbol for '${specifier}'`);
      }
      lines.push('      Object.freeze({');
      lines.push(`        relativePath: ${JSON.stringify(file.relativePath)},`);
      lines.push(`        asset: ${assetSymbol},`);
      lines.push('      }),');
    }
    lines.push('    ]),');
    lines.push('  }),');
  }
  lines.push(']) satisfies BundledPluginUiAppArtifactInventory;');
  lines.push('');
  return lines.join('\n');
}

function resolveBundledPluginUiArtifactProjectionOutPaths(rootDir: string): Readonly<
  Record<'generic' | BundledPluginUiAppArtifactPlatform, string>
> {
  return Object.freeze({
    generic: resolve(
      rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ts',
    ),
    web: resolve(
      rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.web.ts',
    ),
    ios: resolve(
      rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ios.ts',
    ),
    android: resolve(
      rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.android.ts',
    ),
  });
}

const RETIRED_BUNDLED_PLUGIN_PROTOCOL_PROJECTION_OUTPUTS = Object.freeze([
  'packages/protocol/src/agents/generated/bundledPluginProtocolProjectionFacts.ts',
  'packages/protocol/src/agents/generated/profiles/builtInBackendProfiles.ts',
  'packages/protocol/src/agents/generated/memory/defaults.ts',
]);

function removeRetiredBundledPluginProtocolProjectionOutputs(
  rootDir: string,
  mode: GeneratorMode,
): void {
  for (const relativePath of RETIRED_BUNDLED_PLUGIN_PROTOCOL_PROJECTION_OUTPUTS) {
    removeRetiredGeneratedOutput(resolve(rootDir, relativePath), mode);
  }
}

/**
 * Fast final-artifact publication. This is deliberately separate from the
 * source-authoring generator below: all package manifests and UI artifacts are
 * read first and every global conflict/digest is rejected before any projection
 * is replaced.
 */
async function publishBundledPluginUiArtifactProjection(
  options: GeneratorOptions,
  dependencies: GeneratorWorkspaceDependencies,
  additionalOutputs: readonly Readonly<{ outPath: string; out: string }>[] = [],
): Promise<void> {
  const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
  const pluginPackages = readSerializedBundledPluginPackages(
    options.rootDir,
    bundledPluginPackageNames,
    dependencies,
  );
  const cliManifestOutPath = resolve(
    options.rootDir,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
  );
  const cliManifestOut = renderCliBundledPluginManifestEntriesTs({ pluginPackages });
  const sources = collectBundledPluginUiAppArtifactSources(
    options.rootDir,
    pluginPackages,
    dependencies,
  );
  const outPaths = resolveBundledPluginUiArtifactProjectionOutPaths(options.rootDir);
  const outputs = Object.freeze({
    generic: renderBundledPluginUiAppArtifactInventoryTs(sources, null),
    ...Object.fromEntries(BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS.map((platform) => [
      platform,
      renderBundledPluginUiAppArtifactInventoryTs(sources, platform),
    ])),
  } as Record<'generic' | BundledPluginUiAppArtifactPlatform, string>);

  removeRetiredBundledPluginProtocolProjectionOutputs(options.rootDir, options.mode);

  if (options.mode === 'check') {
    syncBundledPluginUiAppArtifactPackageDependencies({
      rootDir: options.rootDir,
      mode: options.mode,
      sources,
    });
    for (const platform of ['generic', ...BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS] as const) {
      assertGeneratedOutputMatches(outPaths[platform], outputs[platform]);
    }
    assertGeneratedOutputMatches(cliManifestOutPath, cliManifestOut);
    for (const output of additionalOutputs) {
      assertGeneratedOutputMatches(output.outPath, output.out);
    }
    return;
  }

  // `sources` has already verified all cross-package IDs, declared files,
  // byte sizes, and content digests. Keep the host dependency update behind
  // that admission gate so an invalid changed plugin preserves last-green.
  syncBundledPluginUiAppArtifactPackageDependencies({
    rootDir: options.rootDir,
    mode: options.mode,
    sources,
  });
  publishCoherentProjectionOutputs(options.rootDir, [
    { outPath: cliManifestOutPath, out: cliManifestOut },
    ...(['generic', ...BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS] as const).map((platform) => ({
      outPath: outPaths[platform],
      out: outputs[platform],
    })),
    ...additionalOutputs,
  ]);
}

function renderBundledAgentDefinitionsTs(params: Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
}>): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push(`import type { AgentDefinition } from '../definitions/agentDefinition.js';`);
  lines.push('');
  lines.push('type BundledAgentDefinition = AgentDefinition;');
  lines.push('');
  lines.push(`export const BUNDLED_AGENT_DEFINITION_IDS: readonly string[] = Object.freeze([`);
  for (const id of params.agentIds) {
    lines.push(`  ${JSON.stringify(id)},`);
  }
  lines.push(']);');
  lines.push('');
  // Keep literal types (e.g. `core.id: "claude"`) intact. Passing the object literal directly into
  // `Object.freeze(...)` can widen nested string literals (via generic inference), which then fails
  // `AgentDefinition` assignment in strict mode.
  lines.push('const _BUNDLED_AGENT_DEFINITIONS_BY_ID = ({');
  for (const id of params.agentIds) {
    const definition = params.agentDefinitionsById[id];
    if (!definition) continue;
    lines.push(`  ${JSON.stringify(id)}: Object.freeze((${renderJsonLiteral(definition)}) as const),`);
  }
  lines.push('}) as const satisfies Readonly<Record<string, BundledAgentDefinition>>;');
  lines.push('');
  lines.push('export const BUNDLED_AGENT_DEFINITIONS_BY_ID: Readonly<Record<string, BundledAgentDefinition>> = Object.freeze(_BUNDLED_AGENT_DEFINITIONS_BY_ID);');
  lines.push('');
  lines.push('// Canonical generated aggregate exports (avoid "*families*" naming).');
  lines.push('export const bundledAgentDefinitionIds = BUNDLED_AGENT_DEFINITION_IDS;');
  lines.push('export const bundledAgentDefinitions = BUNDLED_AGENT_DEFINITIONS_BY_ID;');
  lines.push('');
  return lines.join('\n');
}

function renderProtocolSessionPresentationCompatV1Ts(params: Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
}>): string {
  const entries = params.agentIds.flatMap((agentId) => {
    const definition = params.agentDefinitionsById[agentId];
    if (!isRecord(definition)) return [];
    const core = readJsonObjectProperty(definition, 'core');
    if (!core) return [];
    const flavorAliases = Array.isArray(core.flavorAliases)
      ? core.flavorAliases.filter((value): value is string => typeof value === 'string')
      : [];
    const resume = readJsonObjectProperty(core, 'resume');
    const vendorResumeIdField = typeof resume?.vendorResumeIdField === 'string'
      ? resume.vendorResumeIdField
      : null;
    return [{
      agentId,
      flavorAliases: [...new Set([agentId, ...flavorAliases])],
      vendorResumeIdField,
    }];
  });

  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (C8.1-session-presentation-compat)');
  lines.push(' *');
  lines.push(' * Protocol-safe projection of canonical Agent flavor aliases and vendor resume-id fields.');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('export const GENERATED_SESSION_PRESENTATION_COMPAT_V1 = Object.freeze([');
  for (const entry of entries) {
    lines.push('  Object.freeze({');
    lines.push(`    agentId: ${renderTsStringLiteral(entry.agentId)},`);
    lines.push(`    flavorAliases: Object.freeze(${renderTsStringArrayLiteral(entry.flavorAliases)}),`);
    lines.push(`    vendorResumeIdField: ${renderTsNullableStringLiteral(entry.vendorResumeIdField)},`);
    lines.push('  }),');
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('function normalizePresentationIdentifier(value: unknown): string | null {');
  lines.push('  if (typeof value !== \'string\') return null;');
  lines.push('  const normalized = value.trim();');
  lines.push('  return normalized.length > 0 ? normalized : null;');
  lines.push('}');
  lines.push('');
  lines.push('export function resolveGeneratedSessionPresentationAgentIdV1(');
  lines.push('  metadata: Readonly<Record<string, unknown>>,');
  lines.push('): string | null {');
  lines.push('  const flavor = normalizePresentationIdentifier(metadata.flavor)?.toLowerCase() ?? null;');
  lines.push('  if (flavor) {');
  lines.push('    for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {');
  lines.push('      if (entry.flavorAliases.some((alias) => alias.trim().toLowerCase() === flavor)) {');
  lines.push('        return entry.agentId;');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push('  for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {');
  lines.push('    if (!entry.vendorResumeIdField) continue;');
  lines.push('    if (normalizePresentationIdentifier(metadata[entry.vendorResumeIdField])) return entry.agentId;');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderAgentIdsTs(agentIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Agent ids are sourced from the built-in runtime catalog plus bundled plugin `AGENT_DEFINITION.id` values.');
  lines.push(' */');
  lines.push('');
  lines.push('export const AGENT_IDS = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('/**');
  lines.push(' * Agent ids bundled with this build.');
  lines.push(' *');
  lines.push(' * Closed by construction: it is the discoverability list of Agents whose facts');
  lines.push(' * ship inside the host, and it is the correct key for records that are');
  lines.push(' * exhaustive over bundled Agents.');
  lines.push(' */');
  lines.push('export type BundledAgentId = (typeof AGENT_IDS)[number];');
  lines.push('');
  lines.push('/**');
  lines.push(' * Any installed Agent id.');
  lines.push(' *');
  lines.push(' * Plugin manifests admit an open local Agent identifier, so an externally');
  lines.push(' * installed Agent legitimately carries an id outside `AGENT_IDS`. The');
  lines.push(' * `(string & {})` member keeps editor autocomplete on the bundled ids while');
  lines.push(' * accepting those contributed ids; validation belongs to the parsing boundary');
  lines.push(' * that produced the id, not to this type.');
  lines.push(' */');
  lines.push('export type AgentId = BundledAgentId | (string & {});');
  lines.push('');
  lines.push('const BUNDLED_AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);');
  lines.push('');
  lines.push('export function isBundledAgentId(value: unknown): value is BundledAgentId {');
  lines.push('  return typeof value === \'string\' && BUNDLED_AGENT_ID_SET.has(value);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderProtocolAgentProviderIdsV1Ts(agentIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * This protocol-owned V1 wire schema intentionally preserves the');
  lines.push(' * daemon-facing provider id subset while deriving it from the generated');
  lines.push(' * bundled agent id source. Protocol cannot import `@happier-dev/agents`');
  lines.push(' * because that would create a package dependency cycle.');
  lines.push(' */');
  lines.push('');
  lines.push('import { z } from \'zod\';');
  lines.push('');
  lines.push('export const AGENT_PROVIDER_IDS_V1 = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('export type AgentProviderIdV1 = (typeof AGENT_PROVIDER_IDS_V1)[number];');
  lines.push('');
  lines.push('export const AgentProviderIdV1Schema = z.enum(AGENT_PROVIDER_IDS_V1);');
  lines.push('');
  return lines.join('\n');
}

function collectGeneratedAgentIds(
  pluginAgentIds: readonly string[],
  dependencies: GeneratorWorkspaceDependencies,
): readonly string[] {
  const sourceIds = [
    ...Object.keys(dependencies.agents.CANONICAL_AGENTS_CORE),
    ...pluginAgentIds,
  ];
  const sourceIdSet = new Set(sourceIds);
  const out = STABLE_AGENT_ID_ORDER.filter((agentId) => sourceIdSet.has(agentId));
  const seen = new Set<string>(out);
  for (const agentId of pluginAgentIds) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      out.push(agentId);
    }
  }
  for (const agentId of Object.keys(dependencies.agents.CANONICAL_AGENTS_CORE)) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      out.push(agentId);
    }
  }

  return out;
}

function collectProtocolAgentProviderIdsV1(generatedAgentIds: readonly string[]): readonly string[] {
  const generatedIds = new Set(generatedAgentIds);
  for (const agentId of PROTOCOL_AGENT_PROVIDER_IDS_V1) {
    if (!generatedIds.has(agentId)) {
      throw new Error(`Protocol AgentProviderIdV1 '${agentId}' is not present in generated agent provider ids`);
    }
  }
  return PROTOCOL_AGENT_PROVIDER_IDS_V1;
}

function collectReleasedFlatSessionMetadataRuntimeDescriptorReaderContributions(
  pluginPackages: readonly BundledPluginPackage[],
): readonly ReleasedFlatSessionMetadataRuntimeDescriptorReaderProjectionDescriptor[] {
  return pluginPackages
    .flatMap((entry): ReleasedFlatSessionMetadataRuntimeDescriptorReaderProjectionDescriptor[] => {
      const contribution = entry.releasedFlatSessionMetadataRuntimeDescriptorReader;
      if (!contribution) return [];
      if (contribution.kind === 'providerRuntimeDescriptorReader') {
        return [{
          ...contribution,
          ...(contribution.source === undefined
            ? {}
            : { source: `${entry.packageName}/${normalizePluginRuntimeProjectionSource(contribution.source)}` }),
        }];
      }
      return [contribution];
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function toScreamingSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function compareStableProviderIdOrder(a: string, b: string): number {
  const ai = STABLE_AGENT_ID_ORDER.indexOf(a as (typeof STABLE_AGENT_ID_ORDER)[number]);
  const bi = STABLE_AGENT_ID_ORDER.indexOf(b as (typeof STABLE_AGENT_ID_ORDER)[number]);
  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  }
  return a.localeCompare(b);
}

function readExternalSessionWhenDescriptor(value: unknown, path: string): Readonly<{ field: string; equals: string }> {
  const record = readRequiredRecord(value, path);
  return {
    field: readRequiredString(record, 'field', path),
    equals: readRequiredString(record, 'equals', path),
  };
}

function readExternalSessionSchemaFieldDescriptor(value: unknown, path: string): ExternalSessionSchemaFieldDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  const base = {
    name: readRequiredString(record, 'name', path),
    optional: readOptionalBoolean(record, 'optional', path),
    nullish: readOptionalBoolean(record, 'nullish', path),
    min: readOptionalNumber(record, 'min', path),
    max: readOptionalNumber(record, 'max', path),
  };
  if (kind === 'literal') {
    return {
      ...base,
      kind,
      value: readRequiredString(record, 'value', path),
    };
  }
  if (kind === 'enum') {
    return {
      ...base,
      kind,
      values: readStringArray(record, 'values', path),
    };
  }
  if (kind === 'string' || kind === 'unknown') {
    return { ...base, kind };
  }
  throw new Error(`Invalid external-session source declaration at ${path}.kind: expected literal, string, enum, or unknown`);
}

function readExternalSessionSchemaRefinementDescriptor(value: unknown, path: string): ExternalSessionSchemaRefinementDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  if (kind === 'requiresWhenEquals') {
    return {
      kind,
      field: readRequiredString(record, 'field', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  if (kind === 'forbidsWhenEquals') {
    return {
      kind,
      fields: readStringArray(record, 'fields', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  throw new Error(`Invalid external-session source declaration at ${path}.kind: expected requiresWhenEquals or forbidsWhenEquals`);
}

function readExternalSessionKeySegmentDescriptor(value: unknown, path: string): ExternalSessionKeySegmentDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  if (kind === 'literal') {
    return { kind, value: readRequiredString(record, 'value', path) };
  }
  if (kind === 'field') {
    return { kind, field: readRequiredString(record, 'field', path) };
  }
  if (kind === 'homeMode') {
    return { kind, field: readRequiredString(record, 'field', path) };
  }
  if (kind === 'conditionalField') {
    return {
      kind,
      field: readRequiredString(record, 'field', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  if (kind === 'connectedServiceScope') {
    return {
      kind,
      groupField: readRequiredString(record, 'groupField', path),
      profileField: readRequiredString(record, 'profileField', path),
      when: readExternalSessionWhenDescriptor(record.when, `${path}.when`),
    };
  }
  throw new Error(
    `Invalid external-session source declaration at ${path}.kind: expected literal, field, homeMode, conditionalField, or connectedServiceScope`,
  );
}

function readExternalSessionInstanceConstants(
  value: unknown,
  path: string,
): Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>> {
  if (value === undefined) return {};
  const record = readRequiredRecord(value, path);
  const constants: Record<string, ExternalSessionInstanceConstantDescriptor> = {};
  for (const [field, constant] of Object.entries(record)) {
    if (constant !== null
      && typeof constant !== 'string'
      && typeof constant !== 'number'
      && typeof constant !== 'boolean') {
      throw new Error(`Invalid external-session source instance at ${path}.${field}: expected scalar constant`);
    }
    if (typeof constant === 'number' && !Number.isFinite(constant)) {
      throw new Error(`Invalid external-session source instance at ${path}.${field}: expected finite number`);
    }
    constants[field] = constant;
  }
  return constants;
}

function readExternalSessionInstanceDescriptor(value: unknown, path: string): ExternalSessionInstanceDescriptor {
  const record = readRequiredRecord(value, path);
  const kind = readRequiredString(record, 'kind', path);
  const constants = readExternalSessionInstanceConstants(record.constants, `${path}.constants`);
  if (kind === 'default') return { kind, constants };
  if (kind === 'agentSetting' || kind === 'agentSettingOverride') {
    const byServerIdSettingId = record.byServerIdSettingId;
    if (byServerIdSettingId !== undefined && typeof byServerIdSettingId !== 'string') {
      throw new Error(`Invalid external-session source instance at ${path}.byServerIdSettingId: expected string`);
    }
    const normalization = readRequiredString(record, 'normalization', path);
    const acceptedNormalizations = kind === 'agentSetting'
      ? (['httpOrigin'] as const)
      : (['httpOrigin', 'configuredPath'] as const);
    if (!(acceptedNormalizations as readonly string[]).includes(normalization)) {
      throw new Error(
        `Invalid external-session source instance at ${path}.normalization: expected ${acceptedNormalizations.join(' or ')}`,
      );
    }
    const base = {
      settingId: readRequiredString(record, 'settingId', path),
      ...(byServerIdSettingId ? { byServerIdSettingId } : {}),
      field: readRequiredString(record, 'field', path),
      constants,
    };
    if (kind === 'agentSetting') {
      return { ...base, kind, normalization: 'httpOrigin' };
    }
    return {
      ...base,
      kind,
      normalization: normalization === 'httpOrigin' ? 'httpOrigin' : 'configuredPath',
    };
  }
  if (kind !== 'connectedServiceProfiles') {
    throw new Error(
      `Invalid external-session source instance at ${path}.kind: expected default, connectedServiceProfiles, agentSetting, or agentSettingOverride`,
    );
  }
  const fields = readRequiredRecord(record.fields, `${path}.fields`);
  return {
    kind,
    serviceId: readRequiredString(record, 'serviceId', path),
    constants,
    fields: {
      serviceId: readRequiredString(fields, 'serviceId', `${path}.fields`),
      profileId: readRequiredString(fields, 'profileId', `${path}.fields`),
    },
  };
}

export function readExternalSessionSourceDeclaration(
  value: JsonValue,
  path: string,
  agentId: string,
): ExternalSessionSourceDeclaration {
  const record = readRequiredRecord(value, path);
  if (Object.prototype.hasOwnProperty.call(record, 'agentId') || Object.prototype.hasOwnProperty.call(record, 'providerId')) {
    throw new Error(
      `Invalid external-session source declaration at ${path}.agentId: agentId is derived from manifest.contributes.agents[].id`,
    );
  }
  const schema = readRequiredRecord(record.schema, `${path}.schema`);
  if (Object.prototype.hasOwnProperty.call(schema, 'passthrough')) {
    throw new Error(
      `Invalid external-session source declaration at ${path}.schema.passthrough: no longer supported`,
    );
  }
  const fields = schema.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(`Invalid external-session source declaration at ${path}.schema.fields: expected non-empty array`);
  }
  const refinements = schema.refinements;
  const key = readRequiredRecord(record.key, `${path}.key`);
  const segments = key.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(`Invalid external-session source declaration at ${path}.key.segments: expected non-empty array`);
  }
  const instances = record.instances;
  if (instances !== undefined && (!Array.isArray(instances) || instances.length === 0)) {
    throw new Error(`Invalid external-session source declaration at ${path}.instances: expected non-empty array`);
  }
  return {
    agentId,
    sourceKind: readRequiredString(record, 'sourceKind', path),
    schema: {
      fields: fields.map((field, index) => readExternalSessionSchemaFieldDescriptor(field, `${path}.schema.fields[${String(index)}]`)),
      ...(refinements === undefined
        ? {}
        : {
          refinements: Array.isArray(refinements)
            ? refinements.map((refinement, index) => readExternalSessionSchemaRefinementDescriptor(
              refinement,
              `${path}.schema.refinements[${String(index)}]`,
            ))
            : (() => {
              throw new Error(`Invalid external-session source declaration at ${path}.schema.refinements: expected array`);
            })(),
        }),
    },
    key: {
      segments: segments.map((segment, index) => readExternalSessionKeySegmentDescriptor(segment, `${path}.key.segments[${String(index)}]`)),
    },
    ...(instances === undefined
      ? {}
      : {
        instances: instances.map((instance, index) => readExternalSessionInstanceDescriptor(
          instance,
          `${path}.instances[${String(index)}]`,
        )),
      }),
  };
}

async function collectProtocolExternalSessionSourceContributions(
  pluginPackages: readonly BundledPluginPackage[],
): Promise<readonly ProtocolExternalSessionSourceProjectionDescriptor[]> {
  const out: ProtocolExternalSessionSourceProjectionDescriptor[] = [];
  for (const entry of pluginPackages) {
    const backendContributions = readManifestContributionArray(entry.manifest, 'agents');
    for (const backendContribution of backendContributions) {
      const providerId = readRequiredContributionId(
        backendContribution,
        'agents',
        entry.pluginPackageId,
      );
      // A bundled package may use a manifest-safe local id that differs only
      // in casing from the canonical host Agent id (currently Oh My Pi). The
      // protocol source union is consumed by host runtime contracts, so its
      // discriminator owner must be the canonical Agent definition id.
      const canonicalAgentId = entry.agentId ?? providerId;
      const surfaces = readJsonObjectProperty(backendContribution, 'surfaces');
      const externalSession = readJsonObjectProperty(surfaces, 'externalSession');
      const sources = externalSession === null ? [] : externalSession.sources;
      if (sources === undefined) continue;
      if (!Array.isArray(sources)) {
        throw new Error(
          `Invalid external-session source declaration in ${entry.pluginPackageId}.${providerId}.surfaces.externalSession.sources: expected array`,
        );
      }
      for (const [index, rawDeclaration] of sources.entries()) {
        const declaration = readExternalSessionSourceDeclaration(
          rawDeclaration,
          `${entry.pluginPackageId}.${providerId}.surfaces.externalSession.sources[${String(index)}]`,
          canonicalAgentId,
        );
        out.push({
          agentId: canonicalAgentId,
          declaration,
        });
      }
    }
  }
  out.sort((a, b) => {
    const agentOrder = compareStableProviderIdOrder(a.agentId, b.agentId);
    if (agentOrder !== 0) return agentOrder;
    return a.declaration.sourceKind.localeCompare(b.declaration.sourceKind);
  });
  return out;
}

const PROTOCOL_PROVIDER_DEFAULT_SOURCE_PROJECTION_CONTRACT = 'A.16y.7-protocol-provider-default-and-source-projection';

function renderProtocolProviderProjectionHeader(lines: string[]): void {
  lines.push('/**');
  lines.push(` * GENERATED FILE CONTRACT (${PROTOCOL_PROVIDER_DEFAULT_SOURCE_PROJECTION_CONTRACT})`);
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
}

export function renderGeneratedExternalSessionSourcesTs(
  contributions: readonly ProtocolExternalSessionSourceProjectionDescriptor[],
): string {
  const lines: string[] = [];
  renderProtocolProviderProjectionHeader(lines);
  lines.push('');
  lines.push('export const GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS = [');
  for (const contribution of contributions) {
    lines.push(`${renderJsonLiteral(contribution.declaration, 2).split('\n').map((line) => `  ${line}`).join('\n')},`);
  }
  lines.push('] as const;');
  lines.push('');
  return lines.join('\n');
}

function renderAgentRuntimeDescriptorReadersTs(
  contributions: readonly ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor[],
): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED released flat Session-metadata compatibility readers.');
  lines.push(' *');
  lines.push(' * This bounded registry reads provider-specific metadata written by released');
  lines.push(' * CLI 0.2.0/0.2.1 builds. It is not a current descriptor or plugin-authoring seam.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  if (contributions.length > 0) {
    lines.push('import {');
    lines.push('  createGeneratedRuntimeDescriptorReader,');
    lines.push('  type GeneratedRuntimeDescriptorReaderConfig,');
    lines.push('} from \'../runtime/identity/generatedRuntimeProjection.js\';');
  }
  lines.push('import type { RuntimeDescriptorReaderMap } from \'../runtime/identity/runtimeDescriptorTypes.js\';');
  lines.push('');
  for (const contribution of contributions) {
    const constName = `${toScreamingSnakeCase(contribution.agentId)}_GENERATED_RUNTIME_DESCRIPTOR_READER`;
    lines.push(`const ${constName} = createGeneratedRuntimeDescriptorReader(`);
    lines.push(`${renderJsonLiteral(contribution.generatedReader, 2)} satisfies GeneratedRuntimeDescriptorReaderConfig<${renderTsStringLiteral(contribution.agentId)}>,`);
    lines.push(');');
    lines.push('');
  }
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS = [');
  for (const contribution of contributions) {
    lines.push(`  ${renderTsStringLiteral(contribution.agentId)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type GeneratedRuntimeDescriptorReaderProviderId =');
  lines.push('  (typeof GENERATED_RUNTIME_DESCRIPTOR_READER_PROVIDER_IDS)[number];');
  lines.push('');
  lines.push('export const GENERATED_RUNTIME_DESCRIPTOR_READERS: Readonly<Pick<RuntimeDescriptorReaderMap, GeneratedRuntimeDescriptorReaderProviderId>> = Object.freeze({');
  for (const contribution of contributions) {
    lines.push(`  ${contribution.agentId}: ${toScreamingSnakeCase(contribution.agentId)}_GENERATED_RUNTIME_DESCRIPTOR_READER,`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function renderCliBundledPluginManifestEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const metadata = params.pluginPackages.map((entry) => {
    const manifestAgent = readManifestContributionArray(entry.manifest, 'agents')[0];
    const manifestAgentId = manifestAgent === undefined
      ? undefined
      : readRequiredContributionId(manifestAgent, 'agents', entry.pluginPackageId);
    return {
      // Locator metadata describes the public manifest identity. A registration
      // binding may map that local id to a legacy canonical implementation id;
      // importing the private Agent definition here made source publication and
      // serialized-artifact checks disagree for OhMyPi.
      ...(manifestAgentId ? { agentId: manifestAgentId } : {}),
      manifestPath: `bundled:${entry.pluginId}`,
      packageName: entry.packageName,
      packageVersion: entry.packageVersion,
      pluginId: entry.pluginId,
      pluginPackageId: entry.pluginPackageId,
    };
  });

  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (WS1.T3)');
  lines.push(' *');
  lines.push(' * Data-only locator and provenance records.');
  lines.push(' * Contribution declarations are ingested from generator-normalized manifest');
  lines.push(' * data by the same canonical path used for installed plugins.');
  lines.push(' */');
  lines.push('');
  lines.push("import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';");
  lines.push('');
  lines.push('export type BundledFirstPartyPluginMetadata = Readonly<{');
  lines.push('  agentId?: string;');
  lines.push('  pluginId: string;');
  lines.push('  pluginPackageId: string;');
  lines.push('  packageName: string;');
  lines.push('  packageVersion: string;');
  lines.push('  manifestPath: string;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type BundledFirstPartyPluginLocator = Readonly<{');
  lines.push('  pluginId: string;');
  lines.push('  manifest: unknown;');
  lines.push('  manifestPath: string;');
  lines.push('  daemonEntryPath: string | null;');
  lines.push('  devDaemonEntryPath?: string | null;');
  lines.push('  sourceSpec: PluginSourceSpecV1;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const entry of params.pluginPackages) lines.push(`  ${JSON.stringify(entry.packageName)},`);
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(');
  lines.push(`${renderJsonLiteral(metadata)});`);
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly BundledFirstPartyPluginLocator[] = Object.freeze([');
  for (const entry of params.pluginPackages) {
    lines.push('  Object.freeze({');
    lines.push(`    pluginId: ${JSON.stringify(entry.pluginId)},`);
    lines.push(`    manifest: ${renderCompactJsonLiteral(entry.manifest)},`);
    lines.push(`    manifestPath: ${JSON.stringify(`bundled:${entry.pluginId}`)},`);
    lines.push(`    daemonEntryPath: ${manifestDeclaresDaemonEntrypoint(entry.manifest) ? JSON.stringify(entry.packageName) : 'null'},`);
    lines.push('    sourceSpec: Object.freeze({');
    lines.push("      kind: 'bundled',");
    lines.push(`      locator: ${JSON.stringify(entry.packageName)},`);
    lines.push("      trustPolicy: 'local_trusted',");
    lines.push("      installPolicy: 'link',");
    lines.push(`      resolvedVersion: ${JSON.stringify(entry.packageVersion)},`);
    lines.push('    }),');
    lines.push('  }),');
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

type BundledFirstPartyAgentRegistrationIdentity = Readonly<{
  pluginId: string;
  localId: string;
  implementationOwnerId: string;
  registrationFamily: string;
}>;

function renderCliBundledAgentRegistrationBindingsTs(
  registrations: readonly BundledFirstPartyAgentRegistrationIdentity[],
): string {
  const lines: string[] = [];
  lines.push('/** GENERATED data-only registration identities for bundled first-party Agents. */');
  lines.push("import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';");
  lines.push('');
  lines.push('export type BundledFirstPartyAgentRegistrationBinding = Readonly<{');
  lines.push('  identity: PluginContributionIdentityV1;');
  lines.push('  implementationOwnerId: string;');
  lines.push('  registrationFamily: string;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS: readonly BundledFirstPartyAgentRegistrationBinding[] = Object.freeze([');
  for (const registration of registrations) {
    lines.push('  Object.freeze({');
    lines.push('    identity: Object.freeze({');
    lines.push(`      pluginId: ${JSON.stringify(registration.pluginId)},`);
    lines.push(`      localId: ${JSON.stringify(registration.localId)},`);
    lines.push('    }),');
    lines.push(`    implementationOwnerId: ${JSON.stringify(registration.implementationOwnerId)},`);
    lines.push(`    registrationFamily: ${JSON.stringify(registration.registrationFamily)},`);
    lines.push('  }),');
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function renderCliBundledPluginEntriesTs(params: Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const registrations = params.pluginPackages.flatMap(
    (pluginPackage): BundledFirstPartyAgentRegistrationIdentity[] => {
      if (!pluginPackage.agentId) return [];
      const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
      return [{
        pluginId: pluginPackage.pluginId,
        localId: readRequiredContributionId(
          manifestAgent,
          'agents',
          pluginPackage.pluginPackageId,
        ),
        implementationOwnerId: pluginPackage.agentId,
        registrationFamily: 'agents',
      }];
    },
  );
  return renderCliBundledAgentRegistrationBindingsTs(registrations);
}

export function renderRetainedCliBundledPluginImplementationEntriesTs(entriesOutPath: string): string {
  const source = readFileSync(entriesOutPath, 'utf8');
  const registrations = [...source.matchAll(
    /identity:\s*(?:createPluginContributionIdentity\(\s*|Object\.freeze\(\s*)?\{\s*pluginId:\s*("(?:\\.|[^"\\])*")\s*,\s*localId:\s*("(?:\\.|[^"\\])*")\s*,?\s*\}\s*\)?\s*,\s*implementationOwnerId:\s*("(?:\\.|[^"\\])*")\s*,\s*registrationFamily:\s*(['"])([^'"]+)\4\s*,/gms,
  )].map((match): BundledFirstPartyAgentRegistrationIdentity => ({
    pluginId: JSON.parse(match[1]!),
    localId: JSON.parse(match[2]!),
    implementationOwnerId: JSON.parse(match[3]!),
    registrationFamily: match[5]!,
  }));
  if (registrations.length === 0) {
    throw new Error(
      `Invalid generated bundled plugin registry at ${entriesOutPath}: missing Agent registration bindings`,
    );
  }
  return renderCliBundledAgentRegistrationBindingsTs(registrations);
}

function renderCliBundledPluginArtifactRecordsTs(
  artifacts: readonly JsonValue[],
  sourceArtifactIntegrities: readonly JsonValue[],
): string {
  return [
    '/** GENERATED FILE CONTRACT (WS4.T2/SVC11 bundled immutable artifacts). */',
    "import type { BundledImmutablePluginArtifact } from '../../../store/registry/generationStore';",
    '',
    'export const BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS = Object.freeze(',
    `${renderJsonLiteral(artifacts as unknown as JsonValue)} satisfies readonly BundledImmutablePluginArtifact[]);`,
    '',
    '/**',
    ' * Publisher- and pack-time source-artifact integrity facts. The publisher',
    ' * uses immutable-artifact entries only to retain or rotate its opaque',
    ' * generation record; the verifier checks every bundled package entry.',
    ' * apps/cli/scripts/verifyBundledPluginArtifacts.mjs verifies them. They are',
    ' * not runtime generation/currentness authority.',
    ' */',
    'export type BundledFirstPartySourceArtifactIntegrity = Readonly<{',
    '  packageName: string;',
    '  files: readonly Readonly<{',
    '    relativePath: string;',
    '    byteLength: number;',
    '    digest: string;',
    '  }>[];',
    '}>;',
    '',
    'export const BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES = Object.freeze(',
    `${renderJsonLiteral(sourceArtifactIntegrities as unknown as JsonValue)} satisfies readonly BundledFirstPartySourceArtifactIntegrity[]);`,
    '',
  ].join('\n');
}

function requireBundledPluginSourceArtifactIntegrity(
  pluginPackage: BundledPluginPackage,
): BundledFirstPartySourceArtifactIntegrity {
  if (!pluginPackage.sourceArtifactIntegrity) {
    throw new Error(
      `Bundled plugin '${pluginPackage.packageName}' has no pack-time source artifact integrity`,
    );
  }
  return pluginPackage.sourceArtifactIntegrity;
}

function renderCliBundledPluginArtifactsTs(pluginPackages: readonly BundledPluginPackage[]): string {
  const artifacts = pluginPackages.flatMap((entry) => entry.immutableArtifact
    ? [{
      packageName: entry.packageName,
      packageEntryRelativePath: entry.immutableArtifact.packageEntryRelativePath,
      daemonEntryRelativePath: entry.immutableArtifact.daemonEntryRelativePath,
      record: entry.immutableArtifact.record,
    }]
    : []);
  const sourceArtifactIntegrities = pluginPackages.map(requireBundledPluginSourceArtifactIntegrity);
  return renderCliBundledPluginArtifactRecordsTs(
    artifacts as unknown as readonly JsonValue[],
    sourceArtifactIntegrities as unknown as readonly JsonValue[],
  );
}

function renderTargetedCliBundledPluginArtifactsTs(params: Readonly<{
  artifactsOutPath: string;
  selectedPluginPackages: readonly BundledPluginPackage[];
}>): string {
  const source = existsSync(params.artifactsOutPath)
    ? readFileSync(params.artifactsOutPath, 'utf8')
    : '';
  const priorArtifacts = readGeneratedJsonExportLiteral(
    source,
    'BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS',
    params.artifactsOutPath,
  ) ?? [];
  const priorIntegrities = readGeneratedJsonExportLiteral(
    source,
    'BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES',
    params.artifactsOutPath,
  ) ?? [];
  if (!Array.isArray(priorArtifacts) || !Array.isArray(priorIntegrities)) {
    throw new Error(
      `Invalid generated bundled artifact publication at ${params.artifactsOutPath}: immutable artifacts and source integrities must both be arrays`,
    );
  }

  const selectedPackageNames = new Set(
    params.selectedPluginPackages.map((pluginPackage) => pluginPackage.packageName),
  );
  const readPackageName = (value: unknown, label: string): string => {
    if (!isRecord(value) || Array.isArray(value) || typeof value.packageName !== 'string') {
      throw new Error(
        `Invalid generated bundled artifact publication at ${params.artifactsOutPath}: ${label} has no packageName`,
      );
    }
    return value.packageName;
  };
  const artifacts = priorArtifacts.filter((artifact, index) => (
    !selectedPackageNames.has(readPackageName(artifact, `immutable artifact ${String(index)}`))
  ));
  const sourceArtifactIntegrities = priorIntegrities.filter((integrity, index) => (
    !selectedPackageNames.has(readPackageName(integrity, `source integrity ${String(index)}`))
  ));
  for (const pluginPackage of params.selectedPluginPackages) {
    sourceArtifactIntegrities.push(requireBundledPluginSourceArtifactIntegrity(pluginPackage));
    if (pluginPackage.immutableArtifact) {
      artifacts.push({
        packageName: pluginPackage.packageName,
        packageEntryRelativePath: pluginPackage.immutableArtifact.packageEntryRelativePath,
        daemonEntryRelativePath: pluginPackage.immutableArtifact.daemonEntryRelativePath,
        record: pluginPackage.immutableArtifact.record,
      });
    }
  }
  const comparePackageName = (left: unknown, right: unknown): number => (
    readPackageName(left, 'record').localeCompare(readPackageName(right, 'record'))
  );
  artifacts.sort(comparePackageName);
  sourceArtifactIntegrities.sort(comparePackageName);
  return renderCliBundledPluginArtifactRecordsTs(
    artifacts as readonly JsonValue[],
    sourceArtifactIntegrities as readonly JsonValue[],
  );
}

function toAgentConstPrefix(agentId: string): string {
  return agentId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function renderTsStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

function renderTsImportSpecifier(source: string): string {
  const normalized = source.replaceAll('\\', '/').trim();
  if (!normalized) {
    throw new Error('Invalid generated import source: expected non-empty string');
  }
  if (!normalized.startsWith('.') && !normalized.startsWith('/')) {
    return normalized;
  }
  return /\.(?:mjs|cjs|jsx?|tsx?)$/.test(normalized) ? normalized.replace(/\.(?:tsx?|jsx?)$/, '.js') : `${normalized}.js`;
}

function renderTsNullableStringLiteral(value: string | null): string {
  return value === null ? 'null' : renderTsStringLiteral(value);
}

function renderTsStringArrayLiteral(values: readonly string[]): string {
  return `[${values.map((value) => renderTsStringLiteral(value)).join(', ')}]`;
}

function renderAgentLogoSvgXmlExpression(svgIconKey: string | null): string {
  if (!svgIconKey) return 'null';
  if (/^[A-Za-z_$][\w$]*$/.test(svgIconKey)) {
    return `AGENT_LOGO_SVG_XML.${svgIconKey} ?? null`;
  }
  return `AGENT_LOGO_SVG_XML[${renderTsStringLiteral(svgIconKey)}] ?? null`;
}

function renderThemeColorExpression(token: string): string {
  return `theme.colors.${token}`;
}

function renderDescriptorGeneratedSvgPath(path: DescriptorGeneratedSvgIconPathSource): string {
  const attributes = [
    ...(path.fillToken === undefined ? [] : [`fill="\${${renderThemeColorExpression(path.fillToken)}}"`]),
    ...(path.fillOpacity === undefined ? [] : [`fill-opacity="${String(path.fillOpacity)}"`]),
    ...(path.fillRule === undefined ? [] : [`fill-rule="${path.fillRule}"`]),
    ...(path.clipRule === undefined ? [] : [`clip-rule="${path.clipRule}"`]),
    `d="${path.d}"`,
  ];
  return `<path ${attributes.join(' ')}/>`;
}

function renderDescriptorGeneratedSvgIconLines(source: DescriptorGeneratedSvgIconSource): readonly string[] {
  const lines: string[] = [];
  lines.push(`const ${source.constName}: AgentIconSvgXmlResolver = (theme): string => createGeneratedSvgIconXml(`);
  lines.push(`    ${renderTsStringLiteral(source.viewBox)},`);
  lines.push('    `');
  for (const path of source.paths) {
    lines.push(`        ${renderDescriptorGeneratedSvgPath(path)}`);
  }
  lines.push('    `,');
  lines.push(');');
  return lines;
}

function hasDescriptorFields(value: JsonObject | undefined): value is JsonObject {
  return value !== undefined && Object.keys(value).length > 0;
}

function readDescriptorString(value: JsonObject | undefined, key: string): string | null {
  const property = value?.[key];
  return typeof property === 'string' && property.trim().length > 0 ? property : null;
}

function readUiDescriptorSvgIconKey(descriptor: AgentUiDescriptor): string | null {
  const assetId = readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon')
    ? readDescriptorString(readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon') ?? undefined, 'assetId')
    : null;
  return assetId ?? descriptor.display.icon?.assetId ?? null;
}

function assertSafeSvgAttributeValue(value: string, path: string): void {
  if (
    value.trim().length === 0
    || /["`<>]/u.test(value)
    || value.includes('${')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected safe SVG attribute text`);
  }
}

function readSvgRule(value: unknown, path: string): 'evenodd' | 'nonzero' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'evenodd' && value !== 'nonzero') {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected evenodd or nonzero`);
  }
  return value;
}

function readOptionalFillOpacity(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected finite number between 0 and 1`);
  }
  return value;
}

function readSvgThemeToken(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value)) {
    throw new Error(`Invalid agent UI descriptor at ${path}: expected theme token path`);
  }
  return value;
}

function readDescriptorGeneratedSvgIcon(
  descriptor: AgentUiDescriptor,
  constPrefix: string,
): DescriptorGeneratedSvgIconSource | undefined {
  const svgIcon = readJsonObjectProperty(descriptor.assets ?? {}, 'svgIcon');
  if (!svgIcon) return undefined;

  const viewBox = readOptionalJsonStringProperty(svgIcon, 'viewBox') ?? undefined;
  const pathValues = readJsonArrayProperty(svgIcon, 'paths');
  if (viewBox === undefined && pathValues.length === 0) return undefined;
  if (viewBox === undefined || pathValues.length === 0) {
    throw new Error(
      `Invalid agent UI descriptor at assets.svgIcon for ${descriptor.agentId}: viewBox and paths must be provided together`,
    );
  }
  assertSafeSvgAttributeValue(viewBox, `${descriptor.agentId}.assets.svgIcon.viewBox`);

  return {
    constName: `${constPrefix}_SVG_ICON_XML`,
    viewBox,
    paths: pathValues.map((entry, index) => {
      const path = readRequiredRecord(entry, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}]`);
      const d = readRequiredString(path, 'd', `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}]`);
      assertSafeSvgAttributeValue(d, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].d`);
      return {
        d,
        ...(readSvgThemeToken(path.fillToken, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillToken`) === undefined
          ? {}
          : {
            fillToken: readSvgThemeToken(
              path.fillToken,
              `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillToken`,
            ),
          }),
        ...(readOptionalFillOpacity(path.fillOpacity, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillOpacity`) === undefined
          ? {}
          : {
            fillOpacity: readOptionalFillOpacity(
              path.fillOpacity,
              `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillOpacity`,
            ),
          }),
        ...(readSvgRule(path.fillRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillRule`) === undefined
          ? {}
          : { fillRule: readSvgRule(path.fillRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].fillRule`) }),
        ...(readSvgRule(path.clipRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].clipRule`) === undefined
          ? {}
          : { clipRule: readSvgRule(path.clipRule, `${descriptor.agentId}.assets.svgIcon.paths[${String(index)}].clipRule`) }),
      };
    }),
  };
}

function buildVisibleMessageDescriptor(descriptor: AgentUiDescriptor): JsonObject | undefined {
  const visibleMessages = readJsonObjectProperty(descriptor.session ?? {}, 'visibleMessages');
  return hasDescriptorFields(visibleMessages ?? undefined) ? visibleMessages ?? undefined : undefined;
}

function normalizePluginRuntimeProjectionSource(source: string): string {
  const normalized = source.replaceAll('\\', '/').trim();
  if (normalized === '.') {
    throw new Error(
      `Invalid plugin runtime projection source '${source}': first-party runtime contributions must use a narrow ./agent/contributions/runtime entrypoint`,
    );
  }
  if (!normalized.startsWith('./')) {
    throw new Error(`Invalid plugin runtime projection source '${source}': expected ./-relative path`);
  }
  const withoutPrefix = normalized.slice(2);
  if (
    withoutPrefix.length === 0
    || withoutPrefix.startsWith('/')
    || withoutPrefix.startsWith('../')
    || withoutPrefix.includes('/../')
    || withoutPrefix.endsWith('/..')
  ) {
    throw new Error(`Invalid plugin runtime projection source '${source}': path escapes src`);
  }
  return withoutPrefix.replace(/\.(?:tsx?|jsx?)$/, '');
}

function resolvePluginRuntimeProjectionSourceFile(repoRoot: string, pluginPackageId: string, source: string): string {
  const normalized = normalizePluginRuntimeProjectionSource(source);
  const basePath = normalized === '.'
    ? resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/index')
    : resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src', normalized);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Missing plugin runtime projection source for ${pluginPackageId}: ${source}`);
  }
  return match;
}

function readProviderOwnedEnvironmentKeys(
  pluginPackage: BundledPluginPackage,
  agentId: string,
): readonly string[] {
  const contribution = readManifestContributionArray(pluginPackage.manifest, 'agents')
    .find((entry) => readRequiredContributionId(entry, 'agents', pluginPackage.packageName) === agentId);
  if (!contribution) return [];
  const providerRequirements = readJsonObjectProperty(contribution, 'providerRequirements');
  const authIsolation = providerRequirements ? readJsonObjectProperty(providerRequirements, 'authIsolation') : undefined;
  const raw = authIsolation?.ownedEnvKeys;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    throw new Error(`${pluginPackage.packageName}.contributes.agents.${agentId}.providerRequirements.authIsolation.ownedEnvKeys must be a string array`);
  }
  return raw;
}

function createDescriptorAgentUiProjectionSource(
  pluginPackage: BundledPluginPackage,
  descriptor: AgentUiDescriptor,
): DescriptorAgentUiProjectionSource {
  const constPrefix = toAgentConstPrefix(descriptor.agentId);
  const svgIcon = readDescriptorGeneratedSvgIcon(descriptor, constPrefix);
  return {
    agentId: descriptor.agentId,
    coreConst: `${constPrefix}_CORE`,
    uiConst: `${constPrefix}_UI`,
    descriptor,
    providerOwnedEnvironmentKeys: readProviderOwnedEnvironmentKeys(pluginPackage, descriptor.agentId),
    ...(svgIcon === undefined ? {} : { svgIcon }),
  };
}

/**
 * Reads the one declaration that decides whether an Agent offers the MCP
 * settings screen's detected-config scan: a manifest
 * `contributes.mcp.discoverySources` entry this Agent owns.
 *
 * Ownership is the declaration's `metadata.agentId`, exactly as the daemon's
 * detection resolves it (see
 * `apps/cli/src/mcp/providerDetection/detectProviderMcpServers.ts`), never the
 * contribution's plugin-chosen local id. Deriving from the same fact the scan
 * runs on is what keeps the screen from offering a scan the daemon has no
 * source for, or hiding one it does.
 */
function collectAgentUiBehaviorDescriptorSources(pluginPackages: readonly BundledPluginPackage[]): readonly AgentUiBehaviorDescriptorSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentUiBehaviorDescriptorSource[] => {
    const behavior = pluginPackage.agentUiDescriptor?.behavior;
    const components = pluginPackage.agentUiDescriptor?.components;
    const message = pluginPackage.agentUiDescriptor?.message;
    const agentId = pluginPackage.agentUiDescriptor?.agentId;
    const projection: JsonObject = {
      ...(hasDescriptorFields(behavior) ? behavior : {}),
      ...(hasDescriptorFields(message) ? { message } : {}),
      ...(hasDescriptorFields(components) ? { components } : {}),
    };
    if (
      !hasDescriptorFields(projection)
      && !pluginPackage.agentPredecessorMessageMetaWriter
    ) {
      return [];
    }
    if (!agentId) return [];
    return [{
      agentId,
      descriptor: projection,
      ...(pluginPackage.agentPredecessorMessageMetaWriter
        ? { predecessorMessageMetaWriter: pluginPackage.agentPredecessorMessageMetaWriter }
        : {}),
    }];
  });
}

function collectAgentSessionBehaviorSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly AgentSessionBehaviorSource[] {
  return pluginPackages.flatMap((pluginPackage): AgentSessionBehaviorSource[] => {
    const projection = pluginPackage.agentUiDescriptor?.session;
    if (!hasDescriptorFields(projection) || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function collectVisibleMessageResolverSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly SessionSubagentVisibleMessageResolverSource[] {
  return pluginPackages.flatMap((pluginPackage): SessionSubagentVisibleMessageResolverSource[] => {
    const projection = pluginPackage.agentUiDescriptor
      ? buildVisibleMessageDescriptor(pluginPackage.agentUiDescriptor)
      : undefined;
    if (!projection || !pluginPackage.agentUiDescriptor?.agentId) return [];
    return [{
      agentId: pluginPackage.agentUiDescriptor.agentId,
      descriptor: projection,
    }];
  });
}

function renderDescriptorGeneratedUiProjectionLines(source: DescriptorAgentUiProjectionSource): readonly string[] {
  const { descriptor } = source;
  const agentId = renderTsStringLiteral(descriptor.agentId);
  const svgIconXmlExpression = source.svgIcon?.constName ?? renderAgentLogoSvgXmlExpression(readUiDescriptorSvgIconKey(descriptor));
  const lines: string[] = [];
  if (source.svgIcon) {
    lines.push(...renderDescriptorGeneratedSvgIconLines(source.svgIcon));
    lines.push('');
  }
  lines.push(`const ${source.coreConst}: AgentCoreConfig = {`);
  lines.push(`    id: ${agentId},`);
  lines.push(`    displayNameKey: ${renderTsStringLiteral(descriptor.display.nameKey)},`);
  lines.push(`    subtitleKey: ${renderTsStringLiteral(descriptor.display.subtitleKey)},`);
  lines.push(`    permissionModeI18nPrefix: ${renderTsStringLiteral(descriptor.display.permissionModeI18nPrefix)},`);
  lines.push(`    availability: { experimental: ${String(descriptor.display.availability.experimental)} },`);
  lines.push(`    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: ${agentId} }),`);
  lines.push(
    `    uiConnectedService: { serviceId: ${renderTsNullableStringLiteral(descriptor.display.connectedService.serviceId)}, labelKey: ${renderTsStringLiteral(descriptor.display.connectedService.labelKey)}, connectRoute: ${renderTsNullableStringLiteral(descriptor.display.connectedService.connectRoute)} },`,
  );
  lines.push(`    flavorAliases: ${renderTsStringArrayLiteral(descriptor.display.flavorAliases)},`);
  lines.push(`    providerOwnedEnvironmentKeys: ${renderTsStringArrayLiteral(source.providerOwnedEnvironmentKeys)},`);
  lines.push(`    cli: buildCatalogAgentCliUiConfig(${agentId}),`);
  lines.push('    permissions: {');
  lines.push(`        modeGroup: ${renderTsStringLiteral(descriptor.display.permissions.modeGroup)},`);
  lines.push(`        promptProtocol: ${renderTsStringLiteral(descriptor.display.permissions.promptProtocol)},`);
  lines.push('    },');
  lines.push('    sessionModes: {');
  lines.push(`        kind: getAgentSessionModesKind(${agentId}),`);
  const staticOptions = descriptor.display.sessionModes?.staticOptions;
  if (staticOptions && staticOptions.length > 0) {
    lines.push('        staticOptions: [');
    for (const option of staticOptions) {
      const fields = [
        `id: ${renderTsStringLiteral(option.id)}`,
        `nameKey: ${renderTsStringLiteral(option.nameKey)}`,
        ...(option.descriptionKey === undefined
          ? []
          : [`descriptionKey: ${renderTsStringLiteral(option.descriptionKey)}`]),
      ];
      lines.push(`            { ${fields.join(', ')} },`);
    }
    lines.push('        ],');
  }
  lines.push('    },');
  if (descriptor.display.runtimeInput) {
    lines.push('    runtimeInput: {');
    lines.push(`        inFlightSteerSupported: ${String(descriptor.display.runtimeInput.inFlightSteerSupported)},`);
    lines.push('    },');
  }
  lines.push(`    model: getAgentModelConfig(${agentId}),`);
  lines.push('    resume: buildAgentResumeUiConfig({');
  lines.push(`        agentId: ${agentId},`);
  lines.push(`        uiVendorResumeIdLabelKey: ${renderTsNullableStringLiteral(descriptor.display.resume.uiVendorResumeIdLabelKey)},`);
  lines.push(`        uiVendorResumeIdCopiedKey: ${renderTsNullableStringLiteral(descriptor.display.resume.uiVendorResumeIdCopiedKey)},`);
  lines.push('    }),');
  if (descriptor.display.localControl === true) {
    lines.push(`    localControl: buildAgentLocalControlUiConfig({ agentId: ${agentId} }),`);
  }
  lines.push('    toolRendering: {');
  lines.push(`        hideUnknownToolsByDefault: ${String(descriptor.display.toolRendering.hideUnknownToolsByDefault)},`);
  lines.push('    },');
  lines.push(`    tools: buildAgentToolsUiConfig({ agentId: ${agentId} }),`);
  lines.push(`    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: ${agentId} }),`);
  lines.push('    ui: {');
  lines.push(`        agentPickerIconName: ${renderTsStringLiteral(descriptor.display.picker.iconName)},`);
  lines.push(`        cliGlyphScale: ${String(descriptor.display.picker.cliGlyphScale)},`);
  lines.push(`        profileCompatibilityGlyphScale: ${String(descriptor.display.picker.profileCompatibilityGlyphScale)},`);
  lines.push('    },');
  lines.push('};');
  lines.push('');
  lines.push(`const ${source.uiConst}: AgentUiConfig = {`);
  lines.push(`    id: ${agentId},`);
  lines.push('    icon: null,');
  lines.push(`    svgIconXml: ${svgIconXmlExpression},`);
  if (typeof descriptor.display.picker.iconScale === 'number') {
    lines.push(`    pickerIconScale: ${String(descriptor.display.picker.iconScale)},`);
  }
  lines.push('    tintColor: null,');
  lines.push('    avatarOverlay: {');
  lines.push(`        circleScale: ${String(descriptor.display.avatarOverlay.circleScale)},`);
  lines.push(`        iconScale: ({ size }: { size: number }) => Math.round(size * ${String(descriptor.display.avatarOverlay.iconScaleRatio)}),`);
  lines.push('    },');
  lines.push(`    cliGlyph: ${renderTsStringLiteral(descriptor.display.picker.cliGlyph)},`);
  lines.push('};');
  return lines;
}

function renderQwenGeneratedUiProjectionLines(): readonly string[] {
  return [
    'const QWEN_CORE: AgentCoreConfig = {',
    '    id: \'qwen\',',
    '    displayNameKey: \'agentInput.agent.qwen\',',
    '    subtitleKey: \'profiles.aiBackend.qwenSubtitleExperimental\',',
    '    permissionModeI18nPrefix: \'agentInput.codexPermissionMode\',',
    '    availability: { experimental: true },',
    '    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: \'qwen\' }),',
    '    uiConnectedService: { serviceId: null, labelKey: \'agentInput.agent.qwen\', connectRoute: null },',
    '    flavorAliases: [\'qwen\', \'qwen-code\'],',
    '    cli: buildCatalogAgentCliUiConfig(\'qwen\'),',
    '    permissions: {',
    '        modeGroup: \'codexLike\',',
    '        promptProtocol: \'codexDecision\',',
    '    },',
    '    sessionModes: {',
    '        kind: getAgentSessionModesKind(\'qwen\'),',
    '    },',
    '    model: getAgentModelConfig(\'qwen\'),',
    '    resume: buildAgentResumeUiConfig({',
    '        agentId: \'qwen\',',
    '        uiVendorResumeIdLabelKey: \'sessionInfo.qwenSessionId\',',
    '        uiVendorResumeIdCopiedKey: \'sessionInfo.qwenSessionIdCopied\',',
    '    }),',
    '    toolRendering: {',
    '        hideUnknownToolsByDefault: true,',
    '    },',
    '    tools: buildAgentToolsUiConfig({ agentId: \'qwen\' }),',
    '    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: \'qwen\' }),',
    '    ui: {',
    '        agentPickerIconName: \'code-slash-outline\',',
    '        cliGlyphScale: 1.0,',
    '        profileCompatibilityGlyphScale: 1.0,',
    '    },',
    '};',
    '',
    'const QWEN_UI: AgentUiConfig = {',
    '    id: \'qwen\',',
    '    icon: null,',
    '    svgIconXml: AGENT_LOGO_SVG_XML.qwen ?? null,',
    '    pickerIconScale: 0.9,',
    '    tintColor: null,',
    '    avatarOverlay: {',
    '        circleScale: 0.35,',
    '        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),',
    '    },',
    '    cliGlyph: \'Q\',',
    '};',
  ];
}

function renderUiBundledPluginEntriesTs(params: Readonly<{
  packageNames: readonly string[];
  pluginPackages: readonly BundledPluginPackage[];
}>): string {
  const generatedSourcesByAgentId = new Map(
    GENERATED_AGENT_UI_PROJECTION_SOURCES.map((source) => [source.agentId, source] as const),
  );
  const descriptorSourcesByAgentId = new Map(
    params.pluginPackages
      .flatMap((entry) => (entry.agentUiDescriptor ? [createDescriptorAgentUiProjectionSource(entry, entry.agentUiDescriptor)] : []))
      .map((source) => [source.agentId, source] as const),
  );
  const uiProjectionOrder = new Set(AGENT_UI_PROJECTION_ORDER);
  for (const agentId of descriptorSourcesByAgentId.keys()) {
    if (!uiProjectionOrder.has(agentId)) {
      throw new Error(`Bundled agent UI descriptor '${agentId}' is missing from AGENT_UI_PROJECTION_ORDER`);
    }
  }
  const bundledAgentIds = new Set(
    params.pluginPackages.flatMap((entry) => (entry.agentId ? [entry.agentId] : [])),
  );
  const pluginPackageByAgentId = new Map(
    params.pluginPackages.flatMap((entry) => entry.agentId ? [[entry.agentId, entry] as const] : []),
  );
  const selectedProjectionSources = AGENT_UI_PROJECTION_ORDER.flatMap((agentId) => {
    const descriptorSource = descriptorSourcesByAgentId.get(agentId);
    const generatedSource = generatedSourcesByAgentId.get(agentId);
    if (!descriptorSource && !generatedSource) return [];
    let projectionLines = descriptorSource
      ? renderDescriptorGeneratedUiProjectionLines(descriptorSource)
      : generatedSource?.renderLines() ?? [];
    if (!descriptorSource && generatedSource) {
      const pluginPackage = pluginPackageByAgentId.get(agentId);
      const providerOwnedEnvironmentKeys = pluginPackage
        ? readProviderOwnedEnvironmentKeys(pluginPackage, agentId)
        : [];
      const insertionIndex = projectionLines.findIndex((line) => line.trimStart().startsWith('flavorAliases:'));
      if (insertionIndex < 0) throw new Error(`Generated UI projection '${agentId}' has no flavorAliases insertion anchor`);
      projectionLines = [
        ...projectionLines.slice(0, insertionIndex + 1),
        `    providerOwnedEnvironmentKeys: ${renderTsStringArrayLiteral(providerOwnedEnvironmentKeys)},`,
        ...projectionLines.slice(insertionIndex + 1),
      ];
    }
    return [{
      agentId,
      coreConst: descriptorSource?.coreConst ?? generatedSource?.coreConst,
      uiConst: descriptorSource?.uiConst ?? generatedSource?.uiConst,
      projectionLines,
    }];
  });
  const selectedProjectionSourcesByAgentId = new Map(
    selectedProjectionSources.map((source) => [source.agentId, source] as const),
  );
  const usesGeneratedSvgIcons = selectedProjectionSources.some((source) =>
    source.projectionLines.some((line) =>
      line.includes('AgentIconSvgXmlResolver') || line.includes('createGeneratedSvgIconXml('),
    ),
  );

  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled plugins.');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * UI facts here are descriptor-derived and no-execute; this file must not import plugin UI runtime exports.');
  lines.push(' */');
  lines.push('');
  lines.push('import type { AgentCoreConfig, CanonicalAgentId } from \'./registryCore\';');
  lines.push(usesGeneratedSvgIcons
    ? 'import type { AgentIconSvgXmlResolver, AgentUiConfig } from \'./registryUi\';'
    : 'import type { AgentUiConfig } from \'./registryUi\';');
  lines.push('import { AGENT_LOGO_SVG_XML } from \'./agentLogoSvgXml\';');
  lines.push('');
  lines.push('import { buildCatalogAgentCliUiConfig } from \'@/agents/registry/buildCatalogAgentCliUiConfig\';');
  lines.push('import { buildAgentConnectedServicesUiConfig } from \'@/agents/registry/buildAgentConnectedServicesUiConfig\';');
  lines.push('import { buildAgentLocalControlUiConfig } from \'@/agents/registry/buildAgentLocalControlUiConfig\';');
  lines.push('import { buildAgentResumeUiConfig } from \'@/agents/registry/buildAgentResumeUiConfig\';');
  lines.push('import { buildAgentSessionStorageUiConfig } from \'@/agents/registry/buildAgentSessionStorageUiConfig\';');
  lines.push('import { buildAgentToolsUiConfig } from \'@/agents/registry/buildAgentToolsUiConfig\';');
  lines.push('import { getAgentModelConfig, getAgentSessionModesKind } from \'@happier-dev/agents\';');
  lines.push('');
  if (usesGeneratedSvgIcons) {
    lines.push('function normalizeGeneratedSvgXml(xml: string): string {');
    lines.push('    return xml.replace(/\\s{2,}/g, \' \').trim();');
    lines.push('}');
    lines.push('');
    lines.push('function createGeneratedSvgIconXml(viewBox: string, body: string): string {');
    lines.push('    return normalizeGeneratedSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`);');
    lines.push('}');
    lines.push('');
  }
  for (const source of selectedProjectionSources) {
    lines.push(...source.projectionLines);
    lines.push('');
  }
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([');
  for (const packageName of params.packageNames) {
    lines.push(`  ${JSON.stringify(packageName)},`);
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES: Readonly<Record<');
  lines.push('  CanonicalAgentId,');
  lines.push('  Readonly<{ pluginId: string; localId: string }>');
  lines.push('>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const pluginPackage = pluginPackageByAgentId.get(agentId);
    if (!pluginPackage) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing bundled plugin package for Agent identity '${agentId}'`);
    }
    const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
    const localId = readRequiredContributionId(manifestAgent, 'agents', pluginPackage.pluginPackageId);
    lines.push(`    ${agentId}: Object.freeze({`);
    lines.push(`        pluginId: ${JSON.stringify(pluginPackage.pluginId)},`);
    lines.push(`        localId: ${JSON.stringify(localId)},`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCoreConfig>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.coreConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI core projection source for ${agentId}`);
    }
    lines.push(`    ${agentId}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Record<CanonicalAgentId, AgentCoreConfig>>);');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENTS_UI: Readonly<Record<CanonicalAgentId, AgentUiConfig>> = Object.freeze({');
  for (const agentId of AGENT_UI_PROJECTION_ORDER) {
    const valueName = selectedProjectionSourcesByAgentId.get(agentId)?.uiConst;
    if (!valueName) {
      if (!bundledAgentIds.has(agentId)) continue;
      throw new Error(`Missing UI projection source for ${agentId}`);
    }
    lines.push(`    ${agentId}: ${valueName},`);
  }
  lines.push('} satisfies Readonly<Record<CanonicalAgentId, AgentUiConfig>>);');
  lines.push('');
  return lines.join('\n');
}

function renderBundledUiBehaviorOverridesTs(sources: readonly AgentUiBehaviorDescriptorSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * Agent UI descriptors and predecessor-scoped message metadata writers.');
  lines.push(' *');
  lines.push(' * It is split out from `generatedBundledPluginEntries.ts` to avoid import cycles');
  lines.push(' * between agent UI behavior graphs, message compatibility, and registry maps.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { CanonicalAgentId } from \'./registryCore\';');
  const predecessorMessageMetaWriterSources = sources.flatMap((source) => (
    source.predecessorMessageMetaWriter ? [source.predecessorMessageMetaWriter] : []
  ));
  for (const source of predecessorMessageMetaWriterSources) {
    lines.push(`import { ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`);
  }
  lines.push('');
  lines.push('export type BundledAgentUiBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledAgentUiBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export type BundledAgentPredecessorMessageMetaWriter = Readonly<{');
  lines.push('    buildPredecessorMessageMeta(settings: Readonly<Record<string, unknown>>):');
  lines.push('        Readonly<Record<string, string | number | boolean | null | readonly string[]>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_PREDECESSOR_MESSAGE_META_WRITERS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledAgentPredecessorMessageMetaWriter>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    if (!source.predecessorMessageMetaWriter) continue;
    lines.push(`    ${source.agentId}: ${source.predecessorMessageMetaWriter.importName},`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function collectBundledPluginUiTranslations(
  pluginPackages: readonly BundledPluginPackage[],
): JsonObject {
  const messagesByLocale = new Map<string, Map<string, { owner: string; value: string }>>();
  for (const pluginPackage of pluginPackages) {
    const contributes = isRecord(pluginPackage.manifest.contributes)
      ? pluginPackage.manifest.contributes
      : {};
    const ui = isRecord(contributes.ui) ? contributes.ui : {};
    const translations = Array.isArray(ui.translations) ? ui.translations : [];
    for (const translation of translations) {
      if (!isRecord(translation) || typeof translation.locale !== 'string' || !isRecord(translation.messages)) {
        throw new Error(`Invalid bundled UI translation contribution in ${pluginPackage.pluginPackageId}`);
      }
      const localeMessages = messagesByLocale.get(translation.locale) ?? new Map();
      messagesByLocale.set(translation.locale, localeMessages);
      for (const [key, value] of Object.entries(translation.messages)) {
        if (typeof value !== 'string') {
          throw new Error(`Invalid bundled UI translation '${key}' in ${pluginPackage.pluginPackageId}`);
        }
        const existing = localeMessages.get(key);
        if (existing) {
          throw new Error(
            `Duplicate bundled UI translation '${translation.locale}:${key}' from ${existing.owner} and ${pluginPackage.pluginPackageId}`,
          );
        }
        localeMessages.set(key, { owner: pluginPackage.pluginPackageId, value });
      }
    }
  }

  return Object.fromEntries(
    [...messagesByLocale.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([locale, messages]) => [
        locale,
        Object.fromEntries(
          [...messages.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, entry.value]),
        ),
      ]),
  ) as JsonObject;
}

function assertDescriptorConnectedServiceLabelTranslations(
  pluginPackages: readonly BundledPluginPackage[],
): void {
  for (const pluginPackage of pluginPackages) {
    const descriptor = pluginPackage.agentUiDescriptor;
    if (!descriptor) continue;

    const labelKey = descriptor.display.connectedService.labelKey;
    if (labelKey === descriptor.display.nameKey) continue;

    const contributes = isRecord(pluginPackage.manifest.contributes)
      ? pluginPackage.manifest.contributes
      : {};
    const ui = isRecord(contributes.ui) ? contributes.ui : {};
    const translations = Array.isArray(ui.translations) ? ui.translations : [];
    const ownsEnglishLabel = translations.some((translation) => (
      isRecord(translation)
      && translation.locale === 'en'
      && isRecord(translation.messages)
      && typeof translation.messages[labelKey] === 'string'
    ));
    if (!ownsEnglishLabel) {
      throw new Error(
        `Invalid agent UI descriptor for ${descriptor.agentId}: display.connectedService.labelKey '${labelKey}' must equal display.nameKey or be declared by the same plugin in contributes.ui.translations locale 'en'`,
      );
    }
  }
}

function renderBundledPluginTranslationsTs(translations: JsonObject): string {
  return [
    '/**',
    ' * GENERATED FILE CONTRACT (G5-bundled-plugin-translations)',
    ' *',
    ' * This file is emitted by:',
    ' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`',
    ' */',
    '',
    `export const BUNDLED_PLUGIN_TRANSLATIONS = Object.freeze(${renderJsonLiteral(translations)} as const);`,
    '',
    'type KeysOfUnion<T> = T extends T ? keyof T : never;',
    'type BundledPluginTranslationBundle = (typeof BUNDLED_PLUGIN_TRANSLATIONS)[keyof typeof BUNDLED_PLUGIN_TRANSLATIONS];',
    'export type BundledPluginTranslationKey = KeysOfUnion<BundledPluginTranslationBundle> & string;',
    '',
  ].join('\n');
}

function renderBundledSessionAgentBehaviorsTs(sources: readonly AgentSessionBehaviorSource[]): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry map for first-party bundled');
  lines.push(' * agent session provider behaviors.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { CanonicalAgentId } from \'./registryCore\';');
  lines.push('import type { SessionProviderBehavior } from \'@/sync/domains/session/providers/sessionProviderBehaviorTypes\';');
  lines.push('');
  lines.push('export type BundledSessionAgentBehaviorDescriptor = Readonly<{');
  lines.push('    agentId: CanonicalAgentId;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIOR_DESCRIPTORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, BundledSessionAgentBehaviorDescriptor>>');
  lines.push('> = Object.freeze({');
  for (const source of sources) {
    lines.push(`    ${source.agentId}: Object.freeze({`);
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)} as CanonicalAgentId,`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push('});');
  lines.push('');
  lines.push('export const BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIORS: Readonly<');
  lines.push('    Partial<Record<CanonicalAgentId, SessionProviderBehavior>>');
  lines.push('> = Object.freeze({});');
  lines.push('');
  return lines.join('\n');
}

function renderBundledVisibleMessageResolversTs(
  sources: readonly SessionSubagentVisibleMessageResolverSource[],
): string {
  const lines: string[] = [];
  lines.push('/* eslint-disable @typescript-eslint/naming-convention */');
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (PS-04)');
  lines.push(' *');
  lines.push(' * This file is the UI-side generated bundled entry list for first-party bundled');
  lines.push(' * session subagent visible-message resolvers.');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { SessionSubagentVisibleMessagesResolver } from \'@/sync/domains/session/subagents/visibleMessages/types\';');
  lines.push('');
  lines.push('export type BundledSessionSubagentVisibleMessageDescriptor = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    descriptor: Readonly<Record<string, unknown>>;');
  lines.push('}>;');
  lines.push('');
  lines.push('export type BundledSessionSubagentVisibleMessageRegistryEntry = Readonly<{');
  lines.push('    agentId: string;');
  lines.push('    resolveVisibleMessages: SessionSubagentVisibleMessagesResolver;');
  lines.push('}>;');
  lines.push('');
  lines.push('export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS: readonly BundledSessionSubagentVisibleMessageDescriptor[] = Object.freeze([');
  for (const source of sources) {
    lines.push('    Object.freeze({');
    lines.push(`        agentId: ${renderTsStringLiteral(source.agentId)},`);
    lines.push(`        descriptor: Object.freeze(${renderJsonLiteral(source.descriptor)} as const),`);
    lines.push('    }),');
  }
  lines.push(']);');
  lines.push('');
  lines.push('export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY: readonly BundledSessionSubagentVisibleMessageRegistryEntry[] = Object.freeze([');
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function collectPromptAssetContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly PromptAssetContributionSource[] {
  return pluginPackages
    .flatMap((pluginPackage) => (
      pluginPackage.promptAssetContributions ? [pluginPackage.promptAssetContributions] : []
    ))
    .sort((a, b) => a.pluginPackageId.localeCompare(b.pluginPackageId));
}

function renderCliPromptAssetPluginDescriptorsTs(
  sources: readonly PromptAssetContributionSource[],
): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.16y.4-agent-runtime-codegen-and-prompt-assets-cleanup)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('import type { PluginPromptAssetAdapterDescriptor } from \'../pluginPromptAssetAdapterDescriptor\';');
  for (const source of sources) {
    lines.push(
      `import { ${PLUGIN_PROMPT_ASSET_EXPORT_NAME} as ${source.importName} } from ${renderTsStringLiteral(source.importPath)};`,
    );
  }
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS: readonly PluginPromptAssetAdapterDescriptor[] = Object.freeze([');
  for (const source of sources) {
    lines.push(`  ...${source.importName},`);
  }
  lines.push(']);');
  lines.push('');
  return lines.join('\n');
}

function toBundledVoiceImportPrefix(packageId: BundledFirstPartyVoicePackageId): string {
  return packageId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function renderBundledVoiceManifestProjectionConstant(
  source: BundledFirstPartyVoiceProjectionSource,
): readonly string[] {
  const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
  return [
    `const ${prefix}_BUNDLED_PLUGIN_MANIFEST = Object.freeze(`,
    `${renderJsonLiteral(source.manifest as unknown as JsonValue)} as const,`,
    ');',
  ];
}

function renderBundledVoiceEntriesTs(
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
): string {
  const exportName = 'VOICE_PROVIDER_PRESENTATIONS';
  const subpath = 'ui/voice';
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Normalized first-party manifest projection plus qualified presentation.');
  lines.push(' * Executable activation roots are emitted separately by host platform.');
  lines.push(' */');
  lines.push('');
  lines.push("import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';");
  lines.push("import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';");
  lines.push("import type { VoiceProviderPresentation } from './voiceProviderPresentation';");
  lines.push('');
  for (const source of sources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(
      `import { ${exportName} as ${prefix}_${exportName} } from '${source.packageName}/${subpath}';`,
    );
  }
  if (sources.length > 0) {
    lines.push('');
    for (const source of sources) {
      lines.push(...renderBundledVoiceManifestProjectionConstant(source));
      lines.push('');
    }
  }
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS = Object.freeze([');
  for (const source of sources) {
    lines.push(`  ...projectBundledVoiceManifestContributions(${toBundledVoiceImportPrefix(source.pluginPackageId)}_BUNDLED_PLUGIN_MANIFEST),`);
  }
  lines.push(']) satisfies readonly BundledVoiceManifestContribution[];');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS = Object.freeze([');
  for (const source of sources) {
    lines.push(`  ...${toBundledVoiceImportPrefix(source.pluginPackageId)}_${exportName},`);
  }
  lines.push(']) satisfies readonly VoiceProviderPresentation[];');
  lines.push('');
  return lines.join('\n');
}

function renderBundledVoiceRuntimeEntriesTs(
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
  platform: BundledVoiceRuntimePlatform,
): string {
  const subpath = 'ui/voice';
  const applicableSources = sources.filter(
    (candidate) => candidate.hasConversationProvider
      && candidate.conversationPlatforms.includes(platform),
  );
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-RUNTIME-PROJECTION)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(` * Executable first-party Voice activation roots for ${platform}.`);
  lines.push(' * Contributions that do not declare this host platform are absent.');
  lines.push(' */');
  lines.push('');
  lines.push(applicableSources.length > 0
    ? "import { createBundledConversationRuntimeEntries, type BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';"
    : "import type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';");
  for (const source of applicableSources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(
      `import { activate as ${prefix}_BUNDLED_VOICE_ACTIVATE } from '${source.packageName}/${subpath}';`,
    );
  }
  if (applicableSources.length > 0) {
    lines.push('');
    for (const source of applicableSources) {
      lines.push(...renderBundledVoiceManifestProjectionConstant(source));
      lines.push('');
    }
  }
  for (const source of applicableSources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(`const ${prefix}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(`);
    lines.push(`  ${prefix}_BUNDLED_PLUGIN_MANIFEST,`);
    lines.push(`  ${prefix}_BUNDLED_VOICE_ACTIVATE,`);
    lines.push(');');
  }
  if (applicableSources.length > 0) lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([');
  for (const source of applicableSources) {
    lines.push(`  ...${toBundledVoiceImportPrefix(source.pluginPackageId)}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`);
  }
  lines.push(']) satisfies readonly BundledConversationRuntimeEntry[];');
  lines.push('');
  lines.push('/**');
  lines.push(' * Exact generated first-party entry identities admitted to the hosted');
  lines.push(' * conversation service. This is intentionally separate from provider ids and');
  lines.push(' * manifest metadata so copied or colliding external entries fail closed.');
  lines.push(' */');
  lines.push('export const BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([');
  const elevenLabsSource = applicableSources.find(
    (candidate) => candidate.pluginPackageId === 'elevenlabs',
  );
  if (elevenLabsSource) {
    lines.push(`  ...${toBundledVoiceImportPrefix(elevenLabsSource.pluginPackageId)}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`);
  }
  lines.push(']) satisfies readonly BundledConversationRuntimeEntry[];');
  lines.push('');
  return lines.join('\n');
}

async function generateBundledPluginEntries(
  options: GeneratorOptions,
  dependencies: GeneratorWorkspaceDependencies,
): Promise<void> {
  if (options.aggregateOnly) {
    await publishBundledPluginUiArtifactProjection(options, dependencies);
    return;
  }

  if (options.workspaceNames.length > 0) {
    const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
    const selectedPackageNames = resolveSelectedBundledPluginPackageNames(
      bundledPluginPackageNames,
      options.workspaceNames,
    );
    const cliArtifactsOutPath = resolve(
      options.rootDir,
      'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts',
    );
    const cliOutPath = resolve(
      options.rootDir,
      'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
    );
    const selectedResult = await collectBundledPluginPackages(
      options.rootDir,
      selectedPackageNames,
      options.mode,
      options.scope,
      dependencies,
    );
    const selectedPluginPackages = assignBundledImmutableArtifactGenerationIds({
      mode: options.mode,
      pluginPackages: selectedResult.pluginPackages,
      priorIdentities: readPriorBundledImmutableArtifactIdentities(cliArtifactsOutPath),
    });
    if (selectedPluginPackages.length > 0) {
      const cliArtifactsOut = renderTargetedCliBundledPluginArtifactsTs({
        artifactsOutPath: cliArtifactsOutPath,
        selectedPluginPackages,
      });
      const cliOut = renderRetainedCliBundledPluginImplementationEntriesTs(cliOutPath);
      if (options.mode === 'check') {
        assertGeneratedOutputMatches(cliArtifactsOutPath, cliArtifactsOut);
        assertGeneratedOutputMatches(cliOutPath, cliOut);
      } else {
        const successfulWorkspaceNames = selectedPluginPackages.map((pluginPackage) => (
          pluginPackage.packageName.slice('@happier-dev/'.length)
        ));
        await publishBundledPluginUiArtifactProjection(
          { ...options, workspaceNames: Object.freeze(successfulWorkspaceNames) },
          dependencies,
          [
            { outPath: cliArtifactsOutPath, out: cliArtifactsOut },
            { outPath: cliOutPath, out: cliOut },
          ],
        );
      }
    }
    if (selectedResult.failures.length > 0) {
      throwBundledPluginPackageFailures(selectedResult.failures);
    }
    return;
  }

  // Discover and validate every package before mutating host membership. A rejected
  // first-party identity/export must not leave package.json or generated outputs in a
  // partially admitted state.
  const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
  const cliArtifactsOutPath = resolve(
    options.rootDir,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts',
  );
  const priorBundledImmutableArtifactIdentities =
    readPriorBundledImmutableArtifactIdentities(cliArtifactsOutPath);
  const discoveredPluginPackages = await readBundledPluginPackages(
    options.rootDir,
    bundledPluginPackageNames,
    options.mode,
    options.scope,
    dependencies,
  );
  const pluginPackages = assignBundledImmutableArtifactGenerationIds({
    mode: options.mode,
    pluginPackages: discoveredPluginPackages,
    priorIdentities: priorBundledImmutableArtifactIdentities,
  });
  const builtInLegacyConnectedAccountCompatibility =
    collectBuiltInLegacyConnectedAccountCompatibility(
      options.rootDir,
      pluginPackages,
      dependencies,
    );
  assertDescriptorConnectedServiceLabelTranslations(pluginPackages);
  const todayUtc = new Date().toISOString().slice(0, 10);
  for (const entry of pluginPackages) {
    const providerContributions = readManifestContributionArray(entry.manifest, 'providers');
    if (providerContributions.length === 0) continue;
    readAndAssertBundledProviderVerificationsV1({
      buildQualifiedContributionKey: dependencies.protocol.buildQualifiedPluginContributionKey,
      rootDir: options.rootDir,
      pluginPackageId: entry.pluginPackageId,
      pluginId: entry.pluginId,
      contributions: providerContributions,
      todayUtc,
    });
  }
  const bundledVoiceProjectionSources = collectBundledFirstPartyVoiceProjectionSources(
    options.rootDir,
    pluginPackages,
  );
  const packageNames = pluginPackages.map((entry) => entry.packageName);
  const bundledAgentDefinitionIds = pluginPackages
    .map((entry) => entry.agentId)
    .filter((agentId): agentId is string => typeof agentId === 'string');
  const seenAgentIds = new Set<string>();
  for (const agentId of bundledAgentDefinitionIds) {
    if (seenAgentIds.has(agentId)) {
      throw new Error(`Duplicate bundled agent provider id '${agentId}'`);
    }
    seenAgentIds.add(agentId);
  }
  const generatedAgentIds = collectGeneratedAgentIds(bundledAgentDefinitionIds, dependencies);
  const agentDefinitionsById = Object.fromEntries(
    pluginPackages
      .filter((entry): entry is AgentBundledPluginPackage => (
        typeof entry.agentId === 'string' && entry.agentDefinition !== undefined
      ))
      .map((entry) => [entry.agentId, entry.agentDefinition]),
  );

  const cliOutPath = resolve(options.rootDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts');
  const cliManifestOutPath = resolve(
    options.rootDir,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
  );
  const uiOutPath = resolve(options.rootDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
  const uiTranslationsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/text/bundledPluginTranslations.generated.ts',
  );
  const uiVoiceEntriesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts',
  );
  const uiVoiceRuntimeEntriesOutPaths = Object.freeze({
    web: resolve(
      options.rootDir,
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts',
    ),
    ios: resolve(
      options.rootDir,
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts',
    ),
    android: resolve(
      options.rootDir,
      'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.android.ts',
    ),
  } satisfies Readonly<Record<BundledVoiceRuntimePlatform, string>>);
  const uiBundledPluginUiArtifactInventoryOutPaths = Object.freeze({
    generic: resolve(
      options.rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ts',
    ),
    web: resolve(
      options.rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.web.ts',
    ),
    ios: resolve(
      options.rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ios.ts',
    ),
    android: resolve(
      options.rootDir,
      'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.android.ts',
    ),
  } satisfies Readonly<Record<'generic' | BundledPluginUiAppArtifactPlatform, string>>);
  const uiBehaviorOverridesOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts',
  );
  const sessionAgentBehaviorsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors.ts',
  );
  const retiredAgentSettingsOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.agentSettings.ts',
  );
  const visibleMessageResolversOutPath = resolve(
    options.rootDir,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts',
  );
  const agentsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
  const retiredHostAgentSettingsOutPath = resolve(
    options.rootDir,
    'packages/agents/src/agentSettings/generated/bundledAgentSettings.ts',
  );
  const agentIdsOutPath = resolve(options.rootDir, 'packages/agents/src/generated/agentIds.ts');
  const retiredSessionControlAdaptersOutPath = resolve(
    options.rootDir,
    'packages/agents/src/generated/sessionControlAdapters.ts',
  );
  const runtimeDescriptorReadersOutPath = resolve(options.rootDir, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  const protocolAgentProviderIdsV1OutPath = resolve(
    options.rootDir,
    'packages/protocol/src/generated/providers/agentProviderIdsV1.ts',
  );
  const protocolBuiltInLegacyConnectedAccountCompatibilityOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/connect/generatedBuiltInLegacyConnectedAccountCompatibility.ts',
  );
  const retiredProtocolRuntimeDescriptorContributionsOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/runtime/descriptorContributionsV1.ts',
  );
  const retiredProtocolRuntimeDescriptorModulesDir = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/runtime/descriptors',
  );
  const retiredProtocolRuntimeDescriptorModuleOutPaths = existsSync(retiredProtocolRuntimeDescriptorModulesDir)
    ? readdirSync(retiredProtocolRuntimeDescriptorModulesDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => resolve(retiredProtocolRuntimeDescriptorModulesDir, name))
    : [];
  const protocolSessionPresentationCompatV1OutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/sessionPresentationCompatV1.ts',
  );
  const protocolExternalSessionSourcesOutPath = resolve(
    options.rootDir,
    'packages/protocol/src/agents/generated/externalSession/sources.ts',
  );
  const protocolExternalSessionSourceContributions = await collectProtocolExternalSessionSourceContributions(
    pluginPackages,
  );
  const promptAssetPluginDescriptorsOutPath = resolve(
    options.rootDir,
    'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts',
  );

  const agentUiBehaviorDescriptorSources = collectAgentUiBehaviorDescriptorSources(pluginPackages);
  const sessionAgentBehaviorSources = collectAgentSessionBehaviorSources(pluginPackages);
  const visibleMessageResolverSources = collectVisibleMessageResolverSources(pluginPackages);
  const promptAssetContributionSources = collectPromptAssetContributionSources(pluginPackages);
  const bundledPluginUiTranslations = collectBundledPluginUiTranslations(pluginPackages);
  const bundledPluginUiAppArtifactSources = collectBundledPluginUiAppArtifactSources(
    options.rootDir,
    pluginPackages,
    dependencies,
  );

  const cliOut = renderCliBundledPluginEntriesTs({ pluginPackages });
  const cliManifestOut = renderCliBundledPluginManifestEntriesTs({ pluginPackages });
  const cliArtifactsOut = renderCliBundledPluginArtifactsTs(pluginPackages);

  const agentsOut = renderBundledAgentDefinitionsTs({ agentIds: bundledAgentDefinitionIds, agentDefinitionsById });
  const protocolSessionPresentationCompatV1Out =
    renderProtocolSessionPresentationCompatV1Ts({
      agentIds: bundledAgentDefinitionIds,
      agentDefinitionsById,
    });
  const agentIdsOut = renderAgentIdsTs(generatedAgentIds);
  const runtimeDescriptorReadersOut = renderAgentRuntimeDescriptorReadersTs(
    collectReleasedFlatSessionMetadataRuntimeDescriptorReaderContributions(pluginPackages),
  );
  const protocolAgentProviderIdsV1Out = renderProtocolAgentProviderIdsV1Ts(
    collectProtocolAgentProviderIdsV1(generatedAgentIds),
  );
  const protocolBuiltInLegacyConnectedAccountCompatibilityOut =
    renderProtocolBuiltInLegacyConnectedAccountCompatibilityTs(
      builtInLegacyConnectedAccountCompatibility,
    );
  const protocolExternalSessionSourcesOut = renderGeneratedExternalSessionSourcesTs(
    protocolExternalSessionSourceContributions,
  );
  const uiOut = renderUiBundledPluginEntriesTs({ packageNames, pluginPackages });
  const uiTranslationsOut = renderBundledPluginTranslationsTs(bundledPluginUiTranslations);
  const uiBehaviorOverridesOut = renderBundledUiBehaviorOverridesTs(agentUiBehaviorDescriptorSources);
  const sessionAgentBehaviorsOut = renderBundledSessionAgentBehaviorsTs(sessionAgentBehaviorSources);
  const visibleMessageResolversOut = renderBundledVisibleMessageResolversTs(visibleMessageResolverSources);
  const promptAssetPluginDescriptorsOut = renderCliPromptAssetPluginDescriptorsTs(promptAssetContributionSources);
  const uiVoiceEntriesOut = renderBundledVoiceEntriesTs(bundledVoiceProjectionSources);
  const uiVoiceRuntimeEntriesOut = Object.freeze(Object.fromEntries(
    BUNDLED_VOICE_RUNTIME_PLATFORMS.map((platform) => [
      platform,
      renderBundledVoiceRuntimeEntriesTs(bundledVoiceProjectionSources, platform),
    ]),
  ) as Record<BundledVoiceRuntimePlatform, string>);
  const uiBundledPluginUiArtifactInventoryOut = Object.freeze({
    generic: renderBundledPluginUiAppArtifactInventoryTs(
      bundledPluginUiAppArtifactSources,
      null,
    ),
    ...Object.fromEntries(BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS.map((platform) => [
      platform,
      renderBundledPluginUiAppArtifactInventoryTs(bundledPluginUiAppArtifactSources, platform),
    ])),
  } as Record<'generic' | BundledPluginUiAppArtifactPlatform, string>);

  syncCliBundledPluginMembership({
    rootDir: options.rootDir,
    mode: options.mode,
  });
  syncBundledVoiceUiPackageDependencies({
    rootDir: options.rootDir,
    mode: options.mode,
    sources: bundledVoiceProjectionSources,
  });
  syncBundledPluginUiAppArtifactPackageDependencies({
    rootDir: options.rootDir,
    mode: options.mode,
    sources: bundledPluginUiAppArtifactSources,
  });
  removeRetiredGeneratedOutput(retiredAgentSettingsOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredHostAgentSettingsOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredSessionControlAdaptersOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredProtocolRuntimeDescriptorContributionsOutPath, options.mode);
  for (const retiredOutPath of retiredProtocolRuntimeDescriptorModuleOutPaths) {
    removeRetiredGeneratedOutput(retiredOutPath, options.mode);
  }
  removeRetiredBundledPluginProtocolProjectionOutputs(options.rootDir, options.mode);

  if (options.mode === 'check') {
    assertGeneratedOutputMatches(cliOutPath, cliOut);
    assertGeneratedOutputMatches(cliManifestOutPath, cliManifestOut);
    assertGeneratedOutputMatches(cliArtifactsOutPath, cliArtifactsOut);
    assertGeneratedOutputMatches(agentsOutPath, agentsOut);
    assertGeneratedOutputMatches(agentIdsOutPath, agentIdsOut);
    assertGeneratedOutputMatches(runtimeDescriptorReadersOutPath, runtimeDescriptorReadersOut);
    assertGeneratedOutputMatches(protocolAgentProviderIdsV1OutPath, protocolAgentProviderIdsV1Out);
    assertGeneratedOutputMatches(
      protocolBuiltInLegacyConnectedAccountCompatibilityOutPath,
      protocolBuiltInLegacyConnectedAccountCompatibilityOut,
    );
    assertGeneratedOutputMatches(
      protocolSessionPresentationCompatV1OutPath,
      protocolSessionPresentationCompatV1Out,
    );
    assertGeneratedOutputMatches(protocolExternalSessionSourcesOutPath, protocolExternalSessionSourcesOut);
    assertGeneratedOutputMatches(uiOutPath, uiOut);
    assertGeneratedOutputMatches(uiTranslationsOutPath, uiTranslationsOut);
    assertGeneratedOutputMatches(uiBehaviorOverridesOutPath, uiBehaviorOverridesOut);
    assertGeneratedOutputMatches(sessionAgentBehaviorsOutPath, sessionAgentBehaviorsOut);
    assertGeneratedOutputMatches(visibleMessageResolversOutPath, visibleMessageResolversOut);
    assertGeneratedOutputMatches(promptAssetPluginDescriptorsOutPath, promptAssetPluginDescriptorsOut);
    assertGeneratedOutputMatches(uiVoiceEntriesOutPath, uiVoiceEntriesOut);
    for (const platform of BUNDLED_VOICE_RUNTIME_PLATFORMS) {
      assertGeneratedOutputMatches(
        uiVoiceRuntimeEntriesOutPaths[platform],
        uiVoiceRuntimeEntriesOut[platform],
      );
    }
    for (const platform of ['generic', ...BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS] as const) {
      assertGeneratedOutputMatches(
        uiBundledPluginUiArtifactInventoryOutPaths[platform],
        uiBundledPluginUiArtifactInventoryOut[platform],
      );
    }
    return;
  }

  publishCoherentProjectionOutputs(options.rootDir, [
    { outPath: cliOutPath, out: cliOut },
    { outPath: cliManifestOutPath, out: cliManifestOut },
    { outPath: cliArtifactsOutPath, out: cliArtifactsOut },
    { outPath: agentsOutPath, out: agentsOut },
    { outPath: agentIdsOutPath, out: agentIdsOut },
    { outPath: runtimeDescriptorReadersOutPath, out: runtimeDescriptorReadersOut },
    { outPath: protocolAgentProviderIdsV1OutPath, out: protocolAgentProviderIdsV1Out },
    {
      outPath: protocolBuiltInLegacyConnectedAccountCompatibilityOutPath,
      out: protocolBuiltInLegacyConnectedAccountCompatibilityOut,
    },
    {
      outPath: protocolSessionPresentationCompatV1OutPath,
      out: protocolSessionPresentationCompatV1Out,
    },
    { outPath: protocolExternalSessionSourcesOutPath, out: protocolExternalSessionSourcesOut },
    { outPath: uiOutPath, out: uiOut },
    { outPath: uiTranslationsOutPath, out: uiTranslationsOut },
    { outPath: uiBehaviorOverridesOutPath, out: uiBehaviorOverridesOut },
    { outPath: sessionAgentBehaviorsOutPath, out: sessionAgentBehaviorsOut },
    { outPath: visibleMessageResolversOutPath, out: visibleMessageResolversOut },
    { outPath: promptAssetPluginDescriptorsOutPath, out: promptAssetPluginDescriptorsOut },
    { outPath: uiVoiceEntriesOutPath, out: uiVoiceEntriesOut },
    ...BUNDLED_VOICE_RUNTIME_PLATFORMS.map((platform) => ({
      outPath: uiVoiceRuntimeEntriesOutPaths[platform],
      out: uiVoiceRuntimeEntriesOut[platform],
    })),
    ...(['generic', ...BUNDLED_PLUGIN_UI_APP_ARTIFACT_PLATFORMS] as const).map((platform) => ({
      outPath: uiBundledPluginUiArtifactInventoryOutPaths[platform],
      out: uiBundledPluginUiArtifactInventoryOut[platform],
    })),
  ]);
}

async function withGeneratorWorkspaceLock<T>(
  operation: (dependencies: GeneratorWorkspaceDependencies) => Promise<T>,
  heldLockValue: string | undefined = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
): Promise<T> {
  return await withWorkspaceBundleLock(
    async () => await operation(await loadGeneratorWorkspaceDependencies()),
    {
      // The generator's runtime dependencies are loaded from the canonical
      // workspace closure, even when a caller projects into a temporary
      // target root. Serialize against that producer root so a temp-root
      // invocation cannot observe a concurrent canonical dist publication.
      lockPath: resolveWorkspaceBundleLockPath(CANONICAL_GENERATOR_REPO_ROOT),
      heldLockValue,
      errorLabel: 'bundled plugin generator workspace lock',
    },
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const timing = createBundledPluginTimingReporter();
  const options = parseGeneratorCliArgs(argv);
  const authorRuntimeLoadScope = resolvePluginAuthorRuntimeLoadScope(options);
  const inheritedLockValue = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  if (options.workspaceNames.length === 0 && !options.aggregateOnly) {
    // Package compilation and app-local runtime materialization are reusable
    // preparation, not publication. Complete them before taking the short
    // generator lock; only the final source read/validation/commit needs to
    // exclude another publisher. A caller that already owns the canonical
    // lock keeps passing its lease through for safe reentrancy.
    await synchronizeGeneratorAuthoringRuntimeClosure(options.mode, inheritedLockValue);
    timing.phase('authoring-runtime-synchronization');
  }
  let authorRuntimeLoaded = false;
  if (
    authorRuntimeLoadScope !== 'none'
    && shouldHoldGeneratorWorkspaceLockDuringGeneration(options.mode)
  ) {
    // Module initialization is expensive but does not publish or consume a
    // mutable snapshot. Warm it before entering the shared publication lock so
    // unrelated workspace producers are not blocked by TypeScript graph setup.
    await loadPluginAuthorRuntimeForScope(authorRuntimeLoadScope);
    authorRuntimeLoaded = true;
    timing.phase('authoring-runtime-load');
  }
  if (shouldHoldGeneratorWorkspaceLockDuringGeneration(options.mode)) {
    await withGeneratorWorkspaceLock(
      async (dependencies) => await generateBundledPluginEntries(options, dependencies),
      inheritedLockValue,
    );
    timing.phase('generation-and-publication');
    return;
  }

  // A drift check is read-only. Capture the canonical dependency modules under
  // the publication lock, then release it before initializing the independent
  // authoring runtime graph and scanning plugins. Package publication itself is
  // atomic, so warming a consumer graph is not part of the shared critical
  // section and must not convoy unrelated workspace builds.
  const dependencies = await withGeneratorWorkspaceLock(
    async (loadedDependencies) => loadedDependencies,
    inheritedLockValue,
  );
  timing.phase('dependency-snapshot');
  if (authorRuntimeLoadScope !== 'none' && !authorRuntimeLoaded) {
    await loadPluginAuthorRuntimeForScope(authorRuntimeLoadScope);
    timing.phase('authoring-runtime-load');
  }
  await generateBundledPluginEntries(options, dependencies);
  timing.phase('projection-and-check');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
