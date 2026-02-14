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
  assert.match(
    runScript,
    /minisign.*not.*pem/i,
    'workflow fail gate should explain that updater signing expects minisign keys, not PEM private keys'
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
    /yarn -s workspace @happier-dev\/agents build/,
    'desktop build should compile @happier-dev/agents before expo web export'
  );
  assert.match(
    buildScript,
    /yarn -s workspace @happier-dev\/protocol build/,
    'desktop build should compile @happier-dev/protocol before expo web export'
  );
  assert.match(
    buildScript,
    /rustup target add "\$\{TAURI_TARGET\}"/,
    'desktop build should ensure TAURI_TARGET is installed before invoking tauri build'
  );
  assert.match(
    buildScript,
    /if \[ "\$\{\{ inputs\.environment \}\}" = "preview" \] && \[ "\$\{RUNNER_OS\}" = "macOS" \]; then[\s\S]*--bundles app/,
    'preview macOS tauri builds should disable DMG bundling and build updater app artifacts only'
  );

  const versionStep = buildSteps.find((step) => step?.name === 'Compute build version');
  assert.ok(versionStep, 'workflow should compute build version for tauri builds');
  const versionScript = String(versionStep.run ?? '');
  assert.match(
    versionScript,
    /preview_number="\$\(\(\s*GITHUB_RUN_NUMBER % 65535\s*\)\)"/,
    'preview tauri versions should bound prerelease numeric identifier to MSI-supported range'
  );
  assert.match(
    versionScript,
    /if \[ "\$\{preview_number\}" -eq 0 \]; then/,
    'preview tauri versions should avoid zero prerelease identifier after modulo wrap'
  );
  assert.match(
    versionScript,
    /build_version="\$\{ui_version\}-\$\{preview_number\}"/,
    'preview tauri version should use numeric-only prerelease segment for Windows MSI compatibility'
  );
  assert.doesNotMatch(
    versionScript,
    /-preview\./,
    'preview tauri version should not include non-numeric prerelease labels'
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
  assert.match(
    collectScript,
    /\*\.msi\.sig/,
    'windows updater collection should match MSI signature files emitted by tauri'
  );
  assert.match(
    collectScript,
    /\*\.exe\.sig/,
    'windows updater collection should match NSIS executable signature files emitted by tauri'
  );

  const notarizeStep = buildSteps.find(
    (step) => step?.name === 'Notarize macOS artifacts (updater + DMG) (macOS)'
  );
  assert.ok(notarizeStep, 'workflow should contain macOS notarization step');
  assert.match(
    String(notarizeStep.if ?? ''),
    /inputs\.environment == 'production'/,
    'macOS notarization should run only for production tauri releases'
  );
  const notarizeScript = String(notarizeStep.run ?? '');
  assert.match(
    notarizeScript,
    /replaceAll\("\\\\n", "\\n"\)|replaceAll\('\\\\n', '\\n'\)/,
    'notarization should normalize escaped newline private key secrets before writing the key file'
  );
  assert.match(
    notarizeScript,
    /process\.env\.TAURI_SIGNING_PRIVATE_KEY/,
    'notarization should read TAURI_SIGNING_PRIVATE_KEY for updater re-signing'
  );
  assert.match(
    notarizeScript,
    /sign_key_path="\$\{RUNNER_TEMP\}\/tauri-updater-signing-key\.pem"/,
    'notarization should materialize the updater signing key to a temp pem file'
  );
  assert.match(
    notarizeScript,
    /tauri signer sign --private-key-path "\$\{sign_key_path\}" --password "\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD\}"/,
    'notarization should pass signer key path/password flags explicitly to tauri signer CLI'
  );
  assert.doesNotMatch(
    notarizeScript,
    /export TAURI_PRIVATE_KEY=/,
    'notarization should not rely on TAURI_PRIVATE_KEY env decoding semantics'
  );
  assert.match(
    notarizeScript,
    /normalized_tauri_signing_key.*replaceAll/,
    'notarization should normalize escaped newline updater signing keys before re-signing artifacts'
  );
});
