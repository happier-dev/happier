import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('the CI UI Playwright config reports retry-passes in the job summary', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'playwright-ci-summary-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const summary = join(fixture, 'step-summary');
  await writeFile(summary, '# Existing CI summary\n');
  const baseConfig = new URL('../../packages/tests/playwright.ui.config.mjs', import.meta.url).href;
  await writeFile(join(fixture, 'playwright.config.mjs'), `
import base from ${JSON.stringify(baseConfig)};
export default {
  ...base,
  testDir: '.',
  globalSetup: undefined,
  outputDir: 'test-results',
  reporter: base.reporter.map(entry => entry[0] === 'html' ? ['html', { open: 'never', outputFolder: 'html-report' }] : entry),
};
`);
  const playwrightModule = import.meta.resolve('@playwright/test');
  await writeFile(join(fixture, 'retry.spec.mjs'), `
import { expect, test } from ${JSON.stringify(playwrightModule)};
test('recovers after retry <tag> & preserves its title', ({}, info) => expect(info.retry).toBe(1));
test('passes immediately', () => {});
test('expected failure', () => { test.fail(); expect(0).toBe(1); });
`);
  const { stdout } = await execFileAsync(process.execPath, [
    fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', 'playwright.config.mjs',
  ], { cwd: fixture, env: { ...process.env, CI: 'true', GITHUB_STEP_SUMMARY: summary } });

  assert.match(stdout, /1 flaky/u);
  const markdown = await readFile(summary, 'utf8');
  assert.match(markdown, /^# Existing CI summary/u);
  assert.match(markdown, /Flaky tests \(passed on retry\): \*\*1\*\*/u);
  assert.match(markdown, /recovers after retry &lt;tag&gt; &amp; preserves its title/u);
  assert.doesNotMatch(markdown, /passes immediately|expected failure/u);
});
