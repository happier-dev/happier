import assert from 'node:assert/strict';
import test from 'node:test';

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
