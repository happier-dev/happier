import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as candidateBrowserQa from './run-packed-candidate-browser-qa.mjs';
import {
  buildPackedCandidateBrowserQaInvocation,
  requirePackedCandidateBrowserQaInputs,
} from './run-packed-candidate-browser-qa.mjs';

function triageGithubVoiceHandoffFixture() {
  return {
    schemaVersion: 1,
    kind: 'happier_triage_github_voice_qa_handoff_v1',
    candidate: {
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.3.1',
        integrity: 'sha512-sdk-candidate',
      },
      pluginUi: {
        packageName: '@happier-dev/plugin-ui',
        version: '0.3.1',
        pluginSdkVersion: '0.3.1',
        integrity: 'sha512-plugin-ui-candidate',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.9.4',
        integrity: 'sha512-cli-candidate',
      },
    },
    github: {
      token: 'github_pat_real_credential',
      scopeTitle: 'happier-dev/ucx-live-qa',
      issueA: { title: 'UCX live issue A' },
      issueB: { title: 'UCX live issue B' },
    },
    voice: {
      providerId: 'happier.voice.openai/realtime-openai',
      optionId: 'byo',
      credentialSlotId: 'api_key',
      credential: 'sk-real-voice-credential',
      microphoneFixturePath: '/handoff/open-issue-b.wav',
    },
  };
}

function triageGithubLocalAgentVoiceHandoffFixture() {
  return {
    schemaVersion: 2,
    kind: 'happier_triage_github_voice_qa_handoff_v1',
    candidate: {
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.3.1',
        integrity: 'sha512-sdk-candidate',
      },
      pluginUi: {
        packageName: '@happier-dev/plugin-ui',
        version: '0.3.1',
        pluginSdkVersion: '0.3.1',
        integrity: 'sha512-plugin-ui-candidate',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.9.4',
        integrity: 'sha512-cli-candidate',
      },
    },
    github: {
      token: 'github_pat_real_credential',
      scopeTitle: 'happier-dev/ucx-live-qa',
      issueA: { title: 'UCX live issue A' },
      issueB: { title: 'UCX live issue B' },
    },
    voice: {
      adapterId: 'local_conversation',
      conversationMode: 'agent',
      agentId: 'claude',
      sttProviderId: 'happier.voice.openai-compat/stt',
      microphoneFixturePath: '/handoff/open-issue-b.wav',
    },
  };
}

test('candidate browser QA command fails closed when no exact package artifact basis is supplied', () => {
  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: [],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_artifact_basis_required/u,
  );
});

test('candidate browser QA requires the normal Triage/GitHub Voice handoff and always runs the packed targeted projection', () => {
  const inputs = requirePackedCandidateBrowserQaInputs({
    argv: [
      '--candidate',
      '../../.project/tmp/candidate.json',
      '--novel-handoff',
      '../../.project/tmp/packed-novel-connected-account-qa.json',
      '--triage-github-voice-handoff',
      '../../.project/tmp/triage-github-voice-qa.json',
    ],
    env: {},
    cwd: '/workspace/packages/tests',
  });
  assert.deepEqual(inputs, {
    artifactBasis: 'candidate_manifest',
    manifestPath: '/workspace/.project/tmp/candidate.json',
    novelHandoffManifestPath:
      '/workspace/.project/tmp/packed-novel-connected-account-qa.json',
    triageGithubVoiceHandoffManifestPath:
      '/workspace/.project/tmp/triage-github-voice-qa.json',
  });

  assert.deepEqual(buildPackedCandidateBrowserQaInvocation({
    testsPackageRoot: '/workspace/packages/tests',
    ...inputs,
    processExecPath: '/runtime/node',
  }), {
    command: '/runtime/node',
    args: [
      '/workspace/packages/tests/scripts/run-playwright-with-heartbeat.mjs',
      '--config',
      'playwright.ui.config.mjs',
      'settings.plugins.details.spec.ts',
      'plugin.packed-targeted-projection.spec.ts',
    ],
    cwd: '/workspace/packages/tests',
    envPatch: {
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/workspace/.project/tmp/candidate.json',
      HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
        '/workspace/.project/tmp/packed-novel-connected-account-qa.json',
      HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
        '/workspace/.project/tmp/triage-github-voice-qa.json',
    },
  });
});

test('row-local UCX web proof accepts one exact SDK, Plugin UI, and CLI trio without a global candidate manifest', () => {
  const inputs = requirePackedCandidateBrowserQaInputs({
    argv: [
      '--sdk-tarball',
      '../../.project/ucx/sdk.tgz',
      '--plugin-ui-tarball',
      '../../.project/ucx/plugin-ui.tgz',
      '--cli-tarball',
      '../../.project/ucx/cli.tgz',
      '--triage-github-voice-handoff',
      '../../.project/ucx/triage-github-voice-qa.json',
    ],
    env: {},
    cwd: '/workspace/packages/tests',
  });
  assert.deepEqual(inputs, {
    artifactBasis: 'row_local_natural',
    sdkTarballPath: '/workspace/.project/ucx/sdk.tgz',
    pluginUiTarballPath: '/workspace/.project/ucx/plugin-ui.tgz',
    cliTarballPath: '/workspace/.project/ucx/cli.tgz',
    triageGithubVoiceHandoffManifestPath:
      '/workspace/.project/ucx/triage-github-voice-qa.json',
  });

  assert.deepEqual(buildPackedCandidateBrowserQaInvocation({
    testsPackageRoot: '/workspace/packages/tests',
    ...inputs,
    processExecPath: '/runtime/node',
  }), {
    command: '/runtime/node',
    args: [
      '/workspace/packages/tests/scripts/run-playwright-with-heartbeat.mjs',
      '--config',
      'playwright.ui.config.mjs',
      'plugin.packed-targeted-projection.spec.ts',
    ],
    cwd: '/workspace/packages/tests',
    envPatch: {
      HAPPIER_E2E_UCX_WEB_SDK_TARBALL: '/workspace/.project/ucx/sdk.tgz',
      HAPPIER_E2E_UCX_WEB_PLUGIN_UI_TARBALL:
        '/workspace/.project/ucx/plugin-ui.tgz',
      HAPPIER_E2E_UCX_WEB_CLI_TARBALL: '/workspace/.project/ucx/cli.tgz',
      HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
        '/workspace/.project/ucx/triage-github-voice-qa.json',
    },
  });
});

test('row-local UCX web proof rejects partial trios and candidate/natural split brains', () => {
  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: [
        '--sdk-tarball',
        '/row/sdk.tgz',
        '--plugin-ui-tarball',
        '/row/plugin-ui.tgz',
        '--triage-github-voice-handoff',
        '/row/triage.json',
      ],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_row_local_artifacts_required/u,
  );

  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: [
        '--candidate',
        '/candidate/candidate.json',
        '--sdk-tarball',
        '/row/sdk.tgz',
        '--novel-handoff',
        '/candidate/novel.json',
        '--triage-github-voice-handoff',
        '/row/triage.json',
      ],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_artifact_basis_conflict/u,
  );
});

test('candidate browser QA fails before Playwright when the mandatory normal Triage/GitHub Voice handoff is absent', () => {
  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: [
        '--candidate',
        '/candidate/candidate.json',
        '--novel-handoff',
        '/candidate/packed-novel-connected-account-qa.json',
      ],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_triage_github_voice_blocked_handoff_required/u,
  );

  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: [],
      env: {
        HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/candidate/candidate.json',
        HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
          '/candidate/packed-novel-connected-account-qa.json',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST: '   ',
      },
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_triage_github_voice_blocked_handoff_value_required/u,
  );
});

test('normal Triage/GitHub Voice handoff is exact-candidate bound and rejects fixture providers', () => {
  const parseHandoff = candidateBrowserQa.parsePackedTriageGithubVoiceQaHandoff;
  const assertCandidate = candidateBrowserQa.assertPackedTriageGithubVoiceQaCandidate;
  assert.equal(typeof parseHandoff, 'function');
  assert.equal(typeof assertCandidate, 'function');

  const fixture = triageGithubVoiceHandoffFixture();
  const handoff = parseHandoff(JSON.stringify(fixture));
  assert.deepEqual(handoff, fixture);

  assert.equal(assertCandidate({
    handoff,
    candidate: {
      sdk: fixture.candidate.sdk,
      pluginUi: fixture.candidate.pluginUi,
      cli: fixture.candidate.cli,
    },
  }), handoff);
  assert.throws(
    () => assertCandidate({
      handoff,
      candidate: {
        sdk: fixture.candidate.sdk,
        pluginUi: fixture.candidate.pluginUi,
        cli: {
          ...fixture.candidate.cli,
          integrity: 'sha512-different-cli-candidate',
        },
      },
    }),
    /packed_triage_github_voice_browser_qa_blocked_candidate_mismatch/u,
  );

  const fixtureProvider = structuredClone(fixture);
  fixtureProvider.voice.providerId =
    'examples.packed-targeted-projection-contributor/packed-conversation';
  assert.throws(
    () => parseHandoff(JSON.stringify(fixtureProvider)),
    /packed_triage_github_voice_browser_qa_blocked_handoff_invalid/u,
  );
});

test('normal Triage/GitHub Local Agent Voice is a versioned handoff that retains the v1 Realtime contract', () => {
  const parseHandoff = candidateBrowserQa.parsePackedTriageGithubVoiceQaHandoff;
  const fixture = triageGithubLocalAgentVoiceHandoffFixture();

  assert.deepEqual(parseHandoff(JSON.stringify(triageGithubVoiceHandoffFixture())),
    triageGithubVoiceHandoffFixture());
  assert.deepEqual(parseHandoff(JSON.stringify(fixture)), fixture);

  const wrongAdapter = structuredClone(fixture);
  wrongAdapter.voice.adapterId = 'examples.packed-targeted-projection-contributor/packed-conversation';
  assert.throws(
    () => parseHandoff(JSON.stringify(wrongAdapter)),
    /packed_triage_github_voice_browser_qa_blocked_handoff_invalid/u,
  );

  const wrongMode = structuredClone(fixture);
  wrongMode.voice.conversationMode = 'direct_session';
  assert.throws(
    () => parseHandoff(JSON.stringify(wrongMode)),
    /packed_triage_github_voice_browser_qa_blocked_handoff_invalid/u,
  );
});

test('only the schema-v2 Local Agent handoff can satisfy the packed browser completion row', () => {
  const parseHandoff = candidateBrowserQa.parsePackedTriageGithubVoiceQaHandoff;
  const assertCompletion =
    candidateBrowserQa.assertPackedTriageGithubVoiceQaCompletionHandoff;
  assert.equal(typeof assertCompletion, 'function');

  const realtimeSupplement = parseHandoff(JSON.stringify(triageGithubVoiceHandoffFixture()));
  const localAgentCompletion = parseHandoff(
    JSON.stringify(triageGithubLocalAgentVoiceHandoffFixture()),
  );

  assert.throws(
    () => assertCompletion(realtimeSupplement),
    /packed_triage_github_voice_browser_qa_blocked_local_agent_handoff_required/u,
  );
  assert.equal(assertCompletion(localAgentCompletion), localAgentCompletion);
});

test('Local Agent handoff selects the normal-product Local Agent browser recipe', () => {
  const fixture = triageGithubLocalAgentVoiceHandoffFixture();
  const invocation = buildPackedCandidateBrowserQaInvocation({
    testsPackageRoot: '/workspace/packages/tests',
    artifactBasis: 'candidate_manifest',
    manifestPath: '/candidate/candidate.json',
    novelHandoffManifestPath: '/candidate/packed-novel-connected-account-qa.json',
    triageGithubVoiceHandoffManifestPath: '/candidate/triage-github-voice-qa.json',
    triageGithubVoiceMicrophoneFixturePath: fixture.voice.microphoneFixturePath,
    triageGithubVoiceAdapter: 'local_agent',
    processExecPath: '/runtime/node',
  });

    assert.equal(
    invocation.envPatch.HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ADAPTER,
    'local_agent',
  );
  assert.equal(
    invocation.envPatch.HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH,
    fixture.voice.microphoneFixturePath,
  );
});

test('normal Triage/GitHub Voice row derives its fake microphone only from the exact handoff', async () => {
  const loadHandoff = candidateBrowserQa.loadPackedTriageGithubVoiceQaHandoff;
  assert.equal(typeof loadHandoff, 'function');

  const handoffRoot = await mkdtemp(join(tmpdir(), 'packed-triage-github-voice-'));
  const manifestPath = join(handoffRoot, 'triage-github-voice-qa.json');
  const microphoneFixturePath = join(handoffRoot, 'open-issue-b.wav');
  try {
    const fixture = triageGithubVoiceHandoffFixture();
    fixture.voice.microphoneFixturePath = microphoneFixturePath;
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(fixture), 'utf8'),
      writeFile(microphoneFixturePath, 'real prerecorded open issue B audio', 'utf8'),
    ]);

    const handoff = await loadHandoff({ manifestPath });
    assert.equal(handoff.voice.microphoneFixturePath, microphoneFixturePath);
    assert.equal(buildPackedCandidateBrowserQaInvocation({
      testsPackageRoot: '/workspace/packages/tests',
      manifestPath: '/candidate/candidate.json',
      novelHandoffManifestPath: '/candidate/packed-novel-connected-account-qa.json',
      triageGithubVoiceHandoffManifestPath: manifestPath,
      triageGithubVoiceMicrophoneFixturePath: microphoneFixturePath,
      processExecPath: '/runtime/node',
    }).envPatch.HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH, microphoneFixturePath);

    await rm(microphoneFixturePath);
    await assert.rejects(
      () => loadHandoff({ manifestPath }),
      /packed_triage_github_voice_browser_qa_blocked_microphone_fixture_unavailable/u,
    );
  } finally {
    await rm(handoffRoot, { recursive: true, force: true });
  }
});

test('candidate browser QA command requires the exact packed novel handoff', () => {
  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: ['--candidate', '/candidate/candidate.json'],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_novel_handoff_required/u,
  );
});

test('candidate browser QA command accepts the canonical candidate and novel handoff environment variables', () => {
  assert.deepEqual(requirePackedCandidateBrowserQaInputs({
    argv: [],
    env: {
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/candidate/candidate.json',
      HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
        '/candidate/packed-novel-connected-account-qa.json',
      HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
        '/candidate/triage-github-voice-qa.json',
  },
  cwd: '/workspace/packages/tests',
  }), {
    artifactBasis: 'candidate_manifest',
    manifestPath: '/candidate/candidate.json',
    novelHandoffManifestPath:
      '/candidate/packed-novel-connected-account-qa.json',
    triageGithubVoiceHandoffManifestPath:
      '/candidate/triage-github-voice-qa.json',
  });
});

test('packed novel OAuth stays in the real browser and disables secret-bearing Playwright artifacts', () => {
  const specSource = readFileSync(
    new URL(
      '../../suites/ui-e2e/settings.plugins.details.spec.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const configSource = readFileSync(
    new URL('../../playwright.ui.config.mjs', import.meta.url),
    'utf8',
  );

  assert.equal(specSource.includes("waitForEvent('requestfailed'"), true);
  assert.match(specSource, /net::ERR_CONNECTION_REFUSED/u);
  assert.equal(specSource.includes('page.request'), false);
  assert.equal(
    specSource.includes('packedNovelConnectedAccount.isolation.root'),
    true,
  );
  assert.equal(
    specSource.includes('strict: true'),
    true,
  );
  assert.match(
    specSource,
    /rootPath:\s*testDir,\s*sensitiveValues:\s*\[\s*oauthClientSecret,\s*'oauth:oauth-account',?\s*\],\s*strict:\s*true/u,
  );
  assert.match(
    specSource,
    /rootPath:\s*packedNovelConnectedAccount\.isolation\.root,\s*sensitiveValues:\s*\[\s*oauthClientSecret,\s*'oauth:oauth-account',?\s*\],\s*strict:\s*true/u,
  );
  assert.match(configSource, /packedNovelHandoffEnabled/u);
  assert.match(
    configSource,
    /const credentialedHandoffEnabled\s*=\s*packedNovelHandoffEnabled/u,
  );
  assert.match(configSource, /trace:\s*credentialedHandoffEnabled\s*\?\s*'off'/u);
  assert.match(configSource, /screenshot:\s*credentialedHandoffEnabled\s*\?\s*'off'/u);
  assert.match(configSource, /video:\s*credentialedHandoffEnabled\s*\?\s*'off'/u);
});

test('normal Triage/GitHub Voice keeps the microphone and credential artifacts bound to its handoff', () => {
  const configSource = readFileSync(
    new URL('../../playwright.ui.config.mjs', import.meta.url),
    'utf8',
  );

  assert.match(
    configSource,
    /HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST/u,
  );
  assert.match(
    configSource,
    /HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH/u,
  );
  assert.match(
    configSource,
    /packed_triage_github_voice_browser_qa_blocked_microphone_fixture_required/u,
  );
  assert.match(configSource, /--use-file-for-fake-audio-capture=\$\{/u);
  assert.match(configSource, /credentialedHandoffEnabled/u);
  assert.match(configSource, /trace:\s*credentialedHandoffEnabled\s*\?\s*'off'/u);
  assert.match(configSource, /screenshot:\s*credentialedHandoffEnabled\s*\?\s*'off'/u);
  assert.match(configSource, /video:\s*credentialedHandoffEnabled\s*\?\s*'off'/u);
});

test('candidate browser QA composes qualified collision accounts into the managed Provider chooser', () => {
  const specSource = readFileSync(
    new URL(
      '../../suites/ui-e2e/settings.plugins.details.spec.ts',
      import.meta.url,
    ),
    'utf8',
  );

  for (const fixture of [
    'connectedAccountsConformanceProducer',
    'connectedAccountsCollisionPeer',
  ]) {
    assert.equal(specSource.includes(fixture), true);
  }
  for (const pluginId of [
    'acme.connected-accounts-conformance-producer',
    'acme.connected-accounts-collision-peer',
  ]) {
    assert.equal(specSource.includes(pluginId), true);
  }
  assert.match(specSource, /decideAuthenticatedPluginInstallReview/u);
  assert.match(specSource, /pluginId:\s*'acme\.connected-accounts-conformance-producer'[\s\S]+localId:\s*'vault'/u);
  assert.match(specSource, /pluginId:\s*'acme\.connected-accounts-collision-peer'[\s\S]+localId:\s*'vault'/u);
  assert.equal(specSource.includes('provider-connection-managed-purpose-chooser:upstream'), true);
  for (const label of [
    'Novel account-a',
    'Novel account-b',
    'Packed fallback accounts',
  ]) {
    assert.equal(specSource.includes(label), true);
  }
});

test('packed targeted browser QA makes current-client navigation, provider tool privacy, and lifecycle retirement discriminating', () => {
  const specSource = readFileSync(
    new URL(
      '../../suites/ui-e2e/plugin.packed-targeted-projection.spec.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const clientRuntimeSource = readFileSync(
    new URL(
      '../../fixtures/plugin-platform/packed-targeted-contribution-projection/contributor/src/clientRuntime.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const packedCandidateBrowserQaSource = readFileSync(
    new URL(
      '../../src/testkit/pluginPlatform/packedCandidateBrowserQa.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.equal(
    specSource.includes("const secondClientDistinctPath = '/settings/voice/privacy?happier_hmr=0';"),
    true,
  );
  assert.match(
    specSource,
    /secondPage,[\s\S]+?secondClientDistinctPath/u,
  );
  assert.equal(
    specSource.includes("toHaveText('page:ui', { timeout: 120_000 })"),
    true,
  );
  assert.match(
    specSource,
    /const assertSecondClientPrivacyBaseline = async \(\) => \{[\s\S]+?new URL\(secondPage\.url\(\)\)[\s\S]+?settings\.voice\.section\.privacy/u,
  );
  assert.match(
    specSource,
    /packed-targeted-context-result[\s\S]+?toHaveText\('page:ui', \{ timeout: 120_000 \}\)[\s\S]+?assertSecondClientPrivacyBaseline\(\);/u,
  );
  assert.match(
    clientRuntimeSource,
    /const applyLocalEffect: PluginClientActionHandler = async \(_input, context\) => \{[\s\S]+?context\.ui\.openSurface\([\s\S]+?'packed-provider-page',[\s\S]+?subPath: 'local-effect',[\s\S]+?signal: context\.signal/u,
  );
  assert.match(
    clientRuntimeSource,
    /api\.actions\.register\('apply-local-effect', applyLocalEffect\);/u,
  );
  assert.match(
    specSource,
    /packed-targeted-writes-local-action[\s\S]+?web-modal-confirm[\s\S]+?expectedPathname:\s*localEffectPath[\s\S]+?assertSecondClientPrivacyBaseline\(\);[\s\S]+?page\.goBack\([\s\S]+?expectedPathname:\s*contributorPagePathname[\s\S]+?assertSecondClientPrivacyBaseline\(\);/u,
  );
  assert.match(
    specSource,
    /PACKED_VOICE_CURRENT_UI_TOOLS_OFF_TEXT/u,
  );
  assert.match(
    specSource,
    /PACKED_VOICE_CURRENT_UI_TOOLS_AVAILABLE_TEXT/u,
  );
  assert.equal(
    (specSource.match(/await assertContributorRetirement\(\);/g) ?? []).length,
    3,
  );
  assert.equal(
    (specSource.match(/await exerciseLiveContributor\(\);/g) ?? []).length,
    3,
  );
  assert.match(
    specSource,
    /const exerciseLiveContributor = async \(\) => \{[\s\S]+?packed-targeted-context-action[\s\S]+?packed-targeted-context-result[\s\S]+?voice-surface-toggle:sidebar[\s\S]+?PACKED_VOICE_COMPLETION_TEXT/u,
  );
  assert.match(
    specSource,
    /const assertContributorRetirement = async \(\) => \{[\s\S]+?plugin-app-page-unavailable[\s\S]+?packed-targeted-context-action[\s\S]+?voice-surface-status:sidebar:disconnected[\s\S]+?VOICE_PROVIDER_ROW_TEST_ID/u,
  );
  assert.match(specSource, /kind:\s*'forgetTrust'/u);
  const forgetTrustOffset = specSource.indexOf('await forgetPluginTrust({');
  const disableOffset = specSource.indexOf("args: ['plugins', 'disable'");
  const enableOffset = specSource.indexOf("args: ['plugins', 'enable'");
  const reinstalledV2Offset = specSource.lastIndexOf(
    'archivePath: archives.contributorV2ArchivePath',
  );
  const uninstallOffset = specSource.indexOf("args: ['plugins', 'uninstall'");
  assert.ok(disableOffset >= 0 && enableOffset > disableOffset);
  assert.ok(forgetTrustOffset > enableOffset);
  assert.ok(reinstalledV2Offset > forgetTrustOffset);
  assert.ok(uninstallOffset > reinstalledV2Offset);
  const finalRetirementOffset = specSource.lastIndexOf('await assertContributorRetirement();');
  const loadedModuleObserverOffset = specSource.lastIndexOf(
    'const rowLoadedModuleResponses = observeLoadedBrowserModuleResponses(page);',
  );
  const firstRowNavigationOffset = specSource.indexOf(
    "buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0')",
    loadedModuleObserverOffset,
  );
  const loadedModuleAttestationOffset = specSource.lastIndexOf(
    'await attestLoadedBrowserModules(',
  );
  const resultArtifactOffset = specSource.lastIndexOf(
    "artifactName: 'packed-targeted-projection.result.json'",
  );
  assert.ok(finalRetirementOffset > uninstallOffset);
  assert.ok(
    loadedModuleObserverOffset >= 0
      && firstRowNavigationOffset > loadedModuleObserverOffset,
  );
  assert.ok(finalRetirementOffset > firstRowNavigationOffset);
  assert.ok(loadedModuleAttestationOffset > finalRetirementOffset);
  assert.ok(resultArtifactOffset > finalRetirementOffset);
  assert.match(
    specSource,
    /attestLoadedBrowserModules\(\s*page,\s*await rowLoadedModuleResponses\.observedResponses\(\),\s*\)/u,
  );
  assert.match(specSource, /rowLoadedModuleResponses\.dispose\(\);/u);
  assert.equal(packedCandidateBrowserQaSource.includes('page.request'), false);
  assert.equal(packedCandidateBrowserQaSource.includes('framenavigated'), false);
  assert.match(packedCandidateBrowserQaSource, /page\.on\('response', onResponse\);/u);
  assert.match(packedCandidateBrowserQaSource, /response\.body\(\)/u);
  assert.match(packedCandidateBrowserQaSource, /conflictingResponseUrl/u);
  assert.match(specSource, /normalTriageLocalAgentJourneyCompleted\s*=\s*true/u);
  const localAgentJourneyOffset = specSource.indexOf(
    "test('uses normal Triage Local Agent Voice surfaces with real STT and fake-Claude provider boundaries'",
  );
  const localAgentLoadedModuleObserverOffset = specSource.search(
    /const normalTriageLocalAgentJourneyModuleResponses\s*=\s*observeLoadedBrowserModuleResponses\(page\);/u,
  );
  const localAgentFirstNavigationOffset = specSource.indexOf(
    "buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0')",
    localAgentJourneyOffset,
  );
  const localAgentLoadedModuleAttestationOffset = specSource.indexOf(
    'normalTriageLocalAgentJourneyLoadedModules = await attestLoadedBrowserModules(',
    localAgentJourneyOffset,
  );
  const localAgentJourneyCompletionOffset = specSource.indexOf(
    'normalTriageLocalAgentJourneyCompleted = true;',
    localAgentJourneyOffset,
  );
  assert.ok(localAgentJourneyOffset >= 0);
  assert.ok(
    localAgentLoadedModuleObserverOffset > localAgentJourneyOffset
      && localAgentFirstNavigationOffset > localAgentLoadedModuleObserverOffset,
  );
  assert.ok(localAgentLoadedModuleAttestationOffset > localAgentFirstNavigationOffset);
  assert.ok(localAgentJourneyCompletionOffset > localAgentLoadedModuleAttestationOffset);
  assert.match(
    specSource,
    /attestLoadedBrowserModules\(\s*page,\s*await normalTriageLocalAgentJourneyModuleResponses\.observedResponses\(\),\s*\)/u,
  );
  assert.match(specSource, /normalTriageLocalAgentJourneyModuleResponses\.dispose\(\);/u);
  assert.match(
    specSource,
    /normalTriageLocalAgentJourneyLoadedModules,[\s\S]+?completion:/u,
  );
  assert.match(
    packedCandidateBrowserQaSource,
    /normalTriageLocalAgentJourneyLoadedModules:\s*LoadedBrowserModuleAttestation\s*\|\s*null/u,
  );
  assert.match(
    specSource,
    /completion:\s*\{[\s\S]+?normalTriageLocalAgentJourneyCompleted:[\s\S]+?contributorUninstalledAndRetired:/u,
  );
  assert.match(specSource, /voice-surface-status:sidebar:disconnected[\s\S]+contributorV2Generation/u);
  const automaticMetadataOffset = specSource.indexOf('const automaticMetadataTranscript');
  const replacementOffset = specSource.indexOf('const contributorV2Generation');
  assert.ok(automaticMetadataOffset >= 0 && replacementOffset > automaticMetadataOffset);
  assert.equal(
    specSource.slice(automaticMetadataOffset, replacementOffset)
      .includes("page.getByTestId('voice-surface-toggle:sidebar').click()"),
    false,
  );
});

test('packed target browser QA exposes the requested normal Triage/GitHub Voice journey without a fixture-only bypass', () => {
  const specSource = readFileSync(
    new URL(
      '../../suites/ui-e2e/plugin.packed-targeted-projection.spec.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(
    specSource,
    /HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST/u,
  );
  assert.match(
    specSource,
    /HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH/u,
  );
  assert.match(specSource, /loadPackedTriageGithubVoiceQaHandoff/u);
  assert.match(specSource, /assertPackedTriageGithubVoiceQaCandidate/u);
  assert.match(
    specSource,
    /packed_triage_github_voice_browser_qa_blocked_microphone_fixture_mismatch/u,
  );
  assert.match(specSource, /connected-account-mode:manual/u);
  assert.match(specSource, /Add \$\{handoff\.github\.scopeTitle\} to Happier/u);
  assert.match(specSource, /handoff\.voice\.providerId/u);
  assert.match(specSource, /voice-surface-toggle:sidebar/u);
  assert.match(specSource, /issueBOption\)\.toHaveAttribute\('aria-selected', 'true'/u);
  assert.equal(specSource.includes('test.skip'), false);
  assert.equal(specSource.includes('page.request'), false);
});

test('Local Agent Triage Voice uses the normal UI and real provider boundaries for privacy, currentness, and stale-command proof', () => {
  const specSource = readFileSync(
    new URL(
      '../../suites/ui-e2e/plugin.packed-targeted-projection.spec.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(specSource, /HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ADAPTER/u);
  assert.match(specSource, /HAPPIER_E2E_UCX_WEB_SDK_TARBALL/u);
  assert.match(specSource, /preparePackedUcxWebQa/u);
  assert.match(specSource, /triageGithubVoiceAdapter === 'local_agent'/u);
  assert.match(specSource, /installLocalAgentVoiceSettings/u);
  assert.match(specSource, /startVoiceQaBoundaryServer/u);
  assert.match(specSource, /HAPPIER_E2E_FAKE_CLAUDE_SCENARIO:\s*'voice-current-ui-triage'/u);
  assert.match(
    specSource,
    /HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE/u,
  );
  assert.match(specSource, /UCX_VOICE_OFF/u);
  assert.match(specSource, /UCX_VOICE_READ_A/u);
  assert.match(specSource, /UCX_VOICE_OPEN_B/u);
  assert.match(specSource, /UCX_VOICE_DELAYED_STALE_A/u);
  assert.match(specSource, /createSessionFromNewSessionComposer/u);
  assert.match(specSource, /setSessionSummaryPrivacy/u);
  assert.match(specSource, /Share session summary/u);
  assert.match(specSource, /area:\s*'session'/u);
  assert.match(specSource, /CURRENT UI CONTEXT/u);
  assert.match(specSource, /page\.goBack\(/u);
  assert.match(specSource, /secondContext/u);
  assert.match(specSource, /readCurrentUiContext/u);
  assert.match(specSource, /invokeCurrentUiCommand/u);
  assert.match(specSource, /writeFile\(delayedCurrentUiReleaseFile/u);
  assert.equal(specSource.includes('/dev/voice-qa'), false);
  assert.equal(specSource.includes('page.request'), false);
});
