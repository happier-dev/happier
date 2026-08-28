import { FEATURE_IDS } from './protocolFeatureIds.ts';
import {
  matchesWorkspaceScriptTarget,
  resolveRootScriptWorkspaceTargets,
  resolveScriptNodeTestFiles,
  type WorkspaceScriptTarget,
} from './rootScriptWorkspaceTargets.ts';
import { resolveOwningWorkspaceDirectory, type WorkspaceManifest } from './workspaceManifests.ts';

export type LaneId =
  | 'test'
  | 'test:plugin-workspaces'
  | 'test:plugin-platform:source'
  | 'workspace:test'
  | 'test:integration'
  | 'test:e2e:desktop:native'
  | 'cli:test:slow'
  | 'website:test'
  | 'release-runtime:test'
  | 'test:db-contract:docker'
  | 'test:e2e:core:fast'
  | 'test:e2e:core:slow'
  | 'test:e2e:ui'
  | 'test:e2e:ui:wsrepl:lima'
  | 'test:e2e:ui:wsrepl:lima:self'
  | 'test:e2e:mobile'
  | 'test:agents'
  | 'test:stress'
  | 'stack:test:unit'
  | 'stack:test:integration'
  | 'stack:test:real-integration';

export interface TestLaneDefinition {
  id: LaneId;
  category: 'unit' | 'integration' | 'db-contract' | 'e2e' | 'provider' | 'stress' | 'website';
  rootScriptName: string | null;
  rootCommand: string | null;
  packageLocalOnly: boolean;
}

export const TEST_LANE_DEFINITIONS: readonly TestLaneDefinition[] = Object.freeze([
  { id: 'test', category: 'unit', rootScriptName: 'test', rootCommand: 'yarn test', packageLocalOnly: false },
  {
    id: 'test:plugin-workspaces',
    category: 'unit',
    rootScriptName: 'test:plugin-workspaces',
    rootCommand: 'yarn test:plugin-workspaces',
    packageLocalOnly: false,
  },
  {
    id: 'test:plugin-platform:source',
    category: 'unit',
    rootScriptName: 'test:plugin-platform:source',
    rootCommand: 'yarn test:plugin-platform:source',
    packageLocalOnly: false,
  },
  { id: 'workspace:test', category: 'unit', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'test:integration', category: 'integration', rootScriptName: 'test:integration', rootCommand: 'yarn test:integration', packageLocalOnly: false },
  {
    id: 'test:e2e:desktop:native',
    category: 'e2e',
    rootScriptName: 'test:e2e:desktop:native',
    rootCommand: 'yarn test:e2e:desktop:native',
    packageLocalOnly: false,
  },
  { id: 'cli:test:slow', category: 'integration', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'website:test', category: 'website', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'release-runtime:test', category: 'unit', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  {
    id: 'test:db-contract:docker',
    category: 'db-contract',
    rootScriptName: 'test:db-contract:docker',
    rootCommand: 'yarn test:db-contract:docker',
    packageLocalOnly: false,
  },
  {
    id: 'test:e2e:core:fast',
    category: 'e2e',
    rootScriptName: 'test:e2e:core:fast',
    rootCommand: 'yarn test:e2e:core:fast',
    packageLocalOnly: false,
  },
  {
    id: 'test:e2e:core:slow',
    category: 'e2e',
    rootScriptName: 'test:e2e:core:slow',
    rootCommand: 'yarn test:e2e:core:slow',
    packageLocalOnly: false,
  },
  { id: 'test:e2e:ui', category: 'e2e', rootScriptName: 'test:e2e:ui', rootCommand: 'yarn test:e2e:ui', packageLocalOnly: false },
  {
    id: 'test:e2e:ui:wsrepl:lima',
    category: 'e2e',
    rootScriptName: 'test:e2e:ui:wsrepl:lima',
    rootCommand: 'yarn test:e2e:ui:wsrepl:lima',
    packageLocalOnly: false,
  },
  {
    id: 'test:e2e:ui:wsrepl:lima:self',
    category: 'integration',
    rootScriptName: 'test:e2e:ui:wsrepl:lima:self',
    rootCommand: 'yarn test:e2e:ui:wsrepl:lima:self',
    packageLocalOnly: false,
  },
  { id: 'test:e2e:mobile', category: 'e2e', rootScriptName: 'test:e2e:mobile', rootCommand: 'yarn test:e2e:mobile', packageLocalOnly: false },
  { id: 'test:agents', category: 'provider', rootScriptName: 'test:agents', rootCommand: 'yarn test:agents', packageLocalOnly: false },
  { id: 'test:stress', category: 'stress', rootScriptName: 'test:stress', rootCommand: 'yarn test:stress', packageLocalOnly: false },
  { id: 'stack:test:unit', category: 'unit', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'stack:test:integration', category: 'integration', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
  { id: 'stack:test:real-integration', category: 'integration', rootScriptName: null, rootCommand: null, packageLocalOnly: true },
]);

export const LANE_ROOT_SCRIPTS: Readonly<Record<LaneId, string | null>> = Object.freeze(
  Object.fromEntries(TEST_LANE_DEFINITIONS.map((definition) => [definition.id, definition.rootCommand])) as Record<LaneId, string | null>,
);

const KNOWN_FEATURE_MATCHES = [...FEATURE_IDS]
  .sort((left, right) => right.length - left.length)
  .map((featureId) => `.feat.${featureId}.`);

const UI_INTEGRATION_RE = /\.(?:integration\.(?:test|spec)|real\.integration\.test|e2e\.test)\.[jt]sx?$/;
const CLI_INTEGRATION_RE = /\.(?:integration\.(?:test|spec)|real\.integration\.test|e2e\.test)\.ts$/;
const SERVER_INTEGRATION_RE = /\.(?:integration\.(?:test|spec)|real\.integration\.test)\.ts$/;
const UNIT_TEST_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Files each workspace's vitest configs can actually collect.
 *
 * A workspace running a vitest lane is not evidence that every test file inside it runs: each
 * config declares `include` globs, and a file outside them (a `.mjs` node:test file, or a
 * directory the config excludes) is invisible to that runner. These mirror the `include`/`exclude`
 * declarations of the configs named by the workspaces' own test scripts, so a file outside them
 * falls through to the explicit `node --test` list instead of being credited to a lane that never
 * opens it.
 */
const UI_VITEST_COVERED_RE = /^apps\/ui\/(?:sources|tools)\/.*\.(?:spec|test)\.tsx?$/;
const CLI_VITEST_COVERED_RE = /^apps\/cli\/(?:src\/.*\.(?:test|spec)\.tsx?|scripts\/.*\.(?:test|spec)\.ts)$/;
const SERVER_VITEST_COVERED_RE = /^apps\/server\/(?:sources|scripts)\/.*\.(?:test|spec)\.ts$/;
const CLI_COMMON_VITEST_COVERED_RE = /^packages\/cli-common\/(?:src\/.*\.test\.ts|scripts\/.*\.test\.mjs)$/;

/**
 * Lane assignment for a workspace's own unit tests.
 *
 * `test` means the root unit executor runs the workspace; `workspace:test` means the workspace
 * declares its own test script but no root lane invokes it (package-local only); `null` means the
 * workspace declares no test script at all, so any test file inside it has no runner.
 */
export type WorkspaceUnitLane = 'test' | 'workspace:test';

export interface TestLaneWorkspace {
  /** Repo-relative workspace directory, `/`-separated, without a trailing separator. */
  directory: string;
  unitLane: WorkspaceUnitLane | null;
  /**
   * Repo-relative test files the workspace's own `test` chain names one by one
   * (`node --test a b c`).
   *
   * The workspace's main runner covers a directory wholesale, so membership of that directory is
   * enough to credit the unit lane. A directory the runner excludes is covered only by an explicit
   * list, and there a file is credited only when the list actually names it.
   */
  explicitUnitLaneTestFiles: readonly string[];
}

export interface TestLaneContext {
  workspaces: readonly TestLaneWorkspace[];
  /**
   * Repo-relative test files each lane's script chain names one by one, keyed by lane id.
   *
   * A lane that lists its files runs exactly those files. Crediting the rest of their directory to
   * it reports coverage the lane's script never opens.
   */
  explicitTestFilesByLane: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_TEST_LANE_CONTEXT: TestLaneContext = Object.freeze({
  workspaces: [],
  explicitTestFilesByLane: Object.freeze({}),
});

/**
 * The root script whose transitive workspace invocations define the `test` lane.
 */
export const ROOT_UNIT_LANE_SCRIPT_NAME = 'test';

export function buildTestLaneContext(params: Readonly<{
  workspaceManifests: readonly WorkspaceManifest[];
  rootScripts: Readonly<Record<string, string>>;
  rootUnitLaneScriptName?: string;
}>): TestLaneContext {
  const rootUnitTargets = resolveRootScriptWorkspaceTargets(
    params.rootScripts,
    params.rootUnitLaneScriptName ?? ROOT_UNIT_LANE_SCRIPT_NAME,
  );

  const workspaces = params.workspaceManifests.map((manifest): TestLaneWorkspace => {
    if (manifest.invalidReason !== null || manifest.scripts.test === undefined) {
      return { directory: manifest.workspaceDirectory, unitLane: null, explicitUnitLaneTestFiles: [] };
    }

    const workspaceTarget: WorkspaceScriptTarget = {
      packageName: manifest.packageName,
      workspaceDirectory: manifest.workspaceDirectory,
      scriptName: 'test',
    };
    const isRootUnitWorkspace = rootUnitTargets.some((target) => matchesWorkspaceScriptTarget(workspaceTarget, target));
    return {
      directory: manifest.workspaceDirectory,
      unitLane: isRootUnitWorkspace ? 'test' : 'workspace:test',
      explicitUnitLaneTestFiles: resolveWorkspaceScriptTestFiles(manifest, 'test'),
    };
  });

  return {
    workspaces,
    explicitTestFilesByLane: resolveExplicitTestFilesByLane(params.workspaceManifests, params.rootScripts),
  };
}

function resolveWorkspaceScriptTestFiles(manifest: WorkspaceManifest, scriptName: string): readonly string[] {
  if (manifest.invalidReason !== null) {
    return [];
  }

  const prefix = manifest.workspaceDirectory === '' ? '' : `${manifest.workspaceDirectory}/`;
  return resolveScriptNodeTestFiles(manifest.scripts, scriptName)
    .map((filePath) => `${prefix}${filePath.replace(/^\.\//u, '')}`);
}

/**
 * Files each lane's script chain names one by one, resolved through the root script to the
 * workspace script it delegates to.
 */
function resolveExplicitTestFilesByLane(
  workspaceManifests: readonly WorkspaceManifest[],
  rootScripts: Readonly<Record<string, string>>,
): Readonly<Record<string, readonly string[]>> {
  const byLane: Record<string, readonly string[]> = {};

  for (const definition of TEST_LANE_DEFINITIONS) {
    if (definition.rootScriptName === null) continue;

    const files = resolveRootScriptWorkspaceTargets(rootScripts, definition.rootScriptName).flatMap((target) => {
      const manifest = workspaceManifests.find((candidate) =>
        matchesWorkspaceScriptTarget(target, {
          packageName: candidate.packageName,
          workspaceDirectory: candidate.workspaceDirectory,
          scriptName: target.scriptName,
        }));
      return manifest === undefined ? [] : resolveWorkspaceScriptTestFiles(manifest, target.scriptName);
    });

    if (files.length > 0) {
      byLane[definition.id] = files;
    }
  }

  return byLane;
}

function resolveOwningWorkspace(context: TestLaneContext, relativePath: string): TestLaneWorkspace | null {
  const owningDirectory = resolveOwningWorkspaceDirectory(
    relativePath,
    context.workspaces.map((workspace) => workspace.directory),
  );
  if (owningDirectory === null) {
    return null;
  }
  return context.workspaces.find((workspace) => workspace.directory === owningDirectory) ?? null;
}

function resolveWorkspaceUnitLane(context: TestLaneContext, relativePath: string): WorkspaceUnitLane | null {
  return resolveOwningWorkspace(context, relativePath)?.unitLane ?? null;
}

/** True when the lane's script chain names this exact file. */
function laneNamesTestFile(context: TestLaneContext, laneId: LaneId, relativePath: string): boolean {
  return context.explicitTestFilesByLane[laneId]?.includes(relativePath) ?? false;
}

/**
 * Lane for a test file whose only possible runner is an explicit `node --test` list.
 *
 * Used for directories the owning workspace's main runner does not cover, so "the workspace runs a
 * test script" is not evidence that this file runs. A file no list names has no runner and returns
 * `null`, which surfaces it as unwired instead of crediting a lane that never opens it.
 */
function resolveExplicitlyNamedUnitLane(context: TestLaneContext, relativePath: string): WorkspaceUnitLane | null {
  const workspace = resolveOwningWorkspace(context, relativePath);
  if (workspace === null || !workspace.explicitUnitLaneTestFiles.includes(relativePath)) {
    return null;
  }
  return workspace.unitLane;
}

/**
 * Test files that deliberately have no lane yet.
 *
 * Every entry names the blocking reason. They are reported separately from wiring issues so the
 * residue stays visible instead of quietly passing, and an entry must be removed as soon as its
 * reason clears. This is not a place to silence a test that merely needs wiring.
 */
export const DECLARED_UNWIRED_TEST_FILES: Readonly<Record<string, string>> = Object.freeze({
  // Red where they would be wired. Measured 2026-08-23 with `node --test <file>` from `apps/ui`:
  // `tauri_desktop_autostart` 0 pass / 1 fail (Cargo.toml no longer matches
  // `tauri = { version = "2.8.2", features = [… "tray-icon"`), `tauri_mcp_bridge` 0 pass / 1 fail
  // (dev capabilities are now `['default','overlay','pet_overlay']`, expected `['default']`), and
  // `tauriOnboardingWizardMcpQa` 17 pass / 2 fail. Each asserts a real desktop contract against
  // drifted current bytes, so the fix is the assertion or the product — not the wiring.
  'apps/ui/scripts/tauri_desktop_autostart.test.mjs':
    'Red at current bytes (0 pass / 1 fail): the Cargo.toml tauri feature-list assertion no longer matches.',
  'apps/ui/scripts/tauri_mcp_bridge.test.mjs':
    'Red at current bytes (0 pass / 1 fail): the dev Tauri capability-list assertion no longer matches.',
  'apps/ui/scripts/qa/tauriOnboardingWizardMcpQa.test.mjs':
    'Red at current bytes (17 pass / 2 fail); wiring it would land a failing lane.',

  // Executed only by `yarn --cwd apps/ui certify:activity-surfaces`, whose file list lives in
  // `scripts/runActivitySurfacesCertification.mjs`
  // (`ACTIVITY_SURFACES_VALIDATION_NODE_TEST_FILES`). That command is a manual certification gate:
  // no workflow step in `.github/workflows/**` invokes it. Naming them in the package `test` chain
  // as well would create a second list for one file set.
  'apps/ui/scripts/activitySurfacesValidationContract.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',
  'apps/ui/scripts/runActivitySurfacesCertification.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',
  'apps/ui/scripts/runActivitySurfacesNativeCertification.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',
  'apps/ui/scripts/runActivitySurfacesReleaseReadiness.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',
  'apps/ui/scripts/qa/tauriActivitySurfacesMcpQa.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command, and is red there (224 pass / 1 fail).',
  'apps/ui/scripts/validateExpoWidgetsGeneratedProject.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',
  'apps/ui/scripts/validateExpoWidgetsNativeSync.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',
  'apps/ui/scripts/validateExpoWidgetsSimulatorBuildSmoke.test.mjs':
    'Runs only in the manual `certify:activity-surfaces` command; no CI workflow invokes that lane.',

  // The other twenty files beside it are named by the `cli-common` `test:dist:local` chain and run
  // green there (117 pass / 0 fail measured 2026-08-23). This one is red at current bytes:
  // 33 pass / 7 fail, including `installAgentCli does not treat a system CLI as already-installed
  // when explicitly installing a managed package-backed backend` and `resolveExistingPnpmCommand
  // ignores a non-executable override on Unix`, which reads the real `~/.happier/tools/pnpm`
  // instead of its fixture. Both are managed-agent-CLI install contracts, not wiring defects.
  'packages/cli-common/tests/agents.test.mjs':
    'Red at current bytes (33 pass / 7 fail) in the managed agent CLI install corridor.',

  // Retired 2026-08-19: the C9 out-of-tree channel-socket provider fixture was realigned to the
  // current definePlugin `execution.target` contract and now runs in the workspace `test` script
  // (packages/tests test:local -> test:plugin-platform:out-of-tree-channel-socket-provider).
  // Measured on realignment: 32 tests / 31 pass / 0 fail / 1 skip.
});

export function resolveFeatureTagIssue(relativePath: string): string | null {
  if (!relativePath.includes('.feat.')) {
    return null;
  }

  if (KNOWN_FEATURE_MATCHES.some((needle) => relativePath.includes(needle))) {
    return null;
  }

  return `Invalid feature test tag in ${relativePath}`;
}

export function classifyTestFile(context: TestLaneContext, relativePath: string): LaneId | null {
  if (relativePath.startsWith('apps/stack/')) {
    if (/\.real\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) return 'stack:test:real-integration';
    if (/\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) return 'stack:test:integration';
    return /\.test\.[cm]?[jt]s$/.test(relativePath) ? 'stack:test:unit' : null;
  }

  if (relativePath.startsWith('apps/ui/')) {
    if (/^apps\/ui\/scripts\/qa\/.+\.native-e2e\.test\.[cm]?[jt]s$/.test(relativePath)) return 'test:e2e:desktop:native';
    if (!UI_VITEST_COVERED_RE.test(relativePath)) {
      // The UI vitest configs include only `sources/**` and `tools/**` TypeScript. A `.mjs` file, or
      // anything under `scripts/**` / `plugins/**`, runs only where the package `test` chain names
      // it one by one, so membership of the workspace is not evidence that it runs.
      return resolveExplicitlyNamedUnitLane(context, relativePath);
    }
    if (UI_INTEGRATION_RE.test(relativePath)) return 'test:integration';
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('apps/website/')) {
    return UNIT_TEST_RE.test(relativePath) ? 'website:test' : null;
  }

  if (relativePath.startsWith('apps/cli/')) {
    if (!CLI_VITEST_COVERED_RE.test(relativePath)) {
      // The CLI vitest configs include `src/**/*.test.{ts,tsx}` plus `scripts/**/*.test.ts`; a
      // `.mjs` script test matches none of them and runs only where the package `test` chain
      // names it.
      return resolveExplicitlyNamedUnitLane(context, relativePath);
    }
    if (/\.slow\.test\.ts$/.test(relativePath)) return 'cli:test:slow';
    if (CLI_INTEGRATION_RE.test(relativePath)) return 'test:integration';
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('apps/server/')) {
    if (!SERVER_VITEST_COVERED_RE.test(relativePath)) {
      // The server vitest configs include only `sources/**` and `scripts/**` TypeScript.
      return resolveExplicitlyNamedUnitLane(context, relativePath);
    }
    if (/\.dbcontract\.spec\.ts$/.test(relativePath)) return 'test:db-contract:docker';
    if (SERVER_INTEGRATION_RE.test(relativePath)) return 'test:integration';
    return UNIT_TEST_RE.test(relativePath) ? 'test' : null;
  }

  if (relativePath.startsWith('apps/bootstrap/')) {
    // `vitest.config.ts` includes only `src/**/*.test.ts`.
    if (!/^apps\/bootstrap\/src\/.*\.test\.ts$/.test(relativePath)) {
      return resolveExplicitlyNamedUnitLane(context, relativePath);
    }
    return 'test';
  }

  if (relativePath.startsWith('packages/cli-common/')) {
    // `vitest.config.ts` includes `src/**/*.test.ts` and `scripts/**/*.test.mjs`, and explicitly
    // excludes `tests/**/*.mjs`. The excluded tree runs only where the package `test` chain names
    // each file, so crediting the workspace lane for it reported coverage no runner provides.
    if (!CLI_COMMON_VITEST_COVERED_RE.test(relativePath)) {
      return resolveExplicitlyNamedUnitLane(context, relativePath);
    }
    return 'test';
  }

  if (relativePath.startsWith('packages/tests/')) {
    if (relativePath.startsWith('packages/tests/scripts/') && /\.test\.mjs$/.test(relativePath)) {
      // No vitest config includes `scripts/**`, so these files run only where a `node --test`
      // command names them. The WSREPL Lima self-check lane names two of them; the workspace's own
      // `test` chain names most of the rest. Classifying the whole directory into the Lima lane
      // reported every neighbour as gated by a root script that opens neither.
      if (laneNamesTestFile(context, 'test:e2e:ui:wsrepl:lima:self', relativePath)) {
        return 'test:e2e:ui:wsrepl:lima:self';
      }
      return resolveExplicitlyNamedUnitLane(context, relativePath);
    }
    if (relativePath.startsWith('packages/tests/src/plugin-platform/')) {
      return /\.test\.ts$/.test(relativePath) ? 'test:plugin-platform:source' : null;
    }
    if (relativePath.includes('/suites/ui-e2e/')) return /\.spec\.ts$/.test(relativePath) ? 'test:e2e:ui' : null;
    if (relativePath.includes('/suites/agents/')) return /\.test\.ts$/.test(relativePath) ? 'test:agents' : null;
    if (relativePath.includes('/suites/stress/')) return /\.test\.ts$/.test(relativePath) ? 'test:stress' : null;
    if (relativePath.includes('/suites/core-e2e/')) {
      if (/\.slow\.e2e\.test\.ts$/.test(relativePath)) return 'test:e2e:core:slow';
      return /\.test\.ts$/.test(relativePath) ? 'test:e2e:core:fast' : null;
    }
    if (relativePath.includes('/suites/contracts/')) return /\.test\.ts$/.test(relativePath) ? 'test:e2e:core:fast' : null;
    // In-process layer suites and the runtime-mode parity bench. `vitest.core.config.ts` collected
    // both, but only `test:core` uses that config and no CI job or root CI-shaped script invokes it
    // — the workspace's own `test` script is not named by any root lane either. They are now in
    // `vitest.core.fast.config.ts`, which the `e2e-core` job runs.
    if (relativePath.includes('/suites/core-layer/')) return /\.test\.ts$/.test(relativePath) ? 'test:e2e:core:fast' : null;
    if (relativePath.includes('/suites/runtime-unification/')) return /\.test\.ts$/.test(relativePath) ? 'test:e2e:core:fast' : null;
    if (relativePath.includes('/src/testkit/') && /\.(?:test|spec)\.ts$/.test(relativePath)) return 'test:e2e:core:fast';
    // Everything else in the workspace (`pluginSdkConsumers`, `fixtures/**`,
    // `src/testkit/**/*.test.mjs`) runs through the @happier-dev/tests workspace `test` script, so
    // it resolves through the derived workspace lane.
  }

  if (relativePath.startsWith('packages/release-runtime/')) {
    return /\.test\.mjs$/.test(relativePath) ? 'release-runtime:test' : null;
  }

  if (relativePath.startsWith('packages/plugins/')) {
    return UNIT_TEST_RE.test(relativePath) ? 'test:plugin-workspaces' : null;
  }

  if (relativePath in DECLARED_UNWIRED_TEST_FILES) {
    return null;
  }

  if (relativePath.startsWith('packages/plugin-sdk/examples/')) {
    // The published examples are `node:test` files, which the workspace's vitest run excludes (it
    // reports them as empty suites). Only the explicit `node --test` list in the workspace `test`
    // chain runs them, so an example the list does not name ships to plugin authors unverified.
    return resolveExplicitlyNamedUnitLane(context, relativePath);
  }

  const workspaceUnitLane = resolveWorkspaceUnitLane(context, relativePath);
  if (workspaceUnitLane !== null) {
    return UNIT_TEST_RE.test(relativePath) ? workspaceUnitLane : null;
  }

  return null;
}

export function collectLaneIssues(context: TestLaneContext, relativePath: string): string[] {
  const issues: string[] = [];

  if (relativePath.startsWith('packages/tests/suites/ui-e2e/') && !/\.spec\.ts$/.test(relativePath)) {
    issues.push('UI E2E tests must use *.spec.ts under packages/tests/suites/ui-e2e.');
  }

  if (relativePath.startsWith('packages/tests/suites/agents/') && !/\.test\.ts$/.test(relativePath)) {
    issues.push('Provider suite files must use *.test.ts under packages/tests/suites/agents.');
  }

  if (relativePath.startsWith('packages/tests/suites/stress/') && !/\.test\.ts$/.test(relativePath)) {
    issues.push('Stress suite files must use *.test.ts under packages/tests/suites/stress.');
  }

  if (relativePath.startsWith('packages/tests/suites/core-e2e/') && relativePath.includes('.slow.') && !/\.slow\.e2e\.test\.ts$/.test(relativePath)) {
    issues.push('Core E2E slow files must use *.slow.e2e.test.ts naming.');
  }

  if (relativePath.startsWith('packages/tests/suites/core-e2e/') && /\.spec\.ts$/.test(relativePath)) {
    issues.push('Core E2E files must use *.test.ts naming under packages/tests/suites/core-e2e.');
  }

  if (relativePath.startsWith('apps/stack/') && relativePath.includes('.real.integration.') && !/\.real\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) {
    issues.push('Stack real integration tests must use *.real.integration.test.* naming.');
  }

  if (relativePath.startsWith('apps/stack/') && relativePath.includes('.integration.') && !relativePath.includes('.real.integration.') && !/\.integration\.test\.[cm]?[jt]s$/.test(relativePath)) {
    issues.push('Stack integration tests must use *.integration.test.* naming.');
  }

  if (relativePath.startsWith('apps/stack/') && !relativePath.includes('.integration.') && /\.(?:spec)\.[cm]?[jt]s$/.test(relativePath)) {
    issues.push('Stack unit tests must use *.test.* naming.');
  }

  const shouldSuppressGenericNoLaneIssue =
    issues.length > 0 &&
    ((relativePath.startsWith('apps/stack/') && relativePath.includes('.integration.')) ||
      (relativePath.startsWith('apps/stack/') && /\.spec\.[cm]?[jt]s$/.test(relativePath)) ||
      (relativePath.startsWith('packages/tests/suites/core-e2e/') && relativePath.includes('.slow.')));

  if (relativePath in DECLARED_UNWIRED_TEST_FILES) {
    return issues;
  }

  if (classifyTestFile(context, relativePath) === null && !shouldSuppressGenericNoLaneIssue) {
    issues.push(`No lane mapping matched ${relativePath}.`);
  }

  return issues;
}
