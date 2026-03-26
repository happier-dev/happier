import assert from 'node:assert/strict';
import test from 'node:test';

import { collectWorkflowScriptParityReport } from './workflowScriptParity.ts';

function createPackageJsonText(): string {
  return JSON.stringify(
    {
      scripts: {
        test: 'yarn -s test:unit',
        'test:unit': 'yarn workspace @happier-dev/protocol test && yarn workspace @happier-dev/transfers test && yarn workspace @happier-dev/agents test && yarn workspace @happier-dev/cli-common test && yarn workspace @happier-dev/connection-supervisor test && yarn workspace @happier-dev/app test && yarn workspace @happier-dev/cli test:unit && yarn --cwd apps/server test:unit && yarn --cwd packages/relay-server test && yarn --cwd apps/stack test:unit',
        'test:integration': 'yarn workspace @happier-dev/app test:integration && yarn workspace @happier-dev/cli test:integration && yarn --cwd apps/server test:integration && yarn --cwd apps/stack test:integration',
        'test:e2e:core:fast': 'yarn workspace @happier-dev/tests test:core:fast',
        'test:e2e:core:slow': 'yarn workspace @happier-dev/tests test:core:slow',
        'test:e2e:ui': 'yarn workspace @happier-dev/tests test:ui:e2e',
        'test:e2e:mobile': 'yarn workspace @happier-dev/tests test:mobile:e2e:android',
        'test:providers': 'yarn workspace @happier-dev/tests test:providers',
        'test:stress': 'yarn workspace @happier-dev/tests test:stress',
        'test:db-contract:docker': 'yarn -s test:db-contract:postgres:docker && yarn -s test:db-contract:mysql:docker',
        'test:wiring:self': 'node --import tsx --test scripts/testing/lib/*.test.ts scripts/testing/*.test.ts',
        'test:wiring': 'node --import tsx ./scripts/testing/validateTestWiring.ts',
        'test:policy:self': 'node --import tsx --test scripts/testing/lib/*.test.ts scripts/testing/*.test.ts scripts/testing/migrations/lib/*.test.ts',
        'test:policy': 'node --import tsx ./scripts/testing/validateTestPolicy.ts',
        'test:inventory': 'node --import tsx ./scripts/testing/validateTestInventory.ts',
        'test:migration:inventory': 'node --import tsx ./scripts/testing/migrations/validateMigrationInventory.ts',
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
      - run: yarn workspace @happier-dev/protocol test
      - run: yarn workspace @happier-dev/transfers test
      - run: yarn workspace @happier-dev/agents test
      - run: yarn workspace @happier-dev/cli-common test
      - run: yarn workspace @happier-dev/connection-supervisor test
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
      - run: yarn -s test:e2e:mobile
      - run: yarn workspace @happier-dev/tests providers:run all smoke
      - run: yarn test:stress
      - run: yarn test:wiring:self && yarn test:wiring && yarn test:policy && yarn test:inventory && yarn test:migration:inventory
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
yarn test:e2e:mobile
yarn test:providers
yarn test:stress
yarn test:db-contract:docker
yarn test:wiring:self
yarn test:wiring
yarn test:policy
yarn test:policy:self
yarn test:inventory
yarn test:migration:inventory
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
    'packages/tests/vitest.providers.config.ts': "import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';\nexclude: [...resolveVitestFeatureTestExcludeGlobs()]",
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
