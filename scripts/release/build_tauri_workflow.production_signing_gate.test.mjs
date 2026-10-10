import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { inspectReleaseResumeOrigin, resolveReleaseResume } from '../pipeline/release/resolve-release-resume.mjs';
import { projectReleaseStatus } from '../pipeline/release/project-release-status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowPath = join(repoRoot, '.github', 'workflows', 'build-tauri.yml');

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

test('selective desktop recovery composes current workflow inputs with canonical channel status admission', async () => {
  const desktop = parse(await readFile(workflowPath, 'utf8'));
  const reusable = parse(await loadFile('.github/workflows/resolve-release-resume.yml'));
  const channelWorkflow = parse(await loadFile('.github/workflows/release-channel.yml'));
  const releaseWorkflow = parse(await loadFile('.github/workflows/release.yml'));
  const nightly = parse(await loadFile('.github/workflows/nightly-dev.yml'));
  const evaluate = (value, inputs) => typeof value === 'string' && value.startsWith('${{')
    ? Function('inputs', 'format', `return ${value.slice(3, -2)}`)(inputs, (pattern, name) => pattern.replace('{0}', name)) : value;
  const resolveExpected = (caller, callerInputs) => {
    const inputs = Object.fromEntries(Object.entries(reusable.on.workflow_call.inputs).map(([name, input]) => [name, input.default]));
    Object.assign(inputs, Object.fromEntries(Object.entries(caller.with)
      .map(([name, value]) => [name, evaluate(value, callerInputs)])));
    return { repository: 'happier-dev/happier', workflowPath: inputs.expected_workflow, channel: inputs.expected_channel,
      sourceSha: inputs.expected_source_sha, operationId: inputs.expected_operation_id, statusArtifactName: inputs.status_artifact_name };
  };
  const sourceSha = 'a'.repeat(40);
  const digest = `sha256:${'b'.repeat(64)}`;
  const operationId = 'rel_desktoprecovery37';
  const runId = 123;
  const repository = 'happier-dev/happier';
  for (const [workflow, environment, combined] of [
    ['release.yml', 'preview', true], ['release.yml', 'production', true],
    ['release.yml', 'preview', false], ['release.yml', 'production', false], ['nightly-dev.yml', 'dev', false],
  ]) {
    const consumerInputs = { resume_run_id: String(runId), resume_workflow: workflow, environment,
      resume_operation_id: workflow === 'release.yml' ? operationId : '', source_ref: sourceSha };
    const expected = resolveExpected(desktop.jobs.resolve_resume, consumerInputs);
    const producer = workflow === 'release.yml' ? channelWorkflow : nightly;
    const upload = Object.values(producer.jobs).flatMap((job) => job.steps ?? [])
      .find((step) => String(step.with?.name ?? '').includes('happier-release-status'));
    const artifactName = evaluate(upload.with.name, { environment, combined_preview_production: combined });
    const originRun = { id: runId, run_number: 337, path: `.github/workflows/${workflow}`, event: 'workflow_dispatch',
      status: 'completed', conclusion: 'failure', head_sha: sourceSha, head_branch: 'dev',
      html_url: `https://github.com/${repository}/actions/runs/${runId}`,
      repository: { full_name: repository }, head_repository: { full_name: repository } };
    const artifact = (name, id) => ({ id, name, expired: false, digest, workflow_run: { id: runId, head_sha: sourceSha } });
    const artifacts = [artifact(artifactName, 10), artifact(`tauri-updates-${environment}-windows-x86_64`, 11)];
    if (combined) artifacts.push(artifact(`happier-release-status-${environment === 'preview' ? 'production' : 'preview'}`, 12));
    const status = projectReleaseStatus(workflow === 'release.yml' ? 'standard' : 'nightly', {
      SOURCE_SHA: sourceSha, RELEASE_RUN: String(runId), RELEASE_RUN_URL: originRun.html_url,
      RELEASE_RUN_NAME: consumerInputs.resume_operation_id ? `RELEASE ${consumerInputs.resume_operation_id}` : 'NIGHTLY — Dev Releases', RELEASE_CHANNEL: environment,
      HMAINT_OPERATION_ID: consumerInputs.resume_operation_id, REQUEST_CLI: 'true', CLI_CANDIDATE_RESULT: 'success',
      CLI_VERSION: environment === 'production' ? '0.3.0' : `0.3.0-${environment}.73`,
      CLI_CANDIDATE_VERSION: `0.3.0-${environment}.73`,
      IMMUTABLE_VERIFICATION_RESULT: 'success', REQUEST_DEPLOY_UI: 'true', DEPLOY_UI_RESULT: 'failure',
      DEPLOY_UI_DESKTOP_MODE: 'build_and_publish', DEPLOY_UI_EXPO_ACTION: 'native_submit',
    });
    const originJob = releaseWorkflow.jobs[combined ? `release_${environment}` : 'release_single'];
    const job = { id: 77, run_id: runId, head_sha: sourceSha,
      name: `${originJob.name} / deploy_ui / Mobile native (local runner) / Build (ios)`,
      status: 'completed', conclusion: 'success',
      steps: [{ name: 'EAS build (local runner) (pipeline)', status: 'completed', conclusion: 'success' }] };
    const inspected = inspectReleaseResumeOrigin({ originRun, artifacts, expected });
    assert.equal(inspected.artifactId, 10, `${workflow} ${environment} must admit its producer's status`);
    const resolved = resolveReleaseResume({ originRun, artifacts, expected, downloadedDigest: digest, status, jobs: [job] });
    assert.deepEqual(resolved.desktop.finalizedArtifacts['windows-x86_64'], { id: 11, digest });
    if (workflow === 'release.yml') {
      assert.equal(resolved.uiCompleted.nativeIos, true, 'job evidence must use the actual selected status topology');
      const fullExpected = resolveExpected(channelWorkflow.jobs.resolve_resume, { resume_run_id: String(runId), environment,
        authorized_promotion_source_sha: sourceSha, hmaint_operation_id: operationId, combined_preview_production: !combined });
      const full = resolveReleaseResume({ originRun, artifacts, expected: fullExpected, downloadedDigest: digest, status, jobs: [job] });
      assert.deepEqual(full.desktop, resolved.desktop, 'full recovery consumes origin topology even when the new invocation changes channel grouping');
      assert.equal(full.uiCompleted.nativeIos, true);
    }
  }
});

test('Tauri source metadata rejects malicious versions before publishing workflow outputs', async () => {
  const parsed = parse(await readFile(workflowPath, 'utf8'));
  const resolveStep = parsed?.jobs?.resolve_source?.steps?.find((step) => step?.id === 'resolve');
  assert.ok(resolveStep, 'workflow should define the source metadata resolver');

  const fixtureRoot = fs.mkdtempSync(join(os.tmpdir(), 'happier-tauri-version-'));
  try {
    fs.mkdirSync(join(fixtureRoot, 'apps', 'ui'), { recursive: true });
    fs.mkdirSync(join(fixtureRoot, 'bin'));
    fs.writeFileSync(
      join(fixtureRoot, 'apps', 'ui', 'package.json'),
      JSON.stringify({ version: '1.2.3\n$(touch "$RUNNER_TEMP/tauri-version-injection")' }),
    );
    const fakeGit = join(fixtureRoot, 'bin', 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\nprintf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    fs.chmodSync(fakeGit, 0o755);

    const renderedRun = String(resolveStep.run ?? '')
      .replaceAll('${{ inputs.source_ref }}', 'candidate')
      .replaceAll('${{ inputs.environment }}', 'dev');
    const result = spawnSync('bash', ['-c', renderedRun], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
        SOURCE_REF: 'candidate',
        RELEASE_ENVIRONMENT: 'dev',
        GITHUB_RUN_NUMBER: '42',
        GITHUB_OUTPUT: join(fixtureRoot, 'github-output'),
        RUNNER_TEMP: fixtureRoot,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, 'malicious package version must fail source admission');
    assert.match(result.stderr, /canonical semantic version/, 'failure should identify the rejected version contract');
    assert.equal(fs.existsSync(join(fixtureRoot, 'tauri-version-injection')), false);

    fs.writeFileSync(join(fixtureRoot, 'apps', 'ui', 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const resumed = spawnSync('bash', ['-c', renderedRun], {
      cwd: fixtureRoot,
      env: { ...process.env, PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
        SOURCE_REF: 'a'.repeat(40), RELEASE_ENVIRONMENT: 'dev', RELEASE_MESSAGE: 'Recovery',
        RETRY_VERSION: '', RESUME_RUN_ID: '35700904820', RELEASE_RUN_NUMBER: '337',
        GITHUB_RUN_NUMBER: '999', GITHUB_OUTPUT: join(fixtureRoot, 'github-output') },
      encoding: 'utf8',
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(fs.readFileSync(join(fixtureRoot, 'github-output'), 'utf8'), /^build_version=1\.2\.3-dev\.337$/m);
    const forwarded = (sourceSha) => spawnSync('bash', ['-c', renderedRun], {
      cwd: fixtureRoot,
      env: { ...process.env, PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
        SOURCE_REF: 'a'.repeat(40), RELEASE_ENVIRONMENT: 'preview', RELEASE_MESSAGE: 'Recovery',
        RETRY_VERSION: '', RESUME_RUN_ID: '', RESUME_SOURCE_SHA: sourceSha, RELEASE_RUN_NUMBER: '337',
        GITHUB_RUN_NUMBER: '999', GITHUB_OUTPUT: join(fixtureRoot, 'forwarded-output') }, encoding: 'utf8',
    });
    assert.equal(forwarded('a'.repeat(40)).status, 0);
    assert.notEqual(forwarded('c'.repeat(40)).status, 0, 'forwarded admission cannot reuse artifacts for a different candidate source');
    for (const [environment, retryVersion, expectedVersion] of [['dev', '', '1.2.3-dev.999'], ['production', '1.2.3', '1.2.3']]) {
      const output = join(fixtureRoot, `${environment}-output`);
      const fresh = spawnSync('bash', ['-c', renderedRun], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: `${join(fixtureRoot, 'bin')}:${process.env.PATH ?? ''}`,
          SOURCE_REF: 'a'.repeat(40), RELEASE_ENVIRONMENT: environment, RELEASE_MESSAGE: 'Release',
          RETRY_VERSION: retryVersion, RESUME_RUN_ID: '', RELEASE_RUN_NUMBER: '999',
          GITHUB_RUN_NUMBER: '999', GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.ok(fs.readFileSync(output, 'utf8').includes(`build_version=${expectedVersion}\n`));
      assert.ok(fs.readFileSync(output, 'utf8').includes(`retry_version=${retryVersion}\n`));
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Tauri workflow passes expression data through env instead of interpolating shell source', async () => {
  const parsed = parse(await readFile(workflowPath, 'utf8'));
  for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      assert.doesNotMatch(
        String(step?.run ?? ''),
        /\$\{\{/,
        `${jobName} step '${step?.name ?? '<unnamed>'}' must not interpolate expression data into shell source`,
      );
    }
  }

  const resolveStep = parsed.jobs.resolve_source.steps.find((step) => step.id === 'resolve');
  assert.equal(parsed.jobs.resolve_source.permissions?.contents, 'read');
  const sourceCheckout = parsed.jobs.resolve_source.steps.find((step) => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.equal(sourceCheckout.with?.['persist-credentials'], false);
  assert.equal(resolveStep.env.SOURCE_REF, '${{ inputs.source_ref }}');
  assert.equal(resolveStep.env.RELEASE_ENVIRONMENT, '${{ inputs.environment }}');
  assert.match(resolveStep.run, /printf '%s=%s\\n'/, 'validated workflow outputs should be written with printf');
  assert.doesNotMatch(resolveStep.run, /echo .*GITHUB_OUTPUT/);

  const buildStep = parsed.jobs.build.steps.find((step) => step.name === 'Build desktop candidate binary');
  assert.equal(buildStep.env.BUILD_VERSION, '${{ needs.resolve_source.outputs.build_version }}');
  const materializeStep = parsed.jobs.finalize.steps.find((step) => step.name === 'Validate and materialize desktop candidate');
  assert.equal(materializeStep.env.SOURCE_SHA, '${{ needs.resolve_source.outputs.source_sha }}');
  assert.equal(materializeStep.env.UI_VERSION, '${{ needs.resolve_source.outputs.ui_version }}');
  assert.equal(materializeStep.env.BUILD_VERSION, '${{ needs.resolve_source.outputs.build_version }}');
});

test('production macOS tauri workflow hard-fails when signing/notarization secrets are missing', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.finalize?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.finalize.steps');

  const failStep = buildSteps.find(
    (step) => step?.name === 'Fail when production notarization/signing secrets are missing (macOS)'
  );
  assert.ok(failStep, 'workflow should contain an explicit fail gate step');

  const ifCondition = String(failStep.if ?? '');
  assert.match(ifCondition, /inputs\.environment == 'production'/, 'fail gate should apply to production only');
  assert.match(ifCondition, /runner\.os == 'macOS'/, 'fail gate should apply to macOS builds');
  const signingCheck = buildSteps.find((step) => step?.name === 'Check private signing availability');
  for (const secretName of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER_ID',
    'APPLE_API_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY',
  ]) {
    assert.match(JSON.stringify(signingCheck?.env), new RegExp(secretName), `trusted signing check should include ${secretName}`);
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

test('build-tauri workflow uses trusted shared Apple identity setup and avoids escaped quote JS snippets', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.finalize?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.finalize.steps');

  assert.doesNotMatch(
    workflow,
    /require\(\\"/,
    'build-tauri workflow must not escape quotes inside node -p/-e snippets'
  );

  const trustedControlCheckout = buildSteps.find(
    (step) => step?.name === 'Checkout trusted workflow control bytes'
  );
  assert.equal(trustedControlCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(trustedControlCheckout?.with?.ref, '${{ job.workflow_sha }}');
  const setupIdentityStep = buildSteps.find(
    (step) => step?.name === 'Setup Apple code signing identity (macOS)'
  );
  assert.equal(
    setupIdentityStep?.uses,
    './.github/actions/setup-apple-codesigning',
    'Apple secrets must be consumed by trusted workflow-control action bytes',
  );
  const setupIdentityAction = await loadFile('.github/actions/setup-apple-codesigning/action.yml');
  assert.match(setupIdentityAction, /security find-identity -v -p codesigning "\$\{keychain_path\}" 2>&1/);
  assert.match(setupIdentityAction, /Developer ID Application/);

  const tauriBuildStep = buildSteps.find(
    (step) => step?.name === 'Bundle and sign desktop updater artifacts'
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
    /node scripts\/pipeline\/run\.mjs tauri-build-updater-artifacts/,
    'desktop build should delegate to the pipeline command (no direct leaf script call)'
  );
  assert.match(buildScript, /--tauri-target/, 'desktop build should pass --tauri-target through to pipeline script');

  const buildPipelineScript = await loadFile('scripts/pipeline/tauri/build-updater-artifacts.mjs');
  assert.match(buildPipelineScript, /\brustup\b/, 'pipeline build script should install the tauri rust target when provided');
  assert.match(
    buildPipelineScript,
    /createUpdaterArtifacts/,
    'pipeline build script should enable updater artifacts when TAURI_SIGNING_PRIVATE_KEY is available'
  );
  assert.match(
    buildPipelineScript,
    /TAURI_SIGNING_PRIVATE_KEY/,
    'pipeline build script should gate updater artifact generation on TAURI_SIGNING_PRIVATE_KEY'
  );

  const collectStep = buildSteps.find(
    (step) => step?.name === 'Collect updater artifact + signature'
  );
  assert.ok(collectStep, 'workflow should contain updater artifact collection step');
  const collectScript = String(collectStep.run ?? '');
  assert.match(
    collectScript,
    /node scripts\/pipeline\/run\.mjs tauri-collect-updater-artifacts/,
    'updater collection should delegate to the pipeline command'
  );
  const collectPipelineScript = await loadFile('scripts/pipeline/tauri/collect-updater-artifacts.mjs');
  assert.match(collectPipelineScript, /\.appimage\.sig/, 'linux updater collection should match appimage signature files');

  const notarizeStep = buildSteps.find(
    (step) => step?.name === 'Notarize macOS artifacts (updater + DMG) (macOS)'
  );
  assert.ok(notarizeStep, 'workflow should contain macOS notarization step');
  const notarizeScript = String(notarizeStep.run ?? '');
  assert.match(
    notarizeScript,
    /node scripts\/pipeline\/run\.mjs tauri-notarize-macos-artifacts/,
    'notarization should delegate to the pipeline command'
  );

  const notarizePipelineScript = await loadFile('scripts/pipeline/tauri/notarize-macos-artifacts.mjs');
  assert.match(
    notarizePipelineScript,
    /replaceAll\('\\\\n', '\\n'\)|replaceAll\(\"\\\\n\", \"\\n\"\)/,
    'notarization script should normalize escaped newline private key secrets before writing the key file'
  );
});

test('build-tauri finalizer generates its ephemeral password without platform UUID utilities', async () => {
  const parsed = parse(await readFile(workflowPath, 'utf8'));
  const generateStep = parsed?.jobs?.finalize?.steps?.find(
    (step) => step?.name === 'Generate ephemeral updater bundle key',
  );
  assert.ok(generateStep, 'workflow should generate a temporary updater bundle key');

  const fixtureRoot = fs.mkdtempSync(join(os.tmpdir(), 'happier-tauri-ephemeral-key-'));
  try {
    const binDir = join(fixtureRoot, 'bin');
    fs.mkdirSync(binDir);
    fs.symlinkSync(process.execPath, join(binDir, 'node'));
    const fakeYarn = join(binDir, 'yarn');
    fs.writeFileSync(fakeYarn, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeYarn, 0o755);

    const githubEnv = join(fixtureRoot, 'github-env');
    const result = spawnSync('/bin/bash', ['-c', String(generateStep.run ?? '')], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        PATH: binDir,
        RUNNER_TEMP: fixtureRoot,
        GITHUB_ENV: githubEnv,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const emittedEnv = fs.readFileSync(githubEnv, 'utf8');
    assert.match(emittedEnv, /TAURI_EPHEMERAL_KEY=.*tauri-ephemeral\.key/);
    assert.match(
      emittedEnv,
      /TAURI_EPHEMERAL_PASSWORD=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('build-tauri workflow validates updater pubkey via pipeline script', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.finalize?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.finalize.steps');

  const step = buildSteps.find((s) => s?.name === 'Validate updater public key (production)');
  assert.ok(step, 'workflow should contain updater pubkey validation step');

  const runScript = String(step.run ?? '');
  assert.match(
    runScript,
    /node scripts\/pipeline\/run\.mjs tauri-validate-updater-pubkey/,
    'workflow should delegate updater pubkey validation to the pipeline command (no inline heredoc)',
  );
  assert.doesNotMatch(
    runScript,
    /<<'NODE'|node - <<'NODE'|node --input-type=module - <<'NODE'/,
    'workflow should not embed updater pubkey validation as an inline heredoc',
  );
});

test('build-tauri Linux jobs free unused hosted-runner disk before dependency install', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildSteps = parsed?.jobs?.build?.steps;
  assert.ok(Array.isArray(buildSteps), 'build-tauri workflow should define jobs.build.steps');

  const cleanupIndex = buildSteps.findIndex((step) => step?.name === 'Free Linux runner disk space');
  const installIndex = buildSteps.findIndex((step) => step?.name === 'Install dependencies');
  assert.ok(cleanupIndex >= 0, 'workflow should free unused hosted-runner disk for Linux desktop builds');
  assert.ok(installIndex >= 0, 'workflow should contain dependency installation step');
  assert.ok(cleanupIndex < installIndex, 'Linux disk cleanup should run before dependency installation expands node_modules');

  const cleanupStep = buildSteps[cleanupIndex];
  assert.equal(cleanupStep?.if, "runner.os == 'Linux'");
  const runScript = String(cleanupStep?.run ?? '');
  for (const unusedPath of ['/usr/local/lib/android', '/opt/ghc', '/usr/share/dotnet', '/opt/hostedtoolcache/CodeQL']) {
    assert.match(runScript, new RegExp(unusedPath.replaceAll('/', '\\/')), `cleanup should remove ${unusedPath}`);
  }
  assert.match(runScript, /docker image prune -af/, 'cleanup should remove preloaded Docker images from the Tauri runner');
  assert.match(runScript, /df -h \//, 'cleanup should report available root filesystem space');
});

test('build-tauri workflow sets Happier Cloud as explicit default server for desktop release builds', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const buildJobEnv = parsed?.jobs?.build?.env;
  assert.ok(buildJobEnv && typeof buildJobEnv === 'object', 'build-tauri workflow should define jobs.build.env');

  assert.equal(
    buildJobEnv.EXPO_PUBLIC_HAPPIER_SERVER_URL,
    'https://api.happier.dev',
    'desktop release builds should explicitly set EXPO_PUBLIC_HAPPIER_SERVER_URL to Happier Cloud',
  );
  assert.equal(
    buildJobEnv.EXPO_PUBLIC_HAPPY_SERVER_URL,
    'https://api.happier.dev',
    'desktop release builds should keep EXPO_PUBLIC_HAPPY_SERVER_URL aligned with the canonical server URL',
  );
  assert.equal(
    buildJobEnv.EXPO_PUBLIC_SERVER_URL,
    'https://api.happier.dev',
    'desktop release builds should keep EXPO_PUBLIC_SERVER_URL aligned with the canonical server URL',
  );
});

test('candidate code is isolated from Tauri and Apple private signing authority', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const parsed = parse(workflow);
  const build = parsed?.jobs?.build;
  const finalize = parsed?.jobs?.finalize;
  const prepareAssets = parsed?.jobs?.prepare_assets;

  assert.ok(build, 'workflow should retain one cross-platform candidate build owner');
  assert.ok(finalize, 'workflow should finalize candidate artifacts in a separate trusted job');
  assert.equal(build?.permissions?.contents, 'read', 'candidate builds must not receive a publishing token');
  assert.equal(build?.environment, undefined, 'candidate builds must not enter the secret-bearing release environment');

  const privateSecretNames = [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER_ID',
    'APPLE_API_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  ];
  const buildJson = JSON.stringify(build);
  for (const secretName of privateSecretNames) {
    assert.doesNotMatch(buildJson, new RegExp(secretName), `candidate build must not receive ${secretName}`);
  }

  const candidateCheckout = build.steps.find((step) => step?.name === 'Checkout candidate source');
  assert.equal(candidateCheckout?.with?.ref, '${{ needs.resolve_source.outputs.source_sha }}');
  assert.equal(candidateCheckout?.with?.['persist-credentials'], false);

  const candidateBuild = build.steps.find((step) => step?.name === 'Build desktop candidate binary');
  assert.match(String(candidateBuild?.run ?? ''), /tauri-build-updater-artifacts/);
  assert.match(String(candidateBuild?.run ?? ''), /--no-bundle/);
  assert.match(String(candidateBuild?.run ?? ''), /--secrets-source env/);

  const candidateUpload = build.steps.find((step) => step?.name === 'Upload desktop candidate');
  assert.equal(candidateUpload?.with?.name, 'tauri-candidate-${{ inputs.environment }}-${{ matrix.platform_key }}');
  assert.doesNotMatch(JSON.stringify(build.steps), /Upload updater assets artifact/);

  assert.equal(finalize?.permissions?.contents, 'read');
  assert.equal(finalize?.environment, 'release-shared');
  assert.deepEqual(finalize?.needs, ['resolve_source', 'build']);
  assert.match(finalize.if, /!cancelled\(\)/);
  assert.match(finalize.if, /needs\.resolve_source\.result == 'success'/);
  assert.match(finalize.if, /needs\.build\.result == 'skipped'/);
  assert.match(build.if, /needs\.resolve_source\.outputs\.build_needed == 'true'/);
  assert.equal(build.strategy.matrix, '${{ fromJSON(needs.resolve_source.outputs.build_matrix) }}');
  assert.equal(finalize.strategy.matrix, '${{ fromJSON(needs.resolve_source.outputs.finalize_matrix) }}');
  // These job conditions use the shared JavaScript/Actions boolean-expression subset.
  const admits = (job, needs, cancelled = false) => Function('needs', 'cancelled', `return ${job.if.slice(3, -2)}`)(needs, () => cancelled);
  for (const [buildNeeded, buildResult] of [['true', 'success'], ['false', 'skipped']]) {
    const needs = { resolve_source: { result: 'success', outputs: { build_needed: buildNeeded, finalize_needed: 'true', retry_version: '' } }, build: { result: buildResult } };
    assert.equal(admits(build, needs), buildNeeded === 'true');
    assert.equal(admits(finalize, needs), true, 'all reused unsigned candidates still require finalization');
    assert.equal(admits(finalize, { ...needs, resolve_source: { result: 'success', outputs: { finalize_needed: 'false', retry_version: '' } } }), false,
      'already-finalized candidates must never enter signing again');
    assert.equal(admits(finalize, needs, true), false);
    assert.equal(admits(finalize, { ...needs, build: { result: 'failure' } }), false);
    assert.equal(admits(finalize, { ...needs, resolve_source: { result: 'failure', outputs: {} } }), false);
    assert.equal(admits(finalize, { ...needs, resolve_source: { result: 'success', outputs: { retry_version: '1.2.2' } } }), false);
  }
  const resume = parsed.jobs.resolve_resume;
  assert.equal(resume.uses, './.github/workflows/resolve-release-resume.yml');
  const resolveInputs = (inputs) => Object.fromEntries(Object.entries(resume.with).map(([key, value]) => [key,
    typeof value === 'string' && value.startsWith('${{')
      ? Function('inputs', 'format', `return ${value.slice(3, -2)}`)(inputs, (pattern, name) => pattern.replace('{0}', name))
      : value,
  ]));
  const source = 'a'.repeat(40);
  for (const [workflow, environment, operation] of [
    ['nightly-dev.yml', 'dev', ''],
    ['release.yml', 'production', 'rel_exact'],
    ['release.yml', 'preview', 'rel_exact'],
  ]) {
    assert.deepEqual(resolveInputs({ resume_run_id: '123', resume_workflow: workflow, resume_operation_id: operation, environment, source_ref: source }), {
      origin_run_id: '123', expected_workflow: `.github/workflows/${workflow}`, expected_channel: environment,
      expected_source_sha: source, expected_operation_id: operation,
    });
  }
  assert.equal(resolveInputs({ resume_run_id: '123', environment: 'dev', source_ref: source }).expected_workflow, '.github/workflows/nightly-dev.yml');
  assert.equal(parsed.on.workflow_dispatch.inputs.resume_workflow.default, 'nightly-dev.yml');
  assert.deepEqual(parsed.on.workflow_dispatch.inputs.resume_workflow.options, ['nightly-dev.yml', 'release.yml']);
  const download = finalize.steps.find((step) => step.name === 'Download and verify admitted desktop candidate');
  assert.equal(download.if, "${{ matrix.artifact_id != '' }}");
  assert.equal(download.env.ARTIFACT_ID, '${{ matrix.artifact_id }}');
  assert.equal(download.env.ARTIFACT_DIGEST, '${{ matrix.artifact_digest }}');
  assert.match(download.run, /resolve-release-resume\.mjs[\s\S]*--mode download/);
  assert.ok(finalize.steps.indexOf(download) < finalize.steps.findIndex((step) => step.name === 'Validate and materialize desktop candidate'));
  const trustedCheckout = finalize.steps.find((step) => step?.name === 'Checkout trusted workflow control bytes');
  assert.equal(trustedCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(trustedCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(trustedCheckout?.with?.['persist-credentials'], false);
  assert.equal(
    finalize.steps.filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262').length,
    1,
    'secret-bearing finalizer must never checkout candidate source',
  );

  const materialize = finalize.steps.find((step) => step?.name === 'Validate and materialize desktop candidate');
  const candidateDownload = finalize.steps.find((step) => step?.name === 'Download desktop candidate');
  assert.equal(candidateDownload?.with?.name, 'tauri-candidate-${{ inputs.environment }}-${{ matrix.platform_key }}');
  const materializeRun = String(materialize?.run ?? '');
  assert.match(materializeRun, /tauri-bundle-candidate/);
  assert.match(materializeRun, /--mode materialize/);
  assert.match(materializeRun, /--expected-source-sha/);
  assert.match(materializeRun, /--expected-environment/);
  assert.match(materializeRun, /--expected-ui-version/);
  assert.match(materializeRun, /--expected-build-version/);

  const finalizeStep = finalize.steps.find((step) => step?.name === 'Bundle and sign desktop updater artifacts');
  assert.match(String(finalizeStep?.run ?? ''), /tauri-build-updater-artifacts/);
  assert.match(String(finalizeStep?.run ?? ''), /--bundle-only/);
  assert.equal(finalizeStep?.env?.TAURI_SIGNING_PRIVATE_KEY, '${{ env.TAURI_EPHEMERAL_KEY }}');
  assert.equal(finalizeStep?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, '${{ env.TAURI_EPHEMERAL_PASSWORD }}');
  assert.doesNotMatch(JSON.stringify(finalizeStep), /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  const nonMacSigner = finalize.steps.find((step) => step?.name === 'Sign non-mac updater artifacts');
  assert.equal(nonMacSigner?.if, "runner.os != 'macOS'");
  assert.equal(nonMacSigner?.env?.TAURI_SIGNING_PRIVATE_KEY, '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}');
  assert.match(String(nonMacSigner?.run ?? ''), /tauri-sign-updater-artifacts/);

  const finalizedUpload = finalize.steps.find((step) => step?.name === 'Upload finalized updater assets');
  assert.equal(finalizedUpload?.with?.name, 'tauri-updates-${{ inputs.environment }}-${{ matrix.platform_key }}');

  assert.equal(prepareAssets?.permissions?.contents, 'read');
  const prepareCheckout = prepareAssets.steps.find((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.equal(prepareCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(prepareCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(prepareCheckout?.with?.['persist-credentials'], false);
  assert.deepEqual(prepareAssets?.needs, ['resolve_source', 'finalize', 'reuse_finalized']);
  const finalizedDownload = prepareAssets.steps.find((step) => step?.name === 'Download updater assets artifacts');
  assert.equal(finalizedDownload?.with?.pattern, 'tauri-updates-${{ inputs.environment }}-*');
  const publishUpload = prepareAssets.steps.find((step) => step?.name === 'Upload publish assets artifact');
  assert.equal(publishUpload?.with?.name, 'ui-desktop-assets-${{ inputs.environment }}');
  for (const jobName of ['publish_preview', 'publish_dev', 'publish_stable_release']) {
    assert.equal(parsed?.jobs?.[jobName]?.with?.assets_artifact, 'ui-desktop-assets-${{ inputs.environment }}');
  }
});
