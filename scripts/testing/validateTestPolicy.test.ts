import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectPolicyReport, resolvePolicyExitCode, runTestPolicy } from './validateTestPolicy.ts';

test('advisory CLI output is opt-in without changing the policy verdict', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-policy-output-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(join(rootDir, 'apps/ui/sources'), { recursive: true });
  writeFileSync(join(rootDir, 'apps/ui/sources/advisory.test.ts'), "it.skip('pending', () => {});\n");
  const command = fileURLToPath(new URL('./validateTestPolicy.ts', import.meta.url));
  const results = [[], ['--report-only']].map((args) => spawnSync(
    process.execPath, ['--experimental-strip-types', command, ...args],
    { cwd: rootDir, encoding: 'utf8' },
  ));
  for (const result of results) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.doesNotMatch(results[0]!.stdout, /advisory\.test\.ts/);
  assert.match(results[1]!.stdout, /advisory\.test\.ts/);
});

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

test('test:policy fails when an extension violates import boundaries', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-test-policy-extension-import-boundary-'));
  mkdirSync(join(rootDir, 'packages/plugins/acme/src'), { recursive: true });
  writeFileSync(
    join(rootDir, 'packages/plugins/acme/src/index.ts'),
    "import { something } from '@/api/types';\nexport const ok = true;\n",
    'utf8',
  );

  const report = await runTestPolicy({ rootDir });
  assert.equal(report.extensionImportBoundaries.ok, false);
  assert.equal(report.exitCode, 1);
 });
