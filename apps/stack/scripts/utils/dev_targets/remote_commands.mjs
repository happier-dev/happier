import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDependencyRefreshLockPath } from '../proc/dependency_refresh.mjs';

import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import { decodeJwtPayloadUnsafe } from '../auth/decode_jwt_payload_unsafe.mjs';
import { REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN } from '../managed_lima/guest_toolchain.mjs';
import { resolveEffectiveDbProvider } from '../server/effective_db_provider.mjs';
import { renderNativeHeavyweightPressureCadence } from './heavyweight_pressure_cadence.mjs';
import { resolveRemoteStackStorageDir } from './stack_paths.mjs';
import { collectWorkspacePackageJsonPaths } from '../proc/workspace_package_manifests.mjs';
import { readNativeTestSourceInputs } from '../fs/workspaceBuildInputs.mjs';
import { resolveWorkspaceTypeScriptCompilerArgs } from '../../../../../packages/cli-common/workspaceChildBuildEnv.mjs';
import { resolveCliPublicationBuildSteps } from '../../../../cli/scripts/buildPublication.mjs';
import { sourceWebExportDiagnosticEnv } from '../../build/sourceWebExportArgs.mjs';
import { resolveExpoExportWorkers } from '../expo/exportWorkers.mjs';
export { resolveHeavyweightPressureRetryMilliseconds } from './heavyweight_pressure_cadence.mjs';

// Both dispatchers evaluate this policy. The native artifact is generated once,
// while argv and path normalization remain thin transport adapters.
export const REMOTE_COMMAND_CLASSIFICATION = Object.freeze({
  packageManagerCommands: Object.freeze(['npm', 'npx', 'pnpm', 'yarn']),
  sourceTestComponents: Object.freeze(['apps/cli', 'apps/ui', 'apps/server', 'packages/cli-common', 'packages/sdk', 'packages/plugin-ui', 'packages/plugins/triage', 'packages/channels-protocol', 'packages/email-transports-protocol', 'packages/plugins/channels', 'packages/plugins/channel-email', 'packages/plugins/channel-telegram', 'packages/plugins/channel-discord', 'packages/plugins/scm-github', 'packages/plugins/scm-gitlab', 'packages/plugins/app-context', 'packages/plugins/inspector', 'packages/plugins/linear', 'packages/plugins/jira', 'packages/plugins/sentry', 'packages/plugins/posthog', 'packages/plugins/claude']),
  sourceTestConfigs: Object.freeze(['vitest.config.ts']),
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
});
const DEFAULT_COMMAND_POLICY = Object.freeze({
  placement: 'worker-eligible', commandClass: 'unclassified', bootstrap: '0',
  validation: '0', kind: 'runtime', heavyClass: '', workerTool: '',
  workerArguments: '0', runnerKnown: '0', componentOverride: '',
  generator: '0', generatorCheck: '0', componentFromNative: '0',
  localCompile: '0', requiredTools: '', selfPublisher: '0', compilerLeaf: '0', workspaceLock: '',
  preparationBuildMode: 'strict',
});
const validation = { validation: '1', bootstrap: '1', heavyClass: 'validation' };
// Available-memory envelopes, not process limits or fixed concurrency slots.
// The native selection and admission paths consume this generated policy too.
// 2026-10-05 Linux measurements: cli-common dist 1,853,332 KiB; Protocol
// dist 4,682,608 KiB. Both fit beneath the existing 6 GiB compiler/suite
// envelope.
// The successful full daemon worker request peaked at 16,442,992 KiB of
// aggregate process-tree RSS on Linux x64 (2026-10-05). Preserve at least
// Round 1's measured package headroom (6,291,456 - 4,682,608 = 1,608,848 KiB):
// peak + headroom = 18,051,840 KiB, rounded up to 18 GiB. This does not
// justify admitting a worker with only 15 GiB available.
// 2026-10-09 Round 2: two sequential public TS7 typecheck runs per app on
// Linux ARM64, sampling descendant RSS/VmHWM and /usr/bin/time -v. Largest
// observed metrics: UI 18,909,772, CLI 13,688,852, server 14,179,616 KiB.
// Add the same 1,608,848 KiB measured headroom and round up to whole GiB:
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
// The larger current tree plus the existing 1,608,848 KiB measured headroom
// is 10,269,176 KiB, rounded up to 10 GiB.
// 2026-10-23 nl1 Linux x64 cold source-web export, maxWorkers=1: whole-tree
// VmRSS peak 7,699,992 KiB; live-descendant VmHWM sum 8,236,000 KiB, sampled
// every second (largest interval 1,317 ms). Peak occurred in Metro's
// serialization tail, with 75,349,720 KiB host MemAvailable. The larger
// VmHWM sum + the same 1,608,848 KiB headroom = 9,844,848 KiB, rounded up
// to 10 GiB; the serial export fit the source-bundle envelope.
// 2026-10-23 nl1 Linux x64 export at the executor's observed GOMAXPROCS=47:
// the enclosing sampler measured 32,907,788 KiB concurrent process-tree RSS
// (2,139 samples, largest interval 1,012 ms, no unreadable processes).
// Add the same 1,608,848 KiB headroom: 34,516,636 KiB, rounded up to 33 GiB.
// Keep web export separate from the smaller measured runtime source bundles.
// These observations do not certify a maximum for larger CPU allowances.
const HEAVYWEIGHT_MEMORY_KIB = Object.freeze({
  validation: 6291456,
  // 2026-10-12 Linux native policy fixture: runner + test VmHWM sum 111,684
  // KiB. Reuse the existing measured 1,608,848 KiB headroom and round up to
  // whole GiB. Only one proven built-in/source-only file receives this class;
  // emitted imports, loaders, subprocesses and whole suites keep their class.
  'native-source-test': 2 * 1024 * 1024,
  'source-bundle': 10 * 1024 * 1024,
  'source-web-export': 33 * 1024 * 1024,
  'dependency-install': 6291456,
  'package-dist': 6291456,
  'runtime-build': 18874368,
  compilation: 20 * 1024 * 1024,
  'compilation-ui': 20 * 1024 * 1024,
  'compilation-cli': 15 * 1024 * 1024,
  'compilation-server': 16 * 1024 * 1024,
});
const HEAVYWEIGHT_COMPILE_CLASSES = ['compilation', 'compilation-ui', 'compilation-cli', 'compilation-server', 'package-dist', 'runtime-build'];
export const SOURCE_WEB_EXPORT_ADMISSION_CLASS = 'source-web-export';

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
// Retain exactly the existing headroom and rational slopes for GiB edges.
const EXPORT_MEMORY = Object.freeze({ serialKiB: 8236000, parallelKiB: 32907788,
  intermediateKiB: 12711296, intermediateThreads: 8, parallelThreads: 47,
  headroomKiB: 1608848, gibKiB: 1024 * 1024 });
function exportMemorySegment(startThreads, startKiB, endThreads, endKiB) {
  const denominator = endThreads - startThreads;
  const numerator = endKiB - startKiB;
  return { numerator, denominator, baseNumerator: startKiB * denominator - startThreads * numerator };
}
const EXPORT_MEMORY_SEGMENTS = [
  exportMemorySegment(1, EXPORT_MEMORY.serialKiB, EXPORT_MEMORY.intermediateThreads, EXPORT_MEMORY.intermediateKiB),
  exportMemorySegment(EXPORT_MEMORY.intermediateThreads, EXPORT_MEMORY.intermediateKiB, EXPORT_MEMORY.parallelThreads, EXPORT_MEMORY.parallelKiB),
];

// The primary VM's browser/agent workloads pause below 8 GiB MemAvailable
// (2026-10-06 observation). Worker envelopes remain class-owned; only local
// admission raises smaller envelopes to this measured controller floor.
const LOCAL_HEAVYWEIGHT_MEMORY_FLOOR_KIB = 8 * 1024 * 1024;

export function resolveHeavyweightMemoryFloorKiB(className, { machine = 'worker', workers } = {}) {
  const segment = EXPORT_MEMORY_SEGMENTS[workers <= EXPORT_MEMORY.intermediateThreads ? 0 : 1];
  const floor = className === SOURCE_WEB_EXPORT_ADMISSION_CLASS && Number.isSafeInteger(workers) && workers > 0
    ? Math.ceil((segment.baseNumerator + segment.numerator * workers + EXPORT_MEMORY.headroomKiB * segment.denominator)
      / (segment.denominator * EXPORT_MEMORY.gibKiB)) * EXPORT_MEMORY.gibKiB
    : HEAVYWEIGHT_MEMORY_KIB[className] ?? HEAVYWEIGHT_MEMORY_KIB.compilation;
  return machine === 'local' ? Math.max(floor, LOCAL_HEAVYWEIGHT_MEMORY_FLOOR_KIB) : floor;
}
const COMMAND_RULES = [
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
  { when: { command: ['node', 'nodejs'], entryRepositoryPath: ['packages/tests/scripts/run-extended-db-docker.mjs'] }, set: { requiredTools: 'docker' } },
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
  // These compilers validate/reuse native admission at their leaf. A mixed
  // manifest can defer to that leaf after its finite publishers; direct and
  // pure compiler payloads retain outer admission and certified-busy fallback.
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
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], nativeTestPath: ['packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'] }, set: { kind: 'source-test' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], stackScope: ['1'] }, set: { kind: 'runtime', componentOverride: 'apps/stack' } },
  // These tool owner suites import repository source and construct isolated
  // dependency fixtures, not emitted workspace runtime closures.
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], nativeTestPath: [
    'apps/ui/scripts/runVitestShards.test.mjs',
    'apps/ui/scripts/activitySurfacesValidationContract.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_validation_preparation.test.mjs',
    'apps/stack/scripts/utils/proc/workspace_build_admission.test.mjs',
    'apps/stack/scripts/utils/test/test_process.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs',
    'apps/stack/scripts/build/build_source_runtime.test.mjs',
    'apps/stack/scripts/runtime/shared/pending_source_start.test.mjs',
    'apps/stack/scripts/runtime/launch/resolveLaunchSpecs.test.mjs',
  ] }, set: { kind: 'source-test' } },
  // These lifecycle/transport fixtures use authored exports only when the
  // caller explicitly selects the existing Happier source runtime contract.
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], sourceCondition: ['1'], nativeTestPath: [
    'apps/stack/scripts/utils/dev/expo_dev_crash_supervision.test.mjs',
    'apps/stack/scripts/preferred_execution_launcher.test.mjs',
    'apps/stack/scripts/utils/dev_targets/service_placement.test.mjs',
    'apps/stack/scripts/dev_targets_cmd.test.mjs',
    'apps/stack/scripts/daemon_start_verification.integration.test.mjs',
    'apps/stack/scripts/stack/stack_daemon_command.test.mjs',
    'apps/stack/scripts/stack/stack_daemon_runtime_provenance.test.mjs',
    'apps/stack/scripts/stack_daemon_cmd.integration.test.mjs',
    'apps/stack/scripts/utils/stack/daemonControlClient.test.mjs',
  ] }, set: { kind: 'source-test' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['apps/stack/scripts/build/remote_runtime_build.mjs'] }, set: { ...validation, kind: 'source-test', componentOverride: 'apps/stack' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['scripts/build/remote_runtime_build.mjs'], component: ['apps/stack'] }, set: { ...validation, kind: 'source-test' } },
  // Both finite web entry points consume authored inputs and admit the same
  // measured tree; they do not require emitted Stack workspace prerequisites.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: [
    'apps/stack/scripts/build/build_source_web_ui.mjs', 'apps/stack/scripts/build/build_web_artifact.mjs',
  ] }, set: { ...validation, kind: 'source-test', componentOverride: 'apps/stack', heavyClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS } },
  // Reload coordinates completed lookup, finite production and activation.
  // Its producers jointly admit their own leases; charging the coordinator
  // first makes ordinary foreign-lease contention an admission-order refusal.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs'] },
    set: { ...validation, kind: 'source-test', componentOverride: 'apps/stack', heavyClass: 'source-bundle', selfPublisher: '1' } },
  // Content checking prepares Protocol's reference renderer through the
  // finite workspace publisher. Fit that producer's existing envelope for
  // placement, but leave its capacity/lease admission to the publisher.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['apps/docs/scripts/checkContent.mjs'] },
    set: { ...validation, componentOverride: 'apps/docs', heavyClass: 'runtime-build', selfPublisher: '1' } },
  // Unit coordination publishes dependencies first, then the managed native
  // runner acquires its finite test envelope. Never reserve that envelope
  // across the coordinator's foreign-publication wait.
  // The suite executes real server and daemon Bun builds on its selected host.
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], entryRepositoryPath: ['apps/stack/scripts/test_ci.mjs'] },
    set: { ...validation, componentOverride: 'apps/stack', selfPublisher: '1', requiredTools: 'bun' } },
  { when: { command: ['node'], stripTypes: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'] }, set: { generator: '1', workerTool: 'bundled-plugin-generator', heavyClass: 'validation', placement: 'primary-only' } },
  { when: { command: ['node'], stripTypes: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'], mode: ['check'] }, set: { ...validation, placement: 'worker-eligible', generatorCheck: '1', componentOverride: 'apps/cli' } },
  { when: { command: ['node'], stripTypes: ['1'], sourceCondition: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'], mode: ['check'] }, set: { kind: 'source-test' } },
  { when: { script: ['check:first-party-plugins:finite', 'check:first-party-plugins:finite:local', 'plugins:aggregate:finite', 'test:migration:bundled-plugin-projections', 'test:migration:governance'] }, set: { ...validation, generatorCheck: '1', componentOverride: 'apps/cli' } },
];
const FINAL_COMMAND_RULES = [
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
  { when: { admissionWrapper: ['1'], admissionClass: ['targeted-validation', 'full-validation'] }, set: { heavyClass: 'validation' } },
  // CLI unit aliases use the same source resolver as direct Vitest. Runtime
  // preparation would build the emitted closure and escalate their parent
  // validation reservation for the rest of the test run.
  { when: { kind: ['runtime'], component: ['apps/cli'], script: ['test', 'test:local', 'test:unit', 'test:unit:local', 'test:unit:vitest', 'test:unit:vitest:local'], config: ['vitest.config.ts'], resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: REMOTE_COMMAND_CLASSIFICATION.sourceTestComponents, config: REMOTE_COMMAND_CLASSIFICATION.sourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: ['apps/cli'], config: ['vitest.source.integration.config.ts'], resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  // Native source prerequisites are staged under their own admitted producer
  // lease before the payload. Retaining it through tests prevents a nested
  // compiler from waiting for its legitimate larger resource envelope.
  { when: { kind: ['source-test'], component: ['apps/cli'], workerTool: ['vitest'] }, set: { workspaceLock: '' } },
  // The complete source-unit lane executes real compiler owners. Explicit
  // file requests retain validation; compiler-consuming focused requests use
  // the existing explicit admission-class wrapper, not a filename registry.
  { when: { kind: ['source-test'], component: ['apps/cli'], workerTool: ['vitest'],
    config: ['vitest.config.ts'], generatorCheck: ['0'], testFileSelected: ['0'] },
    set: { heavyClass: 'compilation' } },
  // Verified UI and server lanes keep their workspace-source resolvers.
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: ['apps/ui'], config: REMOTE_COMMAND_CLASSIFICATION.uiSourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: ['apps/server'], config: REMOTE_COMMAND_CLASSIFICATION.serverSourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
  { when: { heavyClass: HEAVYWEIGHT_COMPILE_CLASSES }, set: { localCompile: '1' } },
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
  if (command === 'hstack-exec' && args[1] === '--heavyweight-admission') {
    let admissionClass = 'validation';
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--') {
        if (index + 1 < args.length) {
          const payload = normalizeCommandArguments(args.slice(index + 1), cwd, repoRoot);
          // Admission owns resources, not the payload's preparation contract.
          // Only commands the existing policy admits dependencies for are transparent.
          if (resolveRemoteCommandPolicy(args.slice(index + 1), { cwd, repoRoot }).bootstrap === '1') {
            return { ...payload, admissionWrapper: '1', admissionClass };
          }
        }
        break;
      }
      if (argument.startsWith('--class=')) admissionClass = argument.slice(8);
      else if (!/^(?:--(?:admission-root|machine|failure-id)=|--(?:no-wait|exec-admitted)$)/u.test(argument)) break;
    }
  }
  const managerIndex = command === 'corepack' ? 1 : 0;
  const manager = commandBasename(args[managerIndex]);
  let script = '', entry = commandBasename(args[1]), managerCwd = '', managerNode = '0', workspace = '', managerEntryIndex = 1;
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
  const rawEntryPath = String(args[entryIndex] ?? '').replaceAll('\\', '/');
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
  let admissionClass = '';
  if (command === 'hstack-exec' && args[1] === '--heavyweight-admission') {
    admissionClass = 'validation';
    for (const argument of args.slice(2)) {
      if (argument === '--') break;
      if (argument.startsWith('--class=')) admissionClass = argument.slice('--class='.length);
    }
  }
  return {
    command, manager, script, family: script.split(':', 1)[0], entry, entryPath, entryRepositoryPath, managerNode, admissionClass, workspace,
    admissionWrapper: command === 'hstack-exec' && args[1] === '--heavyweight-admission' ? '1' : '0',
    noCheck,
    declarations: args.includes('--declarations') ? '1' : '0',
    runScript: args.some(arg => arg.startsWith('--run-script=') && arg.length > '--run-script='.length) ? '1' : '0',
    hasScript: script ? '1' : '0', nativeTest: args.includes('--test') ? '1' : '0',
    stripTypes, sourceCondition, mode, config: normalizeCommandPath(config), resolverOverride,
    nativeLoader: args.some(arg => /^(?:--import|--require|--loader|--experimental-loader)(?:=|$)/.test(arg) || /^-r/.test(arg)) ? '1' : '0',
    workerRequest: args.some(arg => arg.startsWith('--worker-request=') && arg.length > '--worker-request='.length) ? '1' : '0',
    component: normalizeCommandPath(slashCwd), managerCwd, project, mixedProjects: projectScopes.size > 1 ? '1' : '0',
    nativeTestPath: testPaths.length === 1 ? testPaths[0] : '',
    testFileSelected: args.some(arg => !arg.startsWith('-') && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg)) ? '1' : '0',
    nativeComponent: testComponents.length && testComponents.every(component => component === testComponents[0]) ? testComponents[0] : '',
    stackScope: /^apps\/stack(?:\/|$)/u.test(posix.normalize(slashCwd))
      || args.some(arg => /(?:^|\/)apps\/stack\//u.test(arg.replaceAll('\\', '/'))) ? '1' : '0',
  };
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

async function resolvePackageCommandManifest(commandArgs, { repoRoot = COMMAND_REPO_ROOT, cwd = process.cwd() } = {}) {
  const facts = normalizeCommandArguments(commandArgs, cwd, repoRoot);
  if (facts.binaryContext || !facts.script || facts.manager === 'npx' || !['corepack', ...REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands].includes(facts.command)) return null;
  const packageDir = await resolveCommandPackageDirectory({ ...facts, cwd }, repoRoot);
  if (!packageDir) return null;
  try {
    return { packageDir, packageJson: readCommandPackageJson(packageDir), scriptName: facts.script };
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
  const match = /^\s*(\S+)\s+--script=\S+(?:\s+[^;&|<>`$\n\r]*)?\s*$/u.exec(script);
  return Boolean(match && resolve(packageDir, match[1]) === resolve(repoRoot, 'apps/stack/bin/hstack-exec'));
}
export function resolveRemoteCommandPolicy(commandArgs, { cwd = '.', repoRoot = COMMAND_REPO_ROOT, env = process.env, packageDir } = {}) {
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
  if ((policy.kind === 'source-test' || facts.component === 'apps/cli') && policy.workerTool === 'vitest' && policy.generatorCheck === '0') {
    policy.requiredTools = resolveSourceTestRequiredTools(repoRoot, facts.component, policy.requiredTools);
  }
  if (['node', 'nodejs'].includes(facts.command) && facts.nativeTest === '1'
    && facts.nativeTestPath && facts.nativeLoader === '0' && !env.NODE_OPTIONS
    && readNativeTestSourceInputs(repoRoot, facts.nativeTestPath) !== null) {
    Object.assign(policy, { kind: 'source-test', bootstrap: '0', heavyClass: 'native-source-test' });
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
  return { ...policy, component: normalizeCommandPath(facts.component) };
}

/** Finite validation retains installed-tree custody through its last read.
 * Producers finish before joint resource/capacity admission; they never inherit
 * a reader that they would have to upgrade to a dependency writer.
 */
export function resolveCommandWorkspaceLocks(policy, repoRoot) {
  return [
    ...(policy.validation === '1' && policy.bootstrap === '1' && policy.selfPublisher !== '1'
      ? [{ kind: 'dependency', installDir: repoRoot, path: resolveDependencyRefreshLockPath(repoRoot) }] : []),
    ...(policy.workspaceLock ? [{ path: resolve(repoRoot, policy.workspaceLock) }] : []),
  ];
}

// Workspace manifests use direct argv commands, sequential &&/; commands and
// repository package script references. Unsupported shell syntax must not produce a
// smaller reservation. This is intentionally not a general shell interpreter.
function workspaceBuildCommands(script) {
  if (/[$`\\\r\n]/u.test(script)) return null;
  const commands = [[]];
  const tokens = /"[^"\r\n]*"|'[^'\r\n]*'|&&|;|[^\s;&|<>`$"']+/gu;
  let end = 0;
  for (const match of script.matchAll(tokens)) {
    if (script.slice(end, match.index).trim()) return null;
    const token = match[0];
    end = match.index + token.length;
    if (token === '&&' || token === ';') {
      if (!commands.at(-1).length) return null;
      commands.push([]);
    } else {
      commands.at(-1).push(token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token);
    }
  }
  if (script.slice(end).trim() || !commands.at(-1).length) return null;
  return commands;
}

/** Declare the full local package build before its publisher acquires leases.
 * Script names and lifecycle hooks come from the manifest; compiler envelopes
 * and source/strict argv remain owned by the canonical command/emit policies.
 * Light generators retain their command policy. A new compiler entry point
 * must be classified there, rather than hidden behind a light generator.
 */
async function resolveWorkspacePackageScriptPolicy({ packageJson, cwd = process.cwd(), env = process.env, repoRoot = COMMAND_REPO_ROOT, scriptName = 'build' } = {}) {
  let admissionClass = '';
  let sawPublisher = false;
  let selfPublisher = true;
  const requiredTools = new Set();
  const include = (candidate) => {
    if (!candidate) return;
    const candidateFloor = resolveHeavyweightMemoryFloorKiB(candidate);
    const currentFloor = admissionClass ? resolveHeavyweightMemoryFloorKiB(admissionClass) : 0;
    if (candidateFloor > currentFloor || (candidateFloor === currentFloor
      && HEAVYWEIGHT_COMPILE_CLASSES.includes(candidate) && !HEAVYWEIGHT_COMPILE_CLASSES.includes(admissionClass))) {
      admissionClass = candidate;
    }
  };
  const visiting = new Set();
  const visit = async (name, packageDir, metadata) => {
    const scripts = metadata?.scripts ?? {};
    const identity = `${packageDir}\0${name}`;
    if (visiting.has(identity) || typeof scripts[name] !== 'string') { include('compilation'); selfPublisher = false; return; }
    visiting.add(identity);
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      if (hook !== name && !(hook in scripts)) continue;
      const commands = typeof scripts[hook] === 'string' ? workspaceBuildCommands(scripts[hook]) : null;
      if (!commands) { include('compilation'); selfPublisher = false; continue; }
      for (const args of commands) {
        const facts = normalizeCommandArguments(args, packageDir, repoRoot);
        const policy = await resolveComposedTypecheckPolicy(args, { cwd: packageDir, repoRoot, env });
        for (const tool of policy.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
        const dispatchedScript = facts.command === 'hstack-exec'
          ? args.find(arg => arg.startsWith('--script='))?.slice('--script='.length) : '';
        if (dispatchedScript) { await visit(dispatchedScript, packageDir, metadata); continue; }
        if (facts.script && REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.includes(facts.manager)) {
          if (facts.manager === 'npx') { include('compilation'); selfPublisher = false; }
          else if (facts.managerCwd || facts.workspace) {
            const referenced = await resolvePackageCommandManifest(args, { repoRoot, cwd: packageDir });
            if (referenced) await visit(referenced.scriptName, referenced.packageDir, referenced.packageJson);
            else { include('compilation'); selfPublisher = false; }
          } else await visit(facts.script, packageDir, metadata);
          continue;
        }
        const wrapperScript = facts.entry === 'bundleWorkspaceDeps.mjs'
          ? args.find(arg => arg.startsWith('--run-script='))?.slice('--run-script='.length) : '';
        if (wrapperScript) {
          if (policy.selfPublisher === '1') sawPublisher = true;
          else selfPublisher = false;
          await visit(wrapperScript, packageDir, metadata);
          continue;
        }
        // Unclassified Node entries are the manifest's light generators.
        // Unknown shell/executable commands can change cwd or launch work we
        // cannot expand, so they retain the existing general compile floor.
        if (!policy.heavyClass && !['node', 'nodejs'].includes(facts.command)) {
          include('compilation');
          selfPublisher = false;
        }
        include(policy.heavyClass);
        if (policy.selfPublisher === '1') sawPublisher = true;
        else if (policy.localCompile === '1' && policy.compilerLeaf !== '1') selfPublisher = false;
      }
    }
    visiting.delete(identity);
  };
  await visit(scriptName, resolve(cwd), packageJson);
  return { admissionClass: admissionClass || 'compilation', selfPublisher: selfPublisher && sawPublisher,
    requiredTools: [...requiredTools].join(' ') };
}

export async function resolveWorkspacePackageBuildAdmissionClass(options = {}) {
  return (await resolveWorkspacePackageScriptPolicy(options)).admissionClass;
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

async function resolveComposedTypecheckPolicy(commandArgs, options) {
  const facts = normalizeCommandArguments(commandArgs, options.cwd ?? process.cwd(), options.repoRoot);
  if (facts.binaryContext) {
    const context = facts.binaryContext;
    const cwd = await resolveCommandPackageDirectory(context, options.repoRoot ?? COMMAND_REPO_ROOT);
    return resolvePackageCommandPolicy(context.args, { ...options, cwd: cwd ?? context.cwd, packageDir: undefined });
  }
  const policy = resolveRemoteCommandPolicy(commandArgs, options);
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
  const manifest = await resolvePackageCommandManifest(commandArgs, options);
  const policy = await resolveComposedTypecheckPolicy(commandArgs, { ...options,
    ...(manifest ? { packageDir: manifest.packageDir } : {}) });
  const requiredTools = new Set(policy.requiredTools.split(/\s+/u).filter(Boolean));
  let selfPublisher = policy.selfPublisher;
  let heavyClass = policy.heavyClass;
  if (manifest) {
    const resolved = await resolveWorkspacePackageScriptPolicy({ ...options, ...manifest, cwd: manifest.packageDir });
    for (const tool of resolved.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
    if (resolved.selfPublisher) selfPublisher = '1';
    if (resolved.selfPublisher || (policy.kind === 'typecheck'
      && resolveHeavyweightMemoryFloorKiB(resolved.admissionClass) > resolveHeavyweightMemoryFloorKiB(heavyClass))) {
      heavyClass = resolved.admissionClass;
    }
  }
  if (policy.selfPublisher === '1' && normalizeCommandArguments(commandArgs, options.cwd, options.repoRoot).entry === 'bundleWorkspaceDeps.mjs') {
    const cwd = options.cwd ?? process.cwd();
    const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const scriptName = commandArgs.find(arg => arg.startsWith('--run-script='))?.slice('--run-script='.length);
    const resolved = await resolveWorkspacePackageScriptPolicy({ ...options, cwd, packageJson, scriptName });
    for (const tool of resolved.requiredTools.split(/\s+/u).filter(Boolean)) requiredTools.add(tool);
    selfPublisher = '1';
    heavyClass = resolved.admissionClass;
  }
  return { ...policy, selfPublisher, heavyClass, requiredTools: [...requiredTools].join(' ') };
}

export async function resolveCommandPublisherPolicy(commandArgs, options = {}) {
  const { selfPublisher, heavyClass, requiredTools } = await resolvePackageCommandPolicy(commandArgs, options);
  return { selfPublisher, heavyClass, requiredTools };
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
    renderNativeHeavyweightPressureCadence(),
    'heavyweight_memory_floor_kib() {',
    '  case "$1" in',
    ...Object.entries(HEAVYWEIGHT_MEMORY_KIB).map(([key, value]) => '    ' + key + ') heavyweight_policy_floor=' + posixQuote(String(value)) + ' ;;'),
    // Historical dispatch labels are validation, while unrecognized resource
    // classes must not silently acquire a smaller compilation envelope.
    '    targeted-validation|full-validation) heavyweight_policy_floor=' + posixQuote(String(HEAVYWEIGHT_MEMORY_KIB.validation)) + ' ;;',
    '    *) heavyweight_policy_floor=' + posixQuote(String(HEAVYWEIGHT_MEMORY_KIB.compilation)) + ' ;;',
    '  esac',
    '  if [ "$1" = source-web-export ]; then',
    '    case "${3-}" in \'\'|*[!0-9]*|0) ;;',
    `      *) heavyweight_policy_floor=$(awk -v threads="$3" 'BEGIN { if(threads<=${EXPORT_MEMORY.intermediateThreads}) {${serialSegment}} else {${parallelSegment}}; total=b+n*threads+${EXPORT_MEMORY.headroomKiB}*d; unit=d*${EXPORT_MEMORY.gibKiB}; printf "%.0f", (int(total/unit)+(total%unit>0))*${EXPORT_MEMORY.gibKiB} }') ;;`,
    '    esac',
    '  fi',
    '  if [ "${2-}" = local ] && [ "$heavyweight_policy_floor" -lt ' + LOCAL_HEAVYWEIGHT_MEMORY_FLOOR_KIB + ' ]; then',
    '    heavyweight_policy_floor=' + posixQuote(String(LOCAL_HEAVYWEIGHT_MEMORY_FLOOR_KIB)),
    '  fi',
    '  printf \'%s\' "$heavyweight_policy_floor"', '}',
    'source_web_export_workers_for_memory_kib() {',
    `  awk -v cpu="$1" -v memory="$2" 'BEGIN { memory=int(memory/${EXPORT_MEMORY.gibKiB})*${EXPORT_MEMORY.gibKiB}; if(memory<=${EXPORT_MEMORY.intermediateKiB + EXPORT_MEMORY.headroomKiB}) {${serialSegment}} else {${parallelSegment}}; workers=int((memory*d-b-${EXPORT_MEMORY.headroomKiB}*d)/n); if(workers<1) workers=1; if(workers>cpu) workers=cpu; printf "%.0f", workers }'`,
    '}',
    'native_command_policy_base() {',
    ...Object.entries(DEFAULT_COMMAND_POLICY).map(([key, value]) => '  policy_' + key + '=' + posixQuote(value)),
    renderShellCommandRules(COMMAND_RULES), '}',
    'native_command_policy_finish() {', renderShellCommandRules(FINAL_COMMAND_RULES),
    '  if { [ "$policy_kind" = source-test ] || [ "$policy_component" = apps/cli ]; } && [ "$policy_workerTool" = vitest ] && [ "$policy_generatorCheck" = 0 ]; then',
    '    policy_requiredTools=$(node "${projection_command_policy:-$repo_root/apps/stack/scripts/utils/dev_targets/remote_commands.mjs}" --source-test-tools "$repo_root" "$policy_component" "$policy_requiredTools") || return $?',
    '  fi', '}',
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
  shift
  resolve_native_command_policy "$@"
}
native_resolve_binary_payload() {
  shift 2
  resolve_native_command_policy "$@"
}
native_try_admission_payload() {
  shift 2
  native_wrapper_class=validation
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --class=*) native_wrapper_class=\${1#--class=} ;;
      --admission-root=*|--machine=*|--failure-id=*|--no-wait|--exec-admitted) ;;
      --)
        shift
        [ "$#" -gt 0 ] || return 1
        # Positional custody preserves this wrapper's class through recursion.
        set -- "$native_wrapper_class" "$@"
        native_resolve_admission_payload "$@" || return 2
        [ "$policy_bootstrap" = 1 ] || return 1
        policy_admissionWrapper=1
        policy_admissionClass=$1
        native_command_policy_finish || return 2
        return 0
        ;;
      *) return 1 ;;
    esac
    shift
  done
  return 1
}
resolve_native_command_policy() {
  [ "\${1-}" = -- ] && shift
  case "\${1-}" in --script=*) native_script=\${1#--script=}; shift; [ "\${1-}" = -- ] && shift; set -- pnpm run --silent "$native_script" "$@" ;; esac
  native_command_basename "\${1-}"; policy_command=$native_basename
  if [ "$policy_command" = hstack-exec ] && [ "\${2-}" = --heavyweight-admission ]; then
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
  policy_testFileSelected=0
  policy_project=; policy_projectPaths=; policy_workerRequest=0
  policy_noCheck=0
  policy_declarations=0; policy_runScript=0
  policy_admissionClass=
  policy_admissionWrapper=0
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
  native_normalize_path "$native_entry_path"; policy_entryPath=$native_result
  case "$policy_entryPath" in "$repo_root"/*) policy_entryPath=\${policy_entryPath#"$repo_root"/} ;; esac
  native_normalize_path "$native_entry_path"; policy_entryRepositoryPath=$native_result
  case "$policy_entryRepositoryPath" in /*) ;; *) native_normalize_path "$policy_component/$policy_entryRepositoryPath"; policy_entryRepositoryPath=$native_result ;; esac
  case "$policy_entryRepositoryPath" in "$repo_root"/*) policy_entryRepositoryPath=\${policy_entryRepositoryPath#"$repo_root"/} ;; esac
  native_pending=; native_project_scope=; policy_mixedProjects=0
  for native_arg in "$@"; do
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
      --test) policy_nativeTest=1 ;;
      --import|--import=*|--require|--require=*|--loader|--loader=*|--experimental-loader|--experimental-loader=*|-r*) policy_nativeLoader=1 ;;
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
      --root|--root=*|--workspace|--workspace=*|-r*) policy_resolverOverride=1 ;;
      --mode) native_pending=mode ;;
      --mode=*) policy_mode=\${native_arg#--mode=} ;;
    esac
    case "$native_arg" in apps/stack/*|./apps/stack/*|*/apps/stack/*) policy_stackScope=1 ;; esac
    case "$native_arg" in
      -*) ;;
      *.test.js|*.test.ts|*.test.mjs|*.test.mts|*.test.cjs|*.test.cts|*.test.jsx|*.test.tsx|*.spec.js|*.spec.ts|*.spec.mjs|*.spec.mts|*.spec.cjs|*.spec.cts|*.spec.jsx|*.spec.tsx) policy_testFileSelected=1 ;;
    esac
  done
  native_normalize_path "$policy_config"; policy_config=$native_result
  policy_project=$native_project
  policy_nativeTestPath=; native_test_count=0; native_test_component=; native_test_component_mixed=0
  native_test_argument_index=0
  for native_arg in "$@"; do
    native_test_argument_index=$((native_test_argument_index + 1))
    [ "$native_test_argument_index" -gt "$native_node_prefix_count" ] || continue
    case "$native_arg" in -*) continue ;; *.mjs|*.cjs|*.js|*.ts|*.mts|*.cts) ;; *) continue ;; esac
    native_normalize_path "$native_arg"; native_test_path=$native_result
    case "$native_test_path" in "$repo_root"/*) native_test_path=\${native_test_path#"$repo_root"/} ;; *) native_normalize_path "$policy_component/$native_test_path"; native_test_path=$native_result ;; esac
    native_test_count=$((native_test_count + 1))
    policy_nativeTestPath=$native_test_path
    native_parent=\${native_test_path%/*}
    [ "$native_parent" != "$native_test_path" ] || native_parent=.
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
  [ "$native_test_component_mixed" -eq 0 ] || native_test_component=
  native_command_basename "\${1-}"; native_manager=$native_basename
  if [ "$native_manager" = corepack ]; then shift; native_command_basename "\${1-}"; native_manager=$native_basename; fi
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
        if [ "$native_source_only" = 1 ]; then
          policy_kind=source-test; policy_bootstrap=0; policy_heavyClass=native-source-test
        fi
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
  return wrapRemoteScript(target, `set -e; cd -- ${posixQuote(target.repoDir)}; exec node --import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs ./apps/stack/scripts/utils/dev_targets/qa_browser.mjs --stop-stack ${posixQuote(stackName)} ${posixQuote(paths.stackEnvPath)}`);
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
  return wrapRemoteScript(
    target,
    `set -euo pipefail; mkdir -p -- ${[target.repoDir, target.cliHomeDir, ...additional].map(posixQuote).join(' ')}`,
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

const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS = new Set([
  // Preserve an explicit host allocator choice; never impose an arena limit here.
  'MALLOC_ARENA_MAX',
  'HAPPIER_STACK_SHARED_DB_SOURCE_STACK',
  'HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE',
  'HAPPIER_SQLITE_AUTO_MIGRATE',
  'HAPPIER_STACK_MIGRATE_MODE',
  'METRICS_ENABLED',
  // The application origin mailed links (verification, reset, invitations) are rendered on.
  'HAPPIER_WEBAPP_URL',
  // Publishing requires the service operator's public report contact on the serving host.
  'HAPPIER_PUBLIC_PROFILE_REPORT_URL',
  'HAPPIER_SQLITE_BUSY_TIMEOUT_MS',
  'HAPPIER_SQLITE_CONNECTION_LIMIT',
  // A Stack's Postgres pool budget (overrides DATABASE_URL connection_limit) belongs to its server too.
  'HAPPIER_DB_CONNECTION_LIMIT',
  // The Stack's chosen server log level (resolved by server_env.mjs) applies wherever its server runs.
  'HAPPIER_STACK_SERVER_LOG_LEVEL',
  'HAPPIER_SERVER_LOG_LEVEL',
  'HAPPIER_SERVER_LOG_FORMAT',
  'HAPPIER_WEB_LATENCY_TRACE',
]);
const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES = [
  // Server feature configuration is non-secret; preserve the Stack's policy wherever it runs.
  'HAPPIER_FEATURE_',
  'HAPPIER_SERVER_RETENTION__',
  // Auth mail delivery and the email/password method: a Stack's own settings must reach its server
  // wherever it is placed, or mail-dependent sign-in silently stays off on a remote target.
  'HAPPIER_AUTH_EMAIL_',
];
// Secrets never enter a remote command line or its persisted env file.
const REMOTE_SERVER_LIGHT_NEVER_FORWARDED_ENV_KEYS = new Set(['HAPPIER_AUTH_EMAIL_SMTP_PASSWORD']);

function isRemoteServerLightSemanticEnvKey(key) {
  if (REMOTE_SERVER_LIGHT_NEVER_FORWARDED_ENV_KEYS.has(key)) return false;
  return REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS.has(key)
    || REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function projectRemoteServerLightSemanticEnvironment(env) {
  const projected = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isRemoteServerLightSemanticEnvKey(key) || value == null) continue;
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error('[dev-targets] invalid remote server semantic environment key');
    }
    const normalized = String(value).trim();
    if (!normalized) continue;
    if (/[\0\r\n]/.test(normalized)) {
      throw new Error('[dev-targets] invalid remote server semantic environment value');
    }
    projected[key] = normalized;
  }
  return projected;
}

export function resolveRemoteServerRuntimeConfig({ serverComponentName, env = {} } = {}) {
  if (serverComponentName !== 'happier-server-light') {
    throw new Error('[dev-targets] remote server placement only supports happier-server-light');
  }
  const effectiveProvider = resolveEffectiveDbProvider({ serverComponentName, env });
  if (!effectiveProvider.ok) {
    throw new Error('[dev-targets] remote server placement has an unsupported database provider configuration');
  }
  if (!['sqlite', 'postgres'].includes(effectiveProvider.provider)) {
    throw new Error('[dev-targets] remote server placement only supports SQLite or Postgres');
  }
  return {
    serverComponentName: 'happier-server-light',
    // The URL/credentials remain in the server host's env, never this projection.
    dbProvider: effectiveProvider.provider,
    environment: projectRemoteServerLightSemanticEnvironment(env),
  };
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

export function buildRemoteRuntimeSnapshotProbeCommand(target, { stackName, snapshotId, runtimeMode = 'controlled', services = {}, sourceUi = 'export', includeDaemonServerUrl = false }) {
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
    runtimeMode === 'source-snapshot'
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
  const guestCliPayloadRoot = String(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim();
  if (normalizedServices.daemon && guestCliPayloadRoot && !/[\0\r\n]/.test(guestCliPayloadRoot)) {
    serviceEnvironment.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT = guestCliPayloadRoot;
  }
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

export function buildSshWorkerArgs(
  target,
  { remoteCommand, sshArgs = [], tty = target.platform !== 'windows' },
) {
  return [
    tty ? '-tt' : '-T',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
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
    process.stdout.write(JSON.stringify(resolveCommandWorkspaceLocks({ workspaceLock: args[2], bootstrap: args[3], validation: args[4] }, args[1])));
    return 0;
  }
  if (args[0] === '--native-source-test') {
    process.stdout.write(!process.env.NODE_OPTIONS && readNativeTestSourceInputs(args[1], args[2]) !== null ? '1\n' : '0\n');
    return 0;
  }
  const sourceTestTools = args[0] === '--source-test-tools';
  const selfPublishing = args[0] === '--self-publishing';
  const publisherPolicy = args[0] === '--publisher-policy';
  const packagePolicy = args[0] === '--package-policy';
  const binaryCwd = args[0] === '--binary-cwd';
  if (sourceTestTools || selfPublishing || publisherPolicy || packagePolicy || binaryCwd) args.shift();
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
    if (packagePolicy) {
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
