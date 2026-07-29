import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

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

const PINNED_PUBLISH_ACTIONS = Object.freeze({
  'actions/attest': 'f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6',
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

function assertPathWithinRepository(repositoryRoot, candidatePath, use) {
  const relativePath = relative(repositoryRoot, candidatePath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`local action path is outside the repository: ${use}`);
  }
}

async function collectPublisherExternalActionUses(workflow, {
  repositoryRoot = repoRootPath,
} = {}) {
  const pendingUses = Object.values(workflow.jobs ?? {}).flatMap((job) => [
    job?.uses,
    ...(job?.steps ?? []).map((step) => step?.uses),
  ]);
  const inspectedLocalActions = new Set();
  const externalUses = [];

  while (pendingUses.length > 0) {
    const use = pendingUses.pop();
    if (typeof use !== 'string') continue;
    if (!use.startsWith('./')) {
      externalUses.push(use);
      continue;
    }
    const localActionPath = resolve(repositoryRoot, use, 'action.yml');
    assertPathWithinRepository(repositoryRoot, localActionPath, use);
    const [canonicalRepositoryRoot, canonicalLocalActionPath] = await Promise.all([
      realpath(repositoryRoot),
      realpath(localActionPath),
    ]);
    assertPathWithinRepository(canonicalRepositoryRoot, canonicalLocalActionPath, use);
    if (inspectedLocalActions.has(canonicalLocalActionPath)) continue;
    inspectedLocalActions.add(canonicalLocalActionPath);
    const localAction = YAML.parse(await readFile(canonicalLocalActionPath, 'utf8'));
    pendingUses.push(...(localAction.runs?.steps ?? []).map((step) => step?.uses));
  }

  return externalUses;
}

function assertPublisherExternalActionsPinned(externalUses) {
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

  return observedActions;
}

test('publisher action recursion rejects local action paths outside the repository', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'publisher-action-escape-'));
  const repositoryRoot = join(workspace, 'repo');
  const outsideActionDir = join(workspace, 'outside');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(outsideActionDir, { recursive: true });
  await writeFile(join(outsideActionDir, 'action.yml'), YAML.stringify({
    runs: { using: 'composite', steps: [] },
  }));
  await symlink(
    outsideActionDir,
    join(repositoryRoot, 'linked-action'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  try {
    await assert.rejects(
      collectPublisherExternalActionUses({
        jobs: { publish: { steps: [{ uses: './../outside' }] } },
      }, { repositoryRoot }),
      /outside the repository/,
    );
    await assert.rejects(
      collectPublisherExternalActionUses({
        jobs: { publish: { steps: [{ uses: './linked-action' }] } },
      }, { repositoryRoot }),
      /outside the repository/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('publisher action recursion visits aliased local-action cycles once', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'publisher-action-cycle-'));
  await mkdir(join(repositoryRoot, 'actions', 'a'), { recursive: true });
  await mkdir(join(repositoryRoot, 'actions', 'b'), { recursive: true });
  await writeFile(join(repositoryRoot, 'actions', 'a', 'action.yml'), YAML.stringify({
    runs: {
      using: 'composite',
      steps: [
        { uses: 'example/a@1111111111111111111111111111111111111111' },
        { uses: './actions/b' },
      ],
    },
  }));
  await writeFile(join(repositoryRoot, 'actions', 'b', 'action.yml'), YAML.stringify({
    runs: {
      using: 'composite',
      steps: [
        { uses: 'example/b@2222222222222222222222222222222222222222' },
        { uses: './actions/../actions/a' },
      ],
    },
  }));

  try {
    const externalUses = await collectPublisherExternalActionUses({
      jobs: { publish: { steps: [{ uses: './actions/a' }] } },
    }, { repositoryRoot });
    assert.deepEqual(externalUses.sort(), [
      'example/a@1111111111111111111111111111111111111111',
      'example/b@2222222222222222222222222222222222222222',
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('privileged CLI binary publishing pins every external action to its reviewed full commit SHA', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const externalUses = await collectPublisherExternalActionUses(workflow);
  const observedActions = assertPublisherExternalActionsPinned(externalUses);

  assert.deepEqual(
    [...observedActions].sort(),
    Object.keys(PINNED_PUBLISH_ACTIONS).sort(),
    'the pin inventory must cover every external action used by the privileged publisher',
  );
});

test('privileged CLI binary action policy rejects mutable and unapproved action refs', () => {
  assert.throws(
    () => assertPublisherExternalActionsPinned(['actions/setup-node@v4']),
    /full commit SHA/,
  );
  assert.throws(
    () => assertPublisherExternalActionsPinned([
      'unapproved/setup-node@1111111111111111111111111111111111111111',
    ]),
    /reviewed release commit/,
  );
});

test('managed wrapper source, diagnostics, notices, and workflows agree on exact Go 1.26.5', async () => {
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

  assert.match(goMod, /^go 1\.26\.5$/m);
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
  assert.match(buildSource, /Go 1\.26\.5 toolchain is required/);
  assert.match(notices, /^Go toolchain go1\.26\.5$/m);
  assert.match(notices, /^source identity: go1\.26\.5$/m);
  assert.match(notices, /^source: https:\/\/go\.dev\/dl\/go1\.26\.5\.src\.tar\.gz$/m);

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

  const checkout = build.steps.find((step) => usesPinnedPublishAction(step, 'actions/checkout'));
  assert.equal(checkout?.with?.ref, '${{ needs.prepare.outputs.source_sha }}');

  const setupGo = build.steps.find((step) => usesPinnedPublishAction(step, 'actions/setup-go'));
  assert.equal(setupGo?.with?.['go-version-file'], 'packages/plugins/cliproxyapi/managed-runtime/go.mod');
  assert.equal(setupGo?.with?.['cache-dependency-path'], 'packages/plugins/cliproxyapi/managed-runtime/go.sum');

  const buildRuns = build.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(buildRuns, /\bgo test \.\/\.\.\./);
  assert.match(buildRuns, /\bgo vet \.\/\.\.\./);
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
    /yarn workspace @happier-dev\/plugins-cliproxyapi managed-runtime:build[\s\S]*?--target "\$\{\{ matrix\.go_target \}\}"[\s\S]*?--output "\$\{WRAPPER_PATH\}"/,
  );
  assert.doesNotMatch(buildRuns, /\bgo build\b/, 'workflow must not create a second Go build definition');
  assert.match(buildRuns, /notarize-standalone-binary\.mjs/);
  assert.match(
    buildRuns,
    /release-build-cli-binaries[\s\S]*?--targets "\$\{\{ matrix\.cli_target \}\}"[\s\S]*?--cliproxyapi-managed-runtime-executable "\$\{WRAPPER_PATH\}"/,
  );
  const signedCliBuild = build.steps.find((step) => String(step.name).includes(
    'Build, sign, and notarize exact native CLI payload',
  ));
  assert.equal(signedCliBuild?.if, "matrix.platform_os == 'macos'");
  assert.match(
    String(signedCliBuild?.run ?? ''),
    /release-build-cli-binaries[\s\S]*?--macos-signing-identity "\$\{\{ steps\.apple_id\.outputs\.identity \}\}"[\s\S]*?--macos-notarization-output "dist\/notary\/\$\{\{ matrix\.platform_key \}\}\.cli\.json"/,
    'the complete staged payload must be Developer-ID signed and notarized before archive creation',
  );
  assert.equal(
    build.steps.some((step) => String(step.name).includes('Sign and notarize standalone wrapper')),
    false,
    'the managed wrapper must be signed once by the stage-wide Darwin payload owner',
  );
  const unsignedCliBuild = build.steps.find((step) => String(step.name).includes(
    'Build exact native CLI archive from the wrapper',
  ));
  assert.equal(unsignedCliBuild?.if, "matrix.platform_os != 'macos'");
  assert.match(
    buildRuns,
    /HAPPIER_CLIPROXYAPI_EXECUTABLE="\$\{PACKAGED_WRAPPER_PATH\}"\s+\\\s+HAPPIER_CLIPROXYAPI_WRAPPER_BUILD_VERSION="\$\{\{ needs\.prepare\.outputs\.version \}\}"\s+\\\s+go test \.\/conformance -run '\^TestPackagedWrapper\$' -count=1 -v/,
  );
  assert.match(
    packagedConformance,
    /"wrapperBuildVersion":\s+wrapperBuildVersion/,
    'packaged conformance must configure the exact compiled wrapper build version',
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
  assert.match(
    buildRuns,
    /PACKAGED_PAYLOAD_PATH="\$\{EXTRACT_DIR\}\/happier-v\$\{\{ needs\.prepare\.outputs\.version \}\}-\$\{\{ matrix\.cli_target \}\}"[\s\S]*?notarize-standalone-binary\.mjs[\s\S]*?--verify-evidence[\s\S]*?--payload "\$\{PACKAGED_PAYLOAD_PATH\}"[\s\S]*?--evidence "\$\{GITHUB_WORKSPACE\}\/dist\/notary\/\$\{\{ matrix\.platform_key \}\}\.cli\.json"/,
    'the exact extracted payload must be rebound to the stage-wide accepted notarization evidence',
  );
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
  assert.equal(build.permissions?.['id-token'], 'write');
  assert.equal(build.permissions?.attestations, 'write');
  assert.equal(build.permissions?.['artifact-metadata'], 'write');
  assert.ok(
    build.steps.some((step) => (
      usesPinnedPublishAction(step, 'actions/attest')
      && String(step.with?.['subject-path'] ?? '').endsWith(
        'happier-v${{ needs.prepare.outputs.version }}-${{ matrix.cli_target }}.tar.gz',
      )
    )),
    'the native builder job must attest the exact archive it produced',
  );
});

test('Apple release credentials are scoped only to macOS signing and notarization steps', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const build = workflow.jobs?.build_native;
  assert.ok(build, 'expected build_native job');

  const jobEnvironment = JSON.stringify(build.env ?? {});
  assert.doesNotMatch(
    jobEnvironment,
    /APPLE_(?:CERTIFICATE|CERTIFICATE_PASSWORD|API_KEY_ID|API_ISSUER_ID|API_PRIVATE_KEY)/,
    'Apple credentials must not be exposed to Linux/Windows matrix steps',
  );

  const secretBearingSteps = build.steps.filter((step) => (
    JSON.stringify(step.env ?? {}).includes('${{ secrets.APPLE_')
  ));
  assert.ok(secretBearingSteps.length > 0, 'expected macOS signing/notarization secret inputs');
  for (const step of secretBearingSteps) {
    assert.equal(
      step.if,
      "matrix.platform_os == 'macos'",
      `secret-bearing step must be macOS-only: ${step.name}`,
    );
  }
  const signedCliBuild = build.steps.find((step) => String(step.name).includes(
    'Build, sign, and notarize exact native CLI payload',
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

  const certificateImport = build.steps.find((step) => String(step.name).includes('Import Apple codesigning certificate'));
  assert.match(String(certificateImport?.run ?? ''), /chmod 600 "\$\{cert_path\}"/);

  const cleanup = build.steps.find((step) => String(step.name).includes('Clean Apple signing material'));
  assert.equal(cleanup?.if, "always() && matrix.platform_os == 'macos'");
  assert.match(String(cleanup?.run ?? ''), /security delete-keychain/);
  assert.match(String(cleanup?.run ?? ''), /rm -f "\$\{RUNNER_TEMP\}\/apple-cert\.p12"/);
});

test('CLI binary publishing aggregates one exact source/version matrix before signing, attesting, and publishing', async () => {
  const raw = await readFile(workflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const prepare = workflow.jobs?.prepare;
  const publish = workflow.jobs?.publish;
  assert.ok(prepare, 'expected prepare job');
  assert.ok(publish, 'expected publish job');
  assert.equal(publish.needs?.includes('build_native'), true);

  const prepareRuns = prepare.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(prepareRuns, /publish-cli-binaries[\s\S]*?--resolve-version-only[\s\S]*?--github-output "\$GITHUB_OUTPUT"/);
  assert.ok(prepare.outputs?.source_sha);
  assert.ok(prepare.outputs?.version);

  const publishCheckout = publish.steps.find((step) => usesPinnedPublishAction(step, 'actions/checkout'));
  assert.equal(publishCheckout?.with?.ref, '${{ needs.prepare.outputs.source_sha }}');
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
    /publish-cli-binaries[\s\S]*?--version "\$\{\{ needs\.prepare\.outputs\.version \}\}"[\s\S]*?--prepared-artifacts/,
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
  assert.deepEqual(candidateOnlyCall, {
    required: false,
    default: false,
    type: 'boolean',
  });

  const jobs = workflow.jobs;
  const candidate = jobs?.finalize_candidate;
  assert.ok(candidate, 'expected finalize_candidate job');
  assert.deepEqual(candidate.needs, ['prepare', 'build_native']);
  assert.equal(
    candidate.if,
    "${{ inputs.retry_version == '' && inputs.candidate_only == true }}",
  );
  assert.equal(
    jobs.publish.if,
    "${{ inputs.retry_version == '' && inputs.candidate_only != true }}",
  );
  assert.equal(
    jobs.promote_existing.if,
    "${{ inputs.retry_version != '' && inputs.candidate_only != true }}",
  );
  assert.equal(candidate.permissions?.contents, 'read');
  assert.equal(candidate.permissions?.['id-token'], undefined);
  assert.equal(candidate.permissions?.attestations, undefined);

  const versionStep = jobs.prepare.steps.find(
    (step) => step.name === 'Allocate one release version for the native matrix',
  );
  assert.equal(versionStep?.env?.CANDIDATE_ONLY, '${{ inputs.candidate_only }}');
  assert.match(
    String(versionStep?.run ?? ''),
    /if \[ "\$CANDIDATE_ONLY" = "true" \][\s\S]*?apps\/cli\/package\.json[\s\S]*?echo "version=\$\{candidate_version\}" >> "\$GITHUB_OUTPUT"[\s\S]*?else[\s\S]*?--resolve-version-only/,
    'candidate-native artifacts must keep the exact package version consumed by the candidate builder',
  );

  const checkout = candidate.steps.find(
    (step) => usesPinnedPublishAction(step, 'actions/checkout'),
  );
  assert.equal(checkout?.with?.ref, '${{ needs.prepare.outputs.source_sha }}');
  assert.ok(candidate.steps.some(
    (step) => usesPinnedPublishAction(step, 'actions/download-artifact'),
  ));
  const uploadSteps = candidate.steps.filter(
    (step) => usesPinnedPublishAction(step, 'actions/upload-artifact'),
  );
  assert.equal(uploadSteps.length, 1, 'candidate finalizer uploads one bounded matrix artifact');
  assert.equal(
    uploadSteps[0]?.with?.name,
    'cli-candidate-native-${{ needs.prepare.outputs.version }}-${{ needs.prepare.outputs.source_sha }}',
  );
  assert.equal(uploadSteps[0]?.with?.path, 'dist/candidate-native-matrix');
  assert.equal(uploadSteps[0]?.with?.['if-no-files-found'], 'error');

  const candidateRuns = candidate.steps
    .map((step) => String(step.run ?? ''))
    .join('\n');
  assert.match(
    candidateRuns,
    /test "\$\(find dist\/candidate-native-matrix -maxdepth 1 -type f -name '\*\.tar\.gz' \| wc -l \| tr -d ' '\)" = "5"/,
  );
  assert.match(candidateRuns, /darwin-x64\.cli\.json/);
  assert.match(candidateRuns, /darwin-arm64\.cli\.json/);
  assert.match(
    candidateRuns,
    /prepare-binary-assets\.mjs[\s\S]*?--finalize-prepared-only[\s\S]*?--artifacts-dir dist\/candidate-native-matrix/,
    'candidate-only mode must reuse the sole complete-matrix checker/checksum/signer',
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
});

test('ordinary CI runs the pinned Go source on macOS, Linux, and Windows and compiles Windows arm64', async () => {
  const raw = await readFile(testsWorkflowPath, 'utf8');
  const workflow = YAML.parse(raw);
  const job = workflow.jobs?.['cliproxyapi-managed-runtime'];
  assert.ok(job, 'expected cliproxyapi-managed-runtime CI job');
  assert.deepEqual(
    job.strategy?.matrix?.include?.map(({ platform_key, runner, go_target }) => ({
      platform_key,
      runner,
      go_target,
    })),
    [
      { platform_key: 'linux-amd64', runner: 'ubuntu-24.04', go_target: 'linux-amd64' },
      { platform_key: 'darwin-arm64', runner: 'macos-15', go_target: 'darwin-arm64' },
      { platform_key: 'windows-amd64', runner: 'windows-2025', go_target: 'windows-amd64' },
      { platform_key: 'windows-arm64', runner: 'windows-2025', go_target: 'windows-arm64' },
    ],
  );
  const setupGo = job.steps.find((step) => step.uses === 'actions/setup-go@v6');
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

test('the plugin package exposes one Go build command while CLI payload remains the sole binary distributor', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../../packages/plugins/cliproxyapi/package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(manifest.scripts?.['managed-runtime:build'], 'go -C ./managed-runtime run ./tools/build');
  assert.deepEqual(manifest.files, ['dist', 'package.json']);
  assert.equal(
    manifest.files.some((entry) => String(entry).includes('managed-runtime')),
    false,
    'Go source/build inputs must not become a second npm binary distribution surface',
  );
});
