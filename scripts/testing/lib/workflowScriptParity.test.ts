import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROOT_TYPECHECK_COMMANDS } from '../runTypecheck.ts';
import { collectWorkflowScriptParityReport } from './workflowScriptParity.ts';
import { resolveRootScriptWorkspaceTargets } from './rootScriptWorkspaceTargets.ts';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function createPackageJsonText(): string {
  return JSON.stringify(
    {
      scripts: {
        test: 'pnpm run test:unit',
        'check:public-sdk:finite': 'apps/stack/bin/hstack-exec --script=check:public-sdk:finite:local',
        'check:public-sdk:finite:local': 'turbo run api:finite test:finite typecheck:finite --filter=@happier-dev/plugin-sdk --filter=@happier-dev/plugin-ui --filter=@happier-dev/sdk',
        'test:unit': 'pnpm --filter privacy-kit run test && pnpm --filter @happier-dev/protocol run test && pnpm --filter @happier-dev/peer-mediation run test && pnpm --filter @happier-dev/transfers run test && pnpm --filter @happier-dev/agents run test && pnpm --filter @happier-dev/cli-common run test && pnpm --filter @happier-dev/support run test && pnpm --filter @happier-dev/connection-supervisor run test && pnpm --filter @happier-dev/bootstrap run test && pnpm --filter @happier-dev/plugin-sdk run test && pnpm --filter @happier-dev/plugin-ui run test && pnpm --filter @happier-dev/app run test && pnpm --filter @happier-dev/cli run test:unit && pnpm --dir apps/server run test:unit && pnpm --dir packages/relay-server run test && pnpm --dir apps/stack run test:unit',
        'test:plugin-workspaces': 'node --experimental-strip-types scripts/testing/runPluginWorkspaceTests.ts',
        'test:plugin-platform:source': 'pnpm --filter @happier-dev/tests run test:plugin-platform:source',
        'test:integration': 'pnpm --filter @happier-dev/app run test:integration && pnpm --filter @happier-dev/cli run test:integration && pnpm --dir apps/server run test:integration && pnpm --dir apps/stack run test:integration',
        'test:e2e:core:fast': 'pnpm --filter @happier-dev/tests run test:core:fast',
        'test:e2e:core:slow': 'pnpm --filter @happier-dev/tests run test:core:slow',
        'test:e2e:ui': 'pnpm --filter @happier-dev/tests run test:ui:e2e',
        'test:e2e:desktop:native': 'pnpm --filter @happier-dev/app run test:native-e2e:activity-surfaces',
        'test:workspace-sync:real': 'pnpm --filter @happier-dev/cli run test:workspace-sync:real',
        'test:e2e:mobile': 'pnpm --filter @happier-dev/tests run test:mobile:e2e:android',
        'test:agents': 'pnpm --filter @happier-dev/tests run test:agents',
        'test:stress': 'pnpm --filter @happier-dev/tests run test:stress',
        'test:db-contract:docker': 'pnpm run test:db-contract:postgres:docker && pnpm run test:db-contract:mysql:docker',
        'test:wiring:self': 'node --experimental-strip-types --test scripts/testing/lib/*.test.ts scripts/testing/validateTestWiring.test.ts scripts/testing/runPluginWorkspaceTests.test.ts',
        'test:wiring': 'node --import tsx ./scripts/testing/validateTestWiring.ts',
        'test:policy:self': 'node --import tsx --test scripts/testing/lib/*.test.ts scripts/testing/*.test.ts scripts/testing/migrations/lib/*.test.ts scripts/testing/migrations/runtimeUnification/validators/*.test.ts',
        'test:policy': 'node --import tsx ./scripts/testing/validateTestPolicy.ts',
        'test:inventory': 'node --import tsx ./scripts/testing/validateTestInventory.ts',
        'test:migration:inventory': 'node --import tsx ./scripts/testing/migrations/validateMigrationInventory.ts',
        'test:migration:v2-zero:enforce': 'node --experimental-strip-types ./scripts/testing/migrations/validateV2ZeroInventory.ts --enforce',
        'test:migration:bundled-plugin-projections': 'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode check --scope projections',
        'test:migration:governance': 'pnpm run test:migration:v2-zero:enforce && pnpm run test:migration:wire-compat && pnpm run test:migration:bundled-plugin-projections',
      },
    },
    null,
    2,
  );
}

function createWorkflowText(): string {
  return `
jobs:
  testing:
    steps:
      - run: pnpm --filter privacy-kit run test
      - run: pnpm --filter @happier-dev/protocol run test
      - run: pnpm --filter @happier-dev/peer-mediation run test
      - run: pnpm --filter @happier-dev/transfers run test
      - run: pnpm --filter @happier-dev/agents run test
      - run: pnpm --filter @happier-dev/cli-common run test
      - run: pnpm --filter @happier-dev/support run test
      - run: pnpm --filter @happier-dev/connection-supervisor run test
      - run: pnpm --filter @happier-dev/bootstrap run test
      - run: pnpm --filter @happier-dev/plugin-sdk run test
      - run: pnpm --filter @happier-dev/plugin-ui run test
      - run: pnpm run test:plugin-workspaces
      - run: pnpm --filter @happier-dev/tests run test:plugin-platform:source
      - run: pnpm --filter @happier-dev/app run test:unit
      - run: pnpm --filter @happier-dev/app run test:integration
      - run: pnpm --filter @happier-dev/cli run test:unit
      - run: pnpm --filter @happier-dev/cli run test:integration
      - run: pnpm --dir apps/server run test:unit
      - run: pnpm --dir apps/server run test:integration
      - run: pnpm --dir apps/server run test:server:db-contract
      - run: pnpm --dir packages/relay-server run test
      - run: pnpm --dir apps/stack run test:unit
      - run: pnpm --dir apps/stack run test:integration
      - run: pnpm run test:e2e:core:fast
      - run: pnpm run test:e2e:core:slow
      - run: pnpm --silent run test:e2e:ui
      - run: pnpm run test:workspace-sync:real
      - run: pnpm --silent run test:e2e:mobile
      - run: pnpm --filter @happier-dev/tests run providers:run all smoke
      - run: pnpm run test:stress
      - run: pnpm run test:wiring:self && pnpm run test:wiring && pnpm run test:policy
`;
}

function createDocsText(): string {
  return `
\`\`\`bash
pnpm run test
pnpm run test:plugin-workspaces
pnpm run test:plugin-platform:source
pnpm run test:integration
pnpm run test:e2e:core:fast
pnpm run test:e2e:core:slow
pnpm run test:e2e:ui
pnpm run test:e2e:desktop:native
pnpm run test:workspace-sync:real
pnpm run test:e2e:mobile
pnpm run test:agents
pnpm run test:stress
pnpm run test:db-contract:docker
pnpm run test:wiring:self
pnpm run test:wiring
pnpm run test:policy
pnpm run test:policy:self
pnpm run test:inventory
pnpm run test:migration:inventory
pnpm run test:migration:v2-zero:enforce
pnpm run test:migration:governance
\`\`\`
`;
}

function createFeatureGatingConfigTexts(): Record<string, string> {
  return {
    'apps/ui/vitest.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'apps/ui/vitest.integration.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'apps/cli/vitest.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs(process.env)]",
    'apps/cli/vitest.integration.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs(process.env)]",
    'apps/cli/vitest.slow.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs({ ...process.env })]",
    'apps/server/vitest.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'apps/server/vitest.integration.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'apps/server/vitest.dbcontract.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'packages/tests/vitest.core.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'packages/tests/vitest.core.fast.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'packages/tests/vitest.agents.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
    'packages/tests/vitest.stress.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
  };
}

test('accepts aligned package scripts, workflow commands, docs commands, and feature gating configs', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText(),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  assert.deepEqual(report.issues, []);
});

test('flags missing governance docs and feature gating drift', () => {
  const configTexts = createFeatureGatingConfigTexts();
  delete configTexts['apps/server/vitest.dbcontract.config.ts'];

  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText(),
    docsText: createDocsText().replace('pnpm run test:policy\n', ''),
    configTexts,
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Docs are missing command pnpm run test:policy/);
  assert.match(messages, /Feature gating is not verified for apps\/server\/vitest\.dbcontract\.config\.ts/);
});

test('keeps migration governance optional in routine CI and docs', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText(),
    docsText: createDocsText()
      .replace('pnpm run test:inventory\n', '')
      .replace('pnpm run test:migration:inventory\n', '')
      .replace('pnpm run test:migration:governance\n', ''),
    configTexts: createFeatureGatingConfigTexts(),
  });

  assert.deepEqual(report.issues, []);
});

test('flags shared package unit workflow drift when peer mediation coverage falls out of the root lane', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText().replace('      - run: pnpm --filter @happier-dev/peer-mediation run test\n', ''),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Workflow coverage is missing for test/);
});

test('recognizes the exact finite public SDK task as unit coverage for its three workspaces', () => {
  const workflowText = createWorkflowText()
    .replace('      - run: pnpm --filter @happier-dev/plugin-sdk run test\n', '')
    .replace('      - run: pnpm --filter @happier-dev/plugin-ui run test\n', '')
    .replace('      - run: pnpm run test:plugin-workspaces\n', '      - run: pnpm run check:public-sdk:finite\n      - run: pnpm run test:plugin-workspaces\n');
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText,
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });
  assert.doesNotMatch(report.issues.map((issue) => issue.message).join('\n'), /@happier-dev\/(?:plugin-sdk|plugin-ui|sdk) test script/u);
});

test('withholds finite public SDK credit from a workspace its turbo filter no longer covers', () => {
  const packageJsonText = createPackageJsonText().replace(
    '--filter=@happier-dev/plugin-sdk --filter=@happier-dev/plugin-ui --filter=@happier-dev/sdk',
    '--filter=@happier-dev/plugin-sdk --filter=@happier-dev/sdk',
  );
  const workflowText = createWorkflowText()
    .replace('      - run: pnpm --filter @happier-dev/plugin-sdk run test\n', '')
    .replace('      - run: pnpm --filter @happier-dev/plugin-ui run test\n', '')
    .replace('      - run: pnpm run test:plugin-workspaces\n', '      - run: pnpm run check:public-sdk:finite\n      - run: pnpm run test:plugin-workspaces\n');
  const report = collectWorkflowScriptParityReport({
    packageJsonText,
    workflowText,
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /no CI step runs the @happier-dev\/plugin-ui test script/u);
  assert.doesNotMatch(messages, /no CI step runs the @happier-dev\/plugin-sdk test script/u);
});

test('withholds finite public SDK credit when the command no longer runs the workspace test task', () => {
  const packageJsonText = createPackageJsonText().replace(
    'turbo run api:finite test:finite typecheck:finite',
    'turbo run api:finite typecheck:finite',
  );
  const workflowText = createWorkflowText()
    .replace('      - run: pnpm --filter @happier-dev/plugin-sdk run test\n', '')
    .replace('      - run: pnpm --filter @happier-dev/plugin-ui run test\n', '')
    .replace('      - run: pnpm run test:plugin-workspaces\n', '      - run: pnpm run check:public-sdk:finite\n      - run: pnpm run test:plugin-workspaces\n');
  const report = collectWorkflowScriptParityReport({
    packageJsonText,
    workflowText,
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /no CI step runs the @happier-dev\/plugin-sdk test script/u);
  assert.match(messages, /no CI step runs the @happier-dev\/plugin-ui test script/u);
});

test('requires the derived plugin workspace test runner in scripts, docs, and CI', () => {
  const packageJson = JSON.parse(createPackageJsonText());
  delete packageJson.scripts['test:plugin-workspaces'];

  const report = collectWorkflowScriptParityReport({
    packageJsonText: JSON.stringify(packageJson, null, 2),
    workflowText: createWorkflowText().replace('      - run: pnpm run test:plugin-workspaces\n', ''),
    docsText: createDocsText().replace('pnpm run test:plugin-workspaces\n', ''),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Missing root script test:plugin-workspaces/);
  assert.match(messages, /Docs are missing command pnpm run test:plugin-workspaces/);
  assert.match(messages, /Workflow coverage is missing for test:plugin-workspaces/);
});

test('flags root self-lane drift when migration lib self-tests fall out of test:policy:self', () => {
  const packageJson = JSON.parse(createPackageJsonText());
  packageJson.scripts['test:policy:self'] = 'node --import tsx --test scripts/testing/lib/*.test.ts scripts/testing/*.test.ts';

  const report = collectWorkflowScriptParityReport({
    packageJsonText: JSON.stringify(packageJson, null, 2),
    workflowText: createWorkflowText(),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Root script test:policy:self is missing required command body/);
  assert.ok(messages.includes('scripts\\/testing\\/migrations\\/lib\\/\\*\\.test\\.ts'));
  assert.ok(messages.includes('scripts\\/testing\\/migrations\\/runtimeUnification\\/validators\\/\\*\\.test\\.ts'));
});

test('flags unknown root commands mentioned in docs or workflow', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: `${createWorkflowText()}\n      - run: pnpm run test:not-real`,
    docsText: `${createDocsText()}\npnpm run test:imaginary`,
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Workflow references unknown root command pnpm run test:not-real/);
  assert.match(messages, /Docs reference unknown root command pnpm run test:imaginary/);
});

test('tracks required workflow coverage for the real workspace-sync lane', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText(),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.doesNotMatch(messages, /test:workspace-sync:real/);
});

test('requires the native desktop e2e root script and docs even though workflow coverage stays local-only', () => {
  const packageJson = JSON.parse(createPackageJsonText());
  delete packageJson.scripts['test:e2e:desktop:native'];

  const report = collectWorkflowScriptParityReport({
    packageJsonText: JSON.stringify(packageJson, null, 2),
    workflowText: createWorkflowText(),
    docsText: createDocsText().replace('pnpm run test:e2e:desktop:native\n', ''),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Missing root script test:e2e:desktop:native/);
  assert.match(messages, /Docs are missing command pnpm run test:e2e:desktop:native/);
  assert.doesNotMatch(messages, /Workflow coverage is missing for test:e2e:desktop:native/);
});

test('wires shared SDK packages into the default root validation lanes', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');
  const unitTargets = resolveRootScriptWorkspaceTargets(packageJson.scripts, 'test:unit');
  const typecheckCommandText = ROOT_TYPECHECK_COMMANDS.map((command) => command.args.join(' ')).join('\n');
  for (const name of ['voice-modelpacks', 'terminal-native', 'sherpa-native', 'support', 'peer-mediation', 'plugin-sdk', 'plugin-ui', 'channels-protocol']) {
    assert.ok(unitTargets.some((target) => target.packageName === `@happier-dev/${name}` && target.scriptName === 'test'), `${name} must run through the root unit owner`);
  }
  // The published Channels protocol package sat outside every ordinary lane while the lane-map
  // unit fixture asserted the opposite from a root command it wrote itself. These two assertions
  // read the real root script and the real workflow, so the fixture can no longer be friendlier
  // than the commands CI actually runs.
  assert.equal(packageJson.scripts['typecheck:inner'], 'node --experimental-strip-types scripts/testing/runTypecheck.ts');
  assert.match(typecheckCommandText, /turbo run typecheck:source:finite/);
  assert.match(typecheckCommandText, /--filter=@happier-dev\/terminal-native/);
  assert.match(
    packageJson.scripts?.['build:packages'] ?? '',
    /@happier-dev\/support/,
    'Support source compilation is reused as its typecheck evidence before the source-only Turbo lane',
  );
  assert.match(typecheckCommandText, /--filter=@happier-dev\/plugin-ui/);
  assert.match(workflowText, /pnpm run test:shared-packages --mode ci/);
  assert.match(workflowText, /pnpm run check:public-sdk:finite/);
  assert.doesNotMatch(workflowText, /pnpm --filter @happier-dev\/plugin-sdk run test/);
  assert.doesNotMatch(workflowText, /pnpm --filter @happier-dev\/plugin-ui run test/);
});

test('routes the root ordinary integration lane through the Stack executor', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.['test:integration'],
    'apps/stack/bin/hstack-exec --script=test:integration:local',
  );
  const targets = resolveRootScriptWorkspaceTargets(packageJson.scripts, 'test:integration');
  assert.ok(targets.some((target) => target.packageName === '@happier-dev/app' && target.scriptName === 'test:integration'));
  assert.ok(targets.some((target) => target.workspaceDirectory === 'apps/stack' && target.scriptName === 'test:integration'));
});

test('runs current-source Plugin Platform contracts without a release representation in CI', () => {
  const testsPackageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'packages/tests/package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');
  const sourceLane = testsPackageJson.scripts?.['test:plugin-platform:source'] ?? '';

  assert.match(sourceLane, /run-contract-tests\.mjs/);
  assert.match(sourceLane, /public-only\.test\.mjs/);
  assert.doesNotMatch(sourceLane, /pack-fixture|installedTarballProof|\.tgz|tarball/i);
  assert.match(workflowText, /pnpm --filter @happier-dev\/tests run test:plugin-platform:source/);
  assert.doesNotMatch(workflowText, /build:plugin-platform:natural|test:plugin-platform:packed-/);
});

test('runs plugin workspace unit tests only through the derived workspace runner', () => {
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');

  assert.match(workflowText, /^  plugin-workspaces-unit:\n/m);
  assert.match(workflowText, /run: pnpm run test:plugin-workspaces/);
  assert.doesNotMatch(workflowText, /pnpm --filter @happier-dev\/plugins-[a-z0-9-]+ run test/);
  assert.doesNotMatch(workflowText, /pnpm --filter @happier-dev\/plugins-[a-z0-9-]+ run typecheck/);
});

test('keeps plugin workspace typechecks reachable when plugin workspace tests fail', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');

  assert.equal(
    packageJson.scripts?.['typecheck:plugin-workspaces'],
    'apps/stack/bin/hstack-exec --script=typecheck:plugin-workspaces:local',
  );
  assert.equal(
    packageJson.scripts?.['typecheck:plugin-workspaces:local'],
    'node --experimental-strip-types scripts/testing/runPluginWorkspaceTests.ts typecheck',
  );
  assert.match(
    workflowText,
    /- name: Run every plugin workspace test\n        run: pnpm run test:plugin-workspaces\n\n      - name: Run every plugin workspace typecheck\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: pnpm run typecheck:plugin-workspaces/,
  );
});

test('keeps the repository typecheck reachable when the governance validators fail', () => {
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');
  const typecheckJob = workflowText.slice(workflowText.indexOf('\n  typecheck:\n'));
  const guardedTypecheckStep = /- name: Run typecheck\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: pnpm run typecheck/;

  // The wiring/policy validators must not be able to swallow the
  // typecheck evidence: a red governance gate has to leave the typecheck result visible.
  assert.match(typecheckJob, /- name: Run governance validators\n        if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(typecheckJob, guardedTypecheckStep);
  assert.doesNotMatch(
    typecheckJob.replace(guardedTypecheckStep, '- name: Run typecheck\n        run: pnpm run typecheck'),
    guardedTypecheckStep,
  );
});

test('keeps targeted reusable CI callers from inheriting plugin workspace coverage', () => {
  const targetedWorkflowPaths = [
    '.github/workflows/providers-contracts.yml',
    '.github/workflows/release-verify.yml',
    '.github/workflows/release-source-validation.yml',
    '.github/workflows/self-host-e2e.yml',
    '.github/workflows/stress-tests.yml',
  ];

  for (const workflowPath of targetedWorkflowPaths) {
    const workflowText = readFileSync(join(ROOT_DIR, workflowPath), 'utf8');
    assert.match(
      workflowText,
      /uses: \.\/\.github\/workflows\/tests\.yml[\s\S]*?with:[\s\S]*?run_shared_packages: false[\s\S]*?run_plugin_workspaces: false/,
      workflowPath,
    );
  }

  const manualDispatchText = readFileSync(join(ROOT_DIR, '.github/workflows/tests-dispatch.yml'), 'utf8');
  assert.match(
    manualDispatchText,
    /run_plugin_workspaces: \$\{\{ needs\.resolve\.outputs\.run_plugin_workspaces == 'true' \}\}/,
  );
});

test('keeps the plugin workspace runner contract in the wiring self-test lane', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };

  assert.match(
    packageJson.scripts?.['test:wiring:self'] ?? '',
    /scripts\/testing\/runPluginWorkspaceTests\.test\.ts/,
  );
});

test('keeps the shared-package aggregate runner contract in the wiring self-test lane', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };

  assert.match(
    packageJson.scripts?.['test:wiring:self'] ?? '',
    /scripts\/testing\/runSharedPackageTests\.test\.ts/,
  );
});
