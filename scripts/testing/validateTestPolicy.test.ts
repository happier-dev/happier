import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectFileInventory } from './migrations/lib/collectFileInventory.ts';
import { containsRawNulByte } from './lib/testPolicySurface.ts';
import { collectPolicyReport, resolvePolicyExitCode } from './validateTestPolicy.ts';

test('resolvePolicyExitCode ignores report-only findings', () => {
  const report = collectPolicyReport([
    {
      filePath: 'apps/ui/sources/example.test.tsx',
      content: "import { testUiMocks } from '@/dev/testkit/testUiMocks';",
    },
  ]);

  assert.equal(report.enforcedFindings.length, 0);
  assert.equal(report.reportOnlyFindings.length, 1);
  assert.equal(resolvePolicyExitCode(report), 0);
});

test('resolvePolicyExitCode fails when enforced findings exist', () => {
  const report = collectPolicyReport([
    {
      filePath: 'apps/ui/sources/example.test.tsx',
      content: "it.only('focus', () => {});",
    },
  ]);

  assert.equal(report.enforcedFindings.length, 1);
  assert.equal(resolvePolicyExitCode(report), 1);
});

test('resolvePolicyExitCode still ignores report-only UI inline mock findings', () => {
  const report = collectPolicyReport([
    {
      filePath: 'apps/ui/sources/example.test.tsx',
      content: `
        vi.mock('@/modal', async () => {
          const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
          return createModalModuleMock().module;
        });
      `,
    },
  ]);

  assert.equal(report.enforcedFindings.length, 0);
  assert.equal(report.reportOnlyFindings.length, 1);
  assert.equal(resolvePolicyExitCode(report), 0);
});

// This one rule is asserted against the REAL tree, not a fixture, and it lives in the
// `test:policy:self` lane rather than `test:policy`. Reason: `test:policy` aggregates every
// enforced rule and is currently red at HEAD for unrelated pre-existing findings, so a rule
// added there alone produces no new signal. The rule owner stays `collectPolicyFindings` --
// this only executes it over the actual repository so a raw NUL byte cannot land unnoticed.
test('no source file in the repository contains a raw NUL byte', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const offenders = collectFileInventory({ rootDir: repoRoot, include: /\.[cm]?[jt]sx?$/ })
    .filter((file) => containsRawNulByte(file.content))
    .map((file) => file.filePath);

  assert.deepEqual(
    offenders,
    [],
    'A raw NUL byte makes Git treat these files as binary, after which recursive rg/grep skip '
    + `them silently. Replace the byte with the \\u0000 escape in:\n  ${offenders.join('\n  ')}`,
  );
});
