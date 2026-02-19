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

test('build-tauri workflow avoids escaped quote JS snippets and captures Apple identity robustly', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.build?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.build.steps');

  assert.doesNotMatch(
    workflow,
    /require\(\\"/,
    'build-tauri workflow must not escape quotes inside node -p/-e snippets'
  );

  const resolveIdentityStep = buildSteps.find(
    (step) => step?.name === 'Resolve Apple signing identity (macOS)'
  );
  assert.ok(resolveIdentityStep, 'workflow should contain Apple signing identity resolution step');
  const runScript = String(resolveIdentityStep.run ?? '');
  assert.match(
    runScript,
    /security find-identity -v -p codesigning 2>&1/,
    'identity lookup should capture stderr output so valid identities are parsed reliably'
  );
  assert.match(
    runScript,
    /awk -F/,
    'identity lookup should use stable field parsing instead of fragile escaped sed groups'
  );
  assert.doesNotMatch(
    runScript,
    /\\\(/,
    'identity parsing should not rely on double-escaped sed capture groups'
  );

  const tauriBuildStep = buildSteps.find(
    (step) => step?.name === 'Build desktop updater artifacts'
  );
  assert.ok(tauriBuildStep, 'workflow should contain the desktop build step');
  const ciEnvValue = String(tauriBuildStep?.env?.CI ?? '');
  assert.match(
    ciEnvValue,
    /^true$/i,
    'desktop tauri builds should set CI=true to satisfy tauri-cli boolean parsing'
  );

  const buildScript = String(tauriBuildStep?.run ?? '');
  assert.match(
    buildScript,
    /rustup target add "\$\{TAURI_TARGET\}"/,
    'desktop build should ensure TAURI_TARGET is installed before invoking tauri build'
  );

  assert.match(
    buildScript,
    /createUpdaterArtifacts/,
    'desktop build should explicitly enable updater artifacts in CI (base config defaults to disabled for local builds)'
  );
  assert.match(
    buildScript,
    /TAURI_SIGNING_PRIVATE_KEY/,
    'desktop build should gate updater artifact generation on the presence of TAURI_SIGNING_PRIVATE_KEY'
  );

  const collectStep = buildSteps.find(
    (step) => step?.name === 'Collect updater artifact + signature'
  );
  assert.ok(collectStep, 'workflow should contain updater artifact collection step');
  const collectScript = String(collectStep.run ?? '');
  assert.match(
    collectScript,
    /\*\.AppImage\.sig/,
    'linux updater collection should match AppImage signature files emitted by tauri'
  );

  const notarizeStep = buildSteps.find(
    (step) => step?.name === 'Notarize macOS artifacts (updater + DMG) (macOS)'
  );
  assert.ok(notarizeStep, 'workflow should contain macOS notarization step');
  const notarizeScript = String(notarizeStep.run ?? '');
  assert.match(
    notarizeScript,
    /replaceAll\("\\\\n", "\\n"\)|replaceAll\('\\\\n', '\\n'\)/,
    'notarization should normalize escaped newline private key secrets before writing the key file'
  );
});

test('build-tauri workflow validates updater pubkey via pipeline script', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.build?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.build.steps');

  const step = buildSteps.find((s) => s?.name === 'Validate updater public key (production)');
  assert.ok(step, 'workflow should contain updater pubkey validation step');

  const runScript = String(step.run ?? '');
  assert.match(
    runScript,
    /node scripts\/pipeline\/tauri\/validate-updater-pubkey\.mjs/,
    'workflow should delegate updater pubkey validation to pipeline script (no inline heredoc)',
  );
  assert.doesNotMatch(
    runScript,
    /<<'NODE'|node - <<'NODE'|node --input-type=module - <<'NODE'/,
    'workflow should not embed updater pubkey validation as an inline heredoc',
  );
});
