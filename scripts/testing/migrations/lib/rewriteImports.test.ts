import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyRewritePlan,
  planImportRewrites,
  planImportRewritesForFilePaths,
} from './rewriteImports.ts';

test('planImportRewrites rewrites exact import specifiers and is idempotent', () => {
  const plan = planImportRewrites(
    [
      {
        filePath: 'apps/ui/sources/example.test.tsx',
        content: "import { testUiMocks } from '@/dev/testkit/testUiMocks';",
      },
    ],
    [
      {
        id: 'rewrite-test-ui-mocks',
        from: '@/dev/testkit/testUiMocks',
        to: '@/sources/dev/testkit/createUiTestHarness',
      },
    ],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]?.after, "import { testUiMocks } from '@/sources/dev/testkit/createUiTestHarness';");

  const secondPass = planImportRewrites(
    [
      {
        filePath: plan.edits[0]!.filePath,
        content: plan.edits[0]!.after,
      },
    ],
    [
      {
        id: 'rewrite-test-ui-mocks',
        from: '@/dev/testkit/testUiMocks',
        to: '@/sources/dev/testkit/createUiTestHarness',
      },
    ],
  );

  assert.equal(secondPass.edits.length, 0);
});

test('planImportRewrites rewrites only import statements and respects namedImportMap', () => {
  const before = [
    "import { oldThing, keepThing, oldAliased as localAlias } from '@/legacy/module';",
    "export { oldThing as exportedThing } from '@/legacy/module';",
    "const diagnostic = '@/legacy/module';",
  ].join('\n');

  const plan = planImportRewrites(
    [
      {
        filePath: 'apps/cli/src/example.ts',
        content: before,
      },
    ],
    [
      {
        id: 'rewrite-legacy-module',
        from: '@/legacy/module',
        to: '@/new/module',
        namedImportMap: {
          oldThing: 'newThing',
          oldAliased: 'newAliased',
        },
      },
    ],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(
    plan.edits[0]?.after,
    [
      "import { newThing, keepThing, newAliased as localAlias } from '@/new/module';",
      "export { newThing as exportedThing } from '@/new/module';",
      "const diagnostic = '@/legacy/module';",
    ].join('\n'),
  );
});

test('planImportRewritesForFilePaths only rewrites targeted files', () => {
  const plan = planImportRewritesForFilePaths(
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';",
      },
      {
        filePath: 'apps/ui/sources/example.tsx',
        content: "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';",
      },
    ],
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/extensions/registry/createResolvedContributionRegistry',
        to: '@/extensions/registry/createResolvedContributionRegistryV2',
      },
    ],
    ['apps/cli/src/backends/catalog.ts'],
  );

  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
  assert.equal(
    plan.edits[0]?.after,
    "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistryV2';",
  );
});

test('applyRewritePlan writes planned edits to disk and refuses mismatched content', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-rewrite-plan-'));
  const targetPath = join(rootDir, 'apps/cli/src/backends/catalog.ts');
  const untouchedPath = join(rootDir, 'apps/ui/sources/example.tsx');
  mkdirSync(dirname(targetPath), { recursive: true });
  mkdirSync(dirname(untouchedPath), { recursive: true });
  writeFileSync(targetPath, "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';", 'utf8');
  writeFileSync(untouchedPath, "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';", 'utf8');

  const plan = planImportRewritesForFilePaths(
    [
      {
        filePath: 'apps/cli/src/backends/catalog.ts',
        content: "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';",
      },
      {
        filePath: 'apps/ui/sources/example.tsx',
        content: "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';",
      },
    ],
    [
      {
        id: 'rewrite-resolved-contribution-registry',
        from: '@/extensions/registry/createResolvedContributionRegistry',
        to: '@/extensions/registry/createResolvedContributionRegistryV2',
      },
    ],
    ['apps/cli/src/backends/catalog.ts'],
  );

  const result = applyRewritePlan(rootDir, plan);

  assert.equal(result.appliedEdits.length, 1);
  assert.equal(result.appliedEdits[0]?.filePath, 'apps/cli/src/backends/catalog.ts');
  assert.equal(
    readFileSync(targetPath, 'utf8'),
    "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistryV2';",
  );
  assert.equal(readFileSync(untouchedPath, 'utf8'), "import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';");

  const mismatched = applyRewritePlan(rootDir, plan);
  assert.equal(mismatched.appliedEdits.length, 0);
  assert.equal(mismatched.skippedEdits.length, 1);
  assert.equal(mismatched.skippedEdits[0]?.reason, 'content-mismatch');
});
