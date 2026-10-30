import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { collectPublisherExternalActionUses } from './workflowSecurityTestkit.mjs';

const repoRootPath = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = new URL('../../.github/workflows/publish-cli-binaries.yml', import.meta.url);
const packagedConformancePath = new URL(
  '../../packages/plugins/cliproxyapi/managed-runtime/conformance/packaged_test.go',
  import.meta.url,
);
const managedRuntimeGoModPath = new URL(
  '../../packages/plugins/cliproxyapi/managed-runtime/go.mod',
  import.meta.url,
);
const managedRuntimeBuildPath = new URL(
  '../../packages/plugins/cliproxyapi/managed-runtime/tools/build/main.go',
  import.meta.url,
);
const managedRuntimeNoticesPath = new URL(
  '../../packages/plugins/cliproxyapi/managed-runtime/licenses/THIRD-PARTY-NOTICES',
  import.meta.url,
);
const testsWorkflowPath = new URL('../../.github/workflows/tests.yml', import.meta.url);

const cliProducts = ['happier', 'happier-memory-runtime', 'happier-voice-runtime', 'happier-difftastic'];
const cliTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];

test('CLI optional products survive native upload and attestation selection', async () => {
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  const upload = workflow.jobs.build_native.steps.find((step) => usesAction(step, 'actions/upload-artifact'));
  const attest = workflow.jobs.attest_native.steps.find((step) => usesAction(step, 'actions/attest'));
  for (const product of cliProducts) {
    const archive = `${product}-v\${{ needs.prepare.outputs.version }}-\${{ matrix.cli_target }}.tar.gz`;
    assert.ok(upload.with.path.split('\n').includes(`dist/release-assets/cli/${archive}`), product);
    assert.ok(attest.with['subject-path'].split('\n').includes(`dist/attestation-leaf/${archive}`), product);
  }
  const select = workflow.jobs.attest_native.steps.find((step) => step.name === 'Select exact archive for attestation');
  const workspace = await mkdtemp(join(tmpdir(), 'cli-attest-products-'));
  try {
    const input = join(workspace, 'input');
    await mkdir(input);
    const expected = cliProducts.map((product) => `${product}-v1.2.3-linux-x64.tar.gz`).sort();
    for (const archive of expected) await writeFile(join(input, archive), archive);
    const result = spawnSync('bash', ['-c', select.run], {
      cwd: workspace,
      env: { ...process.env, CANDIDATE_DATA_DIR: input, RELEASE_VERSION: '1.2.3', CLI_TARGET: 'linux-x64' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(join(workspace, 'dist/attestation-leaf'))).sort(), expected);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const [jobName, stepName] of [
  ['finalize_candidate', 'Assemble bounded candidate-native matrix from exact leaf handoffs'],
  ['publish', 'Assemble prepared archive directory from exact leaf handoffs'],
]) {
  test(`${jobName} assembles every optional product with signed Darwin bytes and rejects missing or duplicate leaves`, async () => {
    const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
    const step = workflow.jobs[jobName].steps.find((entry) => entry.name === stepName);
    const workspace = await mkdtemp(join(tmpdir(), 'cli-assemble-products-'));
    try {
      const unsigned = join(workspace, 'unsigned');
      const signed = join(workspace, 'signed');
      await mkdir(unsigned);
      await mkdir(signed);
      const expected = new Map();
      for (const product of cliProducts) {
        for (const target of cliTargets) {
          const archive = `${product}-v1.2.3-${target}.tar.gz`;
          await writeFile(join(unsigned, archive), `unsigned:${archive}`);
          expected.set(archive, `unsigned:${archive}`);
          if (target.startsWith('darwin-')) {
            await writeFile(join(signed, archive), `signed:${archive}`);
            expected.set(archive, `signed:${archive}`);
            const evidence = `${target}.${product === 'happier' ? 'cli' : product}.json`;
            await writeFile(join(signed, evidence), evidence);
            await writeFile(join(signed, `${evidence}.notary-log.json`), 'not published');
            expected.set(evidence, evidence);
          }
        }
      }
      const run = () => spawnSync('bash', ['-c', step.run], {
        cwd: workspace,
        env: { ...process.env, GITHUB_WORKSPACE: workspace, UNSIGNED_DATA_DIR: unsigned, SIGNED_DATA_DIR: signed, RELEASE_VERSION: '1.2.3' },
        encoding: 'utf8',
      });
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      const assembled = join(workspace, 'dist/release-assets/cli');
      assert.deepEqual((await readdir(assembled)).sort(), [...expected.keys()].sort());
      for (const [name, content] of expected) assert.equal(await readFile(join(assembled, name), 'utf8'), content);
      const missing = 'happier-memory-runtime-v1.2.3-darwin-arm64.tar.gz';
      await rm(join(signed, missing));
      assert.notEqual(run().status, 0, 'an optional Darwin archive must not fall back to unsigned bytes');
      await writeFile(join(signed, missing), `signed:${missing}`);
      await mkdir(join(signed, 'duplicate'));
      await writeFile(join(signed, 'duplicate', missing), `signed:${missing}`);
      assert.notEqual(run().status, 0, 'ambiguous optional archives must fail closed');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

test('CLI matrix verification explicitly selects the complete main checksum envelope', async () => {
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  for (const jobName of ['finalize_candidate', 'publish']) {
    const steps = workflow.jobs[jobName].steps.filter((step) => String(step.run ?? '').includes('verify-artifacts.mjs'));
    assert.ok(steps.length > 0);
    for (const step of steps) {
      assert.match(step.run, /--checksums "[^"\n]*\/checksums-happier-v\$\{RELEASE_VERSION\}\.txt"/);
      assert.match(step.run, /--require-all-artifacts-checksummed/);
      assert.match(step.run, /--require-signature/);
    }
  }
});

test('Darwin leaf handoff retains archives, evidence, and notary logs for every CLI product', async () => {
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  const handoff = workflow.jobs.finalize_darwin.steps.find((step) => step.name === 'Assemble exact signed Darwin leaf handoff');
  const workspace = await mkdtemp(join(tmpdir(), 'cli-darwin-products-'));
  try {
    await mkdir(join(workspace, 'dist/release-assets/cli'), { recursive: true });
    await mkdir(join(workspace, 'dist/notary'), { recursive: true });
    const expected = [];
    for (const product of cliProducts) {
      const archive = `${product}-v1.2.3-darwin-arm64.tar.gz`;
      await writeFile(join(workspace, 'dist/release-assets/cli', archive), archive);
      expected.push(archive);
      for (const suffix of ['.json', '.json.notary-log.json']) {
        const evidence = `darwin-arm64.${product === 'happier' ? 'cli' : product}${suffix}`;
        await writeFile(join(workspace, 'dist/notary', evidence), evidence);
        expected.push(evidence);
      }
    }
    const result = spawnSync('bash', ['-c', handoff.run], {
      cwd: workspace,
      env: { ...process.env, RELEASE_VERSION: '1.2.3', CLI_TARGET: 'darwin-arm64', PLATFORM_KEY: 'darwin-arm64' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(join(workspace, 'dist/signed-leaf'))).sort(), expected.sort());
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const PINNED_PUBLISH_ACTIONS = Object.freeze({
  'actions/attest': 'f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6',
  'actions/cache/restore': '0057852bfaa89a56745cba8c7296529d2fc39830',
  'actions/cache/save': '0057852bfaa89a56745cba8c7296529d2fc39830',
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
  'actions/create-github-app-token': 'd72941d797fd3113feb6b93fd0dec494b13a2547',
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
  'actions/setup-go': '924ae3a1cded613372ab5595356fb5720e22ba16',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  'oven-sh/setup-bun': '0c5077e51419868618aeaa5fe8019c62421857d6',
});

function actionNameFromUse(use) {
  const delimiter = String(use ?? '').lastIndexOf('@');
  return delimiter < 0 ? String(use ?? '') : String(use).slice(0, delimiter);
}

function usesAction(step, actionName) {
  return actionNameFromUse(step?.uses) === actionName;
}

function usesPinnedPublishAction(step, actionName) {
  return step?.uses === `${actionName}@${PINNED_PUBLISH_ACTIONS[actionName]}`;
}

test('privileged CLI binary publishing pins every external action to its reviewed full commit SHA', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const externalUses = await collectPublisherExternalActionUses(workflow);
  const observedActions = new Set();

  for (const use of externalUses) {
    const delimiter = use.lastIndexOf('@');
    assert.notEqual(delimiter, -1, `external action must include an immutable ref: ${use}`);
    const actionName = use.slice(0, delimiter);
    const actionRef = use.slice(delimiter + 1);
    observedActions.add(actionName);
    assert.match(actionRef, /^[0-9a-f]{40}$/, `external action must use a full commit SHA: ${use}`);
    assert.equal(
      actionRef,
      PINNED_PUBLISH_ACTIONS[actionName],
      `external action must use its reviewed release commit: ${use}`,
    );
  }

  assert.deepEqual(
    [...observedActions].sort(),
    Object.keys(PINNED_PUBLISH_ACTIONS).sort(),
    'the pin inventory must cover every external action used by the privileged publisher',
  );
});

test('managed wrapper source, diagnostics, notices, and workflows agree on exact Go 1.26.6', async () => {
  const [
    goMod,
    buildSource,
    notices,
    publishWorkflowRaw,
    testsWorkflowRaw,
  ] = await Promise.all([
    readFile(managedRuntimeGoModPath, 'utf8'),
    readFile(managedRuntimeBuildPath, 'utf8'),
    readFile(managedRuntimeNoticesPath, 'utf8'),
    readFile(workflowPath, 'utf8'),
    readFile(testsWorkflowPath, 'utf8'),
  ]);

  assert.match(goMod, /^go 1\.26\.6$/m);
  assert.match(
    goMod,
    /^tool golang\.org\/x\/vuln\/cmd\/govulncheck$/m,
    'the managed module must pin its vulnerability scanner through the Go tool owner',
  );
  assert.match(
    goMod,
    /^\s*golang\.org\/x\/vuln v1\.6\.0 \/\/ indirect$/m,
    'the managed module must pin the reviewed govulncheck tool dependency in tidy form',
  );
  assert.match(goMod, /^\s*github\.com\/router-for-me\/CLIProxyAPI\/v7 v7\.2\.95$/m);
  assert.match(buildSource, /Go 1\.26\.6 toolchain is required/);
  assert.match(notices, /^Go toolchain go1\.26\.6$/m);
  assert.match(notices, /^source identity: go1\.26\.6$/m);
  assert.match(notices, /^source: https:\/\/go\.dev\/dl\/go1\.26\.6\.src\.tar\.gz$/m);

  for (const [name, workflowRaw, jobName] of [
    ['publishing', publishWorkflowRaw, 'build_native'],
    ['ordinary CI', testsWorkflowRaw, 'cliproxyapi-managed-runtime'],
  ]) {
    const workflow = YAML.parse(workflowRaw);
    const setupGo = workflow.jobs?.[jobName]?.steps?.find(
      (step) => usesAction(step, 'actions/setup-go'),
    );
    assert.equal(
      setupGo?.with?.['go-version-file'],
      'packages/plugins/cliproxyapi/managed-runtime/go.mod',
      `${name} must consume the one exact Go version owner`,
    );
  }
});

test('CLI binary publishing builds and validates each released target on its native runner', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const packagedConformance = await readFile(packagedConformancePath, 'utf8');
  const workflow = YAML.parse(raw);
  const build = workflow.jobs?.build_native;
  assert.ok(build, 'expected build_native job');
  assert.deepEqual(
    build.strategy?.matrix?.include?.map(({ platform_key, runner, cli_target, go_target }) => ({
      platform_key,
      runner,
      cli_target,
      go_target,
    })),
    [
      { platform_key: 'linux-x64', runner: 'ubuntu-24.04', cli_target: 'linux-x64', go_target: 'linux-amd64' },
      { platform_key: 'linux-arm64', runner: 'ubuntu-24.04-arm', cli_target: 'linux-arm64', go_target: 'linux-arm64' },
      { platform_key: 'darwin-x64', runner: 'macos-15-intel', cli_target: 'darwin-x64', go_target: 'darwin-amd64' },
      { platform_key: 'darwin-arm64', runner: 'macos-15', cli_target: 'darwin-arm64', go_target: 'darwin-arm64' },
      { platform_key: 'windows-x64', runner: 'windows-2025', cli_target: 'windows-x64', go_target: 'windows-amd64' },
    ],
  );

  assert.equal(
    build.steps.some((step) => usesPinnedPublishAction(step, 'actions/checkout')),
    false,
    'candidate execution must consume an inert source artifact without repository checkout authority',
  );
  const sourceDownload = build.steps.find(
    (step) => step.name === 'Download exact candidate source transport',
  );
  assert.ok(usesPinnedPublishAction(sourceDownload, 'actions/download-artifact'));
  assert.equal(sourceDownload?.with?.name, 'cli-source-${{ needs.prepare.outputs.source_sha }}');

  const setupGo = build.steps.find((step) => usesPinnedPublishAction(step, 'actions/setup-go'));
  assert.equal(setupGo?.with?.['go-version-file'], 'packages/plugins/cliproxyapi/managed-runtime/go.mod');
  assert.equal(setupGo?.with?.['cache-dependency-path'], 'packages/plugins/cliproxyapi/managed-runtime/go.sum');

  const buildRuns = build.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(buildRuns, /\bgo test \.\/\.\.\./);
  assert.match(buildRuns, /\bgo vet \.\/\.\.\./);
  const processCustodyTests = build.steps.find(
    (step) => step.name === 'Run native process-custody tests',
  );
  assert.equal(
    processCustodyTests?.['working-directory'],
    'apps/cli/native/processcustody',
    'each native matrix runner must execute the process-custody module on its own OS',
  );
  assert.equal(processCustodyTests?.shell, 'bash');
  assert.equal(processCustodyTests?.if, undefined, 'Darwin and Windows must not be filtered out');
  assert.match(String(processCustodyTests?.run ?? ''), /^\s*set -euo pipefail\s+go test \.\/\.\.\.\s*$/u);
  const nativeConfinedSmoke = build.steps.find(
    (step) => step.name === 'Exercise packaged workspace confinement through the CLI owner',
  );
  assert.equal(
    nativeConfinedSmoke?.if,
    "matrix.platform_os == 'macos' || matrix.platform_os == 'windows'",
    'the packaged confinement smoke must run on both supported native filesystem implementations',
  );
  assert.equal(
    nativeConfinedSmoke?.env?.HAPPIER_RUN_NATIVE_CONFINED_WORKSPACE_SYNC_REAL_INTEGRATION,
    '1',
  );
  assert.match(
    String(nativeConfinedSmoke?.run ?? ''),
    /PACKAGED_CUSTODY_PATH="\$\(find "\$\{PACKAGED_PAYLOAD_PATH\}" -type f -name "\$CUSTODY_NAME" -print\)"/,
    'the smoke must consume the helper extracted from the exact candidate archive',
  );
  assert.match(
    String(nativeConfinedSmoke?.run ?? ''),
    /cp "\$\{PACKAGED_CUSTODY_PATH\}" "\$\{STAGED_CUSTODY_PATH\}"/,
    'the smoke must place the packaged helper at the default resolver staging location',
  );
  assert.match(
    String(nativeConfinedSmoke?.run ?? ''),
    /pnpm --filter @happier-dev\/cli exec vitest run[\s\S]*workspaceSyncNativeConfinedFileSystem\.test\.ts[\s\S]*uses the staged native helper for read, abort preservation, and committed deletion/,
    'the native matrix must cross the real TypeScript resolver/spawn/protocol boundary',
  );
  const packagedConformanceStep = build.steps.find(
    (step) => step.name === 'Run retained conformance harness against the packaged wrapper',
  );
  assert.ok(
    build.steps.indexOf(nativeConfinedSmoke) > build.steps.indexOf(packagedConformanceStep),
    'the smoke must consume the archive after canonical extraction and packaged validation',
  );
  assert.doesNotMatch(
    buildRuns,
    /\btar\s+-xzf\s+"\$\{ARCHIVE\}"/,
    'packaged wrapper conformance must not bypass the canonical bounded archive extractor',
  );
  assert.match(
    buildRuns,
    /node "\$\{GITHUB_WORKSPACE\}\/scripts\/pipeline\/release\/node-archive\.mjs"[\s\S]*?--extract-archive-path "\$\{ARCHIVE\}"[\s\S]*?--extract-dir "\$\{EXTRACT_DIR\}"/,
    'packaged wrapper conformance must extract through the canonical release-runtime owner',
  );
  const sourceSecurity = build.steps.find(
    (step) => step.name === 'Run Linux race and reachable vulnerability checks',
  );
  assert.equal(sourceSecurity?.if, "matrix.platform_key == 'linux-x64'");
  assert.equal(
    sourceSecurity?.['working-directory'],
    'packages/plugins/cliproxyapi/managed-runtime',
  );
  assert.match(String(sourceSecurity?.run ?? ''), /\bgo test -race -count=1 \.\/\.\.\./);
  assert.match(String(sourceSecurity?.run ?? ''), /\bgo tool govulncheck \.\/\.\.\./);
  assert.match(
    buildRuns,
    /pnpm --filter @happier-dev\/plugins-cliproxyapi run managed-runtime:build[\s\S]*?--target "\$GO_TARGET"[\s\S]*?--output "\$\{WRAPPER_PATH\}"/,
  );
  assert.doesNotMatch(buildRuns, /\bgo build\b/, 'workflow must not create a second Go build definition');
  assert.doesNotMatch(buildRuns, /notarize-standalone-binary\.mjs/);
  assert.match(
    buildRuns,
    /release-build-cli-binaries[\s\S]*?--targets "\$CLI_TARGET"[\s\S]*?--cliproxyapi-managed-runtime-executable "\$\{WRAPPER_PATH\}"/,
  );
  assert.equal(
    build.steps.some((step) => String(step.name).includes('Sign and notarize standalone wrapper')),
    false,
    'the managed wrapper must be signed once by the stage-wide Darwin payload owner',
  );
  const unsignedCliBuild = build.steps.find((step) => String(step.name).includes(
    'Build exact native CLI archive from the wrapper',
  ));
  assert.equal(unsignedCliBuild?.if, undefined);
  assert.ok(build.steps.indexOf(unsignedCliBuild) >= 0);
  const nativeArchiveSmoke = build.steps.find(
    (step) => step.name === 'Smoke-test exact native CLI archives',
  );
  assert.ok(nativeArchiveSmoke, 'each native matrix leaf must execute its matching-host archives');
  assert.equal(nativeArchiveSmoke.if, undefined, 'Linux, macOS, and Windows matrix leaves must all smoke');
  assert.ok(
    build.steps.indexOf(nativeArchiveSmoke) > build.steps.indexOf(unsignedCliBuild)
      && build.steps.indexOf(nativeArchiveSmoke) < build.steps.indexOf(packagedConformanceStep),
    'the smoke must execute the exact built archives before later leaf validation and upload',
  );
  assert.match(nativeArchiveSmoke.run, /for PRODUCT in happier happier-memory-runtime happier-voice-runtime happier-difftastic; do/);
  assert.match(nativeArchiveSmoke.run, /import \{ smokeTestArchive \} from "\.\/scripts\/pipeline\/release\/verify-artifacts\.mjs"/);
  assert.match(nativeArchiveSmoke.run, /await smokeTestArchive\(\{ archivePath: process\.argv\[1\] \}\)/);
  assert.doesNotMatch(nativeArchiveSmoke.run, /skip-smoke|execute:\s*false/);
  assert.equal(build.environment, undefined);
  assert.doesNotMatch(JSON.stringify(build), /secrets\.APPLE_|setup-apple-codesigning/);
  assert.match(
    buildRuns,
    /HAPPIER_CLIPROXYAPI_EXECUTABLE="\$\{PACKAGED_WRAPPER_PATH\}"\s+\\\s+HAPPIER_CLIPROXYAPI_WRAPPER_BUILD_VERSION="\$RELEASE_VERSION"\s+\\\s+go test \.\/conformance -run '\^TestPackagedWrapper\$' -count=1 -v/,
  );
  assert.match(
    packagedConformance,
    /wrapperBuildVersion := os\.Getenv\("HAPPIER_CLIPROXYAPI_WRAPPER_BUILD_VERSION"\)[\s\S]*healthIdentity\.WrapperBuildVersion != wrapperBuildVersion/,
    'packaged conformance must read and verify the exact compiled wrapper build version',
  );
  assert.doesNotMatch(
    packagedConformance,
    /os\.Environ\(\)/,
    'packaged conformance must not inherit ambient credentials from its runner',
  );
  assert.match(
    packagedConformance,
    /func minimalPackagedEnvironment[\s\S]*SYSTEMROOT[\s\S]*OPENAI_API_KEY[\s\S]*ANTHROPIC_API_KEY[\s\S]*CLAUDE_CODE_OAUTH_TOKEN/,
    'packaged conformance must use a platform-safe minimal environment with synthetic credential sentinels',
  );
  assert.match(
    packagedConformance,
    /func redactPackagedDiagnostics[\s\S]*\[redacted\]/,
    'packaged conformance must redact sensitive material before printing child diagnostics',
  );
  assert.match(
    packagedConformance,
    /assertNoSensitiveMaterial\(t,\s*map\[string\]string\{[\s\S]*"stdout"[\s\S]*"stderr"[\s\S]*"health"/,
    'packaged conformance must scan emitted and health evidence for credential material',
  );
  assert.match(buildRuns, /CLIProxyAPI-LICENSE/, 'packaged leaf must retain upstream license evidence');
  assert.match(
    buildRuns,
    /CLIProxyAPI-THIRD-PARTY-NOTICES/,
    'packaged leaf must retain the source-pinned compiled dependency notices',
  );
  assert.match(
    buildRuns,
    /go run \.\/tools\/notices[\s\S]*?--binary "\$\{PACKAGED_WRAPPER_PATH\}"[\s\S]*?--goos "\$\{GOOS_VALUE\}"[\s\S]*?--goarch "\$\{GOARCH_VALUE\}"[\s\S]*?--output "\$\{PACKAGED_NOTICES_PATH\}"[\s\S]*?--check/,
    'native packaged leaf must verify its notices against the exact packaged wrapper build info',
  );
  assert.match(buildRuns, /test -x "\$\{PACKAGED_WRAPPER_PATH\}"/);
  assert.match(buildRuns, /\bgo mod graph\b/);
  assert.match(buildRuns, /\bgo list -m -f\b/);
  assert.match(buildRuns, /\bgo version -m "\$\{WRAPPER_PATH\}"/);
  assert.match(
    buildRuns,
    /grep -F \$'\\tdep\\tgithub\.com\/router-for-me\/CLIProxyAPI\/v7\\tv7\.2\.95'/,
    'the pinned CLIProxyAPI module is a dependency record in go version -m output',
  );
  assert.doesNotMatch(
    buildRuns,
    /grep -F \$'\\tmod\\tgithub\.com\/router-for-me\/CLIProxyAPI\/v7/,
    'the wrapper module is the sole mod record; CLIProxyAPI must be verified as a dep record',
  );
  assert.match(buildRuns, /\bgo version -m "\$\{PACKAGED_WRAPPER_PATH\}"/);
  assert.doesNotMatch(
    buildRuns,
    /--binary "\$\{PACKAGED_CLI_PATH\}"/,
    'named-binary verification would silently omit future nested Mach-O code',
  );
  assert.doesNotMatch(
    buildRuns,
    /\bcmp\s+\\\s+"\$\{WRAPPER_PATH\}"\s+\\\s+"\$\{PACKAGED_WRAPPER_PATH\}"/,
    'stage-wide signing intentionally changes the prebuilt wrapper bytes',
  );
  assert.match(
    buildRuns,
    /\bcmp\s+\\\s+"licenses\/CLIProxyAPI-LICENSE"\s+\\\s+"\$\{PACKAGED_LICENSE_PATH\}"/,
    'the packaged direct license must be byte-identical to the pinned source license',
  );
  assert.match(buildRuns, /\bcmp\b[\s\S]*?binary-build-info/);
  const wrapperBuildStep = build.steps.find((step) => String(step.name).includes('one package-owned definition'));
  assert.equal(wrapperBuildStep?.env?.HAPPIER_VERSION, '${{ needs.prepare.outputs.version }}');
  assert.deepEqual(build.permissions, {});
  const attest = workflow.jobs?.attest_native;
  assert.ok(attest, 'expected trusted native attestation owner');
  assert.equal(attest.permissions?.['id-token'], 'write');
  assert.equal(attest.permissions?.attestations, 'write');
  assert.equal(attest.permissions?.['artifact-metadata'], 'write');
  assert.ok(
    attest.steps.some((step) => (
      usesPinnedPublishAction(step, 'actions/attest')
      && String(step.with?.['subject-path'] ?? '').split('\n').includes(
        'dist/attestation-leaf/happier-v${{ needs.prepare.outputs.version }}-${{ matrix.cli_target }}.tar.gz',
      )
    )),
    'the trusted artifact-only job must attest the exact archive the native builder produced',
  );
  const upload = build.steps.find((step) => usesPinnedPublishAction(step, 'actions/upload-artifact'));
  assert.equal(
    upload?.with?.name,
    'cli-native-${{ matrix.platform_key }}-${{ needs.prepare.outputs.version }}-${{ needs.prepare.outputs.source_sha }}',
  );
});

test('Apple release credentials exist only in the separate trusted Darwin finalizer', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const build = workflow.jobs?.build_native;
  const darwin = workflow.jobs?.finalize_darwin;
  assert.ok(build, 'expected build_native job');
  assert.ok(darwin, 'expected finalize_darwin job');

  const jobEnvironment = JSON.stringify(build.env ?? {});
  assert.doesNotMatch(
    jobEnvironment,
    /APPLE_(?:CERTIFICATE|CERTIFICATE_PASSWORD|API_KEY_ID|API_ISSUER_ID|API_PRIVATE_KEY)/,
    'Apple credentials must not be exposed to Linux/Windows matrix steps',
  );

  assert.doesNotMatch(JSON.stringify(build), /secrets\.APPLE_|setup-apple-codesigning/);
  assert.equal(darwin.environment, 'release-shared');
  const controlCheckout = darwin.steps.find((step) => usesPinnedPublishAction(step, 'actions/checkout'));
  assert.equal(controlCheckout?.with?.ref, '${{ job.workflow_sha }}');
  const secretBearingSteps = darwin.steps.filter((step) => (
    JSON.stringify(step.env ?? {}).includes('${{ secrets.APPLE_')
  ));
  assert.ok(secretBearingSteps.length > 0, 'expected macOS signing/notarization secret inputs');
  const signedCliBuild = darwin.steps.find((step) => String(step.name).includes(
    'Sign, notarize, and verify exact native CLI archive',
  ));
  assert.equal(
    signedCliBuild?.env?.APPLE_API_KEY_ID,
    '${{ secrets.APPLE_API_KEY_ID }}',
  );
  assert.equal(
    signedCliBuild?.env?.APPLE_API_ISSUER_ID,
    '${{ secrets.APPLE_API_ISSUER_ID }}',
  );
  assert.equal(
    signedCliBuild?.env?.APPLE_API_PRIVATE_KEY,
    '${{ secrets.APPLE_API_PRIVATE_KEY }}',
  );

  assert.match(String(signedCliBuild?.run ?? ''), /--refresh-cli-runtime-asset-manifest/);
  assert.match(String(signedCliBuild?.run ?? ''), /--verify-evidence/);
  assert.match(signedCliBuild.run, /for PRODUCT in happier happier-memory-runtime happier-voice-runtime happier-difftastic; do/);
  assert.match(signedCliBuild.run, /SUFFIX="\$PRODUCT"\s+if \[ "\$PRODUCT" = happier \]; then SUFFIX=cli; fi/);
  assert.match(signedCliBuild.run, /if \[ "\$PRODUCT" = happier \]; then\s+NOTARIZE_ARGS\+=\(--refresh-cli-runtime-asset-manifest\)/);
  const certificateImport = darwin.steps.find((step) => step.uses === './.github/actions/setup-apple-codesigning');
  assert.equal(certificateImport?.with?.certificate, '${{ secrets.APPLE_CERTIFICATE }}');
  assert.equal(certificateImport?.with?.['certificate-password'], '${{ secrets.APPLE_CERTIFICATE_PASSWORD }}');
  const certificateAction = await readFile(
    new URL('../../.github/actions/setup-apple-codesigning/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(certificateAction, /chmod 600 "\$\{cert_path\}"/);

  const cleanup = darwin.steps.find((step) => String(step.name).includes('Clean Apple signing material'));
  assert.equal(cleanup?.if, 'always()');
  assert.match(String(cleanup?.run ?? ''), /security delete-keychain/);
  assert.equal(cleanup?.env?.APPLE_KEYCHAIN_PATH, '${{ steps.apple_id.outputs.keychain-path }}');
  assert.equal(cleanup?.env?.APPLE_CERTIFICATE_PATH, '${{ steps.apple_id.outputs.certificate-path }}');
  assert.match(String(cleanup?.run ?? ''), /rm -f "\$APPLE_CERTIFICATE_PATH"/);
});

test('CLI binary publishing aggregates one exact source/version matrix before signing, attesting, and publishing', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const prepare = workflow.jobs?.prepare;
  const publish = workflow.jobs?.publish;
  assert.ok(prepare, 'expected prepare job');
  assert.ok(publish, 'expected publish job');
  assert.deepEqual(
    publish.needs,
    ['prepare', 'build_native', 'finalize_darwin', 'admit_publication'],
  );

  const prepareRuns = prepare.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(prepareRuns, /publish-cli-binaries[\s\S]*?--resolve-version-only[\s\S]*?--github-output "\$GITHUB_OUTPUT"/);
  assert.ok(prepare.outputs?.source_sha);
  assert.ok(prepare.outputs?.version);

  const publishCheckout = publish.steps.find((step) => usesPinnedPublishAction(step, 'actions/checkout'));
  assert.equal(publishCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.ok(publish.steps.some((step) => usesPinnedPublishAction(step, 'actions/download-artifact')));
  assert.equal(
    publish.steps.some((step) => usesPinnedPublishAction(step, 'actions/attest')),
    false,
    'the later aggregator must not claim that it built the native archives',
  );
  assert.equal(publish.permissions?.['id-token'], undefined);
  assert.equal(publish.permissions?.attestations, undefined);

  const publishRuns = publish.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(
    publishRuns,
    /publish-cli-binaries\.mjs[\s\S]*?--version "\$RELEASE_VERSION"[\s\S]*?--authorized-sha "\$AUTHORIZED_SHA"[\s\S]*?--prepared-artifacts[\s\S]*?--skip-smoke/,
  );
});

test('CLI candidate-only mode finalizes one signed native matrix without a GitHub Release write', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const candidateOnlyDispatch =
    workflow.on?.workflow_dispatch?.inputs?.candidate_only;
  const candidateOnlyCall =
    workflow.on?.workflow_call?.inputs?.candidate_only;
  assert.deepEqual(candidateOnlyDispatch, {
    description: 'Build and sign one candidate-native matrix without publishing GitHub Releases',
    required: true,
    default: false,
    type: 'boolean',
  });
  assert.equal(candidateOnlyCall, undefined, 'reusable callers must not create candidates');

  const jobs = workflow.jobs;
  const candidate = jobs?.finalize_candidate;
  assert.ok(candidate, 'expected finalize_candidate job');
  assert.deepEqual(candidate.needs, ['prepare', 'build_native', 'finalize_darwin']);
  assert.equal(
    candidate.if,
    "${{ inputs.retry_version == '' && inputs.resume_version == '' && inputs.candidate_only == true }}",
  );
  assert.equal(
    jobs.publish.if,
    "${{ always() && inputs.retry_version == '' && inputs.resume_version == '' && inputs.candidate_only != true && needs.admit_publication.result == 'success' }}",
  );
  assert.equal(
    jobs.promote_existing.if,
    "${{ inputs.retry_version != '' && inputs.resume_version == '' && inputs.candidate_only != true }}",
  );
  assert.equal(candidate.permissions?.contents, 'read');
  assert.equal(candidate.permissions?.['id-token'], undefined);
  assert.equal(candidate.permissions?.attestations, undefined);

  const versionStep = jobs.prepare.steps.find(
    (step) => step.name === 'Allocate one release version for the native matrix',
  );
  assert.equal(versionStep?.env?.CANDIDATE_ONLY, undefined);
  assert.match(
    String(versionStep?.run ?? ''),
    /if \[ -n "\$PROMOTE_CANDIDATE_VERSION" \][\s\S]*?else[\s\S]*?publish-cli-binaries[\s\S]*?--resolve-version-only/,
    'candidate creation must allocate the exact channel-qualified version that promotion will publish',
  );
  assert.doesNotMatch(
    String(versionStep?.run ?? ''),
    /apps\/cli\/package\.json|candidate_version=/,
    'dev and preview candidates must not use the unqualified package version',
  );

  const checkout = candidate.steps.find(
    (step) => usesPinnedPublishAction(step, 'actions/checkout'),
  );
  assert.equal(checkout?.with?.ref, '${{ job.workflow_sha }}');
  assert.ok(candidate.steps.some(
    (step) => usesPinnedPublishAction(step, 'actions/download-artifact'),
  ));
  const uploadSteps = candidate.steps.filter(
    (step) => usesPinnedPublishAction(step, 'actions/upload-artifact'),
  );
  assert.equal(uploadSteps.length, 1, 'candidate finalizer uploads one bounded matrix artifact');
  assert.equal(
    uploadSteps[0]?.with?.name,
    'cli-candidate-native-${{ inputs.channel }}-${{ needs.prepare.outputs.version }}-${{ needs.prepare.outputs.source_sha }}',
  );
  assert.equal(uploadSteps[0]?.with?.path, 'dist/release-assets/cli');
  assert.equal(uploadSteps[0]?.with?.['if-no-files-found'], 'error');

  const candidateRuns = candidate.steps
    .map((step) => String(step.run ?? ''))
    .join('\n');
  assert.match(
    candidateRuns,
    /find "\$ARTIFACTS_DIR" -maxdepth 1 -type f -name '\*\.tar\.gz'[\s\S]*?= "20"/,
  );
  assert.match(
    candidateRuns,
    /prepare-binary-assets\.mjs[\s\S]*?--finalize-prepared-only[\s\S]*?--artifacts-dir "\$\{GITHUB_WORKSPACE\}\/dist\/release-assets\/cli"/,
    'candidate-only mode must reuse the sole complete-matrix checker/checksum/signer',
  );
  assert.match(
    candidateRuns,
    /--require-all-artifacts-checksummed[\s\S]*?--require-signature/,
    'the signed candidate envelope must cover all notarization evidence and component envelopes as well as native archives',
  );
  assert.match(
    JSON.stringify(candidate.steps),
    /MINISIGN_SECRET_KEY.*secrets\.MINISIGN_SECRET_KEY/,
    'candidate-only mode must fail closed unless signing material is present',
  );
  assert.doesNotMatch(
    JSON.stringify(candidate),
    /create-github-app-token|GH_TOKEN|publish-cli-binaries|publish-release|promote-rolling/,
    'candidate-only mode must not contain a GitHub Release writer',
  );

  const guardSource = JSON.stringify(jobs.trusted_ref_guard);
  assert.match(guardSource, /CANDIDATE_ONLY/);
  assert.match(guardSource, /RETRY_VERSION/);
  assert.match(
    guardSource,
    /Candidate-only mode cannot promote an existing release/,
    'candidate-only plus retry must fail closed before any recovery publisher can run',
  );
  assert.match(guardSource, /Candidate-only mode requires a direct workflow dispatch/);
  const trustedRefStep = jobs.trusted_ref_guard.steps.find(
    (step) => step.name === 'Reject cross-repository or untrusted workflow control',
  );
  assert.equal(trustedRefStep?.env?.TOP_LEVEL_WORKFLOW_REF, '${{ github.workflow_ref }}');
  assert.match(guardSource, /Candidate-only mode cannot run through a reusable workflow caller/);
  assert.match(guardSource, /Candidate-only channel must match the workflow branch/);
  assert.match(guardSource, /dev:\$WORKFLOW_REPOSITORY\/\.github\/workflows\/publish-cli-binaries\.yml@refs\/heads\/dev/);
  assert.match(guardSource, /preview:\$WORKFLOW_REPOSITORY\/\.github\/workflows\/publish-cli-binaries\.yml@refs\/heads\/preview/);
  assert.match(guardSource, /stable:\$WORKFLOW_REPOSITORY\/\.github\/workflows\/publish-cli-binaries\.yml@refs\/heads\/main/);
  const candidateHeadGuard = jobs.prepare.steps.find(
    (step) => step.name === 'Enforce candidate source equals workflow head',
  );
  assert.ok(candidateHeadGuard);
  assert.equal(candidateHeadGuard?.if, 'inputs.candidate_only == true');
  assert.equal(candidateHeadGuard?.env?.GITHUB_WORKFLOW_HEAD_SHA, '${{ github.sha }}');
  assert.match(candidateHeadGuard?.run ?? '', /git -C \.candidate-source rev-parse HEAD/);
});

test('CLI publishing can promote one exact signed candidate run without rebuilding native targets', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);

  for (const inputName of ['candidate_run_id', 'candidate_version', 'candidate_source_sha']) {
    assert.equal(
      workflow.on?.workflow_dispatch?.inputs?.[inputName]?.type,
      'string',
      `manual CLI publishing must accept exact ${inputName}`,
    );
    assert.equal(
      workflow.on?.workflow_call?.inputs?.[inputName]?.type,
      'string',
      `reusable CLI publishing must accept exact ${inputName}`,
    );
  }
  const guardRuns = workflow.jobs.trusted_ref_guard.steps
    .map((step) => String(step.run ?? ''))
    .join('\n');
  assert.match(
    guardRuns,
    /Candidate promotion requires run ID, version, and source SHA together/,
    'partial candidate identity must fail before any build or publisher job',
  );
  assert.match(
    guardRuns,
    /Candidate-only mode cannot also promote a prior candidate/,
    'candidate creation and promotion must be mutually exclusive',
  );
  assert.match(
    guardRuns,
    /Candidate promotion cannot re-project an existing release/,
    'candidate promotion and immutable-release recovery must be mutually exclusive',
  );
  assert.match(guardRuns, /\^\[0-9\]\+\$/);
  assert.match(guardRuns, /\^\[0-9a-f\]\{40\}\$/);

  const prepare = workflow.jobs.prepare;
  const sourceCheckout = prepare.steps.find(
    (step) => step.name === 'Checkout exact source as inert data',
  );
  assert.equal(
    sourceCheckout?.with?.ref,
    "${{ inputs.candidate_source_sha != '' && inputs.candidate_source_sha || steps.channel_meta.outputs.source_ref }}",
  );
  assert.equal(sourceCheckout?.with?.path, '.candidate-source');
  const versionStep = prepare.steps.find(
    (step) => step.name === 'Allocate one release version for the native matrix',
  );
  assert.match(
    String(versionStep?.run ?? ''),
    /PROMOTE_CANDIDATE_VERSION[\s\S]*?echo "version=\$\{PROMOTE_CANDIDATE_VERSION\}"/,
    'candidate promotion must retain the version embedded in its native archives',
  );

  const build = workflow.jobs.build_native;
  assert.equal(
    build.if,
    "${{ inputs.retry_version == '' && inputs.resume_version == '' && inputs.candidate_run_id == '' }}",
    'selecting a prior candidate must make every native builder job unreachable',
  );

  const publish = workflow.jobs.publish;
  assert.deepEqual(
    publish.needs,
    ['prepare', 'build_native', 'finalize_darwin', 'admit_publication'],
  );
  assert.match(
    workflow.jobs.admit_publication.if,
    /inputs\.candidate_run_id != '' && needs\.build_native\.result == 'skipped' && needs\.finalize_darwin\.result == 'skipped'/,
    'secret-free admission must accept a prior candidate only when native building and signing stayed skipped',
  );
  assert.equal(publish.permissions?.actions, 'read');

  const provenanceStep = prepare.steps.find(
    (step) => step.name === 'Verify exact candidate run provenance',
  );
  assert.equal(provenanceStep?.if, "inputs.candidate_run_id != ''");
  assert.match(
    String(provenanceStep?.run ?? ''),
    /verify-github-candidate-run\.mjs[\s\S]*?--expected-workflow-path "\.github\/workflows\/publish-cli-binaries\.yml"[\s\S]*?--channel "\$RELEASE_CHANNEL"[\s\S]*?--expected-head-sha "\$CANDIDATE_SOURCE_SHA"[\s\S]*?--artifact-name "\$CANDIDATE_ARTIFACT_NAME"/,
    'promotion must bind the artifact to one successful producer run and its exact artifact name',
  );
  assert.equal(provenanceStep?.env?.RELEASE_CHANNEL, '${{ inputs.channel }}');
  assert.equal(provenanceStep?.env?.CANDIDATE_SOURCE_SHA, '${{ inputs.candidate_source_sha }}');
  assert.equal(
    provenanceStep?.env?.CANDIDATE_ARTIFACT_NAME,
    'cli-candidate-native-${{ inputs.channel }}-${{ inputs.candidate_version }}-${{ inputs.candidate_source_sha }}',
  );
  assert.equal(
    prepare.outputs?.candidate_artifact_id,
    '${{ steps.candidate_provenance.outputs.artifact_id }}',
  );

  const candidateDownload = publish.steps.find(
    (step) => step.name === 'Download exact signed candidate-native matrix',
  );
  assert.ok(
    usesPinnedPublishAction(candidateDownload, 'actions/download-artifact'),
    'candidate promotion must use the reviewed immutable artifact downloader',
  );
  assert.equal(candidateDownload?.if, "inputs.candidate_run_id != ''");
  assert.equal(
    candidateDownload?.with?.['artifact-ids'],
    '${{ needs.prepare.outputs.candidate_artifact_id }}',
    'download must use the immutable artifact ID admitted from the trusted run',
  );
  assert.equal(candidateDownload?.with?.['merge-multiple'], true);
  assert.equal(candidateDownload?.with?.['run-id'], '${{ inputs.candidate_run_id }}');
  assert.equal(candidateDownload?.with?.repository, '${{ github.repository }}');
  assert.equal(candidateDownload?.with?.['github-token'], '${{ github.token }}');

  const candidateVerification = publish.steps.find(
    (step) => step.name === 'Verify exact signed candidate-native matrix',
  );
  assert.equal(candidateVerification?.if, "inputs.candidate_run_id != ''");
  const verifyRuns = String(candidateVerification?.run ?? '');
  assert.match(verifyRuns, /-name '\*\.tar\.gz'[\s\S]*?= "20"/);
  assert.match(verifyRuns, /-name '\*\.json'[\s\S]*?= "8"/);
  assert.match(verifyRuns, /-type f[\s\S]*?= "36"/);
  assert.match(
    verifyRuns,
    /scripts\/pipeline\/release\/verify-artifacts\.mjs[\s\S]*?--public-key apps\/website\/public\/happier-release\.pub[\s\S]*?--require-all-artifacts-checksummed[\s\S]*?--require-signature[\s\S]*?--skip-smoke/,
    'trusted workflow-control bytes and key must verify every candidate payload before publication',
  );

  const candidateAssembly = publish.steps.find(
    (step) => step.name === 'Assemble exact promoted candidate envelope',
  );
  assert.equal(candidateAssembly?.if, "inputs.candidate_run_id != ''");
  assert.match(String(candidateAssembly?.run ?? ''), /cp -a "\$CANDIDATE_DATA_DIR\/\." "\$ARTIFACTS_DIR\/"/);
  assert.match(String(candidateAssembly?.run ?? ''), /-type f[\s\S]*?= "36"/);

  const publishRuns = publish.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.doesNotMatch(
    publishRuns,
    /release-build-cli-binaries|managed-runtime:build/,
    'the exact-candidate publisher must contain no native rebuild command',
  );
  const exactPublish = publish.steps.find(
    (step) => step.name === 'Publish authenticated exact candidate matrix',
  );
  assert.equal(exactPublish?.if, "inputs.candidate_run_id != ''");
  assert.match(
    String(exactPublish?.run ?? ''),
    /publish-cli-binaries\.mjs[\s\S]*?--version "\$RELEASE_VERSION"[\s\S]*?--authorized-sha "\$AUTHORIZED_SHA"[\s\S]*?--finalized-artifacts[\s\S]*?--skip-smoke/,
  );
  assert.doesNotMatch(
    JSON.stringify(exactPublish?.env ?? {}),
    /MINISIGN_SECRET_KEY|MINISIGN_PASSPHRASE/,
    'candidate promotion must have no signing key and therefore cannot re-sign the envelope',
  );

});

test('ordinary CI runs the pinned Go source on macOS, Linux, and Windows and compiles Windows arm64', async () => {
  const raw = await readFile(testsWorkflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const job = workflow.jobs?.['cliproxyapi-managed-runtime'];
  assert.ok(job, 'expected cliproxyapi-managed-runtime CI job');
  assert.deepEqual(job.needs, ['trusted_ref_guard']);
  assert.equal(
    workflow.jobs?.trusted_ref_guard?.outputs?.ubuntu_2404,
    '${{ steps.runner_pool.outputs.ubuntu_2404 }}',
    'the semantic Linux runner matrix must consume the trusted runner-pool owner',
  );
  assert.deepEqual(
    job.strategy?.matrix?.include?.map(({ platform_key, runner, go_target }) => ({
      platform_key,
      runner,
      go_target,
    })),
    [
      {
        platform_key: 'linux-amd64',
        runner: '${{ needs.trusted_ref_guard.outputs.ubuntu_2404 }}',
        go_target: 'linux-amd64',
      },
      { platform_key: 'darwin-arm64', runner: 'macos-15', go_target: 'darwin-arm64' },
      { platform_key: 'windows-amd64', runner: 'windows-2025', go_target: 'windows-amd64' },
      { platform_key: 'windows-arm64', runner: 'windows-2025', go_target: 'windows-arm64' },
    ],
  );
  const setupGo = job.steps.find((step) => usesAction(step, 'actions/setup-go'));
  assert.equal(setupGo?.with?.['go-version-file'], 'packages/plugins/cliproxyapi/managed-runtime/go.mod');
  assert.equal(setupGo?.with?.['cache-dependency-path'], 'packages/plugins/cliproxyapi/managed-runtime/go.sum');
  const runs = job.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(runs, /\bgo test \.\/\.\.\./);
  assert.match(runs, /\bgo vet \.\/\.\.\./);
  const sourceSecurity = job.steps.find(
    (step) => step.name === 'Run Linux race and reachable vulnerability checks',
  );
  assert.equal(sourceSecurity?.if, "matrix.platform_key == 'linux-amd64'");
  assert.equal(
    sourceSecurity?.['working-directory'],
    'packages/plugins/cliproxyapi/managed-runtime',
  );
  assert.match(String(sourceSecurity?.run ?? ''), /\bgo test -race -count=1 \.\/\.\.\./);
  assert.match(String(sourceSecurity?.run ?? ''), /\bgo tool govulncheck \.\/\.\.\./);
  assert.match(runs, /managed-runtime:build[\s\S]*?--target "\$\{\{ matrix\.go_target \}\}"/);
  assert.doesNotMatch(runs, /\bgo build\b/);
  const wrapperBuildStep = job.steps.find((step) => String(step.name).includes('one package-owned definition'));
  assert.equal(wrapperBuildStep?.env?.HAPPIER_VERSION, '0.0.0-ci');
});

test('the plugin package ships its managed runtime while the CLI payload remains the sole binary distributor', async () => {
  const packageRoot = fileURLToPath(new URL('../../packages/plugins/cliproxyapi/', import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts?.['managed-runtime:build'], 'go -C ./managed-runtime run ./tools/build');

  // `.happier-plugin/` is the projected plugin package: the manifest the daemon reads to
  // build catalogs without executing plugin code, plus the bundled daemon runtime that the
  // manifest itself points at. The daemon bundle lives here rather than in `dist/` so the
  // TypeScript compiler and the plugin bundler do not both own one output directory.
  assert.deepEqual(manifest.files, ['assets', 'dist', '.happier-plugin', 'package.json']);

  const projected = JSON.parse(await readFile(resolve(packageRoot, '.happier-plugin/plugin.json'), 'utf8'));
  const daemonEntrypoint = String(projected.entrypoints?.daemon ?? '');
  assert.equal(daemonEntrypoint, './.happier-plugin/daemon.js');

  const materialized = (await readdir(resolve(packageRoot, '.happier-plugin'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(
      resolve(packageRoot, '.happier-plugin'),
      resolve(entry.parentPath ?? entry.path, entry.name),
    ).split(sep).join('/'))
    .sort();
  // Only `plugin.json` is tracked here: `.gitignore` keeps the bundled runtime and its
  // chunks out of Git because the bundled-plugin publisher writes them at build time. This
  // job runs on a bare checkout, so requiring `daemon.js` on disk would assert the build
  // ran rather than the package shape. What the shape actually forbids is a Go binary,
  // archive, or build input becoming a second binary distribution surface, so every file
  // present must be a declared member: the projected manifest, the exact daemon entry that
  // manifest points at, one of that bundle's code-split chunks, or the canonical
  // daemon publisher's output-transition metadata retained after a local build.
  const declaredDaemonEntry = daemonEntrypoint.replace('./.happier-plugin/', '');
  assert.ok(materialized.includes('plugin.json'), 'the projected plugin manifest must be published');
  assert.deepEqual(
    materialized.filter((entry) => (
      entry !== 'plugin.json'
      && entry !== declaredDaemonEntry
      && entry !== '.happier-daemon-outputs.json'
      && !entry.startsWith('.happier-chunks/')
    )),
    [],
    'only the projected manifest, declared daemon outputs, and publisher metadata may be materialized here',
  );

  assert.equal(
    manifest.files.some((entry) => String(entry).includes('managed-runtime')),
    false,
    'Go source/build inputs must not become a second npm binary distribution surface',
  );
});
