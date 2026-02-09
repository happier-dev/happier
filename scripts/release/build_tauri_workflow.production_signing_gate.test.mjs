import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowPath = join(repoRoot, '.github', 'workflows', 'build-tauri.yml');

test('production macOS tauri workflow hard-fails when signing/notarization secrets are missing', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.build?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.build.steps');

  const failStep = buildSteps.find(
    (step) => step?.name === 'Fail when production notarization/signing secrets are missing (macOS)'
  );
  assert.ok(failStep, 'workflow should contain an explicit fail gate step');

  const ifCondition = String(failStep.if ?? '');
  assert.match(ifCondition, /inputs\.environment == 'production'/, 'fail gate should apply to production only');
  assert.match(ifCondition, /runner\.os == 'macOS'/, 'fail gate should apply to macOS builds');
  for (const secretName of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER_ID',
    'APPLE_API_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY',
  ]) {
    assert.match(ifCondition, new RegExp(secretName), `fail gate condition should include ${secretName}`);
  }

  const runScript = String(failStep.run ?? '');
  assert.match(
    runScript,
    /Missing required production macOS signing\/notarization secrets\./,
    'workflow fail gate should emit a clear missing-secrets error'
  );
  assert.match(
    runScript,
    /\bexit 1\b/,
    'workflow fail gate should exit with status 1'
  );

  const warningStep = buildSteps.find(
    (step) => String(step?.name ?? '').includes('Warn when production notarization is skipped')
  );
  assert.equal(
    warningStep,
    undefined,
    'workflow must not silently warn-and-continue for production notarization gaps'
  );
});
