import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import { decodeJwtPayloadUnsafe } from '../auth/decode_jwt_payload_unsafe.mjs';
import { REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN } from '../managed_lima/guest_toolchain.mjs';
import { DEFAULT_LOAD_PROBE_TTL_MS } from './config.mjs';
import { resolveRemoteStackStorageDir } from './stack_paths.mjs';
import { collectWorkspacePackageJsonPaths } from '../proc/workspace_package_manifests.mjs';
import { resolveDependencyRefreshLockPath } from '../proc/dependency_refresh.mjs';
import { readNativeTestPreparationDemand } from '../fs/nativeTestInputs.mjs';
import { resolveWorkspaceTypeScriptCompilerArgs } from '../../../../../packages/cli-common/workspaceChildBuildEnv.mjs';
import { resolveCliPublicationBuildSteps } from '../../../../cli/scripts/buildPublication.mjs';
import { isCliTestBuildSkipped } from '../../../../cli/scripts/vitestPreparation.mjs';
import { readVitestSourcePreparation } from './vitest_config_preparation.mjs';
import { sourceWebExportDiagnosticEnv } from '../../build/sourceWebExportArgs.mjs';
import { resolveExpoExportWorkers } from '../expo/exportWorkers.mjs';
import { buildRuntimeSnapshotObservationExpression } from './runtime_snapshot_observation.mjs';
import { resolveRemoteServerRuntimeConfig } from './server_environment.mjs';
export { resolveRemoteServerRuntimeConfig } from './server_environment.mjs';
import { resolveRemoteValidationPlacementClass } from './validation_preparation_policy.mjs';
import { readShellCommandPrefix, workspaceBuildCommands, workspaceBuildSequence } from './shell_command_sequence.mjs';
import { HOST_OBSERVATION_PROGRAMS } from './host_observation.mjs';
import { COMPILER_NATIVE_TEST_FILES, COMPILER_TEST_SUITES, refineCompilerSuiteSelection } from './compiler_test_suites.mjs';
import { HEAVYWEIGHT_COMMAND_RESOURCES, LEGACY_VALIDATION_ADMISSION_CLASSES, SOURCE_WEB_EXPORT_MEMORY as EXPORT_MEMORY } from './command_resources.mjs';
export { HEAVYWEIGHT_COMMAND_RESOURCES, LEGACY_VALIDATION_ADMISSION_CLASSES } from './command_resources.mjs';

// Both dispatchers evaluate this policy. The native artifact is generated once,
// while argv and path normalization remain thin transport adapters.
// The native transport and controller coalescer consume this same projection.
// Only result-affecting inherited inputs participate; per-caller/session ids do
// not travel to the worker and must not split an otherwise identical command.
const COMMAND_ENVIRONMENT = Object.freeze({
  preparation: ['HAPPIER_STACK_SKIP_REFRESH_DEPS', 'HAPPIER_STACK_DISABLE_REFRESH_DEPS', 'HAPPIER_CLI_TEST_SKIP_BUILD'],
  payload: ['HAPPIER_TYPESCRIPT_COMPILER', 'GOMAXPROCS', 'HAPPIER_TYPECHECK_LOCATIONS_ONLY'],
  vitest: ['HAPPIER_VITEST_MAX_WORKERS', 'VITEST_UI_MAX_FORKS', 'HAPPIER_VITEST_GOVERNOR_MAX_WORKERS',
    'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS', 'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS'],
  controller: ['HOME', 'PATH', 'TMPDIR', 'XDG_RUNTIME_DIR', 'NODE_OPTIONS', 'CI', 'SSH_AUTH_SOCK',
    'HAPPIER_EXEC_CONFIG_PATH', 'HAPPIER_STACK_HOME_DIR', 'HAPPIER_STACK_STORAGE_DIR',
    'HAPPIER_STACK_SANDBOX_DIR', 'HAPPIER_STACK_PM_CACHE_BASE_DIR', 'HAPPIER_WORKSPACE_BUILD_MODE',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD', 'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES',
    'HAPPIER_TYPECHECK_DISPATCHED', 'HSTACK_EXEC_PRE_DISPATCH_BUSY_TARGETS',
    'HSTACK_EXEC_PRE_DISPATCH_CAPACITY_TARGETS', 'HSTACK_EXEC_PRE_DISPATCH_DISK_TARGETS',
    'HSTACK_EXEC_PRE_DISPATCH_EXCLUDED_TARGETS', 'HSTACK_EXEC_PRE_DISPATCH_REFUSALS',
    'HSTACK_EXEC_PRE_DISPATCH_RETRY_COUNT', 'HSTACK_EXEC_PRE_DISPATCH_SYNC_FAILED'],
});

export const REMOTE_COMMAND_CLASSIFICATION = Object.freeze({
  packageManagerCommands: Object.freeze(['npm', 'npx', 'pnpm', 'yarn']),
  // Verified default configs resolve their workspace imports from source.
  // Merely importing the resolver is insufficient: it maps only the declared
  // packages, so partial configs keep emitted preparation (for example the
  // machine-docker-sandboxes and Pi defaults).
  sourceTestComponents: Object.freeze([
    'apps/bootstrap', 'apps/server', 'apps/ui',
    'packages/agents', 'packages/channels-protocol', 'packages/cli-common',
    'packages/deployment-protocol', 'packages/deployments', 'packages/email-transports-protocol', 'packages/embed',
    'packages/forge-ci', 'packages/plugin-ui', 'packages/sdk', 'packages/session-core',
    'packages/support', 'packages/sync-client', 'packages/triage-sources',
    ...['app-context', 'auggie', 'backup-destinations', 'channel-discord', 'channel-email',
      'channel-slack', 'channel-telegram', 'channels', 'claude', 'cloudflare-ai-gateway',
      'cursor', 'deepseek', 'deploy-cloudflare', 'deploy-vercel', 'deployment-neon',
      'deployment-supabase', 'deployment-templates', 'devcontainer', 'elevenlabs', 'grok',
      'inspector', 'jira', 'kimi', 'kiro', 'linear', 'machine-boat', 'machine-crabbox',
      'machine-cua', 'machine-digitalocean', 'machine-fly', 'machine-hetzner', 'machine-lima',
      'machine-lume', 'machine-modal', 'machine-vercel', 'ohmypi', 'onepassword', 'openai', 'openrouter',
      'posthog', 'scm-azure-devops', 'scm-bitbucket', 'scm-git', 'scm-github', 'scm-gitlab',
      'sentry', 'triage', 'vercel-ai-gateway', 'xai'].map(name => `packages/plugins/${name}`),
  ]),
  sourceTestConfigs: Object.freeze(['vitest.config.ts']),
  compilerNativeTestFiles: COMPILER_NATIVE_TEST_FILES,
  compilerTestSuites: COMPILER_TEST_SUITES,
  sourceConditionNativeTestPaths: Object.freeze([
    // Patch recovery exercises a scratch pnpm installation through source owners.
    'apps/stack/scripts/utils/proc/dependency_refresh.patch_relock.test.mjs',
    'apps/stack/scripts/utils/proc/dependency_refresh.remote.test.mjs',
    'apps/stack/scripts/utils/proc/dependency_refresh.test.mjs',
    'apps/stack/scripts/utils/proc/dependency_refresh.writer.test.mjs',
    'apps/stack/scripts/utils/proc/workspace_package_manifests.test.mjs',
    // Relay fixtures replace the native Tailscale/relay boundaries and load
    // workspace sources; they do not consume Stack's published closure.
    'apps/stack/scripts/iroh_relay.integration.test.mjs',
    'apps/stack/scripts/utils/server/infra/iroh/listener.test.mjs',
    // Compiler/publication tests use scratch outputs and source-owned helpers.
    'scripts/workspaces/runTypeScriptCli.test.mjs',
    'scripts/workspaces/deriveTypecheckProjects.test.mjs',
    'scripts/workspaces/typecheckDiagnostics.test.mjs',
    'scripts/workspaces/workspaceOutputScriptArgs.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs',
    // Real Metro HTTP negotiation loads installed dependencies and a local helper.
    'apps/ui/scripts/metroNativeBundleResponse.test.mjs',
    'apps/stack/scripts/utils/fs/workspaceBuildInputs.test.mjs',
    // These exercise scratch publishers and the SDK's read-only source
    // projection; package resolution still needs explicit source intent.
    'packages/plugin-sdk/scripts/apiSurfaceCli.test.mjs',
    'packages/plugin-sdk/scripts/apiSurface.test.mjs',
    'apps/stack/scripts/utils/dev_targets/worker_disk_budget.test.mjs',
    'apps/stack/scripts/utils/dev_targets/sync_service.test.mjs',
    'apps/stack/scripts/utils/dev/expo_dev_crash_supervision.test.mjs',
    'apps/stack/scripts/preferred_execution_launcher.test.mjs',
    'apps/stack/scripts/utils/dev_targets/service_placement.test.mjs',
    'apps/stack/scripts/dev_targets_cmd.test.mjs',
    'apps/stack/scripts/daemon_start_verification.integration.test.mjs',
    'apps/stack/scripts/stack/stack_daemon_command.test.mjs',
    'apps/stack/scripts/stack/stack_happier_passthrough_command.test.mjs',
    'apps/stack/scripts/stack/retained_auth_scope.integration.test.mjs',
    'apps/stack/scripts/stack_guided_login_inner_invocation.test.mjs',
    'apps/stack/scripts/auth_login_guided_server_no_expo.test.mjs',
    'apps/stack/scripts/stack/stack_daemon_runtime_provenance.test.mjs',
    'apps/stack/scripts/stack_daemon_cmd.integration.test.mjs',
    'apps/stack/scripts/utils/stack/daemonControlClient.test.mjs',
    'apps/stack/scripts/run_script_with_stack_env.restart_port_reuse.test.mjs',
    'apps/stack/scripts/utils/stack/runtime_state.test.mjs',
    'apps/stack/scripts/utils/dev_targets/supervisor.test.mjs',
    'apps/stack/scripts/utils/dev_targets/runtime_observer.test.mjs',
    'apps/stack/scripts/utils/dev/daemon_watch_resilience.test.mjs',
    'apps/stack/scripts/stack_info_runtime_snapshot.test.mjs',
  ]),
  // Keep eligibility paired with the verified resolver, not a plugin-wide
  // config glob. SDK/Codex defaults register workspace sources directly; these
  // specialized lanes retain the CLI in-memory source resolver unchanged.
  // Unknown configs may consume emitted packages and retain preparation.
  pluginSourceTestConfigs: Object.freeze({
    'packages/plugin-sdk': Object.freeze(['vitest.config.ts', 'vitest.source.config.ts']),
    'packages/triage-protocol': Object.freeze(['vitest.source.config.ts']),
    'packages/voice-modelpacks': Object.freeze(['vitest.direct-source.config.ts']),
    'packages/plugins/claude': Object.freeze(['vitest.mcpToolPolicy.config.ts']),
    'packages/plugins/codex': Object.freeze(['vitest.config.ts', 'vitest.mcpApproval.config.ts', 'vitest.mcpToolPolicy.config.ts']),
    'packages/plugins/kilo': Object.freeze(['vitest.mcpToolPolicy.config.ts']),
    'packages/plugins/opencode': Object.freeze(['vitest.mcpToolPolicy.config.ts']),
    'packages/plugins/pi': Object.freeze(['vitest.mcpApproval.config.ts', 'vitest.realOwners.config.ts', 'vitest.spawnedRealOwners.config.ts']),
  }),
  // Server Vitest lanes share the workspace-source resolver. Derive their
  // configs from the package so specialized lanes also skip dist publication.
  serverSourceTestConfigs: Object.freeze(readdirSync(new URL('../../../../../apps/server/', import.meta.url))
    .filter(name => /^vitest(?:\.[^.]+)*\.config\.ts$/u.test(name)).sort()),
  // These retain the full UI base workspace-source resolver. Added aliases
  // select installed third-party artifacts, never emitted workspace output.
  // The artifact-cache lane has a partial resolver and keeps preparation.
  uiSourceTestConfigs: Object.freeze([
    'vitest.integration.config.ts', 'vitest.gesture-web.config.ts',
    'vitest.legend-native.config.ts', 'vitest.legend-fabric.config.ts',
    'vitest.perf-newchat-baseline.config.ts', 'vitest.r9-tail.config.ts',
  ]),
  sourceTestScripts: Object.freeze(['vitest', 'vitest:local']),
  formatterCheckFlags: Object.freeze(['--check', '--list-different', '--help', '-h', '--version', '-V']),
  // These owners publish tracked files. Worker mirrors are one-way replicas;
  // place the whole writer (including preparation) on the source authority.
  trackedSourceWriteEntries: Object.freeze([
    'scripts/api-governance/cli.mjs',
    'packages/plugin-sdk/scripts/apiSurfaceCli.mjs',
    'packages/plugin-sdk/scripts/generatePublicToolchainCompatibility.mjs',
    'packages/sdk/scripts/generateActions.ts',
    'packages/embed/scripts/generateThemeTokenIds.mjs',
  ]),
  trackedSourceDefaultWriteEntries: Object.freeze([
    'apps/docs/scripts/generateReference.mjs',
    'apps/website/scripts/optimize-images.mjs',
    'packages/plugin-sdk/scripts/buildHostedHtmlGuestBootstrap.mjs',
    'packages/plugin-sdk/scripts/generateActionTypeMap.mjs',
    'apps/server/scripts/schemaSync.ts',
  ]),
  // These CLIs do not implement --check: passing it still writes files.
  trackedSourceUnconditionalWriteEntries: Object.freeze([
    'scripts/generateSupportedAgentsStrip.mjs',
    'apps/ui/sources/theme.gen.ts',
    'apps/ui/tools/i18n/newLocale.ts',
    'apps/website/scripts/generate-plugin-manifest-schema.mjs',
    'apps/website/scripts/i18n-slice-overlays.mjs',
    'apps/website/scripts/optimize-feature-images.mjs',
    'packages/tests/fixtures/plugin-platform/out-of-tree-channel-socket-provider/scripts/write-manifest.mjs',
    'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/scripts/write-manifest.mjs',
  ]),
});
const DEFAULT_COMMAND_POLICY = Object.freeze({
  placement: 'worker-eligible', commandClass: 'unclassified', bootstrap: '0',
  validation: '0', kind: 'runtime', heavyClass: '', workerTool: '',
  workerArguments: '0', runnerKnown: '0', componentOverride: '',
  generator: '0', generatorCheck: '0', componentFromNative: '0',
  localCompile: '0', requiredTools: '', selfPublisher: '0', compilerLeaf: '0', controllerDispatcher: '0', workspaceLock: '',
  preparationBuildMode: 'strict',
  workspaceSync: '1',
  compilerSuite: '0',
});
const validation = { validation: '1', bootstrap: '1', heavyClass: 'validation' };
// Available-memory envelopes, not process limits or fixed concurrency slots.
// The native selection and admission paths consume this generated policy too.
// 2026-10-05 Linux measurements: cli-common dist 1,853,332 KiB; Protocol
// dist 4,682,608 KiB. Both fit beneath the existing 6 GiB package-dist
// envelope.
// The successful full daemon worker request peaked at 16,442,992 KiB of
// aggregate process-tree RSS on Linux x64 (2026-10-05). The retained legacy
// package margin is unmeasured (6,291,456 - 4,682,608 = 1,608,848 KiB):
// peak + headroom = 18,051,840 KiB, rounded up to 18 GiB. This does not
// justify admitting a worker with only 15 GiB available.
// 2026-10-09 Round 2: two sequential public TS7 typecheck runs per app on
// Linux ARM64, sampling descendant RSS/VmHWM and /usr/bin/time -v. Largest
// observed metrics: UI 18,909,772, CLI 13,688,852, server 14,179,616 KiB.
// The legacy envelopes add that unmeasured margin and round up to whole GiB:
// UI 20, CLI 15, server 16. Round 3 owner decision applies these despite
// incomplete import graphs; general/root/mixed compilation uses UI's 20 GiB.
// Re-derive these envelopes if a clean graph measures higher. Admission
// diagnostics and compiler OOMs make insufficient headroom observable;
// these samples are observations, not certified maximum process limits.
// 2026-10-10 completed daemon source-bundle trees: nl1 (Linux x64)
// 8,660,328 KiB; mac-host (Darwin ARM64) 6,425,616 KiB, with dependency-first
// public author emission and the shared single-checker compiler owner.
// Protocol alone peaked at 6,533,716 KiB on nl1. The earlier parallel
// declaration pass was OOM-killed on linux2 at 12,356,912 KiB anonymous RSS.
// The larger recorded tree plus the legacy 1,608,848 KiB unmeasured margin
// is 10,269,176 KiB, rounded up to 10 GiB.
// These historical source/runtime/compilation classes and package-dist are not Q1-complete:
// removing their legacy margin still needs successful class calibration.

// 2026-10-23 nl1 Linux x64 cold exports: one thread's conservative live-tree
// VmHWM sum was 8,236,000 KiB; 47 threads' concurrent RSS peak was 32,907,788
// KiB. The serial endpoint intentionally uses the larger HWM metric; the
// 47-thread endpoint used the then-installed serializer correction.
// Intermediate validation on 2026-10-23, upstream Expo55.0.13 at eight threads:
// cold RSS 11,196,764 KiB (Metro 1,628,336 ms, zero transform hits); a separate
// warm retry reached 12,711,296 KiB. Retain the larger observed eight-thread
// RSS rather than assuming cold is always larger. Both are off the endpoint
// line, so interpolate piecewise through that measured knot. Moving source
// and CPU allowances differ; these are estimates, not certified maxima.
// 2026-10-30 completed finite export: RSS 11,316,692/live-HWM 11,723,928 KiB,
// 105,073 all-task snapshots, zero unreadable processes; SYSTEMIC-DELETE/
// step10-continuation-six-source-web-export-measurement.log. Keep the larger
// recorded peaks above and round without a blanket margin (owner Q1).
const HEAVYWEIGHT_MEMORY_KIB = Object.freeze(Object.fromEntries(
  Object.entries(HEAVYWEIGHT_COMMAND_RESOURCES).map(([name, resource]) => [name, resource.memoryKiB])));
const HEAVYWEIGHT_COMPILE_CLASSES = ['compilation', 'compilation-ui', 'compilation-cli', 'compilation-server', 'package-dist', 'runtime-build', 'native-custody'];
export const SOURCE_WEB_EXPORT_ADMISSION_CLASS = 'source-web-export';

function exportMemorySegment(startThreads, startKiB, endThreads, endKiB) {
  const denominator = endThreads - startThreads;
  const numerator = endKiB - startKiB;
  return { numerator, denominator, baseNumerator: startKiB * denominator - startThreads * numerator };
}
const EXPORT_MEMORY_SEGMENTS = [
  exportMemorySegment(1, EXPORT_MEMORY.serialKiB, EXPORT_MEMORY.intermediateThreads, EXPORT_MEMORY.intermediateKiB),
  exportMemorySegment(EXPORT_MEMORY.intermediateThreads, EXPORT_MEMORY.intermediateKiB, EXPORT_MEMORY.parallelThreads, EXPORT_MEMORY.parallelKiB),
];

export function resolveHeavyweightMemoryFloorKiB(className, { workers } = {}) {
  const segment = EXPORT_MEMORY_SEGMENTS[workers <= EXPORT_MEMORY.intermediateThreads ? 0 : 1];
  const floor = className === SOURCE_WEB_EXPORT_ADMISSION_CLASS && Number.isSafeInteger(workers) && workers > 0
    ? Math.ceil((segment.baseNumerator + segment.numerator * workers)
      / (segment.denominator * EXPORT_MEMORY.gibKiB)) * EXPORT_MEMORY.gibKiB
    : HEAVYWEIGHT_MEMORY_KIB[className] ?? HEAVYWEIGHT_MEMORY_KIB.compilation;
  return floor;
}
function largestHeavyweightClass(...classes) {
  return classes.filter(Boolean).reduce((largest, candidate) => !largest
    || resolveHeavyweightMemoryFloorKiB(candidate) > resolveHeavyweightMemoryFloorKiB(largest) ? candidate : largest, '');
}

const COMMAND_RULES = [
  { when: { command: ['bun'], entry: ['build'], compile: ['1'] }, set: { requiredTools: 'bun' } },
  { when: { hasScript: ['1'] }, set: { bootstrap: '1' } },
  { when: { command: ['git'] }, set: { placement: 'primary-only', commandClass: 'vcs-authority' } },
  { when: { command: ['find', 'grep', 'rg'] }, set: { commandClass: 'source-search' } },
  { when: { command: ['rg'] }, set: { workerTool: 'rg' } },
  { when: { command: ['tsc', 'vitest'] }, set: validation },
  { when: { command: ['hstack-exec'] }, set: { validation: '1', heavyClass: 'validation' } },
  { when: { family: ['build', 'check', 'lint', 'test', 'tsc', 'typecheck', 'vitest'] }, set: validation },
  { when: { family: ['install'] }, set: { commandClass: 'dependency-install', heavyClass: 'dependency-install' } },
  { when: { family: ['test', 'vitest'] }, set: { workerTool: 'vitest' } },
  { when: { command: ['tsc'] }, set: { kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { family: ['tsc', 'typecheck'] }, set: { kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { command: ['node', 'nodejs'], entry: ['runTypeScriptCli.mjs'] }, set: { ...validation, kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['packages/tests/scripts/run-extended-db-docker.mjs'] }, set: { ...validation, requiredTools: 'docker' } },
  { when: { command: ['node', 'nodejs'], entry: ['buildTypeScriptPackageDist.mjs', 'build.mjs'] }, set: { ...validation, heavyClass: 'compilation' } },
  { when: { command: ['node', 'nodejs'], entryPath: ['packages/cli-common/scripts/build.mjs'] }, set: { componentOverride: 'packages/cli-common' } },
  // These finite owners acquire their declared dist leases jointly with native
  // capacity. Placement still consumes heavyClass; only an outer payload
  // reservation would invert their unreserved foreign-lease wait.
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: [
    'scripts/workspaces/buildTypeScriptPackageDist.mjs',
    'packages/cli-common/scripts/build.mjs',
    'apps/cli/scripts/build.mjs',
  ] }, set: { selfPublisher: '1' } },
  // Baselines are controller-local; only this dispatcher's compiler child travels.
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['scripts/workspaces/typecheckTouched.mjs'] },
    set: { controllerDispatcher: '1' } },
  // Source typecheck runners admit their compiler leaves directly. They do not
  // publish first-party dependency outputs or acquire publication custody.
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: [
    'scripts/workspaces/runTypeScriptCli.mjs',
    'apps/server/scripts/runTypeScriptCli.mjs',
  ] }, set: { compilerLeaf: '1' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['packages/plugin-sdk/scripts/bundleWorkspaceDeps.mjs'], declarations: ['1'], runScript: ['1'] }, set: { selfPublisher: '1' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: [
    'scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs',
    'apps/cli/scripts/buildSharedDeps.mjs',
    'apps/server/scripts/buildSharedDeps.mjs',
    'packages/plugins/triage/scripts/ensureTypecheckDeclarationPrerequisites.mjs',
  ] }, set: { ...validation, selfPublisher: '1', heavyClass: 'compilation' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['apps/cli/scripts/buildPublication.mjs'] }, set: { selfPublisher: '1' } },
  { when: { command: ['vitest'] }, set: { runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  { when: { command: ['node', 'nodejs', 'tsx'], entry: ['vitest.mjs'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  { when: { command: ['node', 'nodejs'], entry: ['runVitestShards.mjs'], component: ['apps/cli'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest' } },
  { when: { managerNode: ['1'], entry: ['run-vitest-with-heartbeat.mjs'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  ...['apps/ui', 'apps/cli'].flatMap(componentOverride => [
    { when: { command: ['node', 'nodejs'], entryPath: [`${componentOverride}/scripts/runVitestShards.mjs`] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1', componentOverride } },
    { when: { managerNode: ['1'], entryPath: [`${componentOverride}/scripts/runVitestShards.mjs`] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1', componentOverride } },
  ]),
  { when: { script: REMOTE_COMMAND_CLASSIFICATION.sourceTestScripts }, set: { runnerKnown: '1' } },
  // Unknown native suites may consume emitted workspace packages. Only proven
  // source-resolving suites skip publication; all runners admit dependencies.
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'] }, set: { ...validation, componentFromNative: '1' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], nativeTestPath: [
    'packages/plugin-sdk/scripts/actionFamilyPublication.test.mjs',
    'packages/plugin-sdk/scripts/buildExampleProjects.test.mjs',
    'packages/plugin-sdk/scripts/buildHostedHtmlGuestBootstrap.test.mjs',
    'packages/plugin-sdk/scripts/capabilityMatrixMetadata.test.mjs',
    'packages/plugin-sdk/scripts/externalSessionUserProjectionContract.test.mjs',
    'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs',
    'packages/plugin-sdk/scripts/projectCatalogMetadata.test.mjs',
    'packages/plugin-sdk/scripts/publicDeclarationReport.test.mjs',
  ] }, set: { kind: 'source-test' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], stackScope: ['1'] }, set: { kind: 'runtime', componentOverride: 'apps/stack' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], nativeTestPath: ['apps/stack/scripts/dev_target_control.real.integration.test.mjs'] }, set: { requiredTools: 'mutagen' } },
  // These tool owner suites import repository source and construct isolated
  // dependency fixtures, not emitted workspace runtime closures.
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], nativeTestPath: [
    'apps/ui/scripts/runVitestShards.test.mjs',
    'apps/ui/scripts/activitySurfacesValidationContract.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_validation_preparation.test.mjs',
    'apps/stack/scripts/utils/dev_targets/mutagen_project.test.mjs',
    'apps/stack/scripts/utils/dev_targets/qa_browser.test.mjs',
    'apps/stack/scripts/utils/dev_targets/qa_browser_recovery.integration.test.mjs',
    'apps/stack/scripts/utils/stack/stop_remote.test.mjs',
    'apps/stack/scripts/utils/proc/ownership_killProcessGroupOwnedByStack.test.mjs',
    'apps/stack/scripts/utils/proc/native_process_identity.test.mjs',
    'apps/stack/scripts/utils/proc/workspace_build_admission.test.mjs',
    'apps/stack/scripts/utils/proc/admission_broker.test.mjs',
    'apps/stack/scripts/utils/proc/admission_client.test.mjs',
    'apps/stack/scripts/utils/test/test_process.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs',
    'apps/stack/scripts/build/build_source_runtime.test.mjs',
    'apps/stack/scripts/runtime/shared/pending_source_start.test.mjs',
    'apps/stack/scripts/runtime/launch/resolveLaunchSpecs.test.mjs',
  ] }, set: { kind: 'source-test' } },
  // These lifecycle/transport fixtures use authored exports only when the
  // caller explicitly selects the existing Happier source runtime contract.
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], sourceCondition: ['1'], sourceConditionNativeTests: ['1'] }, set: { kind: 'source-test' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['apps/stack/scripts/build/remote_runtime_build.mjs'] }, set: { ...validation, kind: 'source-test', componentOverride: 'apps/stack' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['scripts/build/remote_runtime_build.mjs'], component: ['apps/stack'] }, set: { ...validation, kind: 'source-test' } },
  // Both finite web entry points consume authored inputs and admit the same
  // measured tree; they do not require emitted Stack workspace prerequisites.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: [
    'apps/stack/scripts/build/build_source_web_ui.mjs', 'apps/stack/scripts/build/build_web_artifact.mjs',
  ] }, set: { ...validation, kind: 'source-test', componentOverride: 'apps/stack', heavyClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS } },
  // Serial entry graphs have their own measured envelope. SDK preparation
  // still retains the controller compilation guard. They prove modules load, so
  // like test consumers they need runtime outputs, not a strict type verdict.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'],
    entryRepositoryPath: ['apps/stack/scripts/perf/entry-load.mjs'] },
    set: { ...validation, kind: 'source-test', componentOverride: 'apps/stack', localCompile: '1', heavyClass: 'entry-loads', preparationBuildMode: 'qa-runtime' } },
  // Reload coordinates completed lookup, finite production and activation.
  // Its producers jointly admit their own leases; charging the coordinator
  // first makes ordinary foreign-lease contention an admission-order refusal.
  // The worker's static imports consume emitted workspace packages before
  // those producers run, so prepare that closure through the runtime owner.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs'] },
    set: { ...validation, kind: 'runtime', componentOverride: 'apps/stack', heavyClass: 'source-bundle', selfPublisher: '1' } },
  // Explicit source workers preload the canonical resolver before linking
  // their static graph. They must not prepare/read a shared emitted closure.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], sourceCondition: ['1'],
    entryRepositoryPath: ['apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs'] },
    set: { kind: 'source-test' } },
  // Content checking prepares Protocol's reference renderer through the
  // finite workspace publisher. Fit that producer's existing envelope for
  // placement, but leave its capacity/lease admission to the publisher.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['apps/docs/scripts/checkContent.mjs'] },
    set: { ...validation, componentOverride: 'apps/docs', heavyClass: 'runtime-build', selfPublisher: '1' } },
  // Suite coordination publishes dependencies first, then the managed native
  // runner acquires its finite test envelope. Never reserve that envelope
  // across the coordinator's foreign-publication wait.
  // The suite executes real server and daemon Bun builds on its selected host.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['apps/stack/scripts/test_ci.mjs', 'apps/stack/scripts/test_integration.mjs'] },
    set: { ...validation, componentOverride: 'apps/stack', heavyClass: 'source-bundle', selfPublisher: '1', requiredTools: 'bun' } },
  { when: { command: ['node'], stripTypes: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'] }, set: { generator: '1', workerTool: 'bundled-plugin-generator', heavyClass: 'validation', placement: 'primary-only' } },
  { when: { command: ['node'], stripTypes: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'], mode: ['check'] }, set: { ...validation, placement: 'worker-eligible', generatorCheck: '1', componentOverride: 'apps/cli' } },
  { when: { command: ['node'], stripTypes: ['1'], sourceCondition: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'], mode: ['check'] }, set: { kind: 'source-test' } },
  { when: { script: ['check:first-party-plugins:finite', 'check:first-party-plugins:finite:local', 'plugins:aggregate:finite', 'test:migration:bundled-plugin-projections', 'test:migration:governance'] }, set: { ...validation, generatorCheck: '1', componentOverride: 'apps/cli' } },
];
const FINAL_COMMAND_RULES = [
  { when: { command: ['oxfmt'], formatterCheck: ['0'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['go'], entryRepositoryPath: ['packages/plugins/cliproxyapi/managed-runtime/tools/catalog'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs', 'tsx'], entryRepositoryPath: REMOTE_COMMAND_CLASSIFICATION.trackedSourceWriteEntries, write: ['1'], readOnly: ['0'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs', 'tsx'], entryRepositoryPath: REMOTE_COMMAND_CLASSIFICATION.trackedSourceDefaultWriteEntries, readOnly: ['0'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs', 'tsx'], entryRepositoryPath: REMOTE_COMMAND_CLASSIFICATION.trackedSourceUnconditionalWriteEntries },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'], mode: ['write'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['apps/website/scripts/i18n-extract.mjs'], readOnly: ['0'], report: ['0'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['apps/stack/scripts/utils/dev_targets/native_execution_projection.mjs'], write: ['1'] },
    set: { placement: 'primary-only', commandClass: 'tracked-source-writer', generator: '1' } },
  { when: { command: ['node', 'nodejs'], entryPath: ['scripts/runVitestShards.mjs'], component: ['apps/ui', 'apps/cli'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  { when: { managerNode: ['1'], entryPath: ['scripts/runVitestShards.mjs'], component: ['apps/ui', 'apps/cli'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  // These public package scripts expand to the authored source shard runners.
  { when: { component: ['apps/ui'], script: ['test:unit', 'test:unit:local'] }, set: { runnerKnown: '1' } },
  { when: { component: ['apps/cli'], script: ['test:unit:vitest', 'test:unit:vitest:local'] }, set: { runnerKnown: '1' } },
  { when: { admissionWrapper: ['1'] }, set: { validation: '1' } },
  // Test consumers need runtime outputs; their own compiler lanes retain
  // responsibility for strict checking. Artifact/build consumers stay strict.
  { when: { nativeTest: ['1'] }, set: { preparationBuildMode: 'qa-runtime' } },
  { when: { runnerKnown: ['1'] }, set: { preparationBuildMode: 'qa-runtime' } },
  { when: { family: ['test', 'vitest'] }, set: { preparationBuildMode: 'qa-runtime' } },
  // Artifact-consuming CLI setup retains its existing publication custody.
  // Native tools come from the selected package declaration below.
  // Source-only readers release that resource after preparation below.
  { when: { component: ['apps/cli'], workerTool: ['vitest'], generatorCheck: ['0'] }, set: {
    workspaceLock: '.project/tmp/cli-dist-build.lock',
  } },
  { when: { script: ['types:check'], component: ['apps/docs'] }, set: { ...validation, kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { bootstrap: ['1'], heavyClass: [''] }, set: { heavyClass: 'dependency-install' } },
  { when: { entry: ['remote_runtime_build.mjs'] }, set: { heavyClass: 'compilation' } },
  { when: { validation: ['1'] }, set: { commandClass: 'targeted-validation' } },
  { when: { validation: ['1'], component: ['.'] }, set: { commandClass: 'full-validation' } },
  { when: { family: ['build'] }, set: { heavyClass: 'compilation' } },
  { when: { kind: ['typecheck'] }, set: { heavyClass: 'compilation' } },
  ...['ui', 'cli', 'server'].map(component => ({
    when: { kind: ['typecheck'], component: [`apps/${component}`] }, set: { heavyClass: `compilation-${component}` },
  })),
  // 2026-10-09 public checks: Protocol tree VmHWM 10,420,624 KiB;
  // cli-common 2,777,992 KiB; Plugin SDK 4,428,896 KiB; docs 439,544 KiB
  // with fresh incremental-state files. The SDK reached
  // both compiler programs and reported only fixture TS2322 diagnostics.
  // With the existing 1,608,848 KiB measured
  // headroom these fit the existing 18 and 6 GiB classes respectively.
  { when: { kind: ['typecheck'], component: ['packages/protocol'] }, set: { heavyClass: 'runtime-build' } },
  { when: { kind: ['typecheck'], component: ['packages/cli-common', 'packages/plugin-sdk', 'apps/docs'] }, set: { heavyClass: 'package-dist' } },
  { when: { kind: ['typecheck'], mixedProjects: ['1'] }, set: { heavyClass: 'compilation' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['apps/stack/scripts/build/remote_runtime_build.mjs'] }, set: { heavyClass: 'runtime-build' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['scripts/build/remote_runtime_build.mjs'], component: ['apps/stack'] }, set: { heavyClass: 'runtime-build' } },
  { when: { script: ['build', 'build:finite', 'build:clean'], component: ['packages/cli-common', 'packages/protocol'] }, set: { heavyClass: 'package-dist' } },
  { when: { command: ['node', 'nodejs'], entryPath: ['scripts/build.mjs', 'packages/cli-common/scripts/build.mjs'], component: ['packages/cli-common'] }, set: { heavyClass: 'package-dist' } },
  // Round 3: strict dependency dist builds compile one package, not the root
  // graph. Reuse package-dist (measured dist peaks fit 6 GiB); Protocol's
  // 10,420,624 KiB and SDK's 6,720,800 KiB public-check observations instead
  // require the existing runtime-build class. Cross-package projects and
  // root/unknown builds retain general compilation; emit-only remains below.
  { when: { command: ['node', 'nodejs'], entry: ['buildTypeScriptPackageDist.mjs'], packageComponent: ['1'], project: ['tsconfig.json', './tsconfig.json'], mixedProjects: ['0'] }, set: { heavyClass: 'package-dist' } },
  { when: { command: ['node', 'nodejs'], entry: ['buildTypeScriptPackageDist.mjs'], component: ['packages/protocol', 'packages/sdk'], project: ['tsconfig.json', './tsconfig.json'], mixedProjects: ['0'] }, set: { heavyClass: 'runtime-build' } },
  { when: { command: ['node', 'nodejs'], entry: ['buildTypeScriptPackageDist.mjs'], noCheck: ['1'] }, set: { heavyClass: 'package-dist' } },
  // Carry the explicit envelope into placement before its payload starts.
  { when: { admissionWrapper: ['1'] }, set: { heavyClass: 'compilation' } },
  ...Object.keys(HEAVYWEIGHT_MEMORY_KIB).map(heavyClass => ({
    when: { admissionWrapper: ['1'], admissionClass: [heavyClass] }, set: { heavyClass },
  })),
  { when: { admissionWrapper: ['1'], admissionClass: LEGACY_VALIDATION_ADMISSION_CLASSES }, set: { heavyClass: 'validation' } },
  // CLI unit aliases use the same source resolver as direct Vitest. Runtime
  // preparation would build the emitted closure and escalate their parent
  // validation reservation for the rest of the test run.
  { when: { kind: ['runtime'], component: ['apps/cli'], script: ['test', 'test:local', 'test:unit', 'test:unit:local', 'test:unit:vitest', 'test:unit:vitest:local'], config: ['vitest.config.ts'], resolverOverride: ['0'] }, set: { runnerKnown: '1' } },
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: REMOTE_COMMAND_CLASSIFICATION.sourceTestComponents, config: REMOTE_COMMAND_CLASSIFICATION.sourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  ...Object.entries(REMOTE_COMMAND_CLASSIFICATION.pluginSourceTestConfigs).map(([component, configs]) => ({
    when: { kind: ['runtime'], runnerKnown: ['1'], component: [component], config: configs, resolverOverride: ['0'] },
    set: { kind: 'source-test' },
  })),
  // Native source prerequisites are staged under their own admitted producer
  // lease before the payload. Retaining it through tests prevents a nested
  // compiler from waiting for its legitimate larger resource envelope.
  { when: { kind: ['source-test'], component: ['apps/cli'], workerTool: ['vitest'] }, set: { workspaceLock: '' } },
  // Verified UI and server lanes keep their workspace-source resolvers.
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: ['apps/ui'], config: REMOTE_COMMAND_CLASSIFICATION.uiSourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: ['apps/server'], config: REMOTE_COMMAND_CLASSIFICATION.serverSourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  // These suites execute the canonical compiler or its API in test bodies.
  // Reserve the composed workload before starting the parent: placement-only
  // demand cannot cover nested admission. Refine focused file selections
  // against this same inventory and preserve explicit enclosing reservations.
  ...REMOTE_COMMAND_CLASSIFICATION.compilerTestSuites.map(suite => ({
    when: { workerTool: ['vitest'], generatorCheck: ['0'], admissionWrapper: ['0'], resolverOverride: ['0'], heavyClass: ['validation'], component: [suite.component], config: suite.configs },
    set: { heavyClass: 'compilation', compilerSuite: '1' },
  })),
  { when: { nativeTest: ['1'], admissionWrapper: ['0'], heavyClass: ['validation'], nativeCompilerSuite: ['1'] }, set: { heavyClass: 'compilation' } },
  { when: { component: ['.'], script: ['test:tooling:self'], admissionWrapper: ['0'], heavyClass: ['validation'] }, set: { heavyClass: 'compilation' } },
  { when: { heavyClass: HEAVYWEIGHT_COMPILE_CLASSES }, set: { localCompile: '1' } },
  // Private-index trees belong to this source checkout. Admit its complete
  // compiler workload locally without the general controller compile refusal.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['scripts/workspaces/checkCommitTypeCoherence.mjs'] },
    set: { ...validation, kind: 'typecheck', placement: 'primary-only',
      commandClass: 'full-validation', heavyClass: 'compilation', localCompile: '0' } },
  { when: { placement: ['primary-only'], generator: ['1'] }, set: { commandClass: 'tracked-source-writer' } },
  // Input writers must repair inconsistent lockfiles before frozen preparation
  // can succeed. Keep their writes on the source authority and serialize them
  // with refresh through the existing dependency writer resource.
  { when: { dependencyInputWriter: ['1'] }, set: {
    placement: 'primary-only', commandClass: 'dependency-input-writer', bootstrap: '0',
    heavyClass: 'dependency-install', generator: '1',
  } },
  // Exact host observations read only kernel/admission state. They neither
  // prepare checkout dependencies nor wait for capacity or source freshness.
  { when: { hostObservation: ['1'], admissionWrapper: ['0'] }, set: {
    commandClass: 'host-observation', bootstrap: '0', validation: '0', heavyClass: '', workspaceSync: '0',
  } },
  // Only the controller expands configured targets. Its finite worker request
  // retains the ordinary host-local publisher policy and resource admission.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['0'],
    entryRepositoryPath: ['scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs'] },
    set: { placement: 'primary-only', commandClass: 'workspace-build-coordinator',
      heavyClass: '', localCompile: '0', bootstrap: '0', validation: '0' } },
];
function commandBasename(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').split('/').at(-1);
}
function normalizeCommandPath(value) {
  return posix.normalize(String(value ?? '.').replaceAll('\\', '/')).replace(/\/+$/u, '') || '.';
}
function compilerProjectDirectory(project) {
  const normalized = normalizeCommandPath(project);
  const directory = normalized.endsWith('.json') ? posix.dirname(normalized) : normalized;
  // Finite compiler projections inherit the authored package's resource owner.
  return directory.replace(/(?:^|\/)node_modules\/\.cache\/tsc$/u, '') || '.';
}
const COMMAND_REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/u, '');

function nativeTestComponent(testPath, repoRoot = COMMAND_REPO_ROOT) {
  let parent = posix.dirname(testPath);
  if (parent.startsWith('/') || parent === '..' || parent.startsWith('../')) return '';
  while (parent !== '.') {
    if (existsSync(repoRoot + '/' + parent + '/package.json')) return parent;
    parent = posix.dirname(parent);
  }
  return '';
}
function applyCommandRules(facts, rules, policy) {
  for (const rule of rules) {
    if (Object.entries(rule.when).every(([key, values]) => values.includes(String(facts[key] ?? policy[key] ?? '')))) Object.assign(policy, rule.set);
  }
  return policy;
}
function normalizeCommandArguments(commandArgs, cwd, repoRoot = COMMAND_REPO_ROOT) {
  let args = Array.isArray(commandArgs) ? commandArgs.map(String) : [];
  if (args[0] === '--') args = args.slice(1);
  if (args[0]?.startsWith('--script=')) args = ['pnpm', 'run', '--silent', args[0].slice(9), ...args.slice(1)];
  const command = commandBasename(args[0]);
  if (command === 'env') {
    let index = 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[index] ?? '')) index++;
    if (args[index] && !args[index].startsWith('-')) {
      return normalizeCommandArguments(args.slice(index), cwd, repoRoot);
    }
  }
  if (command === 'hstack-exec') {
    const admission = args[1] === '--heavyweight-admission';
    let admissionClass = admission ? 'validation' : null;
    let declaredTools = [];
    let payloadCwd = cwd;
    for (let index = admission ? 2 : 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--' || (!admission && argument.startsWith('--script='))) {
        const payloadArgs = args.slice(argument === '--' ? index + 1 : index);
        if (payloadArgs.length) {
          const payload = normalizeCommandArguments(payloadArgs, payloadCwd, repoRoot);
          // Admission owns resources, not the payload's preparation contract.
          // Resource wrappers cannot relocate a primary-only payload, even
          // when that payload needs no dependency preparation.
          return { ...payload,
            ...(admission ? { admissionWrapper: '1', admissionClass } : {}),
            declaredRequiredTools: [...new Set([...(payload.declaredRequiredTools ?? []), ...declaredTools])],
            executorContext: { args: payloadArgs, cwd: payloadCwd, admissionClass },
          };
        }
        break;
      }
      if (admission && argument.startsWith('--class=')) admissionClass = argument.slice(8);
      else if (admission && argument.startsWith('--required-tools=')) {
        declaredTools = parseRequiredToolsDeclaration(argument.slice('--required-tools='.length));
      } else if (!admission && (argument === '--cwd' || argument.startsWith('--cwd='))) {
        const directory = argument === '--cwd' ? args[++index] : argument.slice('--cwd='.length);
        if (!directory) break;
        const pathApi = /^[a-z]:[\\/]/iu.test(repoRoot) ? win32 : posix;
        payloadCwd = pathApi.resolve(repoRoot, directory.replaceAll('\\', '/'));
      } else if (!admission || !/^(?:--(?:admission-root|machine|failure-id|workspace-locks)=|--(?:no-wait|exec-admitted|require-inherited)$)/u.test(argument)) break;
    }
  }
  const managerIndex = command === 'corepack' ? 1 : 0;
  const manager = commandBasename(args[managerIndex]).replace(/^pnpm\.(?:cmd|exe)$/iu, 'pnpm');
  let script = '', scriptArguments = [], entry = commandBasename(args[1]), managerCwd = '', managerNode = '0', workspace = '', managerEntryIndex = 1;
  let managerRun = false;
  if (REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.includes(manager)) {
    for (let index = managerIndex + 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--cwd' || arg === '--dir' || arg === '-C') { managerCwd = args[++index] ?? '.'; continue; }
      if (arg.startsWith('--cwd=')) { managerCwd = arg.slice(6); continue; }
      if (arg.startsWith('--dir=')) { managerCwd = arg.slice(6); continue; }
      if (arg === 'workspace' && manager === 'yarn') { workspace = args[++index] ?? ''; continue; }
      if (manager === 'pnpm' && (arg === '--filter' || arg === '-F')) { workspace = args[++index] ?? ''; continue; }
      if (manager === 'pnpm' && arg.startsWith('--filter=')) { workspace = arg.slice(9); continue; }
      if (arg.startsWith('-')) continue;
      if (manager === 'npx' || (!managerRun && ['exec', 'dlx', 'x'].includes(arg))) {
        // Binary launchers do not consult same-named package scripts. Reuse
        // the payload policy, including its runner and preparation decisions.
        const directory = managerCwd.replaceAll('\\', '/');
        const payloadCwd = directory.startsWith('/') ? directory : posix.join(String(cwd).replaceAll('\\', '/'), directory);
        const payloadArgs = args.slice(manager === 'npx' ? index : index + 1);
        return { ...normalizeCommandArguments(payloadArgs, payloadCwd, repoRoot),
          binaryContext: { args: payloadArgs, cwd: payloadCwd, workspace } };
      }
      if (arg === 'run') { managerRun = true; continue; }
      script = arg;
      scriptArguments = args.slice(index + 1).filter((value, offset) => offset !== 0 || value !== '--');
      if (arg === 'node') { managerNode = '1'; managerEntryIndex = index + 1; entry = commandBasename(args[managerEntryIndex]); }
      break;
    }
  }
  let stripTypes = args[1] === '--experimental-strip-types' ? '1' : '0';
  let sourceCondition = '0';
  let entryIndex = managerNode === '1' ? managerEntryIndex : stripTypes === '1' ? 2 : 1;
  if (command === 'node' || command === 'nodejs') {
    stripTypes = '0';
    entryIndex = 1;
    // These are Node prefixes, not payload options. Stop at the entry (also
    // -e/-p), so source text never becomes an executable script identity.
    while (entryIndex < args.length) {
      const argument = args[entryIndex];
      if (argument === '--experimental-strip-types') { stripTypes = '1'; entryIndex += 1; }
      else if (argument === '--import') entryIndex += 2;
      else if (argument.startsWith('--import=')) entryIndex += 1;
      else if (/^--(?:max-old-space-size|max_old_space_size)=/u.test(argument)) entryIndex += 1;
      else if (argument === '--max-old-space-size' || argument === '--max_old_space_size') entryIndex += 2;
      else if (argument === '--conditions' || argument === '-C') {
        if (args[entryIndex + 1] === 'happier-source') sourceCondition = '1';
        entryIndex += 2;
      }
      else if (argument.startsWith('--conditions=')) {
        if (argument === '--conditions=happier-source') sourceCondition = '1';
        entryIndex += 1;
      }
      else break;
    }
    entry = commandBasename(args[entryIndex]);
  } else if (stripTypes === '1') entry = commandBasename(args[2]);
  let rawEntryPath = String(args[entryIndex] ?? '').replaceAll('\\', '/');
  if (command === 'go' && args.includes('run')) {
    const directoryIndex = args.indexOf('-C');
    const pathApi = /^[a-z]:[\\/]/iu.test(repoRoot) ? win32 : posix;
    rawEntryPath = pathApi.resolve(repoRoot, String(cwd), directoryIndex < 0 ? '.' : args[directoryIndex + 1], args[args.indexOf('run') + 1] ?? '.').replaceAll('\\', '/');
    entry = commandBasename(rawEntryPath);
  }
  // The server's canonical TS runner forwards tsx argv unchanged.
  if (entry === 'runTsx.mjs' && /(?:^|\/)scripts\/runTsx\.mjs$/u.test(rawEntryPath)) {
    const payload = args.slice(entryIndex + 1).find(arg => /\.(?:ts|tsx)$/u.test(arg));
    if (payload) { rawEntryPath = payload.replaceAll('\\', '/'); entry = commandBasename(payload); }
  }
  const normalizedRepoRoot = normalizeCommandPath(repoRoot);
  const entryPath = posix.normalize(rawEntryPath.startsWith(normalizedRepoRoot + '/') ? rawEntryPath.slice(normalizedRepoRoot.length + 1) : rawEntryPath);
  let config = 'vitest.config.ts', resolverOverride = '0', project = '', mode = 'write', noCheck = '0';
  const projects = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (/^(?:--root|--workspace|--project)(?:=|$)/u.test(arg) || arg.startsWith('-r')) resolverOverride = '1';
    if (arg === '--noCheck') {
      noCheck = '1';
      if (args[index + 1] === 'true' || args[index + 1] === 'false') noCheck = args[++index] === 'true' ? '1' : '0';
    }
    else if (arg === '--noCheck=true' || arg === '--noCheck=false') noCheck = arg === '--noCheck=true' ? '1' : '0';
    else if (arg === '--config' || arg === '-c') config = args[++index] ?? '';
    else if (arg.startsWith('--config=')) config = arg.slice(9);
    else if (arg.startsWith('-c') && arg.length > 2) config = arg.slice(2);
    else if (arg === '--project' || arg === '-p') { project = args[++index] ?? ''; projects.push(project); }
    else if (arg.startsWith('--project=')) { project = arg.slice(10); projects.push(project); }
    else if (arg.startsWith('-p') && arg.length > 2) { project = arg.slice(2); projects.push(project); }
    else if (arg === '--mode') mode = args[++index] ?? '';
    else if (arg.startsWith('--mode=')) mode = arg.slice(7);
  }
  const slashCwd = String(cwd ?? '.').replaceAll('\\', '/');
  const scopedEntry = normalizeCommandPath(/^(?:\/|[a-z]:\/)/iu.test(rawEntryPath)
    ? rawEntryPath : posix.join(slashCwd, rawEntryPath));
  const entryRepositoryPath = scopedEntry.startsWith(normalizedRepoRoot + '/')
    ? scopedEntry.slice(normalizedRepoRoot.length + 1) : scopedEntry;
  const projectScopes = new Set(projects.map(value => {
    const directory = compilerProjectDirectory(value);
    const scope = normalizeCommandPath(directory.startsWith('/') ? directory : posix.join(slashCwd, directory));
    return scope.startsWith(COMMAND_REPO_ROOT + '/') ? scope.slice(COMMAND_REPO_ROOT.length + 1) : scope;
  }));
  const nativeCwd = slashCwd === normalizedRepoRoot ? '.'
    : slashCwd.startsWith(normalizedRepoRoot + '/') ? slashCwd.slice(normalizedRepoRoot.length + 1) : slashCwd;
  const testArgumentStart = command === 'node' || command === 'nodejs' ? entryIndex : 1;
  const testPaths = args.slice(testArgumentStart).filter(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]s)$/u.test(arg)).map(arg => {
    const path = arg.replaceAll('\\', '/');
    return posix.normalize(path.startsWith(normalizedRepoRoot + '/') ? path.slice(normalizedRepoRoot.length + 1)
      : path.startsWith('/') ? path : posix.join(nativeCwd, path));
  });
  const testComponents = testPaths.map(path => nativeTestComponent(path, normalizedRepoRoot));
  const vitestArguments = command === 'vitest' ? args.slice(1)
    : ['vitest.mjs', 'run-vitest-with-heartbeat.mjs', 'runVitestShards.mjs'].includes(entry) ? args.slice(entryIndex + 1)
      : scriptArguments;
  let admissionClass = '';
  if (command === 'hstack-exec' && args[1] === '--heavyweight-admission') {
    admissionClass = 'validation';
    for (const argument of args.slice(2)) {
      if (argument === '--') break;
      if (argument.startsWith('--class=')) admissionClass = argument.slice('--class='.length);
    }
  }
  let lockfileOnly = '0';
  for (const argument of args.slice(managerIndex + 1)) {
    if (argument === '--') break;
    if (argument === '--lockfile-only' || argument === '--lockfile-only=true') lockfileOnly = '1';
    else if (argument === '--no-lockfile-only' || argument === '--lockfile-only=false') lockfileOnly = '0';
  }
  return {
    command, manager, script, scriptArguments, vitestArguments, family: script.split(':', 1)[0], entry, entryPath, entryRepositoryPath, entryArguments: args.slice(entryIndex + 1), managerNode, admissionClass, workspace,
    dependencyInputWriter: manager === 'pnpm' && !managerRun && ['install', 'i'].includes(script) ? lockfileOnly : '0',
    write: args.some(arg => arg === '--write' || arg === '--write-command-policy' || arg === '--write-sync-policy') ? '1' : '0',
    readOnly: args.includes('--check') ? '1' : '0',
    report: args.includes('--report') ? '1' : '0',
    formatterCheck: args.some(arg => REMOTE_COMMAND_CLASSIFICATION.formatterCheckFlags.includes(arg)) ? '1' : '0',
    admissionWrapper: command === 'hstack-exec' && args[1] === '--heavyweight-admission' ? '1' : '0',
    hostObservation: (command === 'hstack-exec' && args.length === 2 && args[1] === '--heavyweight-memory-sample')
      || (['node', 'nodejs'].includes(command) && args.length === 3 && args[1] === '-e'
        && Object.values(HOST_OBSERVATION_PROGRAMS).includes(args[2])) ? '1' : '0',
    noCheck,
    compile: args.slice(1, args.indexOf('--') < 0 ? args.length : args.indexOf('--')).includes('--compile') ? '1' : '0',
    declarations: args.includes('--declarations') ? '1' : '0',
    runScript: args.some(arg => arg.startsWith('--run-script=') && arg.length > '--run-script='.length) ? '1' : '0',
    hasScript: script ? '1' : '0', nativeTest: args.includes('--test') ? '1' : '0',
    stripTypes, sourceCondition, mode, config: normalizeCommandPath(config), resolverOverride,
    nativeLoader: args.some(arg => /^(?:--import|--require|--loader|--experimental-loader)(?:=|$)/.test(arg) || /^-r/.test(arg)) ? '1' : '0',
    workerRequest: args.some(arg => arg.startsWith('--worker-request=') && arg.length > '--worker-request='.length) ? '1' : '0',
    component: normalizeCommandPath(slashCwd), managerCwd, project, mixedProjects: projectScopes.size > 1 ? '1' : '0',
    nativeTestPath: testPaths.length === 1 ? testPaths[0] : '',
    sourceConditionNativeTests: testPaths.length > 0 && testPaths.every(path => REMOTE_COMMAND_CLASSIFICATION.sourceConditionNativeTestPaths.includes(path)) ? '1' : '0',
    nativeCompilerSuite: testPaths.some(path => REMOTE_COMMAND_CLASSIFICATION.compilerNativeTestFiles.includes(path)) ? '1' : '0',
    nativeComponent: testComponents.length && testComponents.every(component => component === testComponents[0]) ? testComponents[0] : '',
    stackScope: /^apps\/stack(?:\/|$)/u.test(posix.normalize(slashCwd))
      || args.some(arg => /(?:^|\/)apps\/stack\//u.test(arg.replaceAll('\\', '/'))) ? '1' : '0',
  };
}

function parseRequiredToolsDeclaration(value) {
  const tools = value.split(',');
  if (tools.some(tool => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tool))) {
    const error = new Error('[command-policy] HSTACK_COMMAND_REQUIREMENTS_INVALID: --required-tools must list executable names separated by commas (for example --required-tools=docker,go)');
    error.code = 'HSTACK_COMMAND_REQUIREMENTS_INVALID';
    throw error;
  }
  return [...new Set(tools)];
}

function readCommandPackageJson(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
}

function resolveSourceTestRequiredTools(repoRoot, component, existingTools = '') {
  let metadata;
  try {
    metadata = readCommandPackageJson(resolve(repoRoot, component));
  } catch (error) {
    if (error.code === 'ENOENT') return existingTools;
    throw error;
  }
  if (!Object.hasOwn(metadata, 'happierSourceTestTools')) return existingTools;
  const tools = metadata.happierSourceTestTools;
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tool))) {
    throw new Error(`[command-policy] ${component}/package.json#happierSourceTestTools must be an array of executable names`);
  }
  return [...new Set([...existingTools.split(/\s+/u).filter(Boolean), ...tools])].join(' ');
}

/** Resolve package-manager references against synchronized repository manifests.
 * Dispatch and publication policy consume the same package identity.
 */
async function resolveCommandPackageDirectory({ cwd, managerCwd = '', workspace = '' }, repoRoot) {
  let packageDir = resolve(repoRoot, String(cwd).replaceAll('\\', '/'), managerCwd.replaceAll('\\', '/') || '.');
  try {
    if (workspace) {
      packageDir = '';
      for (const path of await collectWorkspacePackageJsonPaths(repoRoot)) {
        if (readCommandPackageJson(dirname(path)).name === workspace) { packageDir = dirname(path); break; }
      }
      if (!packageDir) return null;
    }
    const packagePath = relative(resolve(repoRoot), packageDir);
    if (packagePath === '..' || packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath)) return null;
    return packageDir;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function resolvePackageCommandManifest(commandArgs, { repoRoot = COMMAND_REPO_ROOT, cwd = process.cwd(), manifestContext } = {}) {
  const facts = normalizeCommandArguments(commandArgs, cwd, repoRoot);
  if (facts.binaryContext || facts.dependencyInputWriter === '1' || !facts.script || facts.manager === 'npx' || !['corepack', ...REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands].includes(facts.command)) return null;
  const packageDir = await resolveCommandPackageDirectory({ ...facts, cwd }, repoRoot);
  if (!packageDir) return null;
  try {
    const packageJson = manifestContext?.packageDir === packageDir
      ? manifestContext.packageJson : readCommandPackageJson(packageDir);
    return { packageDir, packageJson, scriptName: facts.script, scriptArguments: facts.scriptArguments };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function isSelfDispatchingPackageCommand(commandArgs, { repoRoot = COMMAND_REPO_ROOT, cwd = process.cwd() } = {}) {
  const manifest = await resolvePackageCommandManifest(commandArgs, { repoRoot, cwd });
  if (!manifest) return false;
  const { packageDir, packageJson, scriptName } = manifest;
  const scripts = packageJson.scripts;
  const script = scripts?.[scriptName];
  // Match one direct launcher command, never a composite script with local
  // work before or after dispatch. Package manifests remain the authority;
  // no parallel list of public script names or workspace aliases is kept.
  if (scripts?.[`pre${scriptName}`] || scripts?.[`post${scriptName}`]
    || typeof script !== 'string' || /[;&|<>`$\n\r]/u.test(script)) return false;
  const controller = /^\s*node(?:js)?\s+(\S+)\s*$/u.exec(script);
  if (controller && resolveRemoteCommandPolicy(['node', controller[1]], { repoRoot, cwd: packageDir }).controllerDispatcher === '1') return true;
  const match = /^\s*(\S+)\s+--script=\S+(?:\s+[^;&|<>`$\n\r]*)?\s*$/u.exec(script);
  return Boolean(match && resolve(packageDir, match[1]) === resolve(repoRoot, 'apps/stack/bin/hstack-exec'));
}
export function resolveRemoteCommandPolicy(commandArgs, { cwd = '.', repoRoot = COMMAND_REPO_ROOT, env = process.env, packageDir } = {}) {
  return resolveCommandPolicyContext(commandArgs, { cwd, repoRoot, env, packageDir }).policy;
}

// The synchronous classifier uses authored source only. Complete launcher
// policy resolution refines test selections after dependency publication.
function resolveCommandPolicyContext(commandArgs, { cwd = '.', repoRoot = COMMAND_REPO_ROOT, env = process.env, packageDir } = {}) {
  cwd = packageDir ?? cwd;
  let facts = normalizeCommandArguments(commandArgs, cwd, repoRoot);
  if (['node', 'nodejs'].includes(facts.command) && facts.entryRepositoryPath === 'scripts/workspaces/buildTypeScriptPackageDist.mjs') {
    const entryIndex = commandArgs.findIndex(arg => commandBasename(arg) === facts.entry);
    const compilerArgs = resolveWorkspaceTypeScriptCompilerArgs({ compilerArgs: commandArgs.slice(entryIndex + 1), env });
    facts = normalizeCommandArguments([...commandArgs.slice(0, entryIndex + 1), ...compilerArgs], cwd, repoRoot);
  }
  const policy = applyCommandRules(facts, COMMAND_RULES, { ...DEFAULT_COMMAND_POLICY });
  if (facts.managerCwd && !packageDir) {
    const managerCwd = facts.managerCwd.replaceAll('\\', '/');
    facts.component = managerCwd.startsWith('/') ? managerCwd : posix.join(facts.component, managerCwd);
  }
  else if (policy.kind === 'typecheck' && facts.project) {
    const projectDir = compilerProjectDirectory(facts.project);
    facts.component = projectDir.startsWith('/') ? projectDir : posix.join(facts.component, projectDir);
  }
  if (policy.componentOverride) facts.component = policy.componentOverride;
  else if (policy.componentFromNative === '1' && facts.nativeComponent) facts.component = facts.nativeComponent;
  facts.component = normalizeCommandPath(facts.component);
  const normalizedRepoRoot = normalizeCommandPath(repoRoot);
  if (facts.component === normalizedRepoRoot) facts.component = '.';
  else if (facts.component.startsWith(normalizedRepoRoot + '/')) facts.component = facts.component.slice(normalizedRepoRoot.length + 1);
  facts.packageComponent = facts.component.startsWith('packages/') ? '1' : '0';
  applyCommandRules(facts, FINAL_COMMAND_RULES, policy);
  let skipCompilerSetup = false;
  if ((facts.component === 'apps/cli' || policy.kind === 'runtime') && policy.workerTool === 'vitest'
    && policy.runnerKnown === '1' && facts.resolverOverride === '0' && policy.generatorCheck === '0'
    && facts.config === commandBasename(facts.config)) {
    const preparation = readVitestSourcePreparation(repoRoot, join(repoRoot, facts.component, facts.config), path => {
      const baseFacts = { ...facts, component: normalizeCommandPath(relative(repoRoot, dirname(path))), config: commandBasename(path) };
      const basePolicy = applyCommandRules(baseFacts, COMMAND_RULES, { ...DEFAULT_COMMAND_POLICY });
      applyCommandRules(baseFacts, FINAL_COMMAND_RULES, basePolicy);
      return basePolicy.kind === 'source-test';
    });
    const skipBuild = isCliTestBuildSkipped(env);
    if (preparation && (!preparation.buildsDist || skipBuild)) {
      policy.kind = 'source-test';
      policy.workspaceLock = '';
      // The full setup's compiler demand disappears only when setup itself
      // skips publication. Explicit enclosing reservations remain authoritative.
      skipCompilerSetup = preparation.buildsDist && skipBuild;
    }
  }
  if (facts.executorContext && !policy.heavyClass) {
    policy.validation = '1';
    policy.heavyClass = 'validation';
    policy.commandClass = facts.component === '.' ? 'full-validation' : 'targeted-validation';
  }
  if (facts.executorContext && policy.workerTool === 'rg') {
    // Placement needs the payload tool, but its argv governor belongs at
    // the executable leaf rather than the enclosing executor's options.
    policy.requiredTools = [...policy.requiredTools.split(/\s+/u).filter(Boolean), 'rg'].join(' ');
    policy.workerTool = '';
  }
  policy.requiredTools = [...new Set([...policy.requiredTools.split(/\s+/u).filter(Boolean),
    ...(facts.declaredRequiredTools ?? [])])].join(' ');
  if ((policy.kind === 'source-test' || facts.component === 'apps/cli') && policy.workerTool === 'vitest' && policy.generatorCheck === '0') {
    policy.requiredTools = resolveSourceTestRequiredTools(repoRoot, facts.component, policy.requiredTools);
  }
  if (['node', 'nodejs'].includes(facts.command) && facts.nativeTest === '1'
    && facts.nativeTestPath && facts.nativeLoader === '0' && !env.NODE_OPTIONS) {
    const demand = readNativeTestPreparationDemand(repoRoot, facts.nativeTestPath);
    if (demand) Object.assign(policy, { kind: 'source-test',
      bootstrap: demand.requiresDependencyBootstrap ? '1' : '0',
      heavyClass: policy.heavyClass === 'validation'
        ? demand.requiresDependencyBootstrap || demand.hasProcessBoundary ? 'validation' : 'native-source-test'
        : policy.heavyClass });
  }
  if (facts.entryRepositoryPath === 'apps/cli/scripts/buildPublication.mjs' && policy.selfPublisher === '1') {
    // The publication owner defines its ordered strict producers. Metadata
    // consumes those actual steps rather than maintaining a second sequence.
    for (const step of resolveCliPublicationBuildSteps({ repoRoot })) {
      const child = resolveRemoteCommandPolicy([step.command, ...step.args], { repoRoot, cwd: step.cwd, env: { ...env, ...step.env } });
      if (!policy.heavyClass || resolveHeavyweightMemoryFloorKiB(child.heavyClass) > resolveHeavyweightMemoryFloorKiB(policy.heavyClass)) policy.heavyClass = child.heavyClass;
    }
    if (HEAVYWEIGHT_COMPILE_CLASSES.includes(policy.heavyClass)) policy.localCompile = '1';
  }
  return { policy: { ...policy, component: normalizeCommandPath(facts.component) }, facts, skipCompilerSetup };
}

/** Finite work owns publication resources, not installed-tree consumption.
 * Actual imports use explicit scopes; dependency-input writers retain exclusion. */
export function resolveCommandWorkspaceLocks(policy, repoRoot, env = process.env) {
  return [
    ...(policy.workspaceLock ? [{ path: resolve(repoRoot, policy.workspaceLock) }] : []),
    ...(['dependency-input-writer', 'dependency-install'].includes(policy.commandClass) ? [{
      kind: 'dependency-input-writer', installDir: repoRoot,
      path: resolveDependencyRefreshLockPath(repoRoot, env),
    }] : []),
  ];
}

// A batch may have an opaque payload after a statically known publisher. Its
// prefix still constrains placement, without granting admission ownership or
// rewriting shell state. Stop before anything that could change that state.
async function resolveShellPrefixPlacementClass(commandArgs, options) {
  if (!['sh', 'bash'].includes(commandBasename(commandArgs[0] ?? ''))) return '';
  const commands = await readShellCommandPrefix(commandArgs, {
    repoRoot: resolve(options.repoRoot ?? COMMAND_REPO_ROOT), cwd: options.cwd ?? process.cwd(),
  });
  let placementHeavyClass = '';
  for (const args of commands) {
    if (!['node', 'nodejs', 'corepack', 'hstack-exec',
      ...REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands].includes(commandBasename(args[0]))) break;
    const child = await resolvePackageCommandPolicy(args, options);
    if (!child.heavyClass && !child.placementHeavyClass) break;
    placementHeavyClass = largestHeavyweightClass(placementHeavyClass, child.placementHeavyClass, child.heavyClass);
  }
  return placementHeavyClass;
}

/** Declare the full local package build before its publisher acquires leases.
 * Script names and lifecycle hooks come from the manifest; compiler envelopes
 * and source/strict argv remain owned by the canonical command/emit policies.
 * Light generators retain their command policy. A new compiler entry point
 * must be classified there, rather than hidden behind a light generator.
 */
async function resolveWorkspacePackageScriptPolicy({ packageJson, cwd = process.cwd(), env = process.env, repoRoot = COMMAND_REPO_ROOT, scriptName = 'build', scriptArguments = [], visitingScripts } = {}) {
  let admissionClass = '';
  let knownAdmissionClass = '';
  let placementHeavyClass = '';
  let placement = 'worker-eligible', commandClass = '';
  let sawPublisher = false;
  let selfPublisher = true;
  const requiredTools = new Set();
  const include = (candidate, known = true) => {
    if (!candidate) return;
    if (known) knownAdmissionClass = largestHeavyweightClass(knownAdmissionClass, candidate);
    const candidateFloor = resolveHeavyweightMemoryFloorKiB(candidate);
    const currentFloor = admissionClass ? resolveHeavyweightMemoryFloorKiB(admissionClass) : 0;
    if (candidateFloor > currentFloor || (candidateFloor === currentFloor
      && HEAVYWEIGHT_COMPILE_CLASSES.includes(candidate) && !HEAVYWEIGHT_COMPILE_CLASSES.includes(admissionClass))) {
      admissionClass = candidate;
    }
  };
  const visiting = visitingScripts ?? new Set();
  const visit = async (name, packageDir, metadata, forwardedArguments = [], preparingValidation = false) => {
    const scripts = metadata?.scripts ?? {};
    let payloadPolicy;
    const hasLifecycleHooks = `pre${name}` in scripts || `post${name}` in scripts;
    const identity = `${packageDir}\0${name}`;
    if (visiting.has(identity) || typeof scripts[name] !== 'string') { include('compilation', false); selfPublisher = false; return; }
    visiting.add(identity);
    // A validation/build may regenerate source as ephemeral compile input.
    // Only an explicit publication delivers tracked files to the checkout.
    const preparationOnly = preparingValidation || resolveRemoteCommandPolicy(['pnpm', 'run', name], {
      cwd: packageDir, repoRoot, env,
    }).validation === '1';
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      if (hook !== name && !(hook in scripts)) continue;
      const commands = typeof scripts[hook] === 'string' ? workspaceBuildCommands(scripts[hook]) : null;
      if (!commands) { include('compilation', false); selfPublisher = false; continue; }
      for (const [index, command] of commands.entries()) {
        const args = hook === name && index === commands.length - 1 ? [...command, ...forwardedArguments] : command;
        const directPayload = !hasLifecycleHooks && hook === name && commands.length === 1;
        const facts = normalizeCommandArguments(args, packageDir, repoRoot);
        const policy = await resolveComposedCommandPolicy(args, { cwd: packageDir, repoRoot, env, visitingScripts: visiting,
          manifestContext: { packageDir, packageJson: metadata } });
        if (policy.placement === 'primary-only' && !(preparationOnly && policy.generator === '1')) {
          placement = policy.placement; commandClass = policy.commandClass;
        }
        for (const tool of policy.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
        // Executor composition already resolved its payload's cwd and graph.
        // Do not visit the same script again under the caller's metadata.
        const dispatchedScript = !facts.executorContext && facts.command === 'hstack-exec'
          ? args.find(arg => arg.startsWith('--script='))?.slice('--script='.length) : '';
        if (dispatchedScript) {
          const forwarded = args.slice(args.findIndex(arg => arg.startsWith('--script=')) + 1);
          if (forwarded[0] === '--') forwarded.shift();
          const child = await visit(dispatchedScript, packageDir, metadata, forwarded, preparationOnly);
          if (directPayload) payloadPolicy = child;
          continue;
        }
        if (!facts.executorContext && facts.script && REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.includes(facts.manager)) {
          if (facts.manager === 'npx') { include('compilation', false); selfPublisher = false; }
          else if (facts.managerCwd || facts.workspace) {
            const referenced = await resolvePackageCommandManifest(args, { repoRoot, cwd: packageDir });
            if (referenced) {
              const child = await visit(referenced.scriptName, referenced.packageDir, referenced.packageJson, referenced.scriptArguments, preparationOnly);
              if (directPayload) payloadPolicy = child;
            }
            else { include('compilation', false); selfPublisher = false; }
          } else {
            const child = await visit(facts.script, packageDir, metadata, facts.scriptArguments, preparationOnly);
            if (directPayload) payloadPolicy = child;
          }
          continue;
        }
        const wrapperScript = !facts.executorContext && facts.entry === 'bundleWorkspaceDeps.mjs'
          ? args.find(arg => arg.startsWith('--run-script='))?.slice('--run-script='.length) : '';
        if (wrapperScript) {
          if (policy.selfPublisher === '1') sawPublisher = true;
          else selfPublisher = false;
          await visit(wrapperScript, packageDir, metadata, [], preparationOnly);
          continue;
        }
        // Unclassified Node entries are the manifest's light generators.
        // Unknown shell/executable commands can change cwd or launch work we
        // cannot expand, so they retain the existing general compile floor.
        if (!policy.heavyClass && !['node', 'nodejs'].includes(facts.command)) {
          include('compilation', false);
          selfPublisher = false;
        }
        include(policy.heavyClass);
        if (directPayload) payloadPolicy = policy;
        placementHeavyClass = largestHeavyweightClass(placementHeavyClass, policy.placementHeavyClass);
        if (policy.selfPublisher === '1') sawPublisher = true;
        else if (policy.localCompile === '1' && policy.compilerLeaf !== '1') selfPublisher = false;
      }
    }
    visiting.delete(identity);
    return payloadPolicy;
  };
  const payloadPolicy = await visit(scriptName, resolve(cwd), packageJson, scriptArguments);
  return { placement, commandClass, admissionClass, knownAdmissionClass, placementHeavyClass, selfPublisher: selfPublisher && sawPublisher,
    requiredTools: [...requiredTools].join(' '), payloadPolicy };
}

export async function resolveWorkspacePackageBuildAdmissionClass(options = {}) {
  // Finite publication still fails closed for an unresolved/light-only build;
  // ordinary manifest aliases carry only demand actually found in their graph.
  return (await resolveWorkspacePackageScriptPolicy(options)).admissionClass || 'compilation';
}

/** Unlike target dispatch, finite publication owns only the payload envelope.
 * Resolve selected-host manifests after placement, never route it on the
 * controller merely because a descendant owns joint admission.
 */
export async function isSelfPublishingPackageCommand(commandArgs, options = {}) {
  const manifest = await resolvePackageCommandManifest(commandArgs, options);
  if (!manifest) return false;
  return (await resolveWorkspacePackageScriptPolicy({ ...options, ...manifest, cwd: manifest.packageDir })).selfPublisher;
}

async function resolveComposedCommandPolicy(commandArgs, options) {
  const facts = normalizeCommandArguments(commandArgs, options.cwd ?? process.cwd(), options.repoRoot);
  if (facts.executorContext || (['node', 'nodejs'].includes(facts.command)
    && facts.entryRepositoryPath === 'packages/tests/scripts/run-extended-db-docker.mjs')) {
    return resolvePackageCommandPolicy(commandArgs, options);
  }
  if (facts.binaryContext) {
    const context = facts.binaryContext;
    const cwd = await resolveCommandPackageDirectory(context, options.repoRoot ?? COMMAND_REPO_ROOT);
    return resolvePackageCommandPolicy(context.args, { ...options, cwd: cwd ?? context.cwd, packageDir: undefined });
  }
  const { policy, facts: policyFacts, skipCompilerSetup } = resolveCommandPolicyContext(commandArgs, options);
  await refineCompilerSuiteSelection(policy, policyFacts, options.repoRoot ?? COMMAND_REPO_ROOT, skipCompilerSetup, options.env);
  if (policy.kind !== 'typecheck' || policy.component !== 'apps/cli'
    || facts.entry !== 'runTypeScriptCli.mjs') return policy;
  const projects = [];
  for (let index = 0; index < commandArgs.length; index++) {
    const arg = commandArgs[index];
    const project = arg === '-p' || arg === '--project' ? commandArgs[++index]
      : arg.startsWith('--project=') ? arg.slice('--project='.length)
      : arg.startsWith('-p') ? arg.slice(2) : null;
    if (project && !project.startsWith('-')) projects.push({ project });
  }
  if (!projects.length) return policy;
  const { readReferencedUiTypecheckProjects } = await import('../../../../../scripts/workspaces/deriveTypecheckProjects.mjs');
  for (const project of readReferencedUiTypecheckProjects(projects, options.cwd ?? process.cwd())) {
    const producer = resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--project', project], options);
    if (resolveHeavyweightMemoryFloorKiB(producer.heavyClass) > resolveHeavyweightMemoryFloorKiB(policy.heavyClass)) {
      policy.heavyClass = producer.heavyClass;
    }
  }
  return policy;
}

/** Package manifests own workspace aliases and lifecycle expansion. Resolve
 * the selected package before deriving preparation and payload admission. */
export async function resolvePackageCommandPolicy(commandArgs, options = {}) {
  const facts = normalizeCommandArguments(commandArgs, options.cwd ?? process.cwd(), options.repoRoot);
  if (facts.executorContext) {
    const { args, cwd, admissionClass } = facts.executorContext;
    const outer = resolveRemoteCommandPolicy(commandArgs, options);
    const child = await resolvePackageCommandPolicy(args, { ...options, cwd, packageDir: undefined });
    return { ...child,
      workerTool: outer.workerTool,
      workerArguments: outer.workerArguments,
      heavyClass: admissionClass === null ? child.heavyClass || outer.heavyClass : outer.heavyClass,
      ...(child.placementHeavyClass ? { placementHeavyClass: largestHeavyweightClass(child.placementHeavyClass, outer.heavyClass) } : {}),
      validation: outer.validation === '1' ? '1' : child.validation,
      workspaceSync: outer.workspaceSync,
      commandClass: child.commandClass === 'unclassified' ? outer.commandClass : child.commandClass,
      requiredTools: [...new Set([...outer.requiredTools.split(/\s+/u), ...child.requiredTools.split(/\s+/u)].filter(Boolean))].join(' '),
    };
  }
  if (['node', 'nodejs'].includes(facts.command)
    && facts.entryRepositoryPath === 'packages/tests/scripts/run-extended-db-docker.mjs') {
    const policy = resolveRemoteCommandPolicy(commandArgs, options);
    const { parseArgs } = await import('../../../../../packages/tests/scripts/run-extended-db-docker.mjs');
    const { buildExtendedDbCommandPlan } = await import('../../../../../packages/tests/scripts/extended-db-docker.plan.mjs');
    let steps;
    try {
      const parsed = parseArgs(['node', facts.entry, ...facts.entryArguments]);
      if (!parsed.help) steps = buildExtendedDbCommandPlan({ db: parsed.db, mode: parsed.mode,
        contractFile: parsed['contract-file'], databaseUrl: 'classification-only' });
    } catch {
      // The harness owns invalid arguments and help, neither of which starts work.
    }
    if (!steps) return { ...policy, validation: '0', bootstrap: '0', heavyClass: '' };
    const repoRoot = options.repoRoot ?? COMMAND_REPO_ROOT;
    const requiredTools = new Set(policy.requiredTools.split(/\s+/u).filter(Boolean));
    // This synchronous coordinator starts Docker before dispatching its children.
    // Reserve their existing graph's full peak once, with dependency consumption
    // but no publication leases; nested public commands reuse the actual owner.
    for (const step of steps) {
      const child = await resolvePackageCommandPolicy([step.command, ...step.args], {
        ...options, repoRoot, cwd: repoRoot, packageDir: undefined, env: { ...(options.env ?? process.env), ...step.env },
      });
      policy.heavyClass = largestHeavyweightClass(policy.heavyClass, child.heavyClass, child.placementHeavyClass);
      for (const tool of child.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
      if (child.placement === 'primary-only') {
        policy.placement = child.placement;
        policy.commandClass = child.commandClass;
      }
    }
    return { ...policy, kind: 'source-test', selfPublisher: '0',
      localCompile: HEAVYWEIGHT_COMPILE_CLASSES.includes(policy.heavyClass) ? '1' : '0',
      requiredTools: [...requiredTools].join(' ') };
  }
  // Reuse manifest sequence parsing for direct shell chains. Cwd-changing
  // shell state is unsupported. Public phases retain their own admission;
  // placement must not reserve memory across preparation and foreign leases.
  if (['sh', 'bash'].includes(commandBasename(commandArgs[0] ?? ''))
    && commandArgs.length === 3 && /^-[a-z]*c[a-z]*$/u.test(commandArgs[1])) {
    const sequence = workspaceBuildSequence(commandArgs[2]);
    const commands = sequence?.commands;
    const supported = commands?.every(args => ['node', 'nodejs', 'corepack', 'hstack-exec',
      ...REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands].includes(commandBasename(args[0])));
    if (supported) {
      const policy = resolveRemoteCommandPolicy(commandArgs, options);
      const requiredTools = new Set(policy.requiredTools.split(/\s+/u).filter(Boolean));
      let phasesOwnAdmission = true;
      let hasPublisher = false;
      let placementHeavyClass = '';
      const phases = [];
      const childPolicies = [];
      for (const args of commands) {
        const child = await resolvePackageCommandPolicy(args, options);
        childPolicies.push(child);
        placementHeavyClass = largestHeavyweightClass(placementHeavyClass, child.placementHeavyClass, child.heavyClass);
        for (const tool of child.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
        const needsAdmission = child.heavyClass && child.selfPublisher !== '1' && child.compilerLeaf !== '1'
          && !(child.kind === 'typecheck' && await resolvePackageCommandManifest(args, options));
        if (needsAdmission) phasesOwnAdmission = false;
        if (child.selfPublisher === '1') hasPublisher = true;
        phases.push(needsAdmission);
        if (child.heavyClass && (!policy.heavyClass
          || resolveHeavyweightMemoryFloorKiB(child.heavyClass) > resolveHeavyweightMemoryFloorKiB(policy.heavyClass))) {
          policy.heavyClass = child.heavyClass;
        }
        if (child.placement === 'primary-only') {
          policy.placement = child.placement;
          policy.commandClass = child.commandClass;
          policy.generator = child.generator;
        }
      }
      const coordinatesWorkspaceBuild = childPolicies.some(child => child.commandClass === 'workspace-build-coordinator');
      if ((hasPublisher && !phasesOwnAdmission) || coordinatesWorkspaceBuild) {
        // A producer cannot inherit the later consumer's reservation. Keep
        // the shell's ordered phases, but admit each unowned heavy payload
        // at its actual execution point using the existing same-worker
        // execution owner, including its preparation and workspace locks.
        // Relative paths survive dispatch to a different worker repo root.
        const repoRoot = options.repoRoot ?? COMMAND_REPO_ROOT;
        const launcher = './' + posix.join(relative(resolve(options.cwd ?? process.cwd()), repoRoot).replaceAll('\\', '/'),
          'apps/stack/bin/hstack-exec');
        policy.admissionScript = phases.map((needsAdmission, index) => {
          // A workspace coordinator must remain on the controller, while
          // independent finite consumers retain their normal AUTO placement.
          const dispatchReader = coordinatesWorkspaceBuild && childPolicies[index].placement !== 'primary-only'
            && Boolean(childPolicies[index].heavyClass || childPolicies[index].placementHeavyClass);
          const prefix = dispatchReader
            ? ['/bin/sh', launcher, '--'].map(posixQuote).join(' ') + ' '
            : needsAdmission ? ['/bin/sh', launcher, '--local', '--'].map(posixQuote).join(' ') + ' ' : '';
          // Preserve the caller's shell quoting and native argument expansion.
          return (index ? ` ${sequence.operators[index - 1]} ` : '') + prefix + sequence.sources[index];
        }).join('');
        phasesOwnAdmission = true;
      }
      if (policy.heavyClass) policy.selfPublisher = phasesOwnAdmission ? '1' : '0';
      if (placementHeavyClass && placementHeavyClass !== policy.heavyClass) policy.placementHeavyClass = placementHeavyClass;
      policy.requiredTools = [...requiredTools].join(' ');
      return policy;
    }
  }
  const manifest = await resolvePackageCommandManifest(commandArgs, options);
  const resolved = manifest ? await resolveWorkspacePackageScriptPolicy({ ...options, ...manifest, cwd: manifest.packageDir }) : null;
  // A recognized test runner supplies the script's actual preparation facts.
  // Other scripts retain their enclosing phase/admission policy, including
  // light generators, composite/opaque scripts and lifecycle hooks.
  const policy = resolved?.payloadPolicy?.runnerKnown === '1' ? resolved.payloadPolicy : await resolveComposedCommandPolicy(commandArgs, { ...options,
    ...(manifest ? { packageDir: manifest.packageDir } : {}) });
  const requiredTools = new Set(policy.requiredTools.split(/\s+/u).filter(Boolean));
  let selfPublisher = policy.selfPublisher;
  let heavyClass = policy.heavyClass;
  let placementHeavyClass = policy.placementHeavyClass;
  if (resolved) {
    if (resolved.placement === 'primary-only') {
      policy.placement = resolved.placement;
      policy.commandClass = resolved.commandClass;
      if (resolved.commandClass === 'tracked-source-writer') policy.generator = '1';
    }
    if (resolved.commandClass === 'workspace-build-coordinator' && !resolved.admissionClass) {
      // A public alias of the coordinator owns dispatch, not a local payload.
      Object.assign(policy, { bootstrap: '0', validation: '0', localCompile: '0' });
    }
    for (const tool of resolved.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
    if (resolved.selfPublisher) selfPublisher = '1';
    placementHeavyClass = largestHeavyweightClass(placementHeavyClass, resolved.placementHeavyClass);
    const requiredClass = resolved.selfPublisher || policy.kind === 'typecheck' ? resolved.admissionClass : resolved.knownAdmissionClass;
    if (resolved.selfPublisher || (requiredClass && (!heavyClass
      || (heavyClass === 'validation' && requiredClass === 'focused-validation')
      || resolveHeavyweightMemoryFloorKiB(requiredClass) > resolveHeavyweightMemoryFloorKiB(heavyClass)))) {
      heavyClass = requiredClass;
    }
  }
  if (policy.selfPublisher === '1' && normalizeCommandArguments(commandArgs, options.cwd, options.repoRoot).entry === 'bundleWorkspaceDeps.mjs') {
    const cwd = options.cwd ?? process.cwd();
    const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const scriptName = commandArgs.find(arg => arg.startsWith('--run-script='))?.slice('--run-script='.length);
    const resolved = await resolveWorkspacePackageScriptPolicy({ ...options, cwd, packageJson, scriptName });
    if (resolved.placement === 'primary-only') {
      policy.placement = resolved.placement;
      policy.commandClass = resolved.commandClass;
      if (resolved.commandClass === 'tracked-source-writer') policy.generator = '1';
    }
    for (const tool of resolved.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
    selfPublisher = '1';
    placementHeavyClass = largestHeavyweightClass(placementHeavyClass, resolved.placementHeavyClass);
    heavyClass = resolved.admissionClass || 'compilation';
  }
  const result = { ...policy, selfPublisher, heavyClass, requiredTools: [...requiredTools].join(' ') };
  placementHeavyClass = largestHeavyweightClass(placementHeavyClass,
    await resolveShellPrefixPlacementClass(commandArgs, options), await resolveRemoteValidationPlacementClass(result, {
    repoRoot: options.repoRoot ?? COMMAND_REPO_ROOT, env: options.env,
  }), heavyClass);
  if (placementHeavyClass && placementHeavyClass !== heavyClass) result.placementHeavyClass = placementHeavyClass;
  return result;
}

export async function resolveCommandPublisherPolicy(commandArgs, options = {}) {
  const { selfPublisher, heavyClass, requiredTools } = await resolvePackageCommandPolicy(commandArgs, options);
  return { selfPublisher, heavyClass, requiredTools };
}
export function projectRemoteGuestCliPayloadEnvironment(env = process.env) {
  const root = String(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim();
  return root && !/[\0\r\n]/.test(root)
    ? { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: root }
    : {};
}

export function classifyRemoteCommand(commandArgs, options = {}) {
  const policy = resolveRemoteCommandPolicy(commandArgs, options);
  return { placement: policy.placement, commandClass: policy.commandClass, requiresDependencyBootstrap: policy.bootstrap === '1' };
}
export function resolveRemoteValidationComponentRelativeDir(commandArgs, options = {}) {
  return resolveRemoteCommandPolicy(commandArgs, options).component;
}
export function requiresRemoteWorkspacePreparation(commandArgs, options = {}) {
  return classifyRemoteCommand(commandArgs, options).commandClass === 'targeted-validation';
}
export function resolveRemoteValidationKind(commandArgs, options = {}) {
  return resolveRemoteCommandPolicy(commandArgs, options).kind;
}
export function requiresRemoteDependencyBootstrap(commandArgs, options = {}) {
  return classifyRemoteCommand(commandArgs, options).requiresDependencyBootstrap;
}
function renderShellCommandRules(rules) {
  return rules.map(({ when, set }) => {
    const conditions = Object.entries(when).map(([key, values]) => (
      '{ ' + values.map(value => '[ "$policy_' + key + '" = ' + posixQuote(value) + ' ]').join(' || ') + '; }'
    )).join(' && ');
    return '  if ' + conditions + '; then\n' + Object.entries(set).map(([key, value]) => '    policy_' + key + '=' + posixQuote(value)).join('\n') + '\n  fi';
  }).join('\n');
}
export function renderNativeCommandPolicy() {
  const [serialSegment, parallelSegment] = EXPORT_MEMORY_SEGMENTS.map(segment =>
    `b=${segment.baseNumerator}; n=${segment.numerator}; d=${segment.denominator}`);
  return [
    '# Generated by native_execution_projection.mjs --write-command-policy.',
    '# Rule authority: remote_commands.mjs. Do not edit this projection.',
    `payload_ssh_server_alive_interval=${PAYLOAD_SSH_SERVER_ALIVE_INTERVAL}`,
    ...Object.entries(COMMAND_ENVIRONMENT).map(([kind, names]) => `command_${kind}_environment_names=${posixQuote(names.join(' '))}`),
    `controller_coalescing_environment_names=${posixQuote([...new Set(Object.values(COMMAND_ENVIRONMENT).flat())].sort().join(' '))}`,
    // Placement can skip a worker, unlike authoritative dispatch. Divide the
    // existing 15-second burst window across the two read-only SSH connection
    // attempts, using OpenSSH's integral-second unit. This is independent of
    // configured cache reuse; it must not shorten exact or payload connections.
    `placement_probe_connect_timeout_seconds() { printf '%s' '${Math.max(1, Math.floor(DEFAULT_LOAD_PROBE_TTL_MS / 2 / 1000))}'; }`,
    'heavyweight_memory_floor_kib() {',
    '  case "$1" in',
    ...Object.entries(HEAVYWEIGHT_MEMORY_KIB).map(([key, value]) => '    ' + key + ') heavyweight_policy_floor=' + posixQuote(String(value)) + ' ;;'),
    // Historical dispatch labels are validation, while unrecognized resource
    // classes must not silently acquire a smaller compilation envelope.
    ...LEGACY_VALIDATION_ADMISSION_CLASSES.map(name => '    ' + name + ') heavyweight_policy_floor=' + posixQuote(String(HEAVYWEIGHT_MEMORY_KIB.validation)) + ' ;;'),
    '    *) heavyweight_policy_floor=' + posixQuote(String(HEAVYWEIGHT_MEMORY_KIB.compilation)) + ' ;;',
    '  esac',
    '  if [ "$1" = source-web-export ]; then',
    '    case "${3-}" in \'\'|*[!0-9]*|0) ;;',
    `      *) heavyweight_policy_floor=$(awk -v threads="$3" 'BEGIN { if(threads<=${EXPORT_MEMORY.intermediateThreads}) {${serialSegment}} else {${parallelSegment}}; total=b+n*threads; unit=d*${EXPORT_MEMORY.gibKiB}; printf "%.0f", (int(total/unit)+(total%unit>0))*${EXPORT_MEMORY.gibKiB} }') ;;`,
    '    esac',
    '  fi',
    '  printf \'%s\' "$heavyweight_policy_floor"', '}',
    'source_web_export_workers_for_memory_kib() {',
    `  awk -v cpu="$1" -v memory="$2" 'BEGIN { memory=int(memory/${EXPORT_MEMORY.gibKiB})*${EXPORT_MEMORY.gibKiB}; if(memory<=${EXPORT_MEMORY.intermediateKiB}) {${serialSegment}} else {${parallelSegment}}; workers=int((memory*d-b)/n); if(workers<1) workers=1; if(workers>cpu) workers=cpu; printf "%.0f", workers }'`,
    '}',
    'native_command_policy_base() {',
    ...Object.entries(DEFAULT_COMMAND_POLICY).map(([key, value]) => '  policy_' + key + '=' + posixQuote(value)),
    renderShellCommandRules(COMMAND_RULES), '}',
    'native_command_policy_finish() {', renderShellCommandRules(FINAL_COMMAND_RULES), '}',
    'native_package_manager() { case "$1" in ' + REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.join('|') + ') return 0 ;; *) return 1 ;; esac; }',
    NATIVE_COMMAND_NORMALIZATION,
  ].join('\n');
}

const NATIVE_COMMAND_NORMALIZATION = `
# Extract argv facts only; dispatch decisions come from the table above.
native_normalize_path() {
  native_path=$1
  while :; do case "$native_path" in *\\\\*) native_path="\${native_path%%\\\\*}/\${native_path#*\\\\}" ;; *) break ;; esac; done
  native_result=; native_absolute=
  case "$native_path" in /*) native_absolute=/ ;; esac
  while [ -n "$native_path" ]; do
    native_segment=\${native_path%%/*}
    if [ "$native_path" = "$native_segment" ]; then native_path=; else native_path=\${native_path#*/}; fi
    case "$native_segment" in
      ''|.) ;;
      ..) case "$native_result" in '') native_result=.. ;; ..|../*) native_result="$native_result/.." ;; */*) native_result=\${native_result%/*} ;; *) native_result= ;; esac ;;
      *) if [ -z "$native_result" ]; then native_result=$native_segment; else native_result="$native_result/$native_segment"; fi ;;
    esac
  done
  native_result="$native_absolute$native_result"
  [ -n "$native_result" ] || native_result=.
}
native_command_basename() {
  native_basename=$1
  while :; do case "$native_basename" in *\\\\*) native_basename="\${native_basename%%\\\\*}/\${native_basename#*\\\\}" ;; *) break ;; esac; done
  native_basename=\${native_basename##*/}
}
native_node_entry() {
  native_node_prefix_count=$#
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --experimental-strip-types) policy_stripTypes=1; shift ;;
      --import) shift; [ "$#" -eq 0 ] || shift ;;
      --import=*) shift ;;
      --max-old-space-size=*|--max_old_space_size=*) shift ;;
      --max-old-space-size|--max_old_space_size) shift; [ "$#" -eq 0 ] || shift ;;
      --conditions|-C) shift; if [ "$#" -gt 0 ]; then [ "$1" != happier-source ] || policy_sourceCondition=1; shift; fi ;;
      --conditions=happier-source) policy_sourceCondition=1; shift ;;
      --conditions=*) shift ;;
      *) break ;;
    esac
  done
  native_node_prefix_count=$((native_node_prefix_count - $#))
  native_entry_path=\${1-}
  native_command_basename "$native_entry_path"; policy_entry=$native_basename
}
native_compiler_project_directory() {
  native_normalize_path "$1"
  case "$native_result" in *.json) case "$native_result" in */*) native_result=\${native_result%/*} ;; *) native_result=. ;; esac ;; esac
  case "$native_result" in node_modules/.cache/tsc) native_result=. ;; */node_modules/.cache/tsc) native_result=\${native_result%/node_modules/.cache/tsc} ;; esac
}
native_record_project_scope() {
  native_normalize_path "$native_project"; native_scope=$native_result
  native_project_path=$native_result
  case "$native_project_path" in *.json) ;; *) native_project_path="$native_project_path/tsconfig.json" ;; esac
  case "$native_project_path" in /*) ;; *) native_normalize_path "$policy_component/$native_project_path"; native_project_path=$native_result ;; esac
  case "$native_project_path" in "$repo_root"/*) native_project_path=\${native_project_path#"$repo_root"/} ;; esac
  policy_projectPaths="$policy_projectPaths
$native_project_path"
  native_compiler_project_directory "$native_project"; native_scope=$native_result
  case "$native_scope" in /*) ;; *) native_normalize_path "$policy_component/$native_scope"; native_scope=$native_result ;; esac
  case "$native_scope" in "$repo_root"/*) native_scope=\${native_scope#"$repo_root"/} ;; esac
  if [ -z "$native_project_scope" ]; then native_project_scope=$native_scope
  elif [ "$native_project_scope" != "$native_scope" ]; then policy_mixedProjects=1; fi
}
native_resolve_admission_payload() {
  shift 2
  resolve_native_command_policy "$@"
}
native_resolve_binary_payload() {
  shift 2
  resolve_native_command_policy "$@"
}
native_try_admission_payload() {
  shift
  native_wrapper_class=
  native_wrapper_tools=
  if [ "\${1-}" = --heavyweight-admission ]; then native_wrapper_class=validation; shift; fi
  case "\${1-}" in --script=*) set -- -- "$@" ;; esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --class=*) [ -n "$native_wrapper_class" ] || return 1; native_wrapper_class=\${1#--class=} ;;
      --required-tools=*)
        [ -n "$native_wrapper_class" ] || return 1
        native_wrapper_tools=\${1#--required-tools=}
        [ -n "$native_wrapper_tools" ] || { native_required_tools_error; return 64; }
        ;;
      --admission-root=*|--machine=*|--failure-id=*|--workspace-locks=*|--no-wait|--exec-admitted|--require-inherited)
        [ -n "$native_wrapper_class" ] || return 1 ;;
      --)
        shift
        [ "$#" -gt 0 ] || return 1
        # Positional custody preserves declarations through nested expansion.
        set -- "$native_wrapper_class" "$native_wrapper_tools" "$@"
        native_resolve_admission_payload "$@" || return $?
        if [ -n "$1" ] || [ -z "$policy_heavyClass" ]; then
          policy_admissionWrapper=1
          policy_admissionClass=\${1:-validation}
          policy_validation=1
          policy_workspaceSync=1
          policy_localCompile=0
          policy_compilerSuite=0
          native_command_policy_finish || return 2
        fi
        if [ -n "$2" ]; then native_add_required_tools "$2" || return $?; fi
        if [ "$policy_workerTool" = rg ]; then
          native_add_required_tools rg || return $?
          policy_workerTool=
        fi
        return 0
        ;;
      *) return 1 ;;
    esac
    shift
  done
  return 1
}
native_required_tools_error() {
  printf '%s\\n' '[command-policy] HSTACK_COMMAND_REQUIREMENTS_INVALID: --required-tools must list executable names separated by commas (for example --required-tools=docker,go)' >&2
}
native_add_required_tools() {
  native_declared_remaining=$1
  while :; do
    native_declared_tool=\${native_declared_remaining%%,*}
    case "$native_declared_tool" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) native_required_tools_error; return 64 ;; esac
    case " $policy_requiredTools " in *" $native_declared_tool "*) ;; *) policy_requiredTools="\${policy_requiredTools:+$policy_requiredTools }$native_declared_tool" ;; esac
    case "$native_declared_remaining" in *,*) native_declared_remaining=\${native_declared_remaining#*,} ;; *) break ;; esac
  done
}
resolve_native_command_policy() {
  native_test_policy_resolved=0
  native_resolve_command_policy_arguments "$@" || return $?
  # Recursive argv normalization already resolved the actual payload. Reuse
  # its metadata child rather than parsing a package-manager alias twice.
  [ "$native_test_policy_resolved" = 0 ] || return 0
  if [ "$policy_workerTool" = vitest ] && [ "$policy_generatorCheck" = 0 ] && [ "$policy_admissionWrapper" = 0 ]; then
    native_policy_request_cwd=$invoked_cwd
    if [ "\${explicit_relative_cwd_set-0}" = 1 ]; then
      case "$explicit_relative_cwd" in
        /*) native_policy_request_cwd=$explicit_relative_cwd ;;
        *) native_policy_request_cwd=$repo_root/$explicit_relative_cwd ;;
      esac
    fi
    native_vitest_policy=$(node "\${projection_command_policy:-$repo_root/apps/stack/scripts/utils/dev_targets/remote_commands.mjs}" --vitest-policy "$repo_root" "$native_policy_request_cwd" "$@") || return $?
    eval "$native_vitest_policy"
    native_test_policy_resolved=1
  fi
}
native_resolve_command_policy_arguments() {
  [ "\${1-}" = -- ] && shift
  case "\${1-}" in --script=*) native_script=\${1#--script=}; shift; [ "\${1-}" = -- ] && shift; set -- pnpm run --silent "$native_script" "$@" ;; esac
  native_command_basename "\${1-}"; policy_command=$native_basename
  if [ "$policy_command" = env ]; then
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        *=*)
          native_environment_name=\${1%%=*}
          case "$native_environment_name" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) break ;; esac
          shift ;;
        *) break ;;
      esac
    done
    case "\${1-}" in ''|-*) ;; *) native_resolve_command_policy_arguments "$@"; return $? ;; esac
    # Unsupported env options retain conservative classification.
    set -- env "$@"
  fi
  if [ "$policy_command" = hstack-exec ]; then
    if native_try_admission_payload "$@"; then return
    else
      native_wrapper_status=$?
      [ "$native_wrapper_status" -eq 1 ] || return "$native_wrapper_status"
    fi
    # An unsupported payload retains the original wrapper's policy.
    native_command_basename "\${1-}"; policy_command=$native_basename
  fi
  native_command_basename "\${2-}"; policy_entry=$native_basename
  policy_script=; policy_hasScript=0; policy_managerNode=0; policy_stripTypes=0; policy_sourceCondition=0; policy_workspace=
  native_manager_cwd=; native_project=; policy_mode=write
  policy_nativeTest=0; policy_config=vitest.config.ts; policy_resolverOverride=0
  policy_nativeLoader=0
  policy_project=; policy_projectPaths=; policy_workerRequest=0
  policy_noCheck=0
  policy_compile=0; native_compile_options=1
  policy_write=0; policy_readOnly=0; policy_report=0; policy_formatterCheck=0
  policy_declarations=0; policy_runScript=0
  policy_dependencyInputWriter=0; native_lockfile_only=0; native_lockfile_options=1
  policy_admissionClass=
  policy_admissionWrapper=0
  policy_hostObservation=0
  if [ "$policy_command" = hstack-exec ] && [ "$#" -eq 2 ] && [ "\${2-}" = --heavyweight-memory-sample ]; then
    policy_hostObservation=1
  elif { [ "$policy_command" = node ] || [ "$policy_command" = nodejs ]; } && [ "$#" -eq 3 ] && [ "\${2-}" = -e ]; then
    case "\${3-}" in ${Object.values(HOST_OBSERVATION_PROGRAMS).map(posixQuote).join('|')}) policy_hostObservation=1 ;; esac
  fi
  if [ "$policy_command" = hstack-exec ] && [ "\${2-}" = --heavyweight-admission ]; then
    policy_admissionWrapper=1
    policy_admissionClass=validation
    for native_arg in "$@"; do
      case "$native_arg" in --) break ;; --class=*) policy_admissionClass=\${native_arg#--class=} ;; esac
    done
  fi
  native_cwd=\${invoked_cwd#"$repo_root"}
  native_cwd=\${native_cwd#/}
  [ "\${explicit_relative_cwd_set-0}" = 1 ] && native_cwd=$explicit_relative_cwd
  native_normalize_path "$native_cwd"; policy_component=$native_result
  policy_stackScope=0
  case "$policy_component" in apps/stack|apps/stack/*) policy_stackScope=1 ;; esac
  native_entry_path=\${2-}
  native_node_prefix_count=0
  case "$policy_command" in
    node|nodejs) native_node_entry "$@" ;;
    *) if [ "\${2-}" = --experimental-strip-types ]; then policy_stripTypes=1; native_entry_path=\${3-}; native_command_basename "$native_entry_path"; policy_entry=$native_basename; fi ;;
  esac
  if [ "$policy_entry" = runTsx.mjs ]; then
    for native_arg in "$@"; do
      case "$native_arg" in *.ts|*.tsx) native_entry_path=$native_arg; native_command_basename "$native_entry_path"; policy_entry=$native_basename; break ;; esac
    done
  fi
  if [ "$policy_command" = go ]; then
    native_go_directory=.; native_go_pending=
    for native_arg in "$@"; do
      case "$native_go_pending" in
        directory) native_go_directory=$native_arg; native_go_pending=; continue ;;
        entry)
          case "$native_go_directory" in /*) native_go_base=$native_go_directory ;; *) native_go_base="$repo_root/$policy_component/$native_go_directory" ;; esac
          case "$native_arg" in /*) native_entry_path=$native_arg ;; *) native_entry_path="$native_go_base/$native_arg" ;; esac
          native_command_basename "$native_entry_path"; policy_entry=$native_basename; break ;;
      esac
      case "$native_arg" in -C) native_go_pending=directory ;; run) native_go_pending=entry ;; esac
    done
  fi
  native_normalize_path "$native_entry_path"; policy_entryPath=$native_result
  case "$policy_entryPath" in "$repo_root"/*) policy_entryPath=\${policy_entryPath#"$repo_root"/} ;; esac
  native_normalize_path "$native_entry_path"; policy_entryRepositoryPath=$native_result
  case "$policy_entryRepositoryPath" in /*) ;; *) native_normalize_path "$policy_component/$policy_entryRepositoryPath"; policy_entryRepositoryPath=$native_result ;; esac
  case "$policy_entryRepositoryPath" in "$repo_root"/*) policy_entryRepositoryPath=\${policy_entryRepositoryPath#"$repo_root"/} ;; esac
  native_pending=; native_project_scope=; policy_mixedProjects=0
  for native_arg in "$@"; do
    if [ "$native_compile_options" = 1 ]; then
      case "$native_arg" in --) native_compile_options=0 ;; --compile) policy_compile=1 ;; esac
    fi
    if [ "$native_lockfile_options" = 1 ]; then
      case "$native_arg" in
        --) native_lockfile_options=0 ;;
        --lockfile-only|--lockfile-only=true) native_lockfile_only=1 ;;
        --no-lockfile-only|--lockfile-only=false) native_lockfile_only=0 ;;
      esac
    fi
    case "$native_arg" in ${REMOTE_COMMAND_CLASSIFICATION.formatterCheckFlags.join('|')}) policy_formatterCheck=1 ;; esac
    case "$native_pending" in
      config) policy_config=$native_arg; native_pending=; continue ;;
      project) native_project=$native_arg; native_record_project_scope; native_pending=; continue ;;
      mode) policy_mode=$native_arg; native_pending=; continue ;;
      noCheck)
        native_pending=
        case "$native_arg" in true) policy_noCheck=1; continue ;; false) policy_noCheck=0; continue ;; esac
        ;;
    esac
    case "$native_arg" in
      --write|--write-command-policy|--write-sync-policy) policy_write=1 ;;
      --check) policy_readOnly=1 ;;
      --report) policy_report=1 ;;
      --test) policy_nativeTest=1 ;;
      --import|--import=*|--require|--require=*|--loader|--loader=*|--experimental-loader|--experimental-loader=*) policy_nativeLoader=1 ;;
      -r*) policy_nativeLoader=1; policy_resolverOverride=1 ;;
      --declarations) policy_declarations=1 ;;
      --run-script=?*) policy_runScript=1 ;;
      --noCheck) policy_noCheck=1; native_pending=noCheck ;;
      --noCheck=true) policy_noCheck=1 ;;
      --noCheck=false) policy_noCheck=0 ;;
      --worker-request=?*) policy_workerRequest=1 ;;
      --config|-c) native_pending=config; policy_config= ;;
      --config=*) policy_config=\${native_arg#--config=} ;;
      -c?*) policy_config=\${native_arg#-c} ;;
      --project|-p) native_pending=project; [ "$native_arg" = --project ] && policy_resolverOverride=1 ;;
      --project=*) native_project=\${native_arg#--project=}; native_record_project_scope; policy_resolverOverride=1 ;;
      -p?*) native_project=\${native_arg#-p}; native_record_project_scope ;;
      --root|--root=*|--workspace|--workspace=*) policy_resolverOverride=1 ;;
      --mode) native_pending=mode ;;
      --mode=*) policy_mode=\${native_arg#--mode=} ;;
    esac
    case "$native_arg" in apps/stack/*|./apps/stack/*|*/apps/stack/*) policy_stackScope=1 ;; esac
  done
  native_normalize_path "$policy_config"; policy_config=$native_result
  policy_project=$native_project
  policy_nativeTestPath=; policy_nativeCompilerSuite=0; policy_sourceConditionNativeTests=1
  native_test_count=0; native_test_component=; native_test_component_mixed=0
  native_test_argument_index=0
  for native_arg in "$@"; do
    native_test_argument_index=$((native_test_argument_index + 1))
    [ "$native_test_argument_index" -gt "$native_node_prefix_count" ] || continue
    case "$native_arg" in -*) continue ;; *.mjs|*.cjs|*.js|*.ts|*.mts|*.cts) ;; *) continue ;; esac
    native_normalize_path "$native_arg"; native_test_path=$native_result
    case "$native_test_path" in "$repo_root"/*) native_test_path=\${native_test_path#"$repo_root"/} ;; *) native_normalize_path "$policy_component/$native_test_path"; native_test_path=$native_result ;; esac
    native_test_count=$((native_test_count + 1))
    policy_nativeTestPath=$native_test_path
    case "$native_test_path" in ${REMOTE_COMMAND_CLASSIFICATION.sourceConditionNativeTestPaths.map(posixQuote).join('|')}) ;; *) policy_sourceConditionNativeTests=0 ;; esac
    native_parent=\${native_test_path%/*}
    [ "$native_parent" != "$native_test_path" ] || native_parent=.
    case "$native_test_path" in ${REMOTE_COMMAND_CLASSIFICATION.compilerNativeTestFiles.map(posixQuote).join('|')}) policy_nativeCompilerSuite=1 ;; esac
    native_component=
    case "$native_parent" in /*|..|../*) native_parent=. ;; esac
    while [ "$native_parent" != . ]; do
      if [ -f "$repo_root/$native_parent/package.json" ]; then native_component=$native_parent; break; fi
      case "$native_parent" in */*) native_parent=\${native_parent%/*} ;; *) native_parent=. ;; esac
    done
    if [ "$native_test_count" -eq 1 ]; then native_test_component=$native_component
    elif [ "$native_test_component" != "$native_component" ]; then native_test_component_mixed=1; fi
  done
  [ "$native_test_count" -eq 1 ] || policy_nativeTestPath=
  [ "$native_test_count" -gt 0 ] || policy_sourceConditionNativeTests=0
  [ "$native_test_component_mixed" -eq 0 ] || native_test_component=
  native_command_basename "\${1-}"; native_manager=$native_basename
  if [ "$native_manager" = corepack ]; then shift; native_command_basename "\${1-}"; native_manager=$native_basename; fi
  case "$native_manager" in pnpm.cmd|pnpm.exe) native_manager=pnpm ;; esac
  if native_package_manager "$native_manager"; then
    [ "$#" -gt 0 ] && shift
    native_manager_binary=0; native_manager_run=0
    [ "$native_manager" != npx ] || native_manager_binary=1
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -s|--silent) shift ;;
        run) if [ "$native_manager_binary" = 1 ]; then break; fi; native_manager_run=1; shift ;;
        exec|dlx|x)
          if [ "$native_manager_run" = 1 ]; then policy_script=$1; break; fi
          [ "$native_manager_binary" != 1 ] || break
          native_manager_binary=1; shift; break ;;
        --cwd|--dir|-C) shift; native_manager_cwd=\${1-.}; [ "$#" -gt 0 ] && shift ;;
        --cwd=*) native_manager_cwd=\${1#--cwd=}; shift ;;
        --dir=*) native_manager_cwd=\${1#--dir=}; shift ;;
        --filter|-F) if [ "$native_manager" = pnpm ]; then shift; policy_workspace=\${1-}; [ "$#" -gt 0 ] && shift; else shift; fi ;;
        --filter=*) if [ "$native_manager" = pnpm ]; then policy_workspace=\${1#--filter=}; fi; shift ;;
        workspace) if [ "$native_manager" = yarn ]; then shift; policy_workspace=\${1-}; [ "$#" -gt 0 ] && shift; else policy_script=$1; break; fi ;;
        -*) shift ;;
        *) if [ "$native_manager_binary" != 1 ]; then policy_script=$1; if [ "$1" = node ]; then policy_managerNode=1; native_entry_path=\${2-}; native_command_basename "$native_entry_path"; policy_entry=$native_basename; fi; fi; break ;;
      esac
    done
    if [ "$native_manager_binary" = 1 ]; then
      case "$native_manager_cwd" in
        /*) native_normalize_path "$native_manager_cwd" ;;
        *) native_normalize_path "$policy_component/$native_manager_cwd" ;;
      esac
      if [ -n "$policy_workspace" ]; then
        # Resolve workspace identity once through the manifest owner, then
        # classify the actual payload at that directory as usual.
        native_result=$(
          eval "\${explicit_remote_environment-}"
          node "\${projection_command_policy:-$repo_root/apps/stack/scripts/utils/dev_targets/remote_commands.mjs}" --binary-cwd "$repo_root" "$native_result" pnpm --filter "$policy_workspace" exec "$@"
        ) || return $?
      fi
      # Positional custody restores caller cwd overrides after recursion.
      set -- "\${explicit_relative_cwd_set-0}" "\${explicit_relative_cwd-}" "$@"
      explicit_relative_cwd_set=1; explicit_relative_cwd=$native_result
      native_resolve_binary_payload "$@"
      native_binary_status=$?
      explicit_relative_cwd_set=$1; explicit_relative_cwd=$2
      return "$native_binary_status"
    fi
  fi
  [ -n "$policy_script" ] && policy_hasScript=1
  if [ "$native_manager" = pnpm ] && [ "$native_manager_run" = 0 ] && [ "$native_lockfile_only" = 1 ]; then
    case "$policy_script" in install|i) policy_dependencyInputWriter=1 ;; esac
  fi
  policy_family=\${policy_script%%:*}
  native_normalize_path "$native_entry_path"; policy_entryPath=$native_result
  case "$policy_entryPath" in "$repo_root"/*) policy_entryPath=\${policy_entryPath#"$repo_root"/} ;; esac
  native_command_policy_base
  if [ -n "$native_manager_cwd" ]; then
    case "$native_manager_cwd" in /*) native_normalize_path "$native_manager_cwd" ;; *) native_normalize_path "$policy_component/$native_manager_cwd" ;; esac
    policy_component=$native_result
  elif [ "$policy_kind" = typecheck ] && [ -n "$native_project" ]; then
    native_compiler_project_directory "$native_project"; native_project=$native_result
    case "$native_project" in /*) native_normalize_path "$native_project" ;; *) native_normalize_path "$policy_component/$native_project" ;; esac
    policy_component=$native_result
  fi
  case "$policy_component" in "$repo_root"/*) policy_component=\${policy_component#"$repo_root"/} ;; esac
  [ -n "$policy_componentOverride" ] && policy_component=$policy_componentOverride
  if [ -z "$policy_componentOverride" ] && [ "$policy_componentFromNative" = 1 ] && [ -n "$native_test_component" ]; then policy_component=$native_test_component; fi
  case "$policy_component" in packages/*) policy_packageComponent=1 ;; *) policy_packageComponent=0 ;; esac
  native_command_policy_finish || return $?
  case "$policy_command:$policy_nativeTest:$policy_nativeLoader" in
    node:1:0|nodejs:1:0)
      if [ -n "$policy_nativeTestPath" ] && [ -f "$repo_root/$policy_nativeTestPath" ]; then
        native_source_only=$(
          eval "\${explicit_remote_environment-}"
          node "\${projection_command_policy:-$repo_root/apps/stack/scripts/utils/dev_targets/remote_commands.mjs}" --native-source-test "$repo_root" "$policy_nativeTestPath"
        ) || return $?
        case "$native_source_only" in
          1) policy_kind=source-test; policy_bootstrap=0
             [ "$policy_heavyClass" != validation ] || policy_heavyClass=native-source-test ;;
          2) policy_kind=source-test; policy_bootstrap=1 ;;
          3) policy_kind=source-test; policy_bootstrap=0 ;;
        esac
      fi
      ;;
  esac
}
`;

export function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellNativeArgument(value) {
  const escaped = String(value).replace(/(\\*)"/g, (_match, backslashes) => (
    `${backslashes}${backslashes}\\"`
  ));
  return powershellQuote(escaped);
}

export function buildRemotePowerShellCommand(script) {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(String(script), 'utf16le').toString('base64')}`;
}

export function prependRemotePath(target, script) {
  const entries = Array.isArray(target.remotePath) ? target.remotePath.map(String) : [];
  const workerHome = String(target.cliHomeDir ?? '').replace(/[\\/]+$/, '');
  if (workerHome) entries.unshift(`${workerHome}/cache/pnpm-toolchain${target.platform === 'windows' ? '' : '/bin'}`);
  if (entries.length === 0) return script;
  if (target.platform === 'windows') {
    return `$env:PATH = ${powershellQuote(entries.join(';'))} + [IO.Path]::PathSeparator + $env:PATH; ${script}`;
  }
  return `export PATH=${posixQuote(entries.join(':'))}:"$PATH"; ${script}`;
}

function requireRemoteRelativeWorkingDirectory(target, cwd) {
  const raw = String(cwd ?? '.').trim() || '.';
  if (/\0|\r|\n/.test(raw)) {
    throw new Error('[dev-targets] invalid remote working directory');
  }
  const slashNormalized = raw.replace(/\\/g, '/');
  if (
    slashNormalized.startsWith('/')
    || /^[A-Za-z]:\//.test(slashNormalized)
    || slashNormalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('[dev-targets] remote working directory must stay inside the synchronized repository');
  }
  const segments = slashNormalized.split('/').filter((segment) => segment && segment !== '.');
  const root = String(target.repoDir).replace(/[\\/]+$/, '');
  return segments.length ? `${root}/${segments.join('/')}` : root;
}

function normalizeRemoteEnvironment(environment) {
  const result = [];
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`[dev-targets] invalid remote environment key: ${key}`);
    }
    const normalized = String(value ?? '');
    if (normalized.includes('\0')) {
      throw new Error(`[dev-targets] invalid remote environment value for ${key}`);
    }
    result.push([key, normalized]);
  }
  return result;
}

function requireRemoteExecutionId(executionId) {
  const normalized = String(executionId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(normalized)) {
    throw new Error('[dev-targets] remote execution id must be a path-safe opaque identifier');
  }
  return normalized;
}

function resolveRemoteExecutionPidFile(target, executionId) {
  const normalizedHome = String(target.cliHomeDir).replace(/[\\/]+$/, '');
  return `${normalizedHome}/remote-exec/${requireRemoteExecutionId(executionId)}.pid`;
}

export function buildRemoteExecCommand(
  target,
  { executionId, cwd = '.', commandArgs, environment = {}, preparation = null, commandPolicy = null, admissionClass = '', admissionMode = 'wait', lifetimeStdin = false, controlStdin = false } = {},
) {
  let args = Array.isArray(commandArgs) ? commandArgs.map(String) : [];
  if (args.length === 0 || !args[0]) {
    throw new Error('[dev-targets] remote command is required');
  }
  if (args.some((value) => value.includes('\0'))) {
    throw new Error('[dev-targets] remote command arguments cannot contain NUL bytes');
  }
  const workingDirectory = requireRemoteRelativeWorkingDirectory(target, cwd);
  const environmentEntries = normalizeRemoteEnvironment(environment);
  const normalizedExecutionId = requireRemoteExecutionId(executionId);
  const pidFile = resolveRemoteExecutionPidFile(target, normalizedExecutionId);
  if (target.platform !== 'windows' && (preparation || admissionClass)) {
    const repoDir = requireRemoteRelativeWorkingDirectory(target, '.');
    const policy = commandPolicy ?? resolveRemoteCommandPolicy(args, { cwd: workingDirectory, repoRoot: repoDir, env: environment });
    const body = ['set -euo pipefail', `cd -- ${posixQuote(repoDir)}`];
    const defaultBuildMode = environment.HAPPIER_WORKSPACE_BUILD_MODE ?? preparation?.defaultBuildMode
      ?? policy.preparationBuildMode;
    body.push(`export HAPPIER_WORKSPACE_BUILD_MODE=${posixQuote(defaultBuildMode)}`);
    const cacheEnv = `env ${posixQuote(`HAPPIER_STACK_PM_CACHE_BASE_DIR=${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`;
    if (preparation?.bootstrap) {
      const prefix = `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache/pnpm-toolchain`;
      body.push(`export npm_config_prefix=${posixQuote(prefix)}`, `export PATH=${posixQuote(`${prefix}/bin`)}:"$PATH"`);
      body.push(`${cacheEnv} node ./apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs --execution-placement=remote ${posixQuote(`--validation-kind=${preparation.validationKind}`)} ${posixQuote(`--component-relative-dir=${preparation.bootstrapComponentRelativeDir ?? '.'}`)} ${posixQuote(`--default-build-mode=${defaultBuildMode}`)}`);
    }
    if (preparation?.componentRelativeDir != null) {
      requireRemoteRelativeWorkingDirectory(target, preparation.componentRelativeDir);
      body.push(`${cacheEnv} node ./apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs ${posixQuote(`--component-relative-dir=${preparation.componentRelativeDir}`)} ${posixQuote(`--validation-kind=${preparation.validationKind}`)} ${posixQuote(`--required-tools=${policy.requiredTools}`)} ${posixQuote(`--default-build-mode=${defaultBuildMode}`)}`);
    }
    body.push(`cd -- ${posixQuote(workingDirectory)}`);
    let payloadCommand = '';
    if (admissionClass) {
      // Dependency/build lock holders can need admission themselves. Only
      // reserve the payload envelope once preparation has released its locks;
      // dist compilers acquire their own canonical admission before their lock.
      // Resolve physical installed-tree identity on the executing worker.
      body.push(`workspace_locks=$(node ${posixQuote(`${repoDir}/apps/stack/scripts/utils/dev_targets/remote_commands.mjs`)} --workspace-locks ${[repoDir, policy.workspaceLock, policy.bootstrap, policy.validation].map(posixQuote).join(' ')})`);
      const admittedArgs = ['env', `HAPPIER_STACK_PM_CACHE_BASE_DIR=${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`, `${repoDir}/apps/stack/bin/hstack-exec`, '--heavyweight-admission',
        `--class=${admissionClass}`, `--machine=${target.name}`, `--failure-id=${normalizedExecutionId}`,
        ...(admissionMode === 'try' ? ['--no-wait'] : [])];
      const admittedCommand = `${admittedArgs.map(posixQuote).join(' ')} "--workspace-locks=$workspace_locks" -- ${args.map(posixQuote).join(' ')}`;
      const facts = normalizeCommandArguments(args, workingDirectory, repoDir);
      if (policy.selfPublisher !== '1') {
        if (REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.includes(facts.manager) && facts.manager !== 'npx') {
          // The synchronized selected-host manifest owns this decision. A
          // publisher does not own placement, only its own payload admission.
          body.push(`publisher_policy=$(node ${posixQuote(`${repoDir}/apps/stack/scripts/utils/dev_targets/remote_commands.mjs`)} --publisher-policy ${[repoDir, workingDirectory, ...args].map(posixQuote).join(' ')})`);
          payloadCommand = `case "$publisher_policy" in '1 '*) exec ${args.map(posixQuote).join(' ')} ;; '0 '*) exec ${admittedCommand} ;; *) exit 2 ;; esac`;
        } else payloadCommand = `exec ${admittedCommand}`;
      }
    }
    body.push(payloadCommand || `exec ${args.map(posixQuote).join(' ')}`);
    args = ['bash', '-c', body.join('; ')];
  }
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        `$pidFile = ${powershellQuote(pidFile)}`,
        'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null',
        '$selfProcess = Get-Process -Id $PID',
        '"$PID|$($selfProcess.StartTime.ToUniversalTime().Ticks)" | Set-Content -LiteralPath $pidFile -Encoding Ascii -NoNewline',
        'try { '
          + `Set-Location -LiteralPath ${powershellQuote(workingDirectory)}; `
          + environmentEntries.map(([key, value]) => `$env:${key} = ${powershellQuote(value)}; `).join('')
          + `& ${args.map(powershellNativeArgument).join(' ')}; `
          + '$commandStatus = $LASTEXITCODE; '
          + 'if ($null -eq $commandStatus) { $commandStatus = 0 }; '
          + 'exit $commandStatus '
          + '} finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile }',
      ].join('; '),
    );
  }
  const body = [
      'set -euo pipefail',
      `cd -- ${posixQuote(workingDirectory)}`,
      ...environmentEntries.map(([key, value]) => `export ${key}=${posixQuote(value)}`),
      `exec ${args.map(posixQuote).join(' ')}`,
  ].join('; ');
  const custody = `${requireRemoteRelativeWorkingDirectory(target, '.')}/apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh`;
  // Custody must let the browser worker finish closing its detached Chromium
  // session after controller loss, just as the foreground browser owner does.
  const browserKind = environment.HAPPIER_STACK_PROCESS_KIND === 'browser' ? 'HAPPIER_STACK_PROCESS_KIND=browser ' : '';
  return wrapRemoteScript(target, `exec env ${lifetimeStdin ? 'HAPPIER_REMOTE_EXEC_LIFELINE=1 ' : ''}${controlStdin ? 'HAPPIER_REMOTE_EXEC_CONTROL_STDIN=1 ' : ''}${browserKind}bash ${posixQuote(custody)} run ${posixQuote(pidFile)} ${posixQuote(normalizedExecutionId)} bash -c ${posixQuote(body)}`);
}

export function buildRemoteQaBrowserStopCommand(target, { stackName }) {
  if (target.platform !== 'posix') throw new Error('[dev-targets] QA browser retirement requires a POSIX host');
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const helper = `${String(target.repoDir).replace(/[\\/]+$/, '')}/apps/stack/scripts/utils/dev_targets/qa_browser_retirement.mjs`;
  // Retirement only needs OS ownership/lifecycle leaves. Neither mirror admission
  // nor an inherited source-runtime preload may acquire dependency custody here.
  // Replace the login shell on both paths so its EXIT/logout hooks cannot
  // overwrite the unavailable-helper status before SSH returns it.
  return wrapRemoteScript(target, `set -e; if ! test -f ${posixQuote(helper)}; then echo 'browser cleanup helper unavailable' >&2; exec /bin/sh -c 'exit 127'; fi; exec env -u NODE_OPTIONS node --experimental-strip-types ${posixQuote(helper)} --stop-stack ${posixQuote(stackName)} ${posixQuote(paths.stackEnvPath)}`);
}

export function buildRemoteCancelCommand(target, { executionId } = {}) {
  const normalizedExecutionId = requireRemoteExecutionId(executionId);
  const pidFile = resolveRemoteExecutionPidFile(target, normalizedExecutionId);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        `$pidFile = ${powershellQuote(pidFile)}`,
        'if (-not (Test-Path -LiteralPath $pidFile)) { exit 0 }',
        'try { '
          + '$identity = (Get-Content -Raw -LiteralPath $pidFile).Trim().Split(\'|\'); '
          + 'if ($identity.Count -ne 2) { exit 0 }; '
          + '[int]$remoteProcessId = 0; [long]$remoteStartTicks = 0; '
          + 'if (-not [int]::TryParse($identity[0], [ref]$remoteProcessId)) { exit 0 }; '
          + 'if (-not [long]::TryParse($identity[1], [ref]$remoteStartTicks)) { exit 0 }; '
          + '$remoteProcess = Get-Process -Id $remoteProcessId -ErrorAction SilentlyContinue; '
          + 'if ($null -eq $remoteProcess) { exit 0 }; '
          + 'if ($remoteProcess.StartTime.ToUniversalTime().Ticks -ne $remoteStartTicks) { exit 0 }; '
          + 'taskkill.exe /PID $remoteProcessId /T /F | Out-Null; '
          + 'exit 0 '
          + '} finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile }',
      ].join('; '),
    );
  }
  const custody = `${requireRemoteRelativeWorkingDirectory(target, '.')}/apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh`;
  return wrapRemoteScript(target, `bash ${posixQuote(custody)} cancel ${posixQuote(pidFile)} ${posixQuote(normalizedExecutionId)}`);
}

function wrapRemoteScript(target, script) {
  const wrappedScript = prependRemotePath(target, script);
  if (target.platform === 'windows') {
    return buildRemotePowerShellCommand(wrappedScript);
  }
  // Replace SSH's shell so its logout hook cannot replace the actual status.
  return `exec bash -lc ${posixQuote(wrappedScript)}`;
}

function buildWindowsOrphanedMutagenCleanupScript() {
  return [
    'try {',
    `  $mutagenAgents = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'mutagen-agent.exe'" -ErrorAction SilentlyContinue);`,
    '  foreach ($agent in $mutagenAgents) {',
    '    $launcher = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $agent.ParentProcessId) -ErrorAction SilentlyContinue;',
    "    if ($null -eq $launcher -or $launcher.Name -ne 'cmd.exe') { continue };",
    '    $sshParentPid = [int]$launcher.ParentProcessId;',
    '    if (-not (Get-Process -Id $sshParentPid -ErrorAction SilentlyContinue)) {',
    '      & taskkill.exe /PID ([string]$launcher.ProcessId) /T /F | Out-Null',
    '    }',
    '  }',
    '} catch { }',
  ].join(' ');
}

export function buildRemoteEnsureDirectoriesCommand(target, options = {}) {
  const additional = usesRetainedRemoteStackState(options.runtimeMode)
    ? (() => { const paths = resolveRemoteStackStatePaths(target, options); return [paths.stackBaseDir, paths.cliHomeDir, paths.workspaceDir]; })()
    : [];
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        buildWindowsOrphanedMutagenCleanupScript(),
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.repoDir)} | Out-Null`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.cliHomeDir)} | Out-Null`,
        ...additional.map(path => `New-Item -ItemType Directory -Force -Path ${powershellQuote(path)} | Out-Null`),
      ].join('; '),
    );
  }
  const replicaOwner = posix.join(target.repoDir, '.happier', 'command-replica.json');
  const commandReplica = options.commandReplica === true && target.executorRepoDir
    && posix.isAbsolute(target.executorRepoDir) && posix.isAbsolute(target.repoDir)
    && posix.dirname(target.repoDir) === posix.dirname(target.executorRepoDir)
    && target.repoDir !== target.executorRepoDir;
  const sourceAdmission = [];
  // An explicit `exit` in the login shell runs ~/.bash_logout under errexit;
  // Ubuntu's default one ends with a failing test where clear_console is absent.
  // The cold probe therefore skips the setup through else/fi, not an exit.
  let probeOnly = false;
  if (commandReplica) {
    sourceAdmission.push(`if ${options.requireSourceAdmission === true ? 'true' : `[ ! -f ${posixQuote(posix.join(target.repoDir, 'package.json'))} ]`}; then`);
    if (options.requiredAdditionalBytes === undefined) {
      // Probe without creating the destination. Only cold replicas cause the
      // source owner to inventory bytes and return for disk admission.
      sourceAdmission.push(`printf '%s\\n' '__HAPPIER_COMMAND_REPLICA_UNMATERIALIZED__'`, 'else');
      probeOnly = true;
    } else {
      if (!Number.isSafeInteger(options.requiredAdditionalBytes) || options.requiredAdditionalBytes < 0) {
        throw new Error('[dev-targets] invalid replica source byte measurement');
      }
      sourceAdmission.push(`node ${posixQuote(posix.join(target.executorRepoDir, 'apps/stack/scripts/utils/dev_targets/worker_disk_budget.mjs'))} --admit --source-materialization --class=source-replica ${posixQuote(`--repo=${target.repoDir}`)} ${posixQuote(`--cache=${posix.join(target.cliHomeDir, 'cache')}`)} ${posixQuote(`--required-additional-bytes=${options.requiredAdditionalBytes}`)} >/dev/null`);
    }
    if (!probeOnly) sourceAdmission.push('fi');
  }
  const replicaSetup = commandReplica ? [
    `mkdir -p -- ${posixQuote(posix.dirname(replicaOwner))}`,
    `replica_temporary=${posixQuote(`${replicaOwner}.tmp`)}.$$; printf '%s\\n' ${posixQuote(JSON.stringify({ version: 1, repoDir: target.repoDir, executorRepoDir: target.executorRepoDir }))} > "$replica_temporary"; mv -- "$replica_temporary" ${posixQuote(replicaOwner)}`,
    `touch -- ${posixQuote(target.repoDir)}`,
    `[ -f ${posixQuote(posix.join(target.repoDir, 'package.json'))} ] || printf '%s\\n' '__HAPPIER_COMMAND_REPLICA_UNMATERIALIZED__'`,
  ] : options.commandReplica === false || options.runtimeMode
    ? [`rm -f -- ${posixQuote(replicaOwner)}`] : [];
  return wrapRemoteScript(
    target,
    `set -euo pipefail; ${sourceAdmission.length ? `${sourceAdmission.join('\n')}\n` : ''}mkdir -p -- ${[target.repoDir, target.cliHomeDir, ...additional].map(posixQuote).join(' ')}; ${replicaSetup.join('; ')}${probeOnly ? '\nfi' : ''}`,
  );
}

export const REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX = '__HAPPIER_RUNTIME_TARGET__=';

export function buildRemoteDoctorCommand(target) {
  const runtimeTargetExpression = JSON.stringify(REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX)
    + ' + JSON.stringify({platform:process.platform,arch:process.arch})';
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command, label }) => (
          `if (-not (Get-Command ${command} -ErrorAction SilentlyContinue)) { throw "${label} is required on the remote target" }`
        )),
        ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.flatMap(({ command }) => [
          `${command} --version`,
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ]),
        `node -p ${powershellNativeArgument(runtimeTargetExpression)}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command, label }) => (
        `command -v ${command} >/dev/null || { echo "${label} is required on the remote target" >&2; exit 127; }`
      )),
      ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command }) => `${command} --version`),
      `node -p ${posixQuote(runtimeTargetExpression)}`,
    ].join('; '),
  );
}

export function buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }) {
  // Preserve target enrollment within an Account, but carry an explicit
  // controller re-login across Accounts. CLI auth owns selecting the Machine
  // for the new token subject; do not copy or rewrite its settings here.
  // Inline the existing decoder: credential seeding can precede mirror refresh.
  const expression = [
    "const fs = require('node:fs'), path = require('node:path');",
    `const decodeJwtPayloadUnsafe = ${decodeJwtPayloadUnsafe.toString()};`,
    `const stagedPath = ${JSON.stringify(stagedPath)}, finalPath = ${JSON.stringify(finalPath)};`,
    "const seed = fs.readFileSync(stagedPath, 'utf8');",
    "const existing = fs.existsSync(finalPath) ? fs.readFileSync(finalPath, 'utf8') : '';",
    'const accountId = raw => {',
    '  try {',
    '    const sub = decodeJwtPayloadUnsafe(JSON.parse(raw).token)?.sub;',
    "    return typeof sub === 'string' && sub.trim() ? sub.trim() : null;",
    '  } catch { return null; }',
    '};',
    'const seedAccountId = accountId(seed), existingAccountId = accountId(existing);',
    'if (!existing || (seedAccountId && existingAccountId && seedAccountId !== existingAccountId)) {',
    '  fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });',
    "  if (process.platform !== 'win32') {",
    '    fs.chmodSync(path.dirname(finalPath), 0o700);',
    '    fs.chmodSync(stagedPath, 0o600);',
    '  }',
    '  fs.renameSync(stagedPath, finalPath);',
    '} else { fs.unlinkSync(stagedPath); }',
  ].join('\n');
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `node -e ${powershellNativeArgument(expression)}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `exec node -e ${posixQuote(expression)}`,
    ].join('; '),
  );
}

function requireServicePort(value, label, { optional = false } = {}) {
  if (optional && value == null) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`[dev-targets] ${label} must be an integer from 1024 to 65535`);
  }
  return port;
}

function normalizeRemoteServerRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[dev-targets] remote server placement requires a supported server runtime configuration');
  }
  const environment = config.environment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('[dev-targets] remote server semantic environment must be an object');
  }
  const envProvider = environment.HAPPIER_DB_PROVIDER;
  if (
    config.dbProvider != null
    && envProvider != null
    && String(config.dbProvider).trim().toLowerCase() !== String(envProvider).trim().toLowerCase()
  ) {
    throw new Error('[dev-targets] remote server runtime DB provider configuration conflicts');
  }
  return resolveRemoteServerRuntimeConfig({
    serverComponentName: config.serverComponentName,
    env: {
      ...environment,
      ...(config.dbProvider != null ? { HAPPIER_DB_PROVIDER: config.dbProvider } : {}),
    },
  });
}

function requireStableOuterServerUrl(value, { label = '--server-public-url' } = {}) {
  const urlText = String(value ?? '').trim();
  if (!urlText || /[\0\r\n]/.test(urlText)) {
    throw new Error(`[dev-targets] remote server placement requires a stable outer ${label}`);
  }
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error(`[dev-targets] remote server placement requires an HTTP(S) ${label}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`[dev-targets] remote server placement requires an HTTP(S) ${label}`);
  }
  return urlText;
}

function buildRemoteDevArgs({ services, serverUrl, publicServerUrl, startMobile }) {
  const args = [];
  if (!services.server) args.push('--no-server');
  if (!services.expo) args.push('--no-ui');
  if (!services.daemon) args.push('--no-daemon');
  args.push('--no-browser', '--no-dev-targets', '--watch');
  if (services.expo && startMobile) args.push('--mobile');
  if (services.server) {
    if (publicServerUrl) args.push(`--server-public-url=${publicServerUrl}`);
  } else {
    args.push(`--server-url=${serverUrl}`);
    if (publicServerUrl) args.push(`--server-public-url=${publicServerUrl}`);
  }
  return args;
}

function formatPosixDevArg(arg) {
  const separator = arg.indexOf('=');
  if (separator < 0) return arg;
  return `${arg.slice(0, separator + 1)}${posixQuote(arg.slice(separator + 1))}`;
}

function formatPowerShellDevArg(arg) {
  const separator = arg.indexOf('=');
  if (separator < 0) return arg;
  return `${arg.slice(0, separator + 1)}${powershellQuote(arg.slice(separator + 1))}`;
}

function resolveRemoteTargetStackName(target, { stackName } = {}) {
  const controllerStackName = String(stackName ?? '').trim();
  const targetName = String(target?.name ?? '').trim().toLowerCase();
  if (!controllerStackName || !targetName) {
    throw new Error('[dev-targets] remote Stack identity requires controller Stack and target names');
  }
  const targetToken = targetName
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'target';
  const fingerprint = createHash('sha256')
    .update(`${controllerStackName}\0${targetName}\0${String(target.repoDir ?? '')}\0${String(target.cliHomeDir ?? '')}`)
    .digest('hex')
    .slice(0, 16);
  return `dev-target-${targetToken}-${fingerprint}`;
}

function usesRetainedRemoteStackState(runtimeMode) {
  return runtimeMode === 'controlled' || runtimeMode === 'source-snapshot';
}

export function resolveRemoteStackStatePaths(target, { stackName, runtimeMode = 'source' } = {}) {
  const retainedState = usesRetainedRemoteStackState(runtimeMode);
  if (retainedState) {
    const pathApi = target.platform === 'windows' ? win32 : posix;
    const relativeHome = pathApi.relative(String(target.repoDir).replaceAll('\\', '/'), String(target.cliHomeDir).replaceAll('\\', '/'));
    if (!pathApi.isAbsolute(relativeHome) && relativeHome !== '..' && !relativeHome.startsWith(`..${pathApi.sep}`)) {
      throw new Error('[dev-targets] controlled CLI state and workspace must be outside the one-way source replica; configure an external target cli-home-dir');
    }
  }
  const remoteStackName = retainedState ? stackName : resolveRemoteTargetStackName(target, { stackName });
  const stackStorageDir = resolveRemoteStackStorageDir(target.cliHomeDir);
  const stackBaseDir = `${stackStorageDir}/${remoteStackName}`;
  return {
    activeServerId: buildStackStableScopeId({
      stackName: remoteStackName,
      cliIdentity: 'default',
    }),
    stackName: remoteStackName,
    stackStorageDir,
    stackBaseDir,
    stackEnvPath: `${stackBaseDir}/env`,
    cliHomeDir: retainedState ? `${stackBaseDir}/cli` : String(target.cliHomeDir).replace(/[\\/]+$/, ''),
    workspaceDir: `${stackBaseDir}/workspace`,
    serverLightDataDir: `${stackBaseDir}/server-light`,
  };
}

export function buildRemoteStackRetirementProbeCommand(target, { stackName, runtimeMode = 'source', preserveDaemon = false } = {}) {
  const { stackBaseDir, stackName: remoteStackName, stackEnvPath, cliHomeDir } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const runtimeStatePath = `${stackBaseDir}/stack.runtime.json`;
  // Reboots leave state files behind. Runtime ownership, not file presence,
  // proves whether recorded processes still require retirement. Legacy Expo
  // records are checked separately because they can outlive their runner.
  const expression = [
    "const fs = require('node:fs'), path = require('node:path');",
    '(async () => {',
    `if (fs.existsSync(${JSON.stringify(runtimeStatePath)})) {`,
    `  const ownerUrl = require('node:url').pathToFileURL(path.join(${JSON.stringify(target.repoDir)}, 'apps/stack/scripts/utils/stack/runtime_state.mjs')).href;`,
    '  const { readStackRuntimeStateFile, hasTrustedStackRuntimeLifecycle } = await import(ownerUrl);',
    `  const state = await readStackRuntimeStateFile(${JSON.stringify(runtimeStatePath)});`,
    '  if (!state) {',
    // A reboot retires the prior process lifetime even when its last state
    // write was lost. Current-boot corruption still cannot prove absence.
    `    fs.readFileSync(${JSON.stringify(runtimeStatePath)}, 'utf8');`,
    "    const bootedAt = Date.now() - require('node:os').uptime() * 1000;",
    `    if (!(fs.statSync(${JSON.stringify(runtimeStatePath)}).mtimeMs < bootedAt)) process.exit(1);`,
    '  }',
    // A preserved daemon does not complete an interrupted full Stop. Let the
    // native Stop owner settle its request before the next startup consumes it.
    '  if (state?.stopRequest) process.exit(1);',
    `  if (await hasTrustedStackRuntimeLifecycle(state, ${JSON.stringify({ stackName: remoteStackName, envPath: stackEnvPath, cliHomeDir })}, ${JSON.stringify({ preserveDaemon: preserveDaemon === true })})) process.exit(1);`,
    '}',
    `const base = ${JSON.stringify(stackBaseDir)};`,
    "for (const [kind, file] of [['expo-dev','expo.state.json'],['mobile','expo.state.json'],['ui-dev','ui.state.json'],['mobile-dev','mobile.state.json']]) {",
    "  const root = path.join(base, kind); if (!fs.existsSync(root)) continue;",
    "  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {",
    "    if (!entry.isDirectory()) continue; const state = path.join(root, entry.name, file);",
    "    if (!fs.existsSync(state)) continue; const pid = Number(JSON.parse(fs.readFileSync(state, 'utf8')).pid);",
    "    if (!Number.isInteger(pid) || pid <= 1) continue;",
    "    try { process.kill(pid, 0); process.exit(1); } catch (error) { if (error.code !== 'ESRCH') throw error; }",
    '  }',
    '}',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join('\n');
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `node -e ${powershellQuote(expression)}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `exec node -e ${posixQuote(expression)}`,
    ].join('; '),
  );
}

export function buildRemoteRuntimeSnapshotImportCommand(target, { stackName, archivePath, snapshotId, requiredComponents }) {
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const args = ['./apps/stack/scripts/utils/dev_targets/runtime_artifact_transfer.mjs', `--archive=${archivePath}`, `--stack-base-dir=${paths.stackBaseDir}`, `--snapshot-id=${snapshotId}`,
    ...(requiredComponents ? [`--required-components=${requiredComponents.join(',')}`] : [])];
  const quote = target.platform === 'windows' ? powershellQuote : posixQuote;
  return wrapRemoteScript(target, target.platform === 'windows'
    ? `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${quote(target.repoDir)}; node ${args.map(quote).join(' ')}; exit $LASTEXITCODE`
    : `set -euo pipefail; cd -- ${quote(target.repoDir)}; exec node ${args.map(quote).join(' ')}`);
}

export function buildRemoteRuntimeSnapshotProbeCommand(target, { stackName, snapshotId, runtimeMode = 'controlled', services = {}, sourceUi = 'export', includeDaemonServerUrl = false, observeLive = false }) {
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const statePath = paths.stackBaseDir + '/stack.runtime.json';
  const components = ['server', 'daemon'].filter(component => services[component] === true);
  const daemonEndpointProbe = includeDaemonServerUrl ? [
    'const daemonServerUrl = s.serverConnection?.internalServerUrl ?? (s.ports?.server ? `http://127.0.0.1:${s.ports.server}` : null);',
    "if (typeof daemonServerUrl !== 'string' || !daemonServerUrl) fail('daemon_server_endpoint_missing');",
    'observed.daemonServerUrl = daemonServerUrl;',
    'observed.serverPort = s.ports?.server ?? null;',
  ] : [];
  const sourceProbe = [
    'const sourceRuntimeIdentities = {};',
    `for (const component of ${JSON.stringify(components)}) {`,
    '  const identity = s.sourceRuntimeIdentities?.[component];',
    "  if (typeof identity?.selected !== 'string' || !identity.selected) fail('runtime_identity_missing', { component });",
    "  if (identity.loaded !== identity.selected) fail('runtime_identity_not_loaded', { component });",
    '  sourceRuntimeIdentities[component] = { selected: identity.selected, loaded: identity.loaded };',
    '}',
    "if (!Object.keys(sourceRuntimeIdentities).length) fail('runtime_identity_missing');",
    'const observed = { sourceRuntimeIdentities, startedAt: s.startedAt };',
    ...daemonEndpointProbe,
    ...(services.server ? [
      `if (s.sourceUi !== ${JSON.stringify(sourceUi === 'export' ? 'export' : 'disabled')}) process.exit(1); observed.sourceUi = s.sourceUi;`,
      "if (s.sourceUi === 'export') {",
      "  if (typeof s.sourceUiLaunch?.uiDir !== 'string' || !s.sourceUiLaunch.uiDir.trim()) process.exit(1);",
      '  observed.sourceUiLaunch = { uiDir: s.sourceUiLaunch.uiDir };',
      '}',
    ] : []),
    'process.stdout.write(JSON.stringify(observed));',
  ].join('\n');
  const expression = [
    "const fs=require('node:fs');",
    `const statePath=${JSON.stringify(statePath)};`,
    "function fail(code, details = {}) { process.stderr.write(JSON.stringify({ ok: false, error: { code, statePath, ...details, recovery: 'Inspect this target with dev-targets status/doctor and recover the named Stack through stack start --restart.' } }) + '\\n'); process.exit(1); }",
    "let raw; try { raw=fs.readFileSync(statePath,'utf8'); } catch(error) { fail(error.code === 'ENOENT' ? 'runtime_state_missing' : 'runtime_state_unreadable', { causeCode: error.code }); }",
    "if (!raw.trim()) fail('runtime_state_empty');",
    "let s; try { s=JSON.parse(raw); } catch { fail('runtime_state_invalid'); }",
    "if (!s || typeof s !== 'object' || Array.isArray(s)) fail('runtime_state_invalid');",
    observeLive && runtimeMode === 'source-snapshot'
      ? buildRuntimeSnapshotObservationExpression({ target, paths, services })
      : runtimeMode === 'source-snapshot'
      ? sourceProbe
      : includeDaemonServerUrl ? ['const observed = {};', ...daemonEndpointProbe, 'process.stdout.write(JSON.stringify(observed));'].join('\n')
        : `process.exit(s.runtimeSnapshotId===${JSON.stringify(snapshotId)}?0:1)`,
  ].join('');
  const quote = target.platform === 'windows' ? powershellQuote : posixQuote;
  return wrapRemoteScript(target, target.platform === 'windows' ? `node -e ${quote(expression)}; exit $LASTEXITCODE` : `exec node -e ${quote(expression)}`);
}

function resolveRemoteStackStartInvocation(target, {
  services,
  env = process.env,
  serverUrl,
  publicServerUrl = '',
  canonicalServerUrl = '',
  stackName,
  remoteServerPort = null,
  remoteExpoPort = null,
  expoPublicPort = null,
  expoPublicUrl = '',
  startMobile = false,
  resolveServerPublicUrlOnTarget = false,
  resolveExpoPublicUrlOnTarget = false,
  remoteServerRuntimeConfig = null,
  deferDaemonStartUntilCredentials = false,
  attended = false,
  runtimeMode = 'source',
  runtimeSnapshotId = null,
  borrowedExpoProducerStackName = '',
  sourceUi = 'export',
  reuseSourceRuntime = false,
  refreshSourceRuntime = false,
  sourceUiLaunch = null,
  preparedSourceReload = false,
  sourceStartRequestId,
}) {
  const normalizedServices = {
    server: services?.server === true,
    expo: services?.expo === true,
    daemon: services?.daemon === true,
  };
  if (!Object.values(normalizedServices).some(Boolean)) {
    throw new Error('[dev-targets] remote Stack command requires at least one service');
  }
  const serverPort = normalizedServices.server
    ? requireServicePort(remoteServerPort, 'remote server port')
    : null;
  // Retained daemon-only commands still need their selected reverse-forward
  // port after a signed-out native worker has retired its runtime publication.
  const stackServerPort = serverPort ?? (usesRetainedRemoteStackState(runtimeMode) && normalizedServices.daemon
    ? remoteServerPort : null);
  const serverRuntimeConfig = normalizedServices.server
    ? normalizeRemoteServerRuntimeConfig(remoteServerRuntimeConfig)
    : null;
  const stablePublicServerUrl = normalizedServices.server
    ? (resolveServerPublicUrlOnTarget ? '' : requireStableOuterServerUrl(publicServerUrl))
    : publicServerUrl;
  // The signed auth audience belongs to the originating Stack: every client reaches this server
  // through the origin's canonical origin, so the remote server and daemon must consume that one instead of the
  // canonical origin the target would derive from its own Stack name and forwarded port.
  const originCanonicalServerUrl = (normalizedServices.server || normalizedServices.daemon) && String(canonicalServerUrl ?? '').trim()
    ? requireStableOuterServerUrl(canonicalServerUrl, { label: 'canonical server URL' })
    : '';
  const expoPort = normalizedServices.expo
    ? requireServicePort(remoteExpoPort, 'remote Expo port')
    : null;
  const stablePublicExpoPort = normalizedServices.expo && resolveExpoPublicUrlOnTarget
    ? requireServicePort(expoPublicPort, 'public Expo port')
    : null;
  const {
    activeServerId,
    stackName: remoteStackName,
    stackStorageDir,
    stackBaseDir,
    stackEnvPath,
    cliHomeDir,
    workspaceDir,
  } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const stackServerComponent = serverRuntimeConfig?.serverComponentName ?? 'happier-server-light';
  const stackDbProvider = serverRuntimeConfig?.dbProvider ?? 'sqlite';
  const serviceEnvironment = { ...(serverRuntimeConfig?.environment ?? {}) };
  if (runtimeMode === 'source-snapshot' && normalizedServices.server) Object.assign(serviceEnvironment, sourceWebExportDiagnosticEnv(env));
  // Co-located services already share the server's projected setting. A daemon
  // placed separately consumes the controller's opt-in, including its withdrawal.
  if (normalizedServices.daemon) serviceEnvironment.HAPPIER_WEB_LATENCY_TRACE ??= env.HAPPIER_WEB_LATENCY_TRACE === '1' ? '1' : '';
  // The operator's source-built guest CLI (a path on this target) reaches the
  // daemon's managed installer, which reads it before any release download.
  if (normalizedServices.daemon) Object.assign(serviceEnvironment, projectRemoteGuestCliPayloadEnvironment(env));
  const stackEnvLines = [
    `HAPPIER_STACK_REPO_DIR=${target.repoDir}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
    ...(usesRetainedRemoteStackState(runtimeMode) ? [
      'HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'HAPPIER_STACK_UPDATE_CHECK=0',
      `HAPPIER_STACK_INVOKED_CWD=${workspaceDir}`,
      ...(borrowedExpoProducerStackName ? [`HAPPIER_STACK_EXPO_SOURCE_STACK=${borrowedExpoProducerStackName}`] : []),
    ] : []),
    `HAPPIER_STACK_SERVER_COMPONENT=${stackServerComponent}`,
    `HAPPIER_DB_PROVIDER=${stackDbProvider}`,
    ...Object.entries(serviceEnvironment).map(([key, value]) => `${key}=${value}`),
    'HAPPIER_DEV_TARGET_EXECUTION=1',
    ...(normalizedServices.daemon && deferDaemonStartUntilCredentials
      ? ['HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1']
      : []),
    ...(stackServerPort ? [`HAPPIER_STACK_SERVER_PORT=${stackServerPort}`] : []),
    ...(usesRetainedRemoteStackState(runtimeMode) && stablePublicServerUrl ? [`HAPPIER_PUBLIC_SERVER_URL=${stablePublicServerUrl}`] : []),
    ...(originCanonicalServerUrl ? [`HAPPIER_CANONICAL_SERVER_URL=${originCanonicalServerUrl}`] : []),
    ...(expoPort ? [
      `HAPPIER_STACK_EXPO_DEV_PORT=${expoPort}`,
      'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY=stable',
      'HAPPIER_STACK_EXPO_HOST=localhost',
    ] : []),
    ...(stablePublicExpoPort ? [`HAPPIER_STACK_EXPO_PUBLIC_PORT=${stablePublicExpoPort}`] : []),
    ...(expoPublicUrl && !resolveExpoPublicUrlOnTarget ? [`EXPO_PACKAGER_PROXY_URL=${expoPublicUrl}`] : []),
  ];
  const devArgs = usesRetainedRemoteStackState(runtimeMode)
    ? [runtimeMode === 'source-snapshot' ? '--runtime=source' : '--runtime', '--no-dev-targets', '--no-browser',
      // Source startup defaults to borrowed Expo; carry the explicit export
      // choice to the server host that builds and serves its own UI.
      ...(runtimeMode === 'source-snapshot' && normalizedServices.server && sourceUi === 'export' ? ['--ui=export'] : []),
      ...(runtimeMode === 'source-snapshot' && sourceStartRequestId ? [`--source-start-request-id=${sourceStartRequestId}`] : []),
      ...(runtimeMode === 'source-snapshot' && (reuseSourceRuntime || refreshSourceRuntime) ? ['--restart'] : []),
      ...(runtimeMode === 'source-snapshot' && reuseSourceRuntime && !refreshSourceRuntime ? ['--reuse-source-runtime',
        ...(preparedSourceReload ? ['--prepared-source-reload'] : []),
        ...(normalizedServices.server && sourceUi === 'export' && sourceUiLaunch?.uiDir
          ? [`--source-ui-dir=${sourceUiLaunch.uiDir}`] : [])] : []),
      ...(!normalizedServices.server ? ['--no-server', `--server-url=${serverUrl}`] : []),
      ...(!normalizedServices.daemon ? ['--no-daemon'] : []),
      ...(!normalizedServices.server || (runtimeMode === 'source-snapshot'
        ? sourceUi !== 'export' : Boolean(borrowedExpoProducerStackName)) ? ['--no-ui'] : [])]
    : buildRemoteDevArgs({
    services: normalizedServices,
    serverUrl,
    publicServerUrl: stablePublicServerUrl,
    startMobile,
  });
  return {
    activeServerId,
    attended: attended === true,
    runtimeMode,
    runtimeSnapshotId,
    cliHomeDir,
    workspaceDir,
    devArgs,
    stackBaseDir,
    stackEnvLines,
    stackEnvPath,
    stackServerComponent,
    stackDbProvider,
    stackName: remoteStackName,
    stackStorageDir,
  };
}

function buildWindowsRemoteStackPrelude(target, invocation) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$env:HAPPIER_HOME_DIR = ${powershellQuote(invocation.cliHomeDir)}`,
    `$env:HAPPIER_STACK_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
    `$env:HAPPIER_STACK_CLI_HOME_DIR = ${powershellQuote(invocation.cliHomeDir)}`,
    `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(invocation.stackStorageDir)}`,
    `$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = ${powershellQuote(`${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`,
    ...(invocation.runtimeMode === 'source-snapshot' ? ["$env:HAPPIER_STACK_CLI_ROOT_DISABLE = '1'"] : []),
    `$env:HAPPIER_STACK_STACK = ${powershellQuote(invocation.stackName)}`,
    `$env:HAPPIER_ACTIVE_SERVER_ID = ${powershellQuote(invocation.activeServerId)}`,
    `$env:HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = ${powershellQuote(invocation.activeServerId)}`,
    ...(invocation.attended ? ["$env:HAPPIER_STACK_TUI = '1'"] : []),
    `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
    ...(usesRetainedRemoteStackState(invocation.runtimeMode) ? [
      `New-Item -ItemType Directory -Force -Path ${powershellQuote(invocation.cliHomeDir)},${powershellQuote(invocation.workspaceDir)} | Out-Null`,
      "$env:HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'",
      "$env:HAPPIER_STACK_UPDATE_CHECK = '0'",
    ] : []),
  ];
}

function buildPosixRemoteStackPrelude(target, invocation) {
  return [
    'set -euo pipefail',
    `export HAPPIER_HOME_DIR=${posixQuote(invocation.cliHomeDir)}`,
    `export HAPPIER_STACK_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
    `export HAPPIER_STACK_CLI_HOME_DIR=${posixQuote(invocation.cliHomeDir)}`,
    `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(invocation.stackStorageDir)}`,
    `export HAPPIER_STACK_PM_CACHE_BASE_DIR=${posixQuote(`${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`,
    ...(invocation.runtimeMode === 'source-snapshot' ? ['export HAPPIER_STACK_CLI_ROOT_DISABLE=1'] : []),
    `export HAPPIER_STACK_STACK=${posixQuote(invocation.stackName)}`,
    `export HAPPIER_ACTIVE_SERVER_ID=${posixQuote(invocation.activeServerId)}`,
    `export HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=${posixQuote(invocation.activeServerId)}`,
    ...(invocation.attended ? ['export HAPPIER_STACK_TUI=1'] : []),
    `cd -- ${posixQuote(target.repoDir)}`,
    ...(usesRetainedRemoteStackState(invocation.runtimeMode) ? [
      `mkdir -p -- ${posixQuote(invocation.cliHomeDir)} ${posixQuote(invocation.workspaceDir)}`,
      'export HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'export HAPPIER_STACK_UPDATE_CHECK=0',
    ] : []),
  ];
}

function buildWindowsRemoteStackInitializationCommands(target, invocation) {
  const launcher = remoteStackLauncher(invocation);
  return [
    `${launcher} stack new ${powershellQuote(invocation.stackName)} --server=${powershellQuote(invocation.stackServerComponent)} --db-provider=${powershellQuote(invocation.stackDbProvider)} --repo=${powershellQuote(target.repoDir)} --no-copy-auth --non-interactive --if-missing`,
    `${launcher} stack env ${powershellQuote(invocation.stackName)} set ${invocation.stackEnvLines.map(powershellQuote).join(' ')}`,
  ];
}

function buildPosixRemoteStackInitializationCommands(target, invocation) {
  const launcher = remoteStackLauncher(invocation);
  return [
    `${launcher} stack new ${posixQuote(invocation.stackName)} --server=${posixQuote(invocation.stackServerComponent)} --db-provider=${posixQuote(invocation.stackDbProvider)} --repo=${posixQuote(target.repoDir)} --no-copy-auth --non-interactive --if-missing`,
    `${launcher} stack env ${posixQuote(invocation.stackName)} set ${invocation.stackEnvLines.map(posixQuote).join(' ')}`,
  ];
}

function remoteStackLauncher(invocation) {
  // Source QA executes the existing repository entry using the target toolchain
  // PATH selected at provisioning. Runtime children still use the managed JS
  // launch owner; no package-manager wrapper or publication belongs here.
  return invocation.runtimeMode === 'source-snapshot'
    ? 'node ./apps/stack/bin/hstack.mjs'
    : 'pnpm --filter @happier-dev/stack run';
}

export function buildRemoteStackStopCommand(target, options) {
  const { runtimeMode = 'source', attended = false, preserveDaemon = false } = options;
  const preserveDaemonArg = preserveDaemon === true ? ' --preserve-daemon' : '';
  // Retirement uses recorded Stack custody, not the service configuration
  // required to start it. Share the identity owner with startup and probes.
  const invocation = {
    ...resolveRemoteStackStatePaths(target, options),
    runtimeMode,
    attended: attended === true,
  };
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        ...buildWindowsRemoteStackPrelude(target, invocation),
        "$env:HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'",
        "$env:HAPPIER_STACK_UPDATE_CHECK = '0'",
        `${remoteStackLauncher(invocation)} stack stop ${powershellQuote(invocation.stackName)} --yes --no-docker${preserveDaemonArg}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      ...buildPosixRemoteStackPrelude(target, invocation),
      'export HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'export HAPPIER_STACK_UPDATE_CHECK=0',
      `exec ${remoteStackLauncher(invocation)} stack stop ${posixQuote(invocation.stackName)} --yes --no-docker${preserveDaemonArg}`,
    ].join('; '),
  );
}

export function buildRemoteStackCommand(target, options) {
  const invocation = resolveRemoteStackStartInvocation(target, options);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        ...buildWindowsRemoteStackPrelude(target, invocation),
        ...buildWindowsRemoteStackInitializationCommands(target, invocation).flatMap((command) => [
          command,
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ]),
        `${remoteStackLauncher(invocation)} stack ${usesRetainedRemoteStackState(invocation.runtimeMode) ? 'start' : 'dev'} ${powershellQuote(invocation.stackName)} ${invocation.devArgs.map(formatPowerShellDevArg).join(' ')}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      ...buildPosixRemoteStackPrelude(target, invocation),
      ...buildPosixRemoteStackInitializationCommands(target, invocation),
      `exec ${remoteStackLauncher(invocation)} stack ${usesRetainedRemoteStackState(invocation.runtimeMode) ? 'start' : 'dev'} ${posixQuote(invocation.stackName)} ${invocation.devArgs.map(formatPosixDevArg).join(' ')}`,
    ].join('; '),
  );
}

export function buildRemoteStackHappierCommand(target, { stackName, runtimeMode = 'source', passthrough = [] }) {
  return buildRemoteStackOperationCommand(target, { stackName, runtimeMode, passthrough, operation: 'happier' });
}

export function buildRemoteStackOperationCommand(target, { stackName, runtimeMode = 'source', passthrough = [], operation }) {
  if (!['happier', 'daemon', 'build'].includes(operation)) throw new Error('[dev-targets] unsupported remote Stack operation');
  const invocation = { ...resolveRemoteStackStatePaths(target, { stackName, runtimeMode }), runtimeMode };
  if (target.platform === 'windows') {
    return wrapRemoteScript(target, [
      ...buildWindowsRemoteStackPrelude(target, invocation),
      "$env:HAPPIER_DEV_TARGET_EXECUTION = '1'",
      `${remoteStackLauncher(invocation)} stack ${operation} ${powershellQuote(invocation.stackName)} ${passthrough.map(powershellQuote).join(' ')}`,
      'exit $LASTEXITCODE',
    ].join('; '));
  }
  return wrapRemoteScript(target, [
    ...buildPosixRemoteStackPrelude(target, invocation),
    'export HAPPIER_DEV_TARGET_EXECUTION=1',
    `exec ${remoteStackLauncher(invocation)} stack ${operation} ${posixQuote(invocation.stackName)} ${passthrough.map(posixQuote).join(' ')}`,
  ].join('; '));
}

export function buildRemoteDaemonCommand(target, { serverUrl, activeServerId, stackName }) {
  return buildRemoteStackCommand(target, {
    services: { server: false, expo: false, daemon: true },
    serverUrl,
    activeServerId,
    stackName,
  });
}

export function buildRemoteForwardProbeCommand(target, { remoteServerPort }) {
  const port = Math.trunc(Number(remoteServerPort));
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        '$client = [System.Net.Sockets.TcpClient]::new()',
        `try { $client.Connect('127.0.0.1', ${port}) } finally { $client.Dispose() }`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `exec 3<>/dev/tcp/127.0.0.1/${port}`,
      'exec 3>&-',
    ].join('; '),
  );
}

export function buildRemoteDaemonReadinessProbeCommand(target, { stackName, runtimeMode = 'source' }) {
  const { activeServerId, cliHomeDir } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const statePath = `${cliHomeDir}/servers/${String(activeServerId)}/daemon.state.json`;
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$statePath = ${powershellQuote(statePath)}`,
        'if (-not (Test-Path -LiteralPath $statePath)) { exit 1 }',
        '$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json',
        'if ($null -eq $state.pid) { exit 1 }',
        '$daemonProcess = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue',
        'if ($null -eq $daemonProcess) { exit 1 }',
        'exit 0',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `state_path=${posixQuote(statePath)}`,
      '[ -f "$state_path" ] || exit 1',
      'daemon_pid=$(sed -n \'s/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' "$state_path" | head -n 1)',
      'case "$daemon_pid" in \'\'|*[!0-9]*) exit 1 ;; esac',
      'kill -0 "$daemon_pid" 2>/dev/null',
    ].join('; '),
  );
}

export function buildSshTunnelArgs(
  target,
  { localServerPort, remoteServerPort, sshArgs = [] },
) {
  // Forward listeners belong to this process. A multiplexed -N request installs
  // them on the persistent master and exits, losing per-Stack stop custody.
  return [
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-N',
    '-R',
    `127.0.0.1:${remoteServerPort}:127.0.0.1:${localServerPort}`,
    target.ssh,
  ];
}

function formatSshForward(forward) {
  const direction = forward?.direction;
  if (direction !== 'local' && direction !== 'reverse' && direction !== 'reverse-dynamic') {
    throw new Error('[dev-targets] SSH forward direction must be local, reverse or reverse-dynamic');
  }
  const listenHost = String(forward.listenHost ?? '127.0.0.1').trim();
  const targetHost = String(forward.targetHost ?? '127.0.0.1').trim();
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(listenHost) || !/^[A-Za-z0-9.:[\]-]+$/.test(targetHost)) {
    throw new Error('[dev-targets] invalid SSH forward host');
  }
  // OpenSSH treats `0.0.0.0` as IPv4-only, while `*` is its native dual-stack
  // wildcard. LAN-exposed local forwards (notably remote Metro) must remain
  // reachable when a device resolves this Mac through IPv6/Tailscale.
  const effectiveListenHost = direction === 'local' && listenHost === '0.0.0.0'
    ? '*'
    : listenHost;
  const listenPort = requireServicePort(forward.listenPort, 'SSH forward listen port');
  if (direction === 'reverse-dynamic') {
    return { flag: '-R', specification: `${effectiveListenHost}:${listenPort}` };
  }
  const targetPort = requireServicePort(forward.targetPort, 'SSH forward target port');
  return {
    flag: direction === 'local' ? '-L' : '-R',
    specification: `${effectiveListenHost}:${listenPort}:${targetHost}:${targetPort}`,
  };
}

export function buildSshForwardArgs(target, { forwards, sshArgs = [] } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) {
    throw new Error('[dev-targets] at least one SSH forward is required');
  }
  // Keep browser SOCKS/CDP and service listeners under their foreground owner;
  // killing a multiplex client cannot retire master-owned forward listeners.
  return [
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...forwards.flatMap((forward) => {
      const formatted = formatSshForward(forward);
      return [formatted.flag, formatted.specification];
    }),
    '-N',
    target.ssh,
  ];
}

// A transient stall must not expire admitted work. Transport failure and the
// controller-owned custody lifeline still cancel a lost command.
const PAYLOAD_SSH_SERVER_ALIVE_INTERVAL = 0;

export function buildSshWorkerArgs(
  target,
  { remoteCommand, sshArgs = [], tty = target.platform !== 'windows' },
) {
  // Runtime observation and command custody can hold a session for the whole
  // worker lifetime. Other lanes must not exhaust its shared master's slots.
  return [
    tty ? '-tt' : '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    `ServerAliveInterval=${PAYLOAD_SSH_SERVER_ALIVE_INTERVAL}`,
    target.ssh,
    remoteCommand,
  ];
}

export async function runRemoteCommandPolicyCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args[0] === '--source-web-export-workers') {
    const { explicit, workers } = resolveExpoExportWorkers(args.slice(2), process.env, { interactive: args[1] === '1' });
    // Opt-outs and interactive/default-Metro commands do not consume a fitted
    // injected count. Keep their prior conservative reservation instead.
    process.stdout.write(`${explicit || workers === null ? 'explicit' : 'managed'} ${workers ?? 0}\n`);
    return 0;
  }
  if (args[0] === '--workspace-locks') {
    process.stdout.write(JSON.stringify(resolveCommandWorkspaceLocks({ workspaceLock: args[2], bootstrap: args[3], validation: args[4], commandClass: args[5] }, args[1])));
    return 0;
  }
  if (args[0] === '--native-source-test') {
    const demand = !process.env.NODE_OPTIONS && readNativeTestPreparationDemand(args[1], args[2]);
    process.stdout.write(demand ? demand.requiresDependencyBootstrap ? '2\n' : demand.hasProcessBoundary ? '3\n' : '1\n' : '0\n');
    return 0;
  }
  const sourceTestTools = args[0] === '--source-test-tools';
  const vitestPolicy = args[0] === '--vitest-policy';
  const selfPublishing = args[0] === '--self-publishing';
  const publisherPolicy = args[0] === '--publisher-policy';
  const packagePolicy = args[0] === '--package-policy';
  const binaryCwd = args[0] === '--binary-cwd';
  if (sourceTestTools || vitestPolicy || selfPublishing || publisherPolicy || packagePolicy || binaryCwd) args.shift();
  const [repoRoot, cwd, ...commandArgs] = args;
  try {
    if (binaryCwd) {
      const context = normalizeCommandArguments(commandArgs, cwd, repoRoot).binaryContext;
      if (!context) throw new Error('expected a package binary invocation');
      const directory = await resolveCommandPackageDirectory(context, repoRoot);
      process.stdout.write((directory ?? context.cwd) + '\n');
      return 0;
    }
    if (sourceTestTools) {
      process.stdout.write(resolveSourceTestRequiredTools(repoRoot, cwd, commandArgs[0] ?? '') + '\n');
      return 0;
    }
    if (vitestPolicy || packagePolicy) {
      const policy = await resolvePackageCommandPolicy(commandArgs, { repoRoot, cwd });
      process.stdout.write(Object.entries(policy).map(([key, value]) => `policy_${key}=${posixQuote(value)}`).join('\n') + '\n');
      return 0;
    }
    if (publisherPolicy) {
      const policy = await resolveCommandPublisherPolicy(commandArgs, { repoRoot, cwd });
      process.stdout.write(`${policy.selfPublisher} ${policy.heavyClass || '-'} ${policy.requiredTools || '-'}\n`);
      return 0;
    }
    const probe = selfPublishing ? isSelfPublishingPackageCommand : isSelfDispatchingPackageCommand;
    return await probe(commandArgs, { repoRoot, cwd }) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`[command-policy] package ownership probe failed: ${error.message}\n`);
    return 2;
  }
}
// No top-level await: policy resolution lazily imports modules that import
// this one back, and awaiting here would deadlock that cycle (Node exit 13).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runRemoteCommandPolicyCli().then((code) => { process.exitCode = code; });
}
