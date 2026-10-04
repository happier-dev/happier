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
 *   - apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts
 *   - apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts
 *   - apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts (plus its
 *     .agentSettings/.sessionAgentBehaviors/.uiBehaviorOverrides/.visibleMessageResolvers siblings)
 *   - apps/ui/sources/text/bundledPluginTranslations.generated.ts
 *   - apps/ui/sources/voice/registry/generatedBundledVoiceEntries.ts
 *   - apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts
 *     (platform siblings only when manifest-declared membership differs)
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
 *   node --experimental-strip-types apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode write
 *
 * RULE 3 — the semantic drift gate already exists; do not add a second one.
 * It runs this same publisher in check mode and fails when an emitted
 * semantic projection differs from a fresh run:
 *
 *   yarn test:migration:bundled-plugin-projections           # --mode check --scope projections
 *
 * App-preseed byte graphs are owned separately by the `apps/ui` prebuild.
 * The retired whole-repo build-determinism re-stage gate is intentionally
 * absent: byte equality across a shared-dependency rebuild is not a
 * plugin-projection contract. The semantic gate is reached in CI through
 * `test:migration:governance` (`.github/workflows/tests.yml`).
 *
 * RULE 4 — the producer and its tracked projections are ONE publication closure;
 * land them in one commit. Splitting them breaks `test:migration:governance` in
 * CI: either the tracked compatibility entrypoint re-exports a producer CI does
 * not have, or the tracked artifacts record bytes no tracked producer can emit.
 * Establish the closure's membership from `git ls-tree -r --name-only HEAD
 * <path>` at the moment you commit — never from a filename, an artifact count,
 * or an earlier note in a comment, each of which has already drifted here.
 * Packaged plugin.json and executable bytes are ignored publication outputs.
 *
 * `apps/cli/AGENTS.md` ("Generated bundled-plugin artifacts") owns this rule;
 * this note points at it rather than restating a second copy.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentId } from '@happier-dev/agents';
import { readAgentNativeHomeEnvironmentKeys } from '../../src/plugins/authoring/agentNativeHomeEnvironmentKeys.ts';
import { parseBundledPluginPublicationFailures } from '../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
  type WorkspaceBundleLockContext,
} from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { withGeneratorSingleFlight, withPreparedGeneratorPublication } from './bundledPlugins/publication.ts';
import { parseWorkspaceLockLeaseValue } from '../../../../packages/cli-common/workspaceLockLease.mjs';
import { readWorkspacePackageInputFingerprint } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import {
  pluginPackageNameToPackageId,
  readBundledPluginPackageNames,
  syncCliBundledPluginMembership,
} from './bundledPluginMembership.ts';
import { requiresBundledPackagedRuntime } from './bundledPackagedRuntimeEligibility.ts';
import { PLUGIN_HOST_SHARED_RUNTIME_PACKAGES } from '../pluginHostSharedRuntimePackages.mjs';
import { readAndAssertBundledProviderVerificationsV1 } from './bundledProviderVerification.ts';
import {
  assertGeneratedOutputMatches,
  publishCoherentProjectionOutputs,
  removeRetiredGeneratedOutput,
  writeFileAtomic,
  type GeneratorMode,
  type ProjectionPublicationLease,
} from './bundledPlugins/outputs.ts';
import { mapWithConcurrency } from './bundledPlugins/concurrency.ts';
import { createBundledPluginTimingReporter } from './bundledPlugins/timing.ts';
import {
  inspectTypescriptModule as importTypescriptModule,
  withTypescriptModuleInspectionSession,
} from './bundledPlugins/typescriptModuleInspection.ts';
import {
  parseGeneratorCliArgs,
  normalizeCanonicalGeneratorPublication,
  resolvePluginAuthorRuntimeLoadScope,
  resolveGeneratorAuthoringPreparationPolicy,
  resolveSelectedBundledPluginPackageNames,
  shouldEvaluateBundledRuntimeSource,
  type PluginAuthorRuntimeLoadScope,
  type GeneratorOptions,
  type GeneratorScope,
} from './bundledPlugins/options.ts';
import {
  computeSourceDevSharedDepsSignature,
  inspectSourceDevSharedDepsForSourceDev,
  prepareBundledWorkspaceDependenciesForCli,
  resolveCliBundledWorkspacePackageNames,
  resolveBundledWorkspacePackageDir,
  syncSharedDepsForSourceDev,
} from '../buildSharedDeps.mjs';
import { createWorkspaceChildBuildEnv } from '../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  assertHostCanExcludeBundledPlugin,
  createBundledPluginPublicationFailure,
  resolveBundledPluginPublicationFailures,
  writeBundledPluginPublicationFailures,
  type BundledPluginPublicationFailure,
} from '../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';

import {
  PLUGIN_PROMPT_ASSET_EXPORT_NAME,
  renderCliBundledAgentRegistrationBindingsTs,
  renderCliBundledPluginEntriesTs,
  renderCliBundledPluginManifestEntriesTs,
  renderCliPromptAssetPluginDescriptorsTs,
} from './bundledPlugins/registry.ts';
import {
  renderAgentIdsTs,
  renderAgentRuntimeDescriptorReadersTs,
  renderBundledAgentDefinitionsTs,
} from './bundledPlugins/agentFacts.ts';
import {
  renderGeneratedExternalSessionSourcesTs,
  renderProtocolAgentProviderIdsV1Ts,
  renderProtocolBuiltInLegacyConnectedAccountCompatibilityTs,
  renderProtocolBundledAgentIdentitiesV1Ts,
  renderProtocolSessionPresentationCompatV1Ts,
} from './bundledPlugins/protocol.ts';
import {
  buildVisibleMessageDescriptor,
  hasDescriptorFields,
  renderBundledPluginTranslationsTs,
  renderBundledSessionAgentBehaviorsTs,
  renderBundledUiBehaviorOverridesTs,
  renderBundledVisibleMessageResolversTs,
  renderUiBundledPluginEntriesTs,
  toAgentConstPrefix,
} from './bundledPlugins/agentUi.ts';
import {
  renderBundledVoiceEntriesTs,
  renderBundledVoiceRuntimeEntriesTs,
} from './bundledPlugins/voice.ts';
import {
  isJsonObject,
  isRecord,
  manifestDeclaresDaemonEntrypoint,
  readJsonArrayProperty,
  readJsonObjectProperty,
  readManifestContributionArray,
  readOptionalJsonStringProperty,
  readRequiredContributionId,
  readRequiredRecord,
  readRequiredString,
} from './bundledPlugins/literals.ts';
import {
  BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS,
} from './bundledPlugins/projectionFacts.ts';
import type {
  AgentPredecessorMessageMetaWriterImportSource,
  AgentSessionBehaviorSource,
  AgentUiBehaviorDescriptorSource,
  AgentUiDescriptor,
  BuiltInLegacyConnectedAccountCompatibilityProjection,
  BuiltInLegacyConnectedAccountCompatibilitySource,
  BuiltInLegacyConnectedAccountOperation,
  BuiltInLegacyConnectedAccountPeerOperations,
  BundledFirstPartyAgentRegistrationIdentity,
  BundledFirstPartyVoicePackageId,
  BundledFirstPartyVoiceProjectionSource,
  BundledPluginManifestJson,
  BundledPluginPackage,
  BundledVoiceRuntimePlatform,
  ExternalSessionInstanceConstantDescriptor,
  ExternalSessionInstanceDescriptor,
  ExternalSessionKeySegmentDescriptor,
  ExternalSessionSchemaFieldDescriptor,
  ExternalSessionSchemaRefinementDescriptor,
  ExternalSessionSourceDeclaration,
  JsonObject,
  JsonValue,
  PluginManifestJson,
  PluginManifestSerializerModule,
  PromptAssetContributionSource,
  ProtocolExternalSessionSourceProjectionDescriptor,
  ProviderRuntimeDescriptorReaderContributionDescriptor,
  ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor,
  ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor,
  SessionSubagentVisibleMessageResolverSource,
} from './bundledPlugins/projectionFacts.ts';

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
 * Ordinary `--mode write` publishes the full scope; bounded source preparation
 * modes (`--compiler-inputs`, `--agent-definitions`) remain owned by this writer.
 */
type AgentsWorkspaceModule = typeof import('@happier-dev/agents');
type AgentIdsWorkspaceModule = typeof import('@happier-dev/agents/agent-ids');
type AgentsManifestWorkspaceModule = typeof import('@happier-dev/agents/manifest');
type AgentsDefinitionsWorkspaceModule = typeof import('@happier-dev/agents/definitions');
type AgentsCliRuntimeWorkspaceModule = typeof import('@happier-dev/agents/cli/runtime');
type CliCommonWorkspacesModule = typeof import('@happier-dev/cli-common/workspaces');
type ProtocolWorkspaceModule = typeof import('@happier-dev/protocol');
type ProtocolBackendSurfaceWorkspaceModule = typeof import('@happier-dev/protocol/plugins/backend-surface-declaration');
type ProtocolConnectedServiceWorkspaceModule = typeof import('@happier-dev/protocol/connect/connected-service-bindings');
type ProtocolContributionIdentityWorkspaceModule = typeof import('@happier-dev/protocol/plugins/contribution-identity');
type ProtocolManifestWorkspaceModule = typeof import('@happier-dev/protocol/plugins/manifest');
type ProtocolContributionsV2WorkspaceModule = typeof import('@happier-dev/protocol/plugins/contributions/v2');
type PluginDaemonRuntimeStagingModule = typeof import(
  '../../src/plugins/authoring/bundleDaemonRuntime.ts'
);
type PluginDaemonOutputManifestModule = typeof import(
  '../../src/plugins/authoring/daemonOutputManifest.ts'
);
type PluginRuntimeStagingSourceModule = typeof import(
  '../../src/plugins/authoring/runtimeStagingSource.ts'
);
type GeneratorWorkspaceDependencies = Readonly<{
  agents: Readonly<Pick<
    AgentsWorkspaceModule,
    | 'AGENT_IDS'
    | 'CANONICAL_AGENTS_CORE'
    | 'getAllAgentDefinitionContracts'
    | 'getAllBackendCatalogDefinitions'
    | 'getAllBackendDefinitionContracts'
    | 'getAgentCatalogDefinition'
    | 'getAgentCliRuntimeSpec'
  >> & Pick<AgentIdsWorkspaceModule, 'BUNDLED_AGENT_CONTRIBUTION_IDENTITIES'>;
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
}>;
type BundledAgentCatalogDependencies = Readonly<{
  agents: Readonly<Pick<AgentIdsWorkspaceModule, 'AGENT_IDS'>>;
}>;
/**
 * The bounded dependency slice the compiler-input projection may use.
 *
 * The existing generated Agent id module is strictly upstream of `cli-common`
 * and `plugin-sdk`, whose compilation these inputs unblock. The prepass must
 * not ingest committed plugin manifests: those artifacts can legitimately be
 * stale until the full publisher has rebuilt its authoring runtime and
 * replaced them under the same publication lease.
 */
type GeneratedCompilerInputDependencies = Readonly<{
  agents: Readonly<Pick<
    AgentIdsWorkspaceModule,
    'AGENT_IDS' | 'BUNDLED_AGENT_CONTRIBUTION_IDENTITIES'
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
const GENERATOR_PUBLICATION_STAMP_PATH = resolve(
  CANONICAL_GENERATOR_REPO_ROOT,
  // Completion admission never needs the readiness history's output inventory.
  '.project/tmp/cli-generator-publication.json',
);
const PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV =
  'HAPPIER_PRIVATE_BUNDLED_RUNTIME_CONSUMED_AGENT_FACTS_PHASE';
let activeGeneratorPreparationLease: WorkspaceBundleLockContext | undefined;

async function withParentGeneratorPreparationLease(
  heldLockValue: string,
  operation: () => Promise<void>,
): Promise<void> {
  const parsedLease = parseWorkspaceLockLeaseValue(heldLockValue);
  if (!parsedLease) throw new Error('Private bundled phase requires an authenticated preparation lease');
  await withWorkspaceBundleLock(async (lease) => {
    if (!lease.inherited) throw new Error('Private bundled phase requires its parent preparation lease');
    const previousLease = activeGeneratorPreparationLease;
    activeGeneratorPreparationLease = lease;
    try {
      lease.assertOwned();
      await operation();
      lease.assertOwned();
    } finally {
      activeGeneratorPreparationLease = previousLease;
    }
  }, { lockPath: parsedLease.path, heldLockValue, errorLabel: 'bundled plugin private preparation lease' });
}
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
  const [
    agentIds,
    agentsManifest,
    agentsDefinitions,
    agentsCliRuntime,
    cliCommonWorkspaces,
    protocolBackendSurface,
    protocolConnectedService,
    protocolContributionIdentity,
    protocolManifest,
    protocolContributionsV2,
  ] = await Promise.all([
    importCanonicalWorkspaceModule('@happier-dev/agents', 'agent-ids'),
    importCanonicalWorkspaceModule('@happier-dev/agents', 'manifest'),
    importCanonicalWorkspaceModule('@happier-dev/agents', 'definitions'),
    importCanonicalWorkspaceModule('@happier-dev/agents', 'cli/runtime'),
    importCanonicalWorkspaceModule('@happier-dev/cli-common', 'workspaces'),
    importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/backend-surface-declaration'),
    importCanonicalWorkspaceModule('@happier-dev/protocol', 'connect/connected-service-bindings'),
    importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/contribution-identity'),
    importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/manifest'),
    importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/contributions/v2'),
  ]) as [
    AgentIdsWorkspaceModule,
    AgentsManifestWorkspaceModule,
    AgentsDefinitionsWorkspaceModule,
    AgentsCliRuntimeWorkspaceModule,
    CliCommonWorkspacesModule,
    ProtocolBackendSurfaceWorkspaceModule,
    ProtocolConnectedServiceWorkspaceModule,
    ProtocolContributionIdentityWorkspaceModule,
    ProtocolManifestWorkspaceModule,
    ProtocolContributionsV2WorkspaceModule,
  ];
  return Object.freeze({
    agents: Object.freeze({
      AGENT_IDS: agentIds.AGENT_IDS,
      BUNDLED_AGENT_CONTRIBUTION_IDENTITIES: agentIds.BUNDLED_AGENT_CONTRIBUTION_IDENTITIES,
      CANONICAL_AGENTS_CORE: agentsManifest.CANONICAL_AGENTS_CORE,
      getAllAgentDefinitionContracts: agentsDefinitions.getAllAgentDefinitionContracts,
      getAllBackendCatalogDefinitions: agentsDefinitions.getAllBackendCatalogDefinitions,
      getAllBackendDefinitionContracts: agentsDefinitions.getAllBackendDefinitionContracts,
      getAgentCatalogDefinition: agentsDefinitions.getAgentCatalogDefinition,
      getAgentCliRuntimeSpec: agentsCliRuntime.getAgentCliRuntimeSpec,
    }),
    cliCommonWorkspaces: Object.freeze({
      bundleWorkspacePackage: cliCommonWorkspaces.bundleWorkspacePackage,
      resolveWorkspaceBundlesFromPackageJson: cliCommonWorkspaces.resolveWorkspaceBundlesFromPackageJson,
      sanitizeBundledPackageJson: cliCommonWorkspaces.sanitizeBundledPackageJson,
    }),
    protocol: Object.freeze({
      BackendSurfaceOperationCatalogV1: protocolBackendSurface.BackendSurfaceOperationCatalogV1,
      ConnectedServiceIdSchema: protocolConnectedService.ConnectedServiceIdSchema,
      buildQualifiedPluginContributionKey:
        protocolContributionIdentity.buildQualifiedPluginContributionKey,
      derivePluginDaemonContributionRegistrationRights:
        protocolManifest.derivePluginDaemonContributionRegistrationRights,
      ingestPluginManifestV2: protocolManifest.ingestPluginManifestV2,
      isDynamicPluginResourceContributionV2:
        protocolContributionsV2.isDynamicPluginResourceContributionV2,
    }),
  });
}

/**
 * Loads only the Agents runtime the compiler-input projection reads.
 *
 * `loadGeneratorWorkspaceDependencies` additionally imports
 * `@happier-dev/cli-common/workspaces`, whose `dist` cannot exist yet when this
 * projection runs: `cli-common` compiles `BUNDLED_AGENT_CONTRIBUTION_IDENTITIES`
 * out of the very file this projection publishes.
 */
async function loadGeneratedCompilerInputDependencies(): Promise<GeneratedCompilerInputDependencies> {
  const agentIds = await importCanonicalWorkspaceModule(
    '@happier-dev/agents',
    'agent-ids',
  ) as AgentIdsWorkspaceModule;
  return Object.freeze({
    agents: Object.freeze({
      AGENT_IDS: agentIds.AGENT_IDS,
      BUNDLED_AGENT_CONTRIBUTION_IDENTITIES: agentIds.BUNDLED_AGENT_CONTRIBUTION_IDENTITIES,
    }),
  });
}

async function synchronizeGeneratorAuthoringRuntimeClosure(
  preparationPolicy: ReturnType<typeof resolveGeneratorAuthoringPreparationPolicy>,
  inheritedLockValue: string | undefined,
  options: Readonly<{
    prepareGeneratedCompilerInputs?: boolean;
  }> = {},
): Promise<() => void> {
  // `sourceModule.ts` is loaded through tsx below and therefore resolves its
  // public Protocol/SDK imports from the CLI's materialized dependency tree.
  // Use the shared source-dev owner to make that complete closure current
  // before either canonical generator imports or authoring source imports run.
  // The generator asks the shared owner to synchronize without recursively
  // publishing bundled artifacts. A temporary target consumes the canonical
  // authoring closure read-only; only a canonical-root write may update its
  // generated compiler inputs.
  // The manifest-derived compiler inputs are projected from committed plugin
  // manifest artifacts, and this invocation publishes none until after every
  // pass below, so a later pass would re-derive identical bytes. Prepare them on
  // the first pass only: the projection measured ~20s idle and 565s on a
  // saturated machine, so repeating it only lengthens this invocation's own wait
  // for the workspace lock in the case that already hurts most.
  let bundledPluginCompilerInputsPrepared = options.prepareGeneratedCompilerInputs === false;
  const sync = async (
    preserveBundledPluginArtifacts: boolean,
    stampPath: string,
    workspaceNames: readonly string[],
  ): Promise<void> => {
    const prepareBundledPluginCompilerInputs = !bundledPluginCompilerInputsPrepared;
    bundledPluginCompilerInputsPrepared = true;
    await syncSharedDepsForSourceDev({
      repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
      workspaceNames,
      prepareBundledPluginCompilerInputs,
      // Generated compiler inputs are canonical publisher-owned source. Checks
      // and noncanonical target generation may build ignored materialization,
      // but must not repair tracked canonical inputs.
      generatedCompilerInputMode: preparationPolicy.generatedCompilerInputMode,
      includeRuntimeDependencies: true,
      publishBundledPluginArtifacts: false,
      preserveBundledPluginArtifacts,
      // Generator preflight deliberately does not publish immutable plugin
      // artifacts. Its readiness must never make `build:shared` reuse an
      // unpublishable closure.
      stampPath,
      quiet: true,
      reportProgress: (event: Readonly<{ stage: string; event: string; workspaceName?: string; elapsedMs: number }>) => {
        if (event.stage === 'workspace-build' || event.stage === 'workspace-lock') {
          process.stderr.write(`bundled-plugins: dependency-preparation ${JSON.stringify(event)}\n`);
        }
      },
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
  // Finally materialize the non-plugin host/runtime dependencies used by
  // esbuild without letting that source-dev pass reconsider plugin builds.
  const bundledWorkspaceNames = resolveCliBundledWorkspacePackageNames({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
  });
  const hostWorkspaceNames = bundledWorkspaceNames.filter(
    (workspaceName) => !workspaceName.startsWith('plugins-'),
  );
  await sync(true, GENERATOR_STAGE_PREP_STAMP_PATH, hostWorkspaceNames);
  for (const [stampPath, workspaceNames] of [
    [GENERATOR_BUILD_PREP_STAMP_PATH, ['plugin-sdk']],
    [GENERATOR_STAGE_PREP_STAMP_PATH, hostWorkspaceNames],
  ] as const) {
    if (!inspectSourceDevSharedDepsForSourceDev({
      repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
      stampPath,
      workspaceNames,
      includeRuntimeDependencies: true,
    }).current) {
      throw new Error('Bundled plugin dependency preparation is not current; rerun the publisher');
    }
  }
  return captureGeneratorDependencyCurrentness(['plugin-sdk', ...hostWorkspaceNames]);
}

function captureGeneratorDependencyCurrentness(workspaceNames: readonly string[]): () => void {
  const readSignature = () => JSON.stringify(computeSourceDevSharedDepsSignature({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
    workspaceNames,
    includeDevDependencies: false,
  }));
  const preparedSignature = readSignature();
  return () => {
    if (readSignature() !== preparedSignature) {
      throw new Error('Bundled plugin dependency inputs or outputs changed after preparation; rerun the publisher');
    }
  };
}

async function prepareSelectedBundledPluginWorkspaceOutputs(input: Readonly<{
  inheritedLockValue: string | undefined;
  workspaceNames: readonly string[] | undefined;
  excludedPackageNames?: ReadonlySet<string>;
}>): Promise<readonly BundledPluginPackageFailure[]> {
  const bundledWorkspaceNames = resolveCliBundledWorkspacePackageNames({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
  });
  const packagedRuntimePreparation = resolveGeneratorPackagedRuntimePreparation(
    bundledWorkspaceNames,
    input.workspaceNames === undefined
      ? {}
      : input.workspaceNames.length > 0
        ? { workspaceNames: input.workspaceNames }
        : { preparePackagedRuntimes: false },
  );
  const prepared = await prepareBundledWorkspaceDependenciesForCli({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
    workspaceNames: packagedRuntimePreparation.workspaceNames.filter((workspaceName: string) => (
      !input.excludedPackageNames?.has(`@happier-dev/${workspaceName}`)
    )),
    publicationMode: process.env.HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE === 'artifact'
      ? packagedRuntimePreparation.publicationMode
      : 'live',
    env: createWorkspaceChildBuildEnv({
      env: process.env,
      heldLockValue: input.inheritedLockValue,
    }),
    quiet: true,
  });
  return prepared.failedPluginBuilds;
}

async function materializeSelectedBundledPluginWorkspaceOutputs(input: Readonly<{
  inheritedLockValue: string | undefined;
  generatedCompilerInputMode: Mode;
  workspaceNames: readonly string[] | undefined;
}>): Promise<void> {
  const selectedWorkspaceNames = input.workspaceNames ?? resolveCliBundledWorkspacePackageNames({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
  }).filter((workspaceName) => workspaceName.startsWith('plugins-'));
  await syncSharedDepsForSourceDev({
    repoRoot: CANONICAL_GENERATOR_REPO_ROOT,
    workspaceNames: selectedWorkspaceNames,
    prepareBundledPluginCompilerInputs: false,
    generatedCompilerInputMode: input.generatedCompilerInputMode,
    includeRuntimeDependencies: true,
    publishBundledPluginArtifacts: false,
    preserveBundledPluginArtifacts: true,
    stampPath: GENERATOR_STAGE_PREP_STAMP_PATH,
    quiet: true,
    ...(input.inheritedLockValue
      ? { lockOptions: { heldLockValue: input.inheritedLockValue } }
      : {}),
  });
}

type PluginAuthorRuntimeModules = Readonly<{
  staging: PluginDaemonRuntimeStagingModule;
  source: PluginRuntimeStagingSourceModule;
  manifestSerializer: PluginManifestSerializerModule;
}>;

type PluginAuthorRuntimeSupportModules = Pick<PluginAuthorRuntimeModules, 'staging' | 'source'>;

let pluginManifestSerializerPromise: Promise<PluginManifestSerializerModule> | null = null;
let pluginDaemonOutputManifestPromise: Promise<PluginDaemonOutputManifestModule> | null = null;
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

async function loadPluginDaemonOutputManifestModule(): Promise<PluginDaemonOutputManifestModule> {
  pluginDaemonOutputManifestPromise ??= importPluginAuthorRuntimeModules(async (tsImport) => (
    await tsImport(new URL(
      '../../src/plugins/authoring/daemonOutputManifest.ts',
      import.meta.url,
    ).href, import.meta.url) as PluginDaemonOutputManifestModule
  ));
  return await pluginDaemonOutputManifestPromise;
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
type BundledPluginSourceProjectionFacts = Readonly<{
  agentId?: string;
  agentDefinition?: JsonValue;
  agentNativeHomeEnvironmentKeys?: readonly string[];
  agentUiDescriptor?: AgentUiDescriptor;
  agentPredecessorMessageMetaWriter?: AgentPredecessorMessageMetaWriterImportSource;
  releasedFlatSessionMetadataRuntimeDescriptorReader?: ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor;
  promptAssetContributions?: PromptAssetContributionSource;
  builtInLegacyConnectedAccountCompatibility?:
    readonly BuiltInLegacyConnectedAccountCompatibilitySource[];
}>;
type BundledPackagedFile = Readonly<{
  relativePath: string;
  byteLength: number;
  digest: string;
}>;
type ReleasedFlatSessionMetadataRuntimeDescriptorReaderProjectionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;
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
  'devin',
  'fx',
  'droid',
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

async function loadPluginAgentDefinitionFacts(repoRoot: string, pluginPackageId: string): Promise<Readonly<{
  agentDefinition: JsonValue;
  agentNativeHomeEnvironmentKeys: readonly string[];
}>> {
  const definitionPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/agent/definition.ts');
  if (!existsSync(definitionPath)) {
    throw new Error(`Missing required agent definition at ${definitionPath}`);
  }

  const mod = await importTypescriptModule(definitionPath) as {
    AGENT_DEFINITION?: unknown;
    AGENT_STATE_SHARING_DESCRIPTOR?: unknown;
  };
  if (!('AGENT_DEFINITION' in mod)) {
    throw new Error(`Expected AGENT_DEFINITION export in ${definitionPath}`);
  }

  const definition = mod.AGENT_DEFINITION;
  assertJsonSerializable(definition);

  if (!isRecord(definition) || typeof definition.id !== 'string') {
    throw new Error(`Invalid AGENT_DEFINITION in ${definitionPath} (expected object with string id)`);
  }

  return {
    agentDefinition: normalizeAgentDefinitionForAgentsOutput(definition),
    agentNativeHomeEnvironmentKeys: readAgentNativeHomeEnvironmentKeys(mod.AGENT_STATE_SHARING_DESCRIPTOR),
  };
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
    ...(install.npmPackageName !== undefined ? { npmPackageName: install.npmPackageName } : {}),
    ...(install.nativeUpdate !== undefined ? { nativeUpdate: install.nativeUpdate } : {}),
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

  const mod = await importTypescriptModule(predecessorMessageMetaPath) as Record<string, unknown>;
  const defaults = mod.CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS;
  if (!isRecord(defaults) || Array.isArray(defaults)) {
    throw new Error(`Missing Claude predecessor message metadata defaults in ${predecessorMessageMetaPath}`);
  }
  assertJsonSerializable(defaults, ['claude', 'predecessorMessageMetaDefaults']);
  return {
    importName: 'buildClaudePredecessorMessageMeta',
    importPath: '@happier-dev/protocol/agents/claude/predecessor-message-meta',
    defaults: defaults as JsonObject,
  };
}

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
    assertJsonSerializable(contribution, [pluginPackageId, 'promptAssets', String(index)]);
  }

  return {
    pluginPackageId,
    descriptors: rawContributions as readonly JsonObject[],
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
  dependencies: GeneratorWorkspaceDependencies;
}>): Promise<void> {
  const manifestSerializer = await loadPluginManifestSerializerModule();
  const authoredManifest = params.manifest;
  const manifest = manifestRequiresSessionRunnerFactory(authoredManifest, params.dependencies)
    ? await (async () => {
      const daemonEntrypoint = readJsonObjectProperty(authoredManifest, 'entrypoints')?.daemon;
      if (typeof daemonEntrypoint !== 'string') {
        throw new Error(`Bundled Agent runtime '${authoredManifest.id}' has no daemon entrypoint`);
      }
      const factories = (await readBundledAgentRuntimeFacts({
        packageRoot: params.packageRoot,
        manifest: authoredManifest,
      })).sessionRunnerFactories;
      const { staging } = await loadPluginAuthorRuntimeSupportModules();
      return {
        ...authoredManifest,
        runtime: {
          ...authoredManifest.runtime,
          agentFactories: factories.map((factory) => ({
            localAgentId: factory.localAgentId,
            locator: factory.locator,
            normalizedModulePath: staging.projectPackedSessionRunnerModulePath({
              daemonEntrypoint,
              locatorModule: factory.locator.module,
            }),
            loadMode: 'immutable-js' as const,
          })),
        },
      } satisfies PluginManifestJson;
    })()
    : authoredManifest;
  const serializedManifest = manifestSerializer.serializeCanonicalPluginManifest(manifest);
  const manifestPath = resolve(params.packageRoot, BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH);
  if (params.mode === 'check') {
    assertGeneratedOutputMatches(manifestPath, serializedManifest);
    return;
  }
  writeFileAtomic(manifestPath, serializedManifest);
}

async function synchronizeSelectedBundledPluginSourceManifests(input: Readonly<{
  options: GeneratorOptions;
  dependencies: GeneratorWorkspaceDependencies;
}>): Promise<readonly BundledPluginPackageFailure[]> {
  const selectedPackageNames = input.options.workspaceNames.length > 0
    ? resolveSelectedBundledPluginPackageNames(
      readBundledPluginPackageNames(input.options.rootDir),
      input.options.workspaceNames,
    )
    : readBundledPluginPackageNames(input.options.rootDir);
  // Serialized plugin manifests are publisher output, not a source-synchronized
  // projection. A one-way execution target therefore has no authoritative
  // checkout copy to consume and must materialize its own manifest before
  // selected package preparation validates it.
  const mode: Mode = input.options.mode;
  const failures = (await mapWithConcurrency(
    selectedPackageNames,
    2,
    async (packageName): Promise<BundledPluginPackageFailure | null> => (
      await withTypescriptModuleInspectionSession(async () => {
        try {
          const pluginPackageId = pluginPackageNameToPackageId(packageName);
          const packageRoot = resolve(input.options.rootDir, 'packages', 'plugins', pluginPackageId);
          const manifest = await loadPluginManifest(
            input.options.rootDir,
            pluginPackageId,
            input.dependencies,
          );
          await synchronizeSerializedPluginManifest({ packageRoot, manifest, mode, dependencies: input.dependencies });
          return null;
        } catch (error) {
          return createBundledPluginPublicationFailure({
            repoRoot: input.options.rootDir,
            packageName,
            code: 'plugin_manifest_invalid',
            error,
          });
        }
      })
    ),
  )).filter((failure): failure is BundledPluginPackageFailure => failure !== null);
  return failures;
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
): readonly BundledPackagedFile[] {
  const files = new Map<string, BundledPackagedFile>();
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
    throw new Error('Bundled packaged runtime must declare one exact default package root export');
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
const RETIRED_UNMARKED_AGENT_RUNTIME_FACTORY_PATH =
  '.happier-plugin/agent/runtime/factory.js';
const RETIRED_UNMARKED_BUNDLED_RUNTIME_OUTPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  antigravity: Object.freeze([RETIRED_UNMARKED_AGENT_RUNTIME_FACTORY_PATH]),
  auggie: Object.freeze(['.happier-plugin/.happier-chunks/chunk-VOUQT3FH.js']),
  claude: Object.freeze(['.happier-plugin/.happier-chunks/chunk-N7PGJW44.js']),
  codex: Object.freeze(['.happier-plugin/.happier-chunks/chunk-SHXPQNCY.js']),
  copilot: Object.freeze(['.happier-plugin/.happier-chunks/chunk-K3Q3IMHF.js']),
  cursor: Object.freeze(['.happier-plugin/.happier-chunks/chunk-GFYILV73.js']),
  devin: Object.freeze([RETIRED_UNMARKED_AGENT_RUNTIME_FACTORY_PATH]),
  gemini: Object.freeze(['.happier-plugin/.happier-chunks/chunk-ZOTE3VST.js']),
  grok: Object.freeze(['.happier-plugin/.happier-chunks/chunk-GMQD56SV.js']),
  kilo: Object.freeze(['.happier-plugin/.happier-chunks/chunk-2FXVNKQ4.js']),
  kimi: Object.freeze([RETIRED_UNMARKED_AGENT_RUNTIME_FACTORY_PATH]),
  ohmypi: Object.freeze(['.happier-plugin/.happier-chunks/chunk-GRJXWIAP.js']),
  opencode: Object.freeze(['.happier-plugin/.happier-chunks/chunk-HC5PJSTB.js']),
  pi: Object.freeze(['.happier-plugin/.happier-chunks/chunk-GG7JGBJB.js']),
  qwen: Object.freeze(['.happier-plugin/.happier-chunks/chunk-QU3FEF3D.js']),
});

function resolveRetiredUnmarkedBundledRuntimeOutputs(
  pluginPackageId: string,
): readonly string[] {
  // These exact paths were emitted by historical publisher revisions without
  // entering the daemon-output marker. Never broaden this into a directory
  // scan: unmarked neighbors remain author-owned.
  return RETIRED_UNMARKED_BUNDLED_RUNTIME_OUTPUTS[pluginPackageId] ?? [];
}

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

async function readBundledAgentRuntimeFacts(params: Readonly<{
  packageRoot: string;
  manifest: PluginManifestJson;
}>): Promise<Awaited<ReturnType<
  PluginRuntimeStagingSourceModule['evaluatePluginAuthorRuntimeStagingSource']
>>> {
  const sourceEntryPath = resolve(params.packageRoot, 'src', 'index.ts');
  const manifestSerializer = await loadPluginManifestSerializerModule();
  const { source } = await loadPluginAuthorRuntimeSupportModules();
  const runtimeSource = await source.evaluatePluginAuthorRuntimeStagingSource({
    locator: sourceEntryPath,
    rootPath: params.packageRoot,
    authority: {
      kind: 'bundled_first_party',
      pluginId: params.manifest.id,
      packageRootPath: params.packageRoot,
    },
  });
  const { agentFactories: _publishedFactories, ...authoredRuntime } = params.manifest.runtime;
  const staticCanonicalManifest = manifestSerializer.serializeCanonicalPluginManifest({
    ...params.manifest,
    runtime: authoredRuntime,
  });
  if (runtimeSource.evaluated.canonicalManifestJson !== staticCanonicalManifest) {
    throw new Error(
      `Bundled plugin source manifest differs from the statically projected canonical manifest: '${params.manifest.id}'`,
    );
  }
  return runtimeSource;
}

async function stageBundledPluginDaemonRuntime(params: Readonly<{
  packageRoot: string;
  manifest: PluginManifestJson;
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
    // question into a whole-repo build-determinism question; current-source
    // writes own runtime staging instead.
    return new Map();
  }
  const { sessionRunnerFactories } = await readBundledAgentRuntimeFacts(params);
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
      firstPartyPackagedWorkspaceExternals: PLUGIN_HOST_SHARED_RUNTIME_PACKAGES,
    });
    const stagedBytes = new Map<string, Buffer>(staged.outputRelativePaths.map((relativePath) => [
      relativePath,
      readFileSync(resolve(stagingRoot, ...relativePath.split('/'))),
    ]));
    return stagedBytes;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Reconcile the exact generated runtime files installed into one bundled Plugin package.
 * `stagePluginDaemonRuntime.outputRelativePaths` decides the current set and the shared
 * daemon-output transition marker decides the prior set. All other selected package
 * paths remain author-owned, including files beside generated outputs.
 */
export async function reconcileBundledPluginInstalledRuntime(params: Readonly<{
  packageRoot: string;
  pluginPackageId: string;
  daemonRelativePath: string;
  expectedFiles: ReadonlyMap<string, Uint8Array>;
  mode: Mode;
}>): Promise<void> {
  const daemonRelativePath = normalizeDeclaredBundledPackagePath(
    params.daemonRelativePath,
    'daemon entry',
  );
  const expectedPaths = [...params.expectedFiles.keys()].map((relativePath) => (
    normalizeDeclaredBundledPackagePath(relativePath, 'generated runtime output')
  ));
  if (!params.expectedFiles.has(BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH)) {
    throw new Error(`Bundled generated runtime output omits '${BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH}'`);
  }
  if (!params.expectedFiles.has(daemonRelativePath)) {
    throw new Error(`Bundled generated runtime output omits daemon entry '${daemonRelativePath}'`);
  }

  const currentDaemonOutputPaths = expectedPaths
    .filter((relativePath) => relativePath !== BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH)
    .sort(comparePortablePathCodeUnits);
  const {
    cleanupPluginDaemonOutputManifest,
    readPluginDaemonOutputManifest,
    writePluginDaemonOutputManifest,
  } = await loadPluginDaemonOutputManifestModule();
  const priorOutputManifest = await readPluginDaemonOutputManifest(params.packageRoot);
  const retiredUnmarkedOutputPaths = resolveRetiredUnmarkedBundledRuntimeOutputs(
    params.pluginPackageId,
  )
    .filter((relativePath) => !currentDaemonOutputPaths.includes(relativePath))
    .map((relativePath) => resolve(params.packageRoot, ...relativePath.split('/')));

  if (params.mode === 'write') {
    await cleanupPluginDaemonOutputManifest(params.packageRoot);
    for (const retiredUnmarkedOutputPath of retiredUnmarkedOutputPaths) {
      rmSync(retiredUnmarkedOutputPath, { force: true });
    }
    for (const [relativePath, bytes] of params.expectedFiles) {
      const installedPath = resolve(params.packageRoot, ...relativePath.split('/'));
      mkdirSync(dirname(installedPath), { recursive: true });
      writeFileSync(installedPath, bytes);
    }
    await writePluginDaemonOutputManifest({
      projectRoot: params.packageRoot,
      outputRelativePaths: currentDaemonOutputPaths,
    });
    return;
  }

  const remainingRetiredUnmarkedOutputPath = retiredUnmarkedOutputPaths.find(existsSync);
  if (remainingRetiredUnmarkedOutputPath) {
    throw new Error(
      `Bundled plugin retired generated runtime output remains: ${remainingRetiredUnmarkedOutputPath}`,
    );
  }

  if (
    priorOutputManifest === null
    || JSON.stringify(priorOutputManifest.outputs) !== JSON.stringify(currentDaemonOutputPaths)
  ) {
    throw new Error(
      `Bundled plugin generated runtime ownership differs: ${params.packageRoot}`,
    );
  }
  for (const [relativePath, expectedBytes] of params.expectedFiles) {
    const installedPath = resolve(params.packageRoot, ...relativePath.split('/'));
    const installedBytes = readFileSync(installedPath);
    if (!installedBytes.equals(expectedBytes)) {
      throw new Error(
        `Bundled plugin runtime artifact differs: ${installedPath} `
        + `(expected ${sha256Digest(expectedBytes)} ${expectedBytes.byteLength} bytes, `
        + `received ${sha256Digest(installedBytes)} ${installedBytes.byteLength} bytes)`,
      );
    }
  }
}

async function prepareBundledPluginPackageArtifacts(params: Readonly<{
  packageRoot: string;
  pluginPackageId: string;
  packageJson: Readonly<Record<string, unknown>>;
  manifest: PluginManifestJson;
  mode: Mode;
  targetOwnedOnly?: boolean;
  scope: GeneratorScope;
  dependencies: GeneratorWorkspaceDependencies;
  getCanonicalWorkspacePackageRoots: () => Readonly<Record<string, string>> | undefined;
}>): Promise<void> {
  const resources = readManifestContributionArray(params.manifest, 'resources');
  const requiresPackagedRuntime = requiresBundledPackagedRuntime({
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
  if (!requiresPackagedRuntime) {
    return;
  }
  const packageFiles = params.packageJson.files;
  if (!Array.isArray(packageFiles) || packageFiles.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Bundled packaged runtime '${params.manifest.id}' must declare an exact package.json files inventory`);
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
    if (params.mode === 'check' || params.targetOwnedOnly === true) {
      throw new Error(
        `Bundled packaged runtime '${params.manifest.id}' must ship `
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
    scope: params.scope,
    dependencies: params.dependencies,
    getCanonicalWorkspacePackageRoots: params.getCanonicalWorkspacePackageRoots,
  });
  if (daemonRelativePath && shouldEvaluateBundledRuntimeSource(params.scope)) {
    await reconcileBundledPluginInstalledRuntime({
      packageRoot: params.packageRoot,
      pluginPackageId: params.pluginPackageId,
      daemonRelativePath,
      expectedFiles: new Map<string, Uint8Array>([
        [BUNDLED_PLUGIN_MANIFEST_ARTIFACT_PATH, installedManifestBytes],
        ...stagedRuntimeFiles,
      ]),
      mode: params.mode,
    });
  } else if (params.mode === 'check') {
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
  // The prepared package tree itself is the publication authority. Pack-time
  // staging compares these current bytes directly; no generated record mirrors
  // them or assigns a second currentness identity.
}

const BUNDLED_PLUGIN_WORKSPACE_PACKAGE_PREFIX = '@happier-dev/plugins-';

export function resolveGeneratorPackagedRuntimePreparation(
  workspaceNames: readonly string[],
  options: Readonly<{
    workspaceNames?: readonly string[];
    preparePackagedRuntimes?: boolean;
  }> = {},
): Readonly<{ workspaceNames: readonly string[]; publicationMode: 'artifact' }> {
  const selectedWorkspaceNames = options.workspaceNames?.length
    ? new Set(options.workspaceNames)
    : null;
  return Object.freeze({
    workspaceNames: Object.freeze(options.preparePackagedRuntimes === false
      ? []
      : workspaceNames.filter((workspaceName) => (
        workspaceName.startsWith('plugins-')
        && (!selectedWorkspaceNames || selectedWorkspaceNames.has(workspaceName))
      ))),
    // Artifact mode prunes obsolete outputs; the package-build owner's content
    // identity admits unchanged outputs and detects deleted source leaves.
    publicationMode: 'artifact',
  });
}

/**
 * Runtime staging consumes current host workspace outputs, but always builds a
 * Plugin from its authored source entry. Even after package preparation has
 * refreshed plugin `dist`, resolving plugin-to-plugin source imports through a
 * package output or installed `node_modules` copy would mix ownership domains;
 * the existing first-party resolver must fail closed for those imports.
 */
export function selectCanonicalRuntimeWorkspacePackageRoots(
  bundles: readonly Readonly<{ packageName: string; srcDir: string }>[],
): Readonly<Record<string, string>> {
  const roots: Record<string, string> = {};
  for (const bundle of bundles) {
    if (bundle.packageName.startsWith(BUNDLED_PLUGIN_WORKSPACE_PACKAGE_PREFIX)) continue;
    if (Object.hasOwn(roots, bundle.packageName)) {
      throw new Error(`Duplicate canonical workspace package root for '${bundle.packageName}'`);
    }
    roots[bundle.packageName] = bundle.srcDir;
  }
  return Object.freeze(roots);
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
    canonicalWorkspacePackageRoots = selectCanonicalRuntimeWorkspacePackageRoots(
      dependencies.cliCommonWorkspaces.resolveWorkspaceBundlesFromPackageJson({
        repoRoot,
        hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
      }),
    );
    return canonicalWorkspacePackageRoots;
  };
}

async function readSourceProjectionFacts(params: Readonly<{
  repoRoot: string;
  pluginPackageId: string;
  packageName: string;
  manifest: PluginManifestJson;
  dependencies: GeneratorWorkspaceDependencies;
  readAgentRuntimeFacts?: boolean;
}>): Promise<BundledPluginSourceProjectionFacts> {
  const definitionPath = resolve(
    params.repoRoot,
    'packages/plugins',
    params.pluginPackageId,
    'src/agent/definition.ts',
  );
  const loadedAgentFacts = existsSync(definitionPath)
    ? await loadPluginAgentDefinitionFacts(params.repoRoot, params.pluginPackageId)
    : undefined;
  const agentDefinition = loadedAgentFacts
    ? projectNativeAgentCliDefinitionFacts(
      loadedAgentFacts.agentDefinition,
      params.manifest,
      params.pluginPackageId,
    )
    : undefined;
  const runtimeFacts = agentDefinition && params.readAgentRuntimeFacts !== false
    ? await readBundledAgentRuntimeFacts({
      packageRoot: resolve(params.repoRoot, 'packages/plugins', params.pluginPackageId),
      manifest: params.manifest,
    })
    : undefined;
  if (runtimeFacts && JSON.stringify(runtimeFacts.agentNativeHomeEnvironmentKeys)
    !== JSON.stringify(loadedAgentFacts?.agentNativeHomeEnvironmentKeys)) {
    throw new Error(`Agent native-home registration differs from static source facts: ${definitionPath}`);
  }
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
      agentUiDescriptor.agentId,
    )
    : undefined;
  const promptAssetContributions = await loadPluginPromptAssetContributions(
    params.repoRoot,
    params.pluginPackageId,
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
    ...(loadedAgentFacts ? { agentNativeHomeEnvironmentKeys: loadedAgentFacts.agentNativeHomeEnvironmentKeys } : {}),
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
  excludedArtifactPackageNames: ReadonlySet<string> = new Set(),
): Promise<Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
  failures: readonly BundledPluginPackageFailure[];
}>> {
  return await collectBundledPluginPackages({
    repoRoot,
    bundledPluginPackageNames,
    mode,
    scope,
    dependencies,
    excludedArtifactPackageNames,
  });
}

type BundledPluginPackageFailure = BundledPluginPublicationFailure;

function mergeBundledPluginFailures(
  ...groups: readonly (readonly BundledPluginPackageFailure[])[]
): readonly BundledPluginPackageFailure[] {
  const byPackageName = new Map<string, BundledPluginPackageFailure>();
  for (const failure of groups.flat()) {
    if (!byPackageName.has(failure.packageName)) byPackageName.set(failure.packageName, failure);
  }
  return Object.freeze([...byPackageName.values()].sort((a, b) => a.packageName.localeCompare(b.packageName)));
}

function assertNoBundledPluginPublicationFailures(
  failures: readonly BundledPluginPackageFailure[],
  mode: Mode,
): void {
  if (failures.length > 0 && (mode === 'check' || process.env.HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE === 'artifact')) {
    throwBundledPluginPackageFailures(failures);
  }
}

export function readInheritedBundledPluginFailures(
  fromStdin: boolean,
  repoRoot: string,
): readonly BundledPluginPackageFailure[] {
  // A previous UI diagnostic describes an earlier evaluation, not this build.
  // Preparation must retry repaired source; only current-run failures on stdin
  // can exclude a package before compilation/materialization.
  const raw = fromStdin ? readFileSync(0, 'utf8') : '[]';
  if (!raw) throw new Error('Missing inherited bundled plugin publication failures on stdin');
  const failures = mergeBundledPluginFailures(parseBundledPluginPublicationFailures(raw));
  for (const failure of failures) {
    assertHostCanExcludeBundledPlugin(
      repoRoot,
      failure.packageName,
      new Error(failure.diagnostic.message),
    );
  }
  return failures;
}

type BundledPluginSourcePackage = BundledPluginPackage & Readonly<{
  packageRoot: string;
  packageJson: Readonly<Record<string, unknown>>;
}>;

function throwBundledPluginPackageFailures(
  failures: readonly BundledPluginPackageFailure[],
): never {
  throw new Error(
    `Bundled plugin package validation failed:\n${failures
      .map((failure) => `- ${failure.packageName}: ${failure.diagnostic.message}`)
      .join('\n')}`,
  );
}

function collectBundledAgentDefinitionProjection(
  pluginPackages: readonly Pick<
    BundledPluginPackage,
    'agentId' | 'agentDefinition' | 'agentNativeHomeEnvironmentKeys'
  >[],
): Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
  nativeHomeEnvironmentKeys: readonly string[];
}> {
  const agentIds = pluginPackages
    .map((entry) => entry.agentId)
    .filter((agentId): agentId is string => typeof agentId === 'string');
  const seenAgentIds = new Set<string>();
  for (const agentId of agentIds) {
    if (seenAgentIds.has(agentId)) {
      throw new Error(`Duplicate bundled agent provider id '${agentId}'`);
    }
    seenAgentIds.add(agentId);
  }
  return Object.freeze({
    agentIds: Object.freeze(agentIds),
    nativeHomeEnvironmentKeys: Object.freeze([...new Set(
      pluginPackages.flatMap((entry) => entry.agentNativeHomeEnvironmentKeys ?? []),
    )].sort()),
    agentDefinitionsById: Object.freeze(Object.fromEntries(
      pluginPackages.flatMap((entry): readonly (readonly [string, JsonValue])[] => (
        typeof entry.agentId === 'string' && entry.agentDefinition !== undefined
          ? [[entry.agentId, entry.agentDefinition] as const]
          : []
      )),
    )),
  });
}

async function runRuntimeConsumedAgentFactsPrivatePhase(
  repoRoot: string,
  publicationContext: WorkspaceBundleLockContext,
): Promise<void> {
  const dependencies = await loadGeneratorWorkspaceDependencies();
  await loadPluginAuthorRuntimeForScope('full');
  const sourceResult = await collectBundledPluginSourcePackages({
    repoRoot,
    bundledPluginPackageNames: readBundledPluginPackageNames(repoRoot),
    mode: 'check',
    dependencies,
    // This phase may publish only the runtime-consumed Agent facts. Source
    // manifests are validated in memory and remain owned by the final phase.
    synchronizeSerializedManifest: false,
    readAgentRuntimeFacts: false,
  });
  // Duplicate Agent identities are validated before the first early write.
  const projection = collectBundledAgentDefinitionProjection(
    sourceResult.sourcePluginPackages,
  );
  const outPath = resolve(
    repoRoot,
    'packages/agents/src/generated/bundledAgentDefinitions.ts',
  );
  const out = renderBundledAgentDefinitionsTs({
    agentIds: projection.agentIds,
    agentDefinitionsById: projection.agentDefinitionsById,
    nativeHomeEnvironmentKeys: projection.nativeHomeEnvironmentKeys,
  });
  publishCoherentProjectionOutputs(
    repoRoot,
    [{ outPath, out }],
    publicationContext,
  );
}

/** Refresh data-only Agent facts with the canonical loader, projection and writer. */
async function publishSourceAgentDefinitions(
  options: GeneratorOptions,
  publicationContext: WorkspaceBundleLockContext,
): Promise<void> {
  const parser = await importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/manifest') as ProtocolManifestWorkspaceModule;
  // The tracked projection is the clean-checkout declaration authority. Packed
  // plugin.json files are publication outputs and need not exist before builds.
  const manifestProjection = await import(pathToFileURL(resolve(options.rootDir,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts')).href) as Readonly<{
      BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly Readonly<{ pluginId: string; manifest: unknown; sourceSpec: { locator: string } }>[];
  }>;
  const definitions = await withTypescriptModuleInspectionSession(async () => {
    const entries: Pick<BundledPluginPackage, 'agentId' | 'agentDefinition' | 'agentNativeHomeEnvironmentKeys'>[] = [];
    for (const packageName of readBundledPluginPackageNames(options.rootDir)) {
      const pluginPackageId = pluginPackageNameToPackageId(packageName);
      const packageRoot = resolve(options.rootDir, 'packages/plugins', pluginPackageId);
      const definitionPath = resolve(packageRoot, 'src/agent/definition.ts');
      if (!existsSync(definitionPath)) continue;
      const locator = manifestProjection.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.sourceSpec.locator === packageName);
      if (!locator) throw new Error(`Missing tracked bundled plugin declaration: ${packageName}`);
      const manifest = normalizePluginManifest(locator.manifest, `bundled:${locator.pluginId}`, parser);
      const sourceFacts = await loadPluginAgentDefinitionFacts(options.rootDir, pluginPackageId);
      const definition = projectNativeAgentCliDefinitionFacts(
        sourceFacts.agentDefinition,
        manifest,
        pluginPackageId,
      );
      rejectRetiredAgentRuntimeContributionsAggregate(definition, definitionPath);
      if (!isRecord(definition) || typeof definition.id !== 'string') {
        throw new Error(`Invalid Agent definition at ${definitionPath}`);
      }
      entries.push({ agentId: definition.id, agentDefinition: definition,
        agentNativeHomeEnvironmentKeys: sourceFacts.agentNativeHomeEnvironmentKeys });
    }
    return collectBundledAgentDefinitionProjection(entries);
  });
  const outPath = resolve(options.rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
  const out = renderBundledAgentDefinitionsTs({
    agentIds: definitions.agentIds,
    agentDefinitionsById: definitions.agentDefinitionsById,
    nativeHomeEnvironmentKeys: definitions.nativeHomeEnvironmentKeys,
  });
  if (options.mode === 'check') assertGeneratedOutputMatches(outPath, out);
  else publishCoherentProjectionOutputs(options.rootDir, [{ outPath, out }], publicationContext);
}

async function runRuntimeConsumedAgentFactsPrivateChild(
  argv: readonly string[],
  inheritedLockValue: string | undefined,
): Promise<void> {
  await runGeneratorPrivateChild(argv, inheritedLockValue,
    activeGeneratorPreparationLease ? `facts:${activeGeneratorPreparationLease.heldLockValue}` : '1');
}

async function runGeneratorPrivateChild(
  argv: readonly string[],
  inheritedLockValue: string | undefined,
  phase: string,
  inheritedFailures?: readonly BundledPluginPackageFailure[],
): Promise<void> {
  const childEnvironment = createWorkspaceChildBuildEnv({
    env: process.env,
    heldLockValue: inheritedLockValue,
  });
  childEnvironment[PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV] = phase;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), ...argv],
      {
        cwd: process.cwd(),
        env: childEnvironment,
        stdio: inheritedFailures === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      },
    );
    if (inheritedFailures !== undefined) child.stdin?.end(JSON.stringify(inheritedFailures));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        `Bundled generator private phase failed (${signal ?? `exit ${String(code)}`})`,
      ));
    });
  });
}

async function collectBundledPluginSourcePackages(
  params: Readonly<{
    repoRoot: string;
    bundledPluginPackageNames: readonly string[];
    mode: Mode;
    dependencies: GeneratorWorkspaceDependencies;
    synchronizeSerializedManifest: boolean;
    readAgentRuntimeFacts?: boolean;
  }>,
): Promise<Readonly<{
  sourcePluginPackages: readonly BundledPluginSourcePackage[];
  failures: readonly BundledPluginPackageFailure[];
}>> {
  const pluginsRoot = resolve(params.repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) {
    return Object.freeze({ sourcePluginPackages: Object.freeze([]), failures: Object.freeze([]) });
  }

  const collectedSources = await mapWithConcurrency(
    params.bundledPluginPackageNames,
    2,
    async (packageName): Promise<Readonly<{
      sourcePluginPackage?: BundledPluginSourcePackage;
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

      const sourceManifest = await loadPluginManifest(
        params.repoRoot,
        pluginPackageId,
        params.dependencies,
      );
      if (params.synchronizeSerializedManifest) {
        await synchronizeSerializedPluginManifest({
          packageRoot,
          manifest: sourceManifest,
          mode: params.mode,
          dependencies: params.dependencies,
        });
      }
      const manifest = params.synchronizeSerializedManifest
        ? readCommittedBundledPluginManifest(
          packageRoot,
          packageName,
          params.dependencies.protocol,
        )
        : sourceManifest;
      const sourceProjectionFacts = await readSourceProjectionFacts({
        repoRoot: params.repoRoot,
        pluginPackageId,
        packageName,
        manifest,
        dependencies: params.dependencies,
        readAgentRuntimeFacts: params.readAgentRuntimeFacts,
      });

      return Object.freeze({ sourcePluginPackage: Object.freeze({
        packageRoot,
        packageJson: pkgJson,
        pluginPackageId,
        pluginId: manifest.id,
        packageName,
        packageVersion: pkgJson.version,
        manifest,
        ...(sourceProjectionFacts.agentNativeHomeEnvironmentKeys
          ? { agentNativeHomeEnvironmentKeys: sourceProjectionFacts.agentNativeHomeEnvironmentKeys }
          : {}),
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
      }) });
    } catch (error) {
      return Object.freeze({ failure: createBundledPluginPublicationFailure({
        repoRoot: params.repoRoot,
        packageName,
        code: 'plugin_manifest_invalid',
        error,
      }) });
    }
    }),
  );

  const sourcePluginPackages = collectedSources.flatMap(
    (entry) => entry.sourcePluginPackage ? [entry.sourcePluginPackage] : [],
  );
  const failures = collectedSources.flatMap((entry) => entry.failure ? [entry.failure] : []);

  sourcePluginPackages.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return Object.freeze({
    sourcePluginPackages: Object.freeze(sourcePluginPackages),
    failures: Object.freeze(failures),
  });
}

async function materializeBundledPluginPackages(
  params: Readonly<{
    repoRoot: string;
    sourcePluginPackages: readonly BundledPluginSourcePackage[];
    mode: Mode;
    targetOwnedOnly?: boolean;
    scope: GeneratorScope;
    dependencies: GeneratorWorkspaceDependencies;
  }>,
): Promise<Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
  failures: readonly BundledPluginPackageFailure[];
}>> {
  const getCanonicalWorkspacePackageRoots = createCanonicalWorkspacePackageRootsReader(
    params.repoRoot,
    params.dependencies,
  );
  const failures: BundledPluginPackageFailure[] = [];

  const collectedArtifacts = await mapWithConcurrency(
    params.sourcePluginPackages,
    2,
    async (sourcePluginPackage): Promise<Readonly<{
      pluginPackage?: BundledPluginPackage;
      failure?: BundledPluginPackageFailure;
    }>> => {
      try {
        const {
          packageRoot,
          packageJson,
          ...pluginPackage
        } = sourcePluginPackage;
        await prepareBundledPluginPackageArtifacts({
          packageRoot,
          pluginPackageId: pluginPackage.pluginPackageId,
          packageJson,
          manifest: pluginPackage.manifest,
          mode: params.mode,
          targetOwnedOnly: params.targetOwnedOnly,
          scope: params.scope,
          dependencies: params.dependencies,
          getCanonicalWorkspacePackageRoots,
        });
        return Object.freeze({ pluginPackage: Object.freeze({
          ...pluginPackage,
        }) });
      } catch (error) {
        return Object.freeze({ failure: createBundledPluginPublicationFailure({
          repoRoot: params.repoRoot,
          packageName: sourcePluginPackage.packageName,
          pluginId: sourcePluginPackage.pluginId,
          error,
        }) });
      }
    },
  );

  const out = collectedArtifacts.flatMap((entry) => entry.pluginPackage ? [entry.pluginPackage] : []);
  failures.push(...collectedArtifacts.flatMap((entry) => entry.failure ? [entry.failure] : []));

  out.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return Object.freeze({
    pluginPackages: Object.freeze(out),
    failures: Object.freeze(failures),
  });
}

async function collectBundledPluginPackages(
  params: Readonly<{
    repoRoot: string;
    bundledPluginPackageNames: readonly string[];
    mode: Mode;
    targetOwnedOnly?: boolean;
    scope: GeneratorScope;
    dependencies: GeneratorWorkspaceDependencies;
    excludedArtifactPackageNames?: ReadonlySet<string>;
  }>,
): Promise<Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
  failures: readonly BundledPluginPackageFailure[];
}>> {
  const sourceResult = await collectBundledPluginSourcePackages({
    repoRoot: params.repoRoot,
    bundledPluginPackageNames: params.bundledPluginPackageNames,
    mode: params.mode,
    dependencies: params.dependencies,
    synchronizeSerializedManifest: true,
  });
  const materialized = await materializeBundledPluginPackages({
    repoRoot: params.repoRoot,
    sourcePluginPackages: sourceResult.sourcePluginPackages.filter((entry) => (
      !params.excludedArtifactPackageNames?.has(entry.packageName)
    )),
    mode: params.mode,
    targetOwnedOnly: params.targetOwnedOnly,
    scope: params.scope,
    dependencies: params.dependencies,
  });
  return Object.freeze({
    // Tracked declarations describe source membership, not this publication's
    // runtime admission. Failed artifact preparation lives only in failures.json.
    pluginPackages: sourceResult.sourcePluginPackages,
    failures: Object.freeze([...sourceResult.failures, ...materialized.failures]),
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
  dependencies: Readonly<{ protocol: BundledPluginManifestParser }>,
): Readonly<{
  pluginPackages: readonly BundledPluginPackage[];
  failures: readonly BundledPluginPackageFailure[];
}> {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return Object.freeze({ pluginPackages: [], failures: [] });

  const out: BundledPluginPackage[] = [];
  const failures: BundledPluginPackageFailure[] = [];
  const pluginOwnerById = new Map<string, string>();
  const agentOwnerById = new Map<string, string>();
  for (const packageName of bundledPluginPackageNames) {
    let entry: BundledPluginPackage;
    try {
    const pluginPackageId = pluginPackageNameToPackageId(packageName);
    const packageRoot = resolve(pluginsRoot, pluginPackageId);
    const packageJsonPath = resolve(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new Error(`Missing bundled plugin package metadata: ${packageJsonPath}`);
    }
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

    const agentContributions = readManifestContributionArray(manifest, 'agents');
    let agentId: string | undefined;
    for (const agentContribution of agentContributions) {
      const contributionAgentId = readRequiredContributionId(
        agentContribution,
        'agents',
        pluginPackageId,
      );
      agentId ??= contributionAgentId;
    }

    entry = Object.freeze({
      pluginPackageId,
      pluginId: manifest.id,
      packageName,
      packageVersion: packageJson.version,
      manifest,
      ...(agentId ? { agentId } : {}),
    });
    } catch (error) {
      failures.push(createBundledPluginPublicationFailure({
        repoRoot, packageName, code: 'plugin_manifest_invalid', error,
      }));
      continue;
    }
    const previousPluginOwner = pluginOwnerById.get(entry.pluginId);
    if (previousPluginOwner) {
      throw new Error(`Duplicate bundled plugin id '${entry.pluginId}' from '${previousPluginOwner}' and '${packageName}'`);
    }
    pluginOwnerById.set(entry.pluginId, packageName);
    for (const agentContribution of readManifestContributionArray(entry.manifest, 'agents')) {
      const agentId = readRequiredContributionId(agentContribution, 'agents', entry.pluginPackageId);
      const previousAgentOwner = agentOwnerById.get(agentId);
      if (previousAgentOwner) {
        throw new Error(`Duplicate bundled agent provider id '${agentId}' from '${previousAgentOwner}' and '${packageName}'`);
      }
      agentOwnerById.set(agentId, packageName);
    }
    out.push(entry);
  }
  return Object.freeze({
    pluginPackages: Object.freeze(out.sort((left, right) => left.packageName.localeCompare(right.packageName))),
    failures: Object.freeze(failures),
  });
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

function readBundledVoiceClientBinding(
  contribution: Readonly<Record<string, unknown>>,
  pluginPackageId: string,
): Readonly<{ artifactId: string; exportName: string }> {
  const client = contribution.client;
  if (!isRecord(client)) {
    throw new Error(
      `Invalid voiceProviders contribution in ${pluginPackageId}: conversation client execution is required`,
    );
  }
  if (typeof client.artifactId !== 'string' || client.artifactId.length === 0) {
    throw new Error(
      `Invalid voiceProviders contribution in ${pluginPackageId}: conversation client.artifactId is required`,
    );
  }
  if (typeof client.exportName !== 'string' || client.exportName.length === 0) {
    throw new Error(
      `Invalid voiceProviders contribution in ${pluginPackageId}: conversation client.exportName is required`,
    );
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(client.exportName)) {
    throw new Error(
      `Invalid voiceProviders contribution in ${pluginPackageId}: conversation client.exportName must be a JavaScript export identifier`,
    );
  }
  return Object.freeze({ artifactId: client.artifactId, exportName: client.exportName });
}

function assertBundledVoicePackageExport(
  packageJson: Record<string, unknown>,
  packageName: string,
  artifactId: string,
): void {
  const exportSubpath = `./happier-plugin-ui/${artifactId}`;
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

  const defaultPath = exportTarget.default;
  const nativePath = exportTarget['react-native'];
  const expectedConditionOrder = nativePath !== undefined
    ? ['react-native', 'default']
    : ['default'];
  if (JSON.stringify(Object.keys(exportTarget)) !== JSON.stringify(expectedConditionOrder)) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected ordered conditions ${expectedConditionOrder.join(', ')}`,
    );
  }
  const builtArtifactRoot = './dist/ui/voice/';
  const isSafeBuiltArtifactPath = (value: unknown): value is string => {
    if (typeof value !== 'string' || !value.startsWith(builtArtifactRoot) || !value.endsWith('.js')) {
      return false;
    }
    const relativePath = value.slice(builtArtifactRoot.length);
    return relativePath.length > '.js'.length
      && /^[A-Za-z0-9._/-]+$/.test(relativePath)
      && relativePath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  };
  if (!isSafeBuiltArtifactPath(defaultPath) || (nativePath !== undefined && !isSafeBuiltArtifactPath(nativePath))) {
    throw new Error(
      `Invalid bundled voice export '${packageName}/${exportSubpath.slice(2)}': expected typed built artifact export`,
    );
  }
}

export async function collectBundledFirstPartyVoiceProjectionSources(
  repoRoot: string,
  pluginPackages: readonly BundledPluginPackage[],
  readPresentationFacts = true,
  excludedPackageNames: ReadonlySet<string> = new Set(),
): Promise<Readonly<{
  sources: readonly BundledFirstPartyVoiceProjectionSource[];
  failures: readonly BundledPluginPackageFailure[];
}>> {
  const sources: BundledFirstPartyVoiceProjectionSource[] = [];
  const failures: BundledPluginPackageFailure[] = [];
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
    const conversationContributions = readManifestContributionArray(
      pluginPackage.manifest,
      'voiceProviders',
    ).filter((contribution) => isRecord(contribution) && contribution.kind === 'conversation');
    const conversationPlatforms = new Set<BundledVoiceRuntimePlatform>();
    let conversationClient: Readonly<{ artifactId: string; exportName: string }> | null = null;
    for (const contribution of conversationContributions) {
      if (!isRecord(contribution) || !Array.isArray(contribution.platforms)) {
        throw new Error(
          `Invalid voiceProviders contribution in ${pluginPackageId}: conversation platforms are required`,
        );
      }
      const contributionClient = readBundledVoiceClientBinding(contribution, pluginPackageId);
      if (
        conversationClient
        && (conversationClient.artifactId !== contributionClient.artifactId
          || conversationClient.exportName !== contributionClient.exportName)
      ) {
        throw new Error(
          `Invalid voiceProviders contribution in ${pluginPackageId}: bundled conversation providers must share one client artifact binding`,
        );
      }
      conversationClient = contributionClient;
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
    if (conversationClient) {
      assertBundledVoicePackageExport(
        packageJson,
        pluginPackage.packageName,
        conversationClient.artifactId,
      );
    }
    const presentationPath = resolve(repoRoot, 'packages/plugins', pluginPackageId, 'src/ui/voice/entries.ts');
    let presentations: readonly JsonObject[] = [];
    if (readPresentationFacts && !excludedPackageNames.has(pluginPackage.packageName)) {
      try {
        const presentationModule = await importTypescriptModule(presentationPath) as Record<string, unknown>;
        const facts = presentationModule.VOICE_PROVIDER_PRESENTATIONS;
        if (!Array.isArray(facts) || facts.some((presentation) => (
          !isJsonObject(presentation)
          || typeof presentation.providerId !== 'string'
          || typeof presentation.settingsSectionId !== 'string'
        ))) {
          throw new Error(`Invalid bundled Voice presentation facts: ${presentationPath}`);
        }
        presentations = facts as JsonObject[];
      } catch (error) {
        failures.push(createBundledPluginPublicationFailure({
          repoRoot,
          packageName: pluginPackage.packageName,
          pluginId: pluginPackage.pluginId,
          code: 'plugin_ui_artifact_invalid',
          error,
        }));
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
      conversationClient,
      presentations,
    });
  }

  return Object.freeze({
    sources: Object.freeze(sources.sort((a, b) => a.packageName.localeCompare(b.packageName))),
    failures: Object.freeze(failures),
  });
}

function renderBundledVoiceRuntimeProjectionOutputs(
  rootDir: string,
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
  failures: readonly BundledPluginPackageFailure[],
  mode: Mode,
): readonly Readonly<{ outPath: string; out: string }>[] {
  const excludedPackageNames = new Set(failures.map((failure) => failure.packageName));
  const outputs = BUNDLED_VOICE_RUNTIME_PLATFORMS.map((platform) => ({
    platform,
    outPath: resolve(rootDir, 'apps/ui/sources/voice/registry',
      `generatedBundledVoiceRuntimeEntries${platform === 'web' ? '' : `.${platform}`}.ts`),
    out: renderBundledVoiceRuntimeEntriesTs(sources, platform, excludedPackageNames),
  }));
  const common = outputs[0]!.out;
  return outputs.flatMap(({ platform, ...output }) => {
    if (platform !== 'web' && output.out === common) {
      removeRetiredGeneratedOutput(output.outPath, mode);
      return [];
    }
    return [output];
  });
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

export async function publishBundledPluginSemanticProjection(
  options: GeneratorOptions,
  dependencies: Readonly<{ protocol: BundledPluginManifestParser }>,
  publicationLease: ProjectionPublicationLease,
  additionalOutputs: readonly Readonly<{ outPath: string; out: string }>[] = [],
  publicationFailures: readonly BundledPluginPackageFailure[] = [],
): Promise<readonly BundledPluginPackageFailure[]> {
  const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
  const serialized = readSerializedBundledPluginPackages(
    options.rootDir,
    bundledPluginPackageNames,
    dependencies,
  );
  const failures = mergeBundledPluginFailures(publicationFailures, serialized.failures);
  assertNoBundledPluginPublicationFailures(failures, options.mode);
  const pluginPackages = serialized.pluginPackages;
  const cliManifestOutPath = resolve(
    options.rootDir,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
  );
  const cliManifestOut = renderCliBundledPluginManifestEntriesTs({ pluginPackages });
  // Serialized declaration facts suffice for executable roots; never inspect
  // failed authored leaves or retain an old activation import in scoped publication.
  const runtimeFailures = resolveBundledPluginPublicationFailures(options.rootDir, failures,
    options.aggregateOnly
      ? failures.map((failure) => failure.packageName)
      : options.workspaceNames.length > 0
        ? resolveSelectedBundledPluginPackageNames(bundledPluginPackageNames, options.workspaceNames)
        : undefined,
  );
  const voiceProjection = options.targetOwnedOnly ? { sources: [] } : await collectBundledFirstPartyVoiceProjectionSources(
    options.rootDir,
    pluginPackages.filter((entry) => !runtimeFailures.some((failure) => failure.packageName === entry.packageName)),
    false,
  );
  const voiceRuntimeOutputs = options.targetOwnedOnly ? [] : renderBundledVoiceRuntimeProjectionOutputs(
    options.rootDir, voiceProjection.sources, runtimeFailures, options.mode,
  );

  if (options.mode === 'check') {
    assertGeneratedOutputMatches(cliManifestOutPath, cliManifestOut);
    for (const output of [...additionalOutputs, ...voiceRuntimeOutputs]) {
      assertGeneratedOutputMatches(output.outPath, output.out);
    }
    return failures;
  }

  publishCoherentProjectionOutputs(options.rootDir, [
    ...(!options.targetOwnedOnly
      ? [{ outPath: cliManifestOutPath, out: cliManifestOut }]
      : []),
    ...additionalOutputs,
    ...voiceRuntimeOutputs,
  ], publicationLease);
  if (options.aggregateOnly) {
    // Serialized manifests cannot settle an unrelated authored-source failure.
    // Aggregate publication replaces only diagnostics actually evaluated here;
    // scoped/full source publication below owns recovery of successful packages.
    writeBundledPluginPublicationFailures(options.rootDir, failures, failures.map((failure) => failure.packageName));
  }
  return failures;
}

export function collectBundledAgentContributionIdentities(
  pluginPackages: readonly BundledPluginPackage[],
  dependencies: GeneratedCompilerInputDependencies,
): Readonly<Record<string, Readonly<{ pluginId: string; localId: string }>>> {
  // The id union retains the upstream source catalog even when an optional
  // plugin cannot be prepared. Retain its declared identity from that same
  // catalog; successfully read authored facts replace it below.
  return Object.freeze(Object.fromEntries([
    ...Object.entries(dependencies.agents.BUNDLED_AGENT_CONTRIBUTION_IDENTITIES),
    ...pluginPackages.flatMap((pluginPackage) => {
      if (!pluginPackage.agentId) return [];
      const manifestAgent = readManifestContributionArray(pluginPackage.manifest, 'agents')[0];
      const localId = readRequiredContributionId(
        manifestAgent,
        'agents',
        pluginPackage.pluginPackageId,
      );
      return [[pluginPackage.agentId, Object.freeze({
        pluginId: pluginPackage.pluginId,
        localId,
      })] as const];
    }),
  ]));
}

function collectGeneratedAgentIds(
  pluginAgentIds: readonly string[],
  dependencies: BundledAgentCatalogDependencies,
): readonly string[] {
  const sourceIds = [
    ...dependencies.agents.AGENT_IDS,
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
  for (const agentId of dependencies.agents.AGENT_IDS) {
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

/**
 * The generated TypeScript files that are *compiler inputs* of workspaces this
 * publisher itself depends on.
 *
 * `packages/agents/src/generated/agentIds.ts` compiles into
 * `@happier-dev/agents/agent-ids`, which `packages/cli-common` imports for
 * `BUNDLED_AGENT_CONTRIBUTION_IDENTITIES`, and `plugin-sdk` depends on
 * `cli-common`. Both therefore compile in this publisher's FIRST preparation
 * phase, so these two files must be publishable before any workspace `dist`
 * exists — see `runCanonicalGeneratedCompilerInputs` in
 * `apps/cli/scripts/buildSharedDeps.mjs`, the single pre-build choke point that
 * invokes `--compiler-inputs`.
 */
function resolveGeneratedCompilerInputOutPaths(rootDir: string): Readonly<{
  agentIds: string;
  protocolAgentProviderIdsV1: string;
  protocolBundledAgentIdentitiesV1: string;
}> {
  return Object.freeze({
    agentIds: resolve(rootDir, 'packages/agents/src/generated/agentIds.ts'),
    protocolAgentProviderIdsV1: resolve(
      rootDir,
      'packages/protocol/src/generated/providers/agentProviderIdsV1.ts',
    ),
    protocolBundledAgentIdentitiesV1: resolve(
      rootDir,
      'packages/protocol/src/generated/agents/bundledAgentIdentitiesV1.ts',
    ),
  });
}

function renderGeneratedCompilerInputs(params: Readonly<{
  generatedAgentIds: readonly string[];
  contributionIdentities: Readonly<Record<string, Readonly<{ pluginId: string; localId: string }>>>;
}>): Readonly<{ agentIds: string; protocolAgentProviderIdsV1: string; protocolBundledAgentIdentitiesV1: string }> {
  return Object.freeze({
    agentIds: renderAgentIdsTs({
      agentIds: params.generatedAgentIds,
      contributionIdentities: params.contributionIdentities,
    }),
    protocolAgentProviderIdsV1: renderProtocolAgentProviderIdsV1Ts(
      collectProtocolAgentProviderIdsV1(params.generatedAgentIds),
    ),
    protocolBundledAgentIdentitiesV1: renderProtocolBundledAgentIdentitiesV1Ts({
      agentIds: params.generatedAgentIds,
      contributionIdentities: params.contributionIdentities,
    }),
  });
}

/**
 * Publishes only the generated compiler inputs.
 *
 * This carries the current source-derived Agent ids and contribution identity
 * map forward without consulting serialized manifests. The full run later
 * derives both from authored plugin sources and replaces these outputs. It
 * deliberately loads neither the plugin authoring runtime nor the esbuild
 * daemon-runtime stage, and imports no workspace whose `dist` these inputs
 * unblock.
 */
async function publishGeneratedCompilerInputs(
  options: GeneratorOptions,
  publicationLease: ProjectionPublicationLease,
): Promise<void> {
  const dependencies = await loadGeneratedCompilerInputDependencies();
  const out = renderGeneratedCompilerInputs({
    generatedAgentIds: collectGeneratedAgentIds([], dependencies),
    contributionIdentities: dependencies.agents.BUNDLED_AGENT_CONTRIBUTION_IDENTITIES,
  });
  const outPaths = resolveGeneratedCompilerInputOutPaths(options.rootDir);
  const outputs = [
    { outPath: outPaths.agentIds, out: out.agentIds },
    { outPath: outPaths.protocolAgentProviderIdsV1, out: out.protocolAgentProviderIdsV1 },
    { outPath: outPaths.protocolBundledAgentIdentitiesV1, out: out.protocolBundledAgentIdentitiesV1 },
  ];
  if (options.mode === 'check') {
    for (const output of outputs) {
      assertGeneratedOutputMatches(output.outPath, output.out);
    }
    return;
  }
  publishCoherentProjectionOutputs(options.rootDir, outputs, publicationLease);
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

export function renderRetainedCliBundledPluginImplementationEntriesTs(
  entriesOutPath: string,
  excludedPluginIds: ReadonlySet<string> = new Set(),
): string {
  const source = readFileSync(entriesOutPath, 'utf8');
  const registrations = [...source.matchAll(
    /identity:\s*(?:createPluginContributionIdentity\(\s*|Object\.freeze\(\s*)?\{\s*pluginId:\s*("(?:\\.|[^"\\])*")\s*,\s*localId:\s*("(?:\\.|[^"\\])*")\s*,?\s*\}\s*\)?\s*,\s*implementationOwnerId:\s*("(?:\\.|[^"\\])*")\s*,\s*registrationFamily:\s*(['"])([^'"]+)\4\s*,/gms,
  )].map((match): BundledFirstPartyAgentRegistrationIdentity => ({
    pluginId: JSON.parse(match[1]!),
    localId: JSON.parse(match[2]!),
    implementationOwnerId: JSON.parse(match[3]!),
    registrationFamily: match[5]!,
  })).filter((registration) => !excludedPluginIds.has(registration.pluginId));
  if (registrations.length === 0) {
    throw new Error(
      `Invalid generated bundled plugin registry at ${entriesOutPath}: missing Agent registration bindings`,
    );
  }
  return renderCliBundledAgentRegistrationBindingsTs(registrations);
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

export function collectBundledPluginUiTranslations(
  pluginPackages: readonly Readonly<{
    pluginPackageId: string;
    manifest: Readonly<{ contributes?: unknown }>;
  }>[],
): JsonObject {
  const messagesByLocale = new Map<string, Map<string, { owner: string; value: string }>>();
  // Bundled packages may each embed the same shared UI source. The aggregate
  // owns one locale/key table, so identical source text is one contribution;
  // only divergent values are an ambiguous contract failure. Sort only to make
  // that diagnostic independent of package discovery order, never to select a
  // winner.
  for (const pluginPackage of [...pluginPackages].sort((left, right) => (
    left.pluginPackageId.localeCompare(right.pluginPackageId)
  ))) {
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
          if (existing.value !== value) {
            throw new Error(
              `Conflicting bundled UI translation '${translation.locale}:${key}' from ${existing.owner} and ${pluginPackage.pluginPackageId}`,
            );
          }
          continue;
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

function collectPromptAssetContributionSources(
  pluginPackages: readonly BundledPluginPackage[],
): readonly PromptAssetContributionSource[] {
  return pluginPackages
    .flatMap((pluginPackage) => (
      pluginPackage.promptAssetContributions ? [pluginPackage.promptAssetContributions] : []
    ))
    .sort((a, b) => a.pluginPackageId.localeCompare(b.pluginPackageId));
}

async function generateBundledPluginEntries(
  options: GeneratorOptions,
  dependencies: GeneratorWorkspaceDependencies,
  publicationLease: WorkspaceBundleLockContext,
  inheritedFailures: readonly BundledPluginPackageFailure[] = [],
): Promise<readonly BundledPluginPackageFailure[]> {
  if (options.aggregateOnly) {
    return await publishBundledPluginSemanticProjection(options, dependencies, publicationLease, [], inheritedFailures);
  }

  if (options.workspaceNames.length > 0) {
    const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
    const selectedPackageNames = resolveSelectedBundledPluginPackageNames(
      bundledPluginPackageNames,
      options.workspaceNames,
    ).filter((packageName) => !inheritedFailures.some((failure) => failure.packageName === packageName));
    const cliOutPath = resolve(
      options.rootDir,
      'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
    );
    const selectedResult = await collectBundledPluginPackages({
      repoRoot: options.rootDir,
      bundledPluginPackageNames: selectedPackageNames,
      mode: options.mode,
      targetOwnedOnly: options.targetOwnedOnly,
      scope: options.scope,
      dependencies,
    });
    const selectedPluginPackages = selectedResult.pluginPackages;
    const failures = mergeBundledPluginFailures(inheritedFailures, selectedResult.failures);
    assertNoBundledPluginPublicationFailures(failures, options.mode);
    if (selectedPluginPackages.length > 0 || failures.length > 0) {
      const cliOut = renderRetainedCliBundledPluginImplementationEntriesTs(
        cliOutPath,
        new Set(),
      );
      if (options.mode === 'check') {
        assertGeneratedOutputMatches(cliOutPath, cliOut);
      } else {
        return await publishBundledPluginSemanticProjection(
          options,
          dependencies,
          publicationLease,
          !options.targetOwnedOnly ? [{ outPath: cliOutPath, out: cliOut }] : [],
          failures,
        );
      }
    }
    return failures;
  }

  // Discover and validate every package before mutating host membership. A rejected
  // first-party identity/export must not leave package.json or generated outputs in a
  // partially admitted state.
  const bundledPluginPackageNames = readBundledPluginPackageNames(options.rootDir);
  const discoveredPluginPackages = await readBundledPluginPackages(
    options.rootDir,
    bundledPluginPackageNames,
    options.mode,
    options.scope,
    dependencies,
    new Set(inheritedFailures.map((failure) => failure.packageName)),
  );
  let failures = mergeBundledPluginFailures(inheritedFailures, discoveredPluginPackages.failures);
  assertNoBundledPluginPublicationFailures(failures, options.mode);
  const pluginPackages = discoveredPluginPackages.pluginPackages;
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
  const bundledVoiceProjection = await collectBundledFirstPartyVoiceProjectionSources(
    options.rootDir,
    pluginPackages,
    true,
    new Set(failures.map((failure) => failure.packageName)),
  );
  failures = mergeBundledPluginFailures(failures, bundledVoiceProjection.failures);
  assertNoBundledPluginPublicationFailures(failures, options.mode);
  const bundledVoiceProjectionSources = bundledVoiceProjection.sources;
  const packageNames = pluginPackages.map((entry) => entry.packageName);
  const bundledAgentDefinitionProjection = collectBundledAgentDefinitionProjection(pluginPackages);
  const bundledAgentDefinitionIds = bundledAgentDefinitionProjection.agentIds;
  const generatedAgentIds = collectGeneratedAgentIds(bundledAgentDefinitionIds, dependencies);
  const agentDefinitionsById = bundledAgentDefinitionProjection.agentDefinitionsById;

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
  const generatedCompilerInputOutPaths = resolveGeneratedCompilerInputOutPaths(options.rootDir);
  const agentIdsOutPath = generatedCompilerInputOutPaths.agentIds;
  const retiredSessionControlAdaptersOutPath = resolve(
    options.rootDir,
    'packages/agents/src/generated/sessionControlAdapters.ts',
  );
  const runtimeDescriptorReadersOutPath = resolve(options.rootDir, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  const protocolAgentProviderIdsV1OutPath =
    generatedCompilerInputOutPaths.protocolAgentProviderIdsV1;
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

  const cliOut = renderCliBundledPluginEntriesTs({ pluginPackages });
  const cliManifestOut = renderCliBundledPluginManifestEntriesTs({ pluginPackages });

  const agentsOut = renderBundledAgentDefinitionsTs({
    agentIds: bundledAgentDefinitionIds,
    agentDefinitionsById,
    nativeHomeEnvironmentKeys: bundledAgentDefinitionProjection.nativeHomeEnvironmentKeys,
  });
  const protocolSessionPresentationCompatV1Out =
    renderProtocolSessionPresentationCompatV1Ts({
      agentIds: bundledAgentDefinitionIds,
      agentDefinitionsById,
    });
  const agentIdsOut = renderAgentIdsTs({
    agentIds: generatedAgentIds,
    contributionIdentities: collectBundledAgentContributionIdentities(pluginPackages, dependencies),
  });
  const runtimeDescriptorReadersOut = renderAgentRuntimeDescriptorReadersTs(
    collectReleasedFlatSessionMetadataRuntimeDescriptorReaderContributions(pluginPackages),
  );
  const protocolAgentProviderIdsV1Out = renderProtocolAgentProviderIdsV1Ts(
    collectProtocolAgentProviderIdsV1(generatedAgentIds),
  );
  const protocolBundledAgentIdentitiesV1Out = renderProtocolBundledAgentIdentitiesV1Ts({
    agentIds: generatedAgentIds,
    contributionIdentities: collectBundledAgentContributionIdentities(pluginPackages, dependencies),
  });
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
  const voiceRuntimeOutputs = renderBundledVoiceRuntimeProjectionOutputs(
    options.rootDir, bundledVoiceProjectionSources, failures, options.mode,
  );
  syncCliBundledPluginMembership({
    rootDir: options.rootDir,
    mode: options.mode,
  });
  syncBundledVoiceUiPackageDependencies({
    rootDir: options.rootDir,
    mode: options.mode,
    sources: bundledVoiceProjectionSources,
  });
  removeRetiredGeneratedOutput(retiredAgentSettingsOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredHostAgentSettingsOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredSessionControlAdaptersOutPath, options.mode);
  removeRetiredGeneratedOutput(retiredProtocolRuntimeDescriptorContributionsOutPath, options.mode);
  for (const retiredOutPath of retiredProtocolRuntimeDescriptorModuleOutPaths) {
    removeRetiredGeneratedOutput(retiredOutPath, options.mode);
  }
  if (options.mode === 'check') {
    assertGeneratedOutputMatches(cliOutPath, cliOut);
    assertGeneratedOutputMatches(cliManifestOutPath, cliManifestOut);
    assertGeneratedOutputMatches(agentsOutPath, agentsOut);
    assertGeneratedOutputMatches(agentIdsOutPath, agentIdsOut);
    assertGeneratedOutputMatches(runtimeDescriptorReadersOutPath, runtimeDescriptorReadersOut);
    assertGeneratedOutputMatches(protocolAgentProviderIdsV1OutPath, protocolAgentProviderIdsV1Out);
    assertGeneratedOutputMatches(
      generatedCompilerInputOutPaths.protocolBundledAgentIdentitiesV1,
      protocolBundledAgentIdentitiesV1Out,
    );
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
    for (const output of voiceRuntimeOutputs) {
      assertGeneratedOutputMatches(output.outPath, output.out);
    }
    return failures;
  }

  publishCoherentProjectionOutputs(options.rootDir, [
    { outPath: cliOutPath, out: cliOut },
    { outPath: cliManifestOutPath, out: cliManifestOut },
    { outPath: agentsOutPath, out: agentsOut },
    { outPath: agentIdsOutPath, out: agentIdsOut },
    { outPath: runtimeDescriptorReadersOutPath, out: runtimeDescriptorReadersOut },
    { outPath: protocolAgentProviderIdsV1OutPath, out: protocolAgentProviderIdsV1Out },
    {
      outPath: generatedCompilerInputOutPaths.protocolBundledAgentIdentitiesV1,
      out: protocolBundledAgentIdentitiesV1Out,
    },
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
    ...voiceRuntimeOutputs,
  ], publicationLease);
  return failures;
}

async function withGeneratorPublicationLock<T>(
  operation: (context: WorkspaceBundleLockContext) => Promise<T>,
  heldLockValue: string | undefined = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
  prepare: () => Promise<() => void> = async () => () => {},
): Promise<T> {
  return await withPreparedGeneratorPublication({
    prepare,
    preparationLease: activeGeneratorPreparationLease,
    publish: operation,
    lockOptions: {
      // The generator's runtime dependencies are loaded from the canonical
      // workspace closure, even when a caller projects into a temporary
      // target root. Serialize against that producer root so a temp-root
      // invocation cannot observe a concurrent canonical dist publication.
      lockPath: resolveWorkspaceBundleLockPath(CANONICAL_GENERATOR_REPO_ROOT),
      heldLockValue,
      errorLabel: 'bundled plugin generator workspace lock',
    },
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseGeneratorCliArgs(argv);
  const canonicalWrite = options.mode === 'write'
    && resolve(options.rootDir) === CANONICAL_GENERATOR_REPO_ROOT
    && !options.compilerInputsOnly && !options.agentDefinitionsOnly
    && !options.aggregateOnly && !options.targetOwnedOnly;
  if (!canonicalWrite) return await runGenerator(argv, options);

  const inheritedFailures = readInheritedBundledPluginFailures(options.inheritedFailuresStdin, options.rootDir);
  const bundledNames = readBundledPluginPackageNames(options.rootDir).map((name) => name.replace('@happier-dev/', ''));
  // The all-plugin spelling and an unscoped request have the same publication
  // owner. Normalize both execution and admission, including the private facts
  // phase, so source readiness and snapshot reconciliation cannot duplicate it.
  const { options: selectedOptions, argv: selectedArgv } = normalizeCanonicalGeneratorPublication(argv, options, bundledNames);
  const request = JSON.stringify({
    workspaceNames: [...selectedOptions.workspaceNames].sort(),
    inheritedFailures,
    publicationMode: process.env.HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE ?? 'live',
  });
  const workspaceNames = [...new Set([
    'plugin-sdk',
    ...resolveCliBundledWorkspacePackageNames({ repoRoot: options.rootDir }),
    ...bundledNames,
  ])].sort();
  const readFingerprint = () => JSON.stringify([
    request,
    ...[
      resolve(options.rootDir, 'apps/cli'),
      ...workspaceNames.map((workspaceName) => resolveBundledWorkspacePackageDir({ repoRoot: options.rootDir, workspaceName })),
    ].map((packageDir) => readWorkspacePackageInputFingerprint({
      packageDir,
      // CLI release files include executable distribution globs; the publisher
      // consumes its source/scripts, not those downstream packaged outputs.
      includeShippedFiles: packageDir !== resolve(options.rootDir, 'apps/cli'),
      excludeGeneratedPluginArtifacts: true,
    })),
  ]);
  const inheritedLockValue = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  await withGeneratorSingleFlight({
    readFingerprint,
    readCurrentness: () => JSON.stringify([
      readFingerprint(),
      computeSourceDevSharedDepsSignature({ repoRoot: options.rootDir, workspaceNames }),
      ...workspaceNames.map((workspaceName) => readWorkspacePackageInputFingerprint({
        packageDir: resolveBundledWorkspacePackageDir({ repoRoot: options.rootDir, workspaceName }),
        includeShippedFiles: true,
      })),
    ]),
    stampPath: GENERATOR_PUBLICATION_STAMP_PATH,
    // Each preparation uses a fresh ESM process, also for the trailing pass.
    // The coordinator and waiters never retain a previous heavy authoring graph.
    run: (lease) => runGeneratorPrivateChild(
      selectedArgv,
      inheritedLockValue,
      `publication:${lease.heldLockValue}`,
      selectedOptions.inheritedFailuresStdin ? inheritedFailures : undefined,
    ),
    lockOptions: {
      // An authenticated outer publisher must not wait for a preparation owner
      // that is itself waiting for that publisher. Ordinary callers acquire only
      // the separate preparation lease; all short global transactions stay below.
      lockPath: inheritedLockValue
        ? resolveWorkspaceBundleLockPath(CANONICAL_GENERATOR_REPO_ROOT)
        : resolve(CANONICAL_GENERATOR_REPO_ROOT, '.project/tmp/bundled-plugin-preparation.lock'),
      heldLockValue: inheritedLockValue,
      errorLabel: 'bundled plugin preparation single-flight',
    },
  });
}

async function runGenerator(
  argv: readonly string[],
  options: GeneratorOptions,
  inheritedFailures?: readonly BundledPluginPackageFailure[],
): Promise<void> {
  const timing = createBundledPluginTimingReporter();
  const inheritedLockValue = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  if (options.agentDefinitionsOnly) {
    await withGeneratorPublicationLock(
      async (context) => await publishSourceAgentDefinitions(options, context),
      inheritedLockValue,
    );
    timing.phase('source-agent-definitions');
    return;
  }
  if (options.compilerInputsOnly) {
    // This mode exists to run BEFORE any workspace `dist` exists, so it returns
    // here without the full publication run's authoring synchronization, which
    // compiles the very `agents`/`cli-common`/`plugin-sdk` closure these inputs
    // unblock. Its bounded manifest load and coherent output transaction still
    // run under the canonical publication lock. When build preparation invokes
    // this mode from an existing publisher, the inherited lease makes that lock
    // acquisition reentrant rather than creating a bootstrap deadlock.
    await withGeneratorPublicationLock(
      async (context) => await publishGeneratedCompilerInputs(options, context),
      inheritedLockValue,
    );
    timing.phase('generated-compiler-inputs');
    return;
  }
  const authorRuntimeLoadScope = resolvePluginAuthorRuntimeLoadScope(options);
  const preparationPolicy = resolveGeneratorAuthoringPreparationPolicy({
    mode: options.mode,
    targetsCanonicalRoot: resolve(options.rootDir) === CANONICAL_GENERATOR_REPO_ROOT,
    targetOwnedOnly: options.targetOwnedOnly,
  });
  let pluginFailures = inheritedFailures ?? readInheritedBundledPluginFailures(options.inheritedFailuresStdin, options.rootDir);
  const publishesFullRuntime = options.mode === 'write'
    && options.scope === 'all'
    && options.workspaceNames.length === 0
    && !options.aggregateOnly
    && !options.compilerInputsOnly;
  if (publishesFullRuntime) {
    await withGeneratorPublicationLock(
      async (publicationLease) => {
        timing.phase('compiler-input-publication-lock-wait');
        await publishGeneratedCompilerInputs(options, publicationLease);
        timing.phase('generated-compiler-inputs');
      },
      inheritedLockValue,
      async () => {
        // Compile before acquiring any generator publication lease. The bounded
        // compiler-input mode is an independent bootstrap write, not compilation.
        const assertCurrent = await synchronizeGeneratorAuthoringRuntimeClosure(
          preparationPolicy,
          inheritedLockValue,
          { prepareGeneratedCompilerInputs: false },
        );
        timing.phase('initial-dependency-preparation');
        return assertCurrent;
      },
    );
    // The child owns preparation and its short publication transaction. Do not
    // give it a lease acquired by this parent around its dependency compilation.
    // Its exit remains the ESM cache boundary before parent runtime imports.
    await runRuntimeConsumedAgentFactsPrivateChild(argv, inheritedLockValue);
    timing.phase('runtime-consumed-agent-facts');
  }
  let assertRuntimeCurrent: () => void = () => {};
  const dependencies = await withGeneratorPublicationLock(
    async () => {
      timing.phase('manifest-publication-lock-wait');
      const dependencies = await loadGeneratorWorkspaceDependencies();
      if (authorRuntimeLoadScope !== 'none') {
        await loadPluginAuthorRuntimeForScope(authorRuntimeLoadScope);
        timing.phase('authoring-runtime-load');
      }
      if (!options.aggregateOnly) {
        pluginFailures = mergeBundledPluginFailures(
          pluginFailures,
          await synchronizeSelectedBundledPluginSourceManifests({ options, dependencies }),
        );
        timing.phase('source-manifest-synchronization');
      }
      return dependencies;
    },
    inheritedLockValue,
    async () => {
      if (!options.aggregateOnly) {
        assertRuntimeCurrent = await synchronizeGeneratorAuthoringRuntimeClosure(
          preparationPolicy,
          inheritedLockValue,
          { prepareGeneratedCompilerInputs: publishesFullRuntime ? false : undefined },
        );
        timing.phase('authoring-runtime-synchronization');
      } else {
        assertRuntimeCurrent = captureGeneratorDependencyCurrentness(
          resolveCliBundledWorkspacePackageNames({ repoRoot: CANONICAL_GENERATOR_REPO_ROOT })
            .filter((name) => !name.startsWith('plugins-')),
        );
      }
      return assertRuntimeCurrent;
    },
  );
  await withGeneratorPublicationLock(
    async (publicationLease) => {
      timing.phase('final-publication-lock-wait');
      const publishedFailures = await generateBundledPluginEntries(options, dependencies, publicationLease, pluginFailures);
      if (options.mode === 'write' && !options.aggregateOnly) {
        writeBundledPluginPublicationFailures(
          options.rootDir,
          publishedFailures,
          options.workspaceNames.length > 0
            ? resolveSelectedBundledPluginPackageNames(
                readBundledPluginPackageNames(options.rootDir),
                options.workspaceNames,
              )
            : undefined,
        );
      }
    },
    inheritedLockValue,
    async () => {
      if (!options.aggregateOnly) {
        pluginFailures = mergeBundledPluginFailures(pluginFailures, await prepareSelectedBundledPluginWorkspaceOutputs({
          inheritedLockValue,
          workspaceNames: options.workspaceNames.length > 0
            ? options.workspaceNames
            : undefined,
          excludedPackageNames: new Set(pluginFailures.map((failure) => failure.packageName)),
        }));
        await materializeSelectedBundledPluginWorkspaceOutputs({
          inheritedLockValue,
          generatedCompilerInputMode: preparationPolicy.generatedCompilerInputMode,
          workspaceNames: options.workspaceNames.length > 0
            ? options.workspaceNames.filter((workspaceName) => !pluginFailures.some((failure) => failure.packageName === `@happier-dev/${workspaceName}`))
            : pluginFailures.length > 0
              ? resolveCliBundledWorkspacePackageNames({ repoRoot: CANONICAL_GENERATOR_REPO_ROOT })
                .filter((workspaceName) => workspaceName.startsWith('plugins-'))
                .filter((workspaceName) => !pluginFailures.some((failure) => failure.packageName === `@happier-dev/${workspaceName}`))
              : undefined,
        });
        timing.phase('selected-plugin-preparation');
      }
      return assertRuntimeCurrent;
    },
  );
  timing.phase('generation-and-publication');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const privatePhase = process.env[PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV];
  if (privatePhase?.startsWith('publication:')) {
    delete process.env[PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV];
    const privateOptions = parseGeneratorCliArgs(process.argv.slice(2));
    if (privateOptions.mode !== 'write' || resolve(privateOptions.rootDir) !== CANONICAL_GENERATOR_REPO_ROOT
      || privateOptions.aggregateOnly || privateOptions.targetOwnedOnly
      || privateOptions.compilerInputsOnly || privateOptions.agentDefinitionsOnly) {
      throw new Error('Private bundled publication requires a canonical source write');
    }
    await withParentGeneratorPreparationLease(privatePhase.slice('publication:'.length),
      () => runGenerator(process.argv.slice(2), privateOptions));
  } else if (privatePhase === '1' || privatePhase?.startsWith('facts:')) {
    const heldLockValue = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
    const privateOptions = parseGeneratorCliArgs(process.argv.slice(2));
    if (
      privateOptions.mode !== 'write'
      || privateOptions.scope !== 'all'
      || privateOptions.workspaceNames.length !== 0
      || privateOptions.aggregateOnly
      || privateOptions.compilerInputsOnly
      || privateOptions.agentDefinitionsOnly
    ) {
      throw new Error('Private bundled Agent-facts phase requires one full unscoped write invocation');
    }
    // The marker dispatches only this process. Nested canonical build owners
    // must enter their normal compiler-input modes rather than recursively
    // re-entering the private phase.
    delete process.env[PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV];
    const publishFacts = async () => await withGeneratorPublicationLock(
      async (context) => await runRuntimeConsumedAgentFactsPrivatePhase(
        privateOptions.rootDir,
        context,
      ),
      heldLockValue,
      async () => await synchronizeGeneratorAuthoringRuntimeClosure(
        resolveGeneratorAuthoringPreparationPolicy({ mode: 'check', targetsCanonicalRoot: true }),
        heldLockValue,
        { prepareGeneratedCompilerInputs: false },
      ),
    );
    if (privatePhase.startsWith('facts:')) {
      await withParentGeneratorPreparationLease(privatePhase.slice('facts:'.length), publishFacts);
    } else {
      await publishFacts();
    }
  } else {
    await main();
  }
}
