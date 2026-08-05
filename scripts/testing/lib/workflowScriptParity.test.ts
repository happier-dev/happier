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
        'test:unit': 'yarn workspace privacy-kit test && yarn workspace @happier-dev/protocol test && yarn workspace @happier-dev/peer-mediation test && yarn workspace @happier-dev/transfers test && yarn workspace @happier-dev/agents test && yarn workspace @happier-dev/cli-common test && yarn workspace @happier-dev/support test && yarn workspace @happier-dev/connection-supervisor test && yarn workspace @happier-dev/bootstrap test && yarn workspace @happier-dev/plugin-sdk test && yarn workspace @happier-dev/plugin-ui test && yarn workspace @happier-dev/app test && yarn workspace @happier-dev/cli test:unit && yarn --cwd apps/server test:unit && yarn --cwd packages/relay-server test && yarn --cwd apps/stack test:unit',
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
        'test:wiring:self': 'node --experimental-strip-types --test scripts/testing/lib/*.test.ts scripts/testing/validateTestWiring.test.ts',
        'test:wiring': 'node --import tsx ./scripts/testing/validateTestWiring.ts',
        'test:policy:self': 'node --import tsx --test scripts/testing/lib/*.test.ts scripts/testing/*.test.ts scripts/testing/migrations/lib/*.test.ts scripts/testing/migrations/runtimeUnification/validators/*.test.ts',
        'test:policy': 'node --import tsx ./scripts/testing/validateTestPolicy.ts',
        'test:inventory': 'node --import tsx ./scripts/testing/validateTestInventory.ts',
        'test:migration:inventory': 'node --import tsx ./scripts/testing/migrations/validateMigrationInventory.ts',
        'test:migration:v2-zero:enforce': 'node --experimental-strip-types ./scripts/testing/migrations/validateV2ZeroInventory.ts --enforce',
        'test:migration:bundled-plugin-projections': 'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode check',
        'test:migration:governance': 'yarn -s test:migration:v2-zero:enforce && yarn -s test:migration:wire-compat && yarn -s test:migration:bundled-plugin-projections',
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

  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/voice-modelpacks test/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/terminal-native test/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/sherpa-native test/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/support test/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/peer-mediation test/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/plugin-sdk test/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /yarn workspace @happier-dev\/plugin-ui test/);
  assert.match(packageJson.scripts?.['typecheck:inner'] ?? '', /yarn workspace @happier-dev\/terminal-native typecheck/);
  assert.match(packageJson.scripts?.['typecheck:inner'] ?? '', /yarn workspace @happier-dev\/support typecheck/);
  assert.match(packageJson.scripts?.['typecheck:inner'] ?? '', /yarn workspace @happier-dev\/plugin-ui typecheck/);
  assert.match(workflowText, /yarn workspace @happier-dev\/voice-modelpacks test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/terminal-native test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/sherpa-native test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/support test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/peer-mediation test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/plugin-sdk test/);
  assert.match(workflowText, /yarn workspace @happier-dev\/plugin-ui test/);
});
