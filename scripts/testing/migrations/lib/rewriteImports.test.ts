import assert from 'node:assert/strict';
import test from 'node:test';

import { planImportRewrites } from './rewriteImports.ts';

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
