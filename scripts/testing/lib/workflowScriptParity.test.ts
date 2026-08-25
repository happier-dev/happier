import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectWorkflowScriptParityReport } from './workflowScriptParity.ts';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function createPackageJsonText(): string {
  return JSON.stringify(
    {
      scripts: {
        test: 'yarn -s test:unit',
        'check:public-sdk:finite': 'apps/stack/bin/hstack-exec --script=check:public-sdk:finite:local',
        'check:public-sdk:finite:local': 'turbo run api:finite test:finite typecheck:finite --filter=@happier-dev/plugin-sdk --filter=@happier-dev/plugin-ui --filter=@happier-dev/sdk',
        'test:unit': 'yarn workspace privacy-kit test && yarn workspace @happier-dev/protocol test && yarn workspace @happier-dev/peer-mediation test && yarn workspace @happier-dev/transfers test && yarn workspace @happier-dev/agents test && yarn workspace @happier-dev/cli-common test && yarn workspace @happier-dev/support test && yarn workspace @happier-dev/connection-supervisor test && yarn workspace @happier-dev/bootstrap test && yarn workspace @happier-dev/plugin-sdk test && yarn workspace @happier-dev/plugin-ui test && yarn workspace @happier-dev/app test && yarn workspace @happier-dev/cli test:unit && yarn --cwd apps/server test:unit && yarn --cwd packages/relay-server test && yarn --cwd apps/stack test:unit',
        'test:plugin-workspaces': 'node --experimental-strip-types scripts/testing/runPluginWorkspaceTests.ts',
        'test:plugin-platform:contracts': 'yarn workspace @happier-dev/tests test:plugin-platform:contracts',
        'test:integration': 'yarn workspace @happier-dev/app test:integration && yarn workspace @happier-dev/cli test:integration && yarn --cwd apps/server test:integration && yarn --cwd apps/stack test:integration',
        'test:e2e:core:fast': 'yarn workspace @happier-dev/tests test:core:fast',
        'test:e2e:core:slow': 'yarn workspace @happier-dev/tests test:core:slow',
        'test:e2e:ui': 'yarn workspace @happier-dev/tests test:ui:e2e',
        'test:e2e:desktop:native': 'yarn workspace @happier-dev/app test:native-e2e:activity-surfaces',
        'test:e2e:ui:wsrepl:lima': 'yarn workspace @happier-dev/tests test:ui:e2e:wsrepl:lima',
        'test:e2e:ui:wsrepl:lima:self': 'yarn workspace @happier-dev/tests test:ui:e2e:wsrepl:lima:self',
        'test:e2e:mobile': 'yarn workspace @happier-dev/tests test:mobile:e2e:android',
        'test:agents': 'yarn workspace @happier-dev/tests test:agents',
        'test:stress': 'yarn workspace @happier-dev/tests test:stress',
        'test:db-contract:docker': 'yarn -s test:db-contract:postgres:docker && yarn -s test:db-contract:mysql:docker',
        'test:wiring:self': 'node --experimental-strip-types --test scripts/testing/lib/*.test.ts scripts/testing/validateTestWiring.test.ts scripts/testing/runPluginWorkspaceTests.test.ts',
        'test:wiring': 'node --import tsx ./scripts/testing/validateTestWiring.ts',
        'test:policy:self': 'node --import tsx --test scripts/testing/lib/*.test.ts scripts/testing/*.test.ts scripts/testing/migrations/lib/*.test.ts scripts/testing/migrations/runtimeUnification/validators/*.test.ts',
        'test:policy': 'node --import tsx ./scripts/testing/validateTestPolicy.ts',
        'test:inventory': 'node --import tsx ./scripts/testing/validateTestInventory.ts',
        'test:migration:inventory': 'node --import tsx ./scripts/testing/migrations/validateMigrationInventory.ts',
        'test:migration:v2-zero:enforce': 'node --experimental-strip-types ./scripts/testing/migrations/validateV2ZeroInventory.ts --enforce',
        'test:migration:bundled-plugin-projections': 'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode check --scope projections',
        'test:migration:bundled-plugin-runtime-determinism': 'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode check --scope all',
        'test:migration:governance': 'yarn -s test:migration:v2-zero:enforce && yarn -s test:migration:wire-compat && yarn -s test:migration:bundled-plugin-projections && yarn -s test:migration:bundled-plugin-runtime-determinism',
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
      - run: yarn workspace privacy-kit test
      - run: yarn workspace @happier-dev/protocol test
      - run: yarn workspace @happier-dev/peer-mediation test
      - run: yarn workspace @happier-dev/transfers test
      - run: yarn workspace @happier-dev/agents test
      - run: yarn workspace @happier-dev/cli-common test
      - run: yarn workspace @happier-dev/support test
      - run: yarn workspace @happier-dev/connection-supervisor test
      - run: yarn workspace @happier-dev/bootstrap test
      - run: yarn workspace @happier-dev/plugin-sdk test
      - run: yarn workspace @happier-dev/plugin-ui test
      - run: yarn test:plugin-workspaces
      - run: yarn test:plugin-platform:contracts
      - run: yarn workspace @happier-dev/app test:unit
      - run: yarn workspace @happier-dev/app test:integration
      - run: yarn workspace @happier-dev/cli test:unit
      - run: yarn workspace @happier-dev/cli test:integration
      - run: yarn --cwd apps/server test:unit
      - run: yarn --cwd apps/server test:integration
      - run: yarn --cwd apps/server test:server:db-contract
      - run: yarn --cwd packages/relay-server test
      - run: yarn --cwd apps/stack test:unit
      - run: yarn --cwd apps/stack test:integration
      - run: yarn test:e2e:core:fast
      - run: yarn test:e2e:core:slow
      - run: yarn -s test:e2e:ui
      - run: yarn -s test:e2e:ui:wsrepl:lima
      - run: yarn -s test:e2e:mobile
      - run: yarn workspace @happier-dev/tests providers:run all smoke
      - run: yarn test:stress
      - run: yarn test:wiring:self && yarn test:wiring && yarn test:policy && yarn test:inventory && yarn test:migration:inventory && yarn test:migration:governance
`;
}

function createDocsText(): string {
  return `
\`\`\`bash
yarn test
yarn test:plugin-workspaces
yarn test:plugin-platform:contracts
yarn test:integration
yarn test:e2e:core:fast
yarn test:e2e:core:slow
yarn test:e2e:ui
yarn test:e2e:desktop:native
yarn test:e2e:ui:wsrepl:lima
yarn test:e2e:ui:wsrepl:lima:self
yarn test:e2e:mobile
yarn test:agents
yarn test:stress
yarn test:db-contract:docker
yarn test:wiring:self
yarn test:wiring
yarn test:policy
yarn test:policy:self
yarn test:inventory
yarn test:migration:inventory
yarn test:migration:v2-zero:enforce
yarn test:migration:governance
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

  assert.equal(report.issues.length, 0);
});

test('flags missing governance docs and feature gating drift', () => {
  const configTexts = createFeatureGatingConfigTexts();
  delete configTexts['apps/server/vitest.dbcontract.config.ts'];

  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText(),
    docsText: createDocsText().replace('yarn test:policy\n', ''),
    configTexts,
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Docs are missing command yarn test:policy/);
  assert.match(messages, /Feature gating is not verified for apps\/server\/vitest\.dbcontract\.config\.ts/);
});

test('flags missing migration governance parity in docs and workflow', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText().replace(' && yarn test:migration:governance', ''),
    docsText: createDocsText()
      .replace('yarn test:migration:v2-zero:enforce\n', '')
      .replace('yarn test:migration:governance\n', ''),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Docs are missing command yarn test:migration:v2-zero:enforce/);
  assert.match(messages, /Docs are missing command yarn test:migration:governance/);
  assert.match(messages, /Workflow coverage is missing for test:migration:governance/);
});

test('flags shared package unit workflow drift when peer mediation coverage falls out of the root lane', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText().replace('      - run: yarn workspace @happier-dev/peer-mediation test\n', ''),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Workflow coverage is missing for test/);
});

test('recognizes the exact finite public SDK task as unit coverage for its three workspaces', () => {
  const workflowText = createWorkflowText()
    .replace('      - run: yarn workspace @happier-dev/plugin-sdk test\n', '')
    .replace('      - run: yarn workspace @happier-dev/plugin-ui test\n', '')
    .replace('      - run: yarn test:plugin-workspaces\n', '      - run: yarn -s check:public-sdk:finite\n      - run: yarn test:plugin-workspaces\n');
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
    .replace('      - run: yarn workspace @happier-dev/plugin-sdk test\n', '')
    .replace('      - run: yarn workspace @happier-dev/plugin-ui test\n', '')
    .replace('      - run: yarn test:plugin-workspaces\n', '      - run: yarn -s check:public-sdk:finite\n      - run: yarn test:plugin-workspaces\n');
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
    .replace('      - run: yarn workspace @happier-dev/plugin-sdk test\n', '')
    .replace('      - run: yarn workspace @happier-dev/plugin-ui test\n', '')
    .replace('      - run: yarn test:plugin-workspaces\n', '      - run: yarn -s check:public-sdk:finite\n      - run: yarn test:plugin-workspaces\n');
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
    workflowText: createWorkflowText().replace('      - run: yarn test:plugin-workspaces\n', ''),
    docsText: createDocsText().replace('yarn test:plugin-workspaces\n', ''),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Missing root script test:plugin-workspaces/);
  assert.match(messages, /Docs are missing command yarn test:plugin-workspaces/);
  assert.match(messages, /Workflow coverage is missing for test:plugin-workspaces/);
});

test('flags governed root script body drift when migration governance no longer runs the owned validator chain', () => {
  const packageJson = JSON.parse(createPackageJsonText());
  packageJson.scripts['test:migration:governance'] = 'yarn -s test:migration:wire-compat';

  const report = collectWorkflowScriptParityReport({
    packageJsonText: JSON.stringify(packageJson, null, 2),
    workflowText: createWorkflowText(),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Root script test:migration:governance is missing required command body/);
  assert.match(messages, /test:migration:v2-zero:enforce/);
  assert.match(messages, /test:migration:bundled-plugin-projections/);
  assert.match(messages, /test:migration:bundled-plugin-runtime-determinism/);
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
    workflowText: `${createWorkflowText()}\n      - run: yarn test:not-real`,
    docsText: `${createDocsText()}\nyarn test:imaginary`,
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Workflow references unknown root command yarn test:not-real/);
  assert.match(messages, /Docs reference unknown root command yarn test:imaginary/);
});

test('tracks optional workflow coverage for the WSREPL Lima UI lane', () => {
  const report = collectWorkflowScriptParityReport({
    packageJsonText: createPackageJsonText(),
    workflowText: createWorkflowText(),
    docsText: createDocsText(),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.doesNotMatch(messages, /test:e2e:ui:wsrepl:lima/);
});

test('requires the native desktop e2e root script and docs even though workflow coverage stays local-only', () => {
  const packageJson = JSON.parse(createPackageJsonText());
  delete packageJson.scripts['test:e2e:desktop:native'];

  const report = collectWorkflowScriptParityReport({
    packageJsonText: JSON.stringify(packageJson, null, 2),
    workflowText: createWorkflowText(),
    docsText: createDocsText().replace('yarn test:e2e:desktop:native\n', ''),
    configTexts: createFeatureGatingConfigTexts(),
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Missing root script test:e2e:desktop:native/);
  assert.match(messages, /Docs are missing command yarn test:e2e:desktop:native/);
  assert.doesNotMatch(messages, /Workflow coverage is missing for test:e2e:desktop:native/);
});

test('wires shared SDK packages into the default root validation lanes', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');
  const unitLane = packageJson.scripts?.['test:unit:local'] ?? '';

  assert.match(unitLane, /yarn workspace @happier-dev\/voice-modelpacks test/);
  assert.match(unitLane, /yarn workspace @happier-dev\/terminal-native test/);
  assert.match(unitLane, /yarn workspace @happier-dev\/sherpa-native test/);
  assert.match(unitLane, /yarn workspace @happier-dev\/support test/);
  assert.match(unitLane, /yarn workspace @happier-dev\/peer-mediation test/);
  assert.match(unitLane, /yarn workspace @happier-dev\/plugin-sdk test/);
  assert.match(unitLane, /yarn workspace @happier-dev\/plugin-ui test/);
  // The published Channels protocol package sat outside every ordinary lane while the lane-map
  // unit fixture asserted the opposite from a root command it wrote itself. These two assertions
  // read the real root script and the real workflow, so the fixture can no longer be friendlier
  // than the commands CI actually runs.
  assert.match(unitLane, /yarn workspace @happier-dev\/channels-protocol test/);
  assert.match(packageJson.scripts?.['typecheck:inner'] ?? '', /turbo run typecheck:source:finite/);
  assert.match(packageJson.scripts?.['typecheck:inner'] ?? '', /--filter=@happier-dev\/terminal-native/);
  assert.match(
    packageJson.scripts?.['build:packages'] ?? '',
    /@happier-dev\/support/,
    'Support source compilation is reused as its typecheck evidence before the source-only Turbo lane',
  );
  assert.match(packageJson.scripts?.['typecheck:inner'] ?? '', /--filter=@happier-dev\/plugin-ui/);
  assert.match(workflowText, /yarn workspace @happier-dev\/voice-modelpacks test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/terminal-native test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/sherpa-native test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/support test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/peer-mediation test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/channels-protocol test/);
  assert.match(workflowText, /yarn -s check:public-sdk:finite/);
  assert.doesNotMatch(workflowText, /yarn workspace @happier-dev\/plugin-sdk test/);
  assert.doesNotMatch(workflowText, /yarn workspace @happier-dev\/plugin-ui test/);
});

test('routes the root ordinary integration lane through the Stack executor', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };

  assert.equal(
    packageJson.scripts?.['test:integration'],
    'apps/stack/bin/hstack-exec --script=test:integration:local',
  );
  assert.match(
    packageJson.scripts?.['test:integration:local'] ?? '',
    /yarn workspace @happier-dev\/app test:integration/,
  );
  assert.match(
    packageJson.scripts?.['test:integration:local'] ?? '',
    /yarn --cwd apps\/stack test:integration/,
  );
});

test('runs every direct natural-artifact packed Plugin Platform script from CI', () => {
  const testsPackageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'packages/tests/package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');
  const directNaturalArtifactScripts = [
    'test:plugin-platform:packed-author',
    'test:plugin-platform:packed-targeted-projection',
    'test:plugin-platform:packed-background-indexer',
    'test:plugin-platform:packed-composer',
    'test:plugin-platform:out-of-tree-channel-socket-provider',
  ];

  for (const scriptName of directNaturalArtifactScripts) {
    assert.ok(testsPackageJson.scripts?.[scriptName], `${scriptName} must remain executable.`);
    assert.match(workflowText, new RegExp(`workspace @happier-dev/tests ${scriptName}`));
  }
  assert.match(workflowText, /build:plugin-platform:natural/);
  const invokedPluginPlatformScripts = [...new Set(Array.from(
    workflowText.matchAll(/workspace @happier-dev\/tests (test:plugin-platform:[a-z0-9:-]+)/g),
    (match) => match[1],
  ))].sort();
  assert.deepEqual(invokedPluginPlatformScripts, [...directNaturalArtifactScripts].sort());
  assert.match(workflowText, /run_vertical\(\) \{[\s\S]*pids\+=\("\$!"\)/);
});

test('runs plugin workspace unit tests only through the derived workspace runner', () => {
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');

  assert.match(workflowText, /^  plugin-workspaces-unit:\n/m);
  assert.match(workflowText, /run: yarn test:plugin-workspaces/);
  assert.doesNotMatch(workflowText, /yarn workspace @happier-dev\/plugins-[a-z0-9-]+ test/);
  assert.doesNotMatch(workflowText, /yarn workspace @happier-dev\/plugins-[a-z0-9-]+ typecheck/);
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
    /- name: Run every plugin workspace test\n        run: yarn test:plugin-workspaces\n\n      - name: Run every plugin workspace typecheck\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: yarn typecheck:plugin-workspaces/,
  );
});

test('keeps the repository typecheck reachable when the governance validators fail', () => {
  const workflowText = readFileSync(join(ROOT_DIR, '.github/workflows/tests.yml'), 'utf8');
  const typecheckJob = workflowText.slice(workflowText.indexOf('\n  typecheck:\n'));
  const guardedTypecheckStep = /- name: Run typecheck\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: yarn typecheck/;

  // The wiring/policy validators and the inventory reports must not be able to swallow the
  // typecheck evidence: a red governance gate has to leave the typecheck result visible.
  assert.match(typecheckJob, /- name: Run governance validators\n        if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(typecheckJob, /- name: Run governance inventory reports\n        if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(typecheckJob, guardedTypecheckStep);
  assert.doesNotMatch(
    typecheckJob.replace(guardedTypecheckStep, '- name: Run typecheck\n        run: yarn typecheck'),
    guardedTypecheckStep,
  );
});

test('keeps targeted reusable CI callers from inheriting plugin workspace coverage', () => {
  const targetedWorkflowPaths = [
    '.github/workflows/providers-contracts.yml',
    '.github/workflows/release-verify.yml',
    '.github/workflows/release.yml',
    '.github/workflows/self-host-e2e.yml',
    '.github/workflows/stress-tests.yml',
  ];

  for (const workflowPath of targetedWorkflowPaths) {
    const workflowText = readFileSync(join(ROOT_DIR, workflowPath), 'utf8');
    assert.match(
      workflowText,
      /uses: \.\/\.github\/workflows\/tests\.yml[\s\S]*?with:[\s\S]*?run_plugin_workspaces: false/,
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
