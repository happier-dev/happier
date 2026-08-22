import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as tar from 'tar';

import {
  cleanupPackedTriageGithubVoiceQaHandoff,
  createPackedTriageGithubVoiceQaHandoff,
  parsePackedTriageGithubVoiceQaHandoffArgs,
  runPackedTriageGithubVoiceQaHandoffCommand,
} from './triage-github-voice-qa-handoff.mjs';
import {
  loadPackedTriageGithubVoiceQaHandoff,
} from './run-packed-candidate-browser-qa.mjs';

const candidateIdentity = Object.freeze({
  sdk: Object.freeze({
    packageName: '@happier-dev/plugin-sdk',
    version: '1.2.3',
    integrity: 'sha512-sdk',
  }),
  pluginUi: Object.freeze({
    packageName: '@happier-dev/plugin-ui',
    version: '1.2.3',
    pluginSdkVersion: '1.2.3',
    integrity: 'sha512-plugin-ui',
  }),
  cli: Object.freeze({
    packageName: '@happier-dev/cli',
    version: '1.2.3',
    integrity: 'sha512-cli',
  }),
});

const candidate = Object.freeze({
  runId: 'candidate-run-id',
  ...candidateIdentity,
  standaloneCli: Object.freeze({ archives: [] }),
});

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'happier-triage-github-voice-qa-'));
  const microphoneFixturePath = join(root, 'microphone.wav');
  await writeFile(microphoneFixturePath, 'fixture');
  return { root, microphoneFixturePath };
}

function createInput({ microphoneFixturePath, outputRoot, token = 'github-token-test' }) {
  return {
    candidate,
    token,
    scopeTitle: 'happier-dev/happier',
    issueATitle: 'QA issue A',
    issueBTitle: 'QA issue B',
    microphoneFixturePath,
    outputRoot,
  };
}

async function createNaturalArtifactFixture(root) {
  const sdkSourceRoot = join(root, 'sdk-source');
  const pluginUiSourceRoot = join(root, 'plugin-ui-source');
  const cliSourceRoot = join(root, 'cli-source');
  const sdkTarballPath = join(root, 'sdk.tgz');
  const pluginUiTarballPath = join(root, 'plugin-ui.tgz');
  const cliTarballPath = join(root, 'cli.tgz');
  await Promise.all([
    mkdir(join(sdkSourceRoot, 'package'), { recursive: true }),
    mkdir(join(pluginUiSourceRoot, 'package'), { recursive: true }),
    mkdir(join(cliSourceRoot, 'package', 'bin'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(sdkSourceRoot, 'package', 'package.json'),
      `${JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '1.2.3',
      })}\n`,
    ),
    writeFile(
      join(pluginUiSourceRoot, 'package', 'package.json'),
      `${JSON.stringify({
        name: '@happier-dev/plugin-ui',
        version: '1.2.3',
        dependencies: { '@happier-dev/plugin-sdk': '1.2.3' },
      })}\n`,
    ),
    writeFile(
      join(cliSourceRoot, 'package', 'package.json'),
      `${JSON.stringify({
        name: '@happier-dev/cli',
        version: '4.5.6',
        bin: { happier: './bin/happier.mjs' },
      })}\n`,
    ),
    writeFile(join(cliSourceRoot, 'package', 'bin', 'happier.mjs'), '#!/usr/bin/env node\n'),
  ]);
  await Promise.all([
    tar.c({ cwd: sdkSourceRoot, file: sdkTarballPath, gzip: true }, ['package']),
    tar.c({ cwd: pluginUiSourceRoot, file: pluginUiTarballPath, gzip: true }, ['package']),
    tar.c({ cwd: cliSourceRoot, file: cliTarballPath, gzip: true }, ['package']),
  ]);
  return { sdkTarballPath, pluginUiTarballPath, cliTarballPath };
}

async function sha512Sri(path) {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`;
}

test('creates a canonical schema-v2 handoff in a private marker-authorized root', async () => {
  const fixture = await createFixtureRoot();
  const outputRoot = join(fixture.root, 'handoff');
  try {
    const created = await createPackedTriageGithubVoiceQaHandoff(
      createInput({
        microphoneFixturePath: fixture.microphoneFixturePath,
        outputRoot,
      }),
    );

    assert.equal(created.manifestPath, join(outputRoot, 'triage-github-voice-qa.json'));
    const handoff = await loadPackedTriageGithubVoiceQaHandoff({
      manifestPath: created.manifestPath,
    });
    assert.deepEqual(handoff, {
      schemaVersion: 2,
      kind: 'happier_triage_github_voice_qa_handoff_v1',
      candidate: candidateIdentity,
      github: {
        token: 'github-token-test',
        scopeTitle: 'happier-dev/happier',
        issueA: { title: 'QA issue A' },
        issueB: { title: 'QA issue B' },
      },
      voice: {
        adapterId: 'local_conversation',
        conversationMode: 'agent',
        agentId: 'claude',
        sttProviderId: 'happier.voice.openai-compat/stt',
        microphoneFixturePath: fixture.microphoneFixturePath,
      },
    });

    if (process.platform !== 'win32') {
      assert.equal((await lstat(outputRoot)).mode & 0o777, 0o700);
      assert.equal((await lstat(created.manifestPath)).mode & 0o777, 0o600);
      assert.equal(
        (await lstat(join(outputRoot, '.triage-github-voice-qa-root.json'))).mode & 0o777,
        0o600,
      );
    }

    const cleanup = await cleanupPackedTriageGithubVoiceQaHandoff({
      manifestPath: created.manifestPath,
    });
    assert.deepEqual(cleanup, { removed: true });
    await assert.rejects(lstat(outputRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a missing token before creating an output root', async () => {
  const fixture = await createFixtureRoot();
  const outputRoot = join(fixture.root, 'handoff');
  try {
    await assert.rejects(
      createPackedTriageGithubVoiceQaHandoff(
        createInput({
          microphoneFixturePath: fixture.microphoneFixturePath,
          outputRoot,
          token: ' ',
        }),
      ),
      /triage_github_voice_qa_handoff_token_required/,
    );
    await assert.rejects(lstat(outputRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refuses a repository-local output root before writing the credential-bearing manifest', async () => {
  const fixture = await createFixtureRoot();
  const outputRoot = join(
    process.cwd(),
    `.triage-github-voice-qa-handoff-${randomUUID()}`,
  );
  try {
    await assert.rejects(
      createPackedTriageGithubVoiceQaHandoff(
        createInput({
          microphoneFixturePath: fixture.microphoneFixturePath,
          outputRoot,
        }),
      ),
      /triage_github_voice_qa_handoff_output_root_must_be_outside_repository/,
    );
    await assert.rejects(lstat(outputRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('uses a private temporary root when the operator does not select an output root', async () => {
  const fixture = await createFixtureRoot();
  let created = null;
  try {
    created = await createPackedTriageGithubVoiceQaHandoff(
      createInput({
        microphoneFixturePath: fixture.microphoneFixturePath,
      }),
    );
    assert.equal(created.manifestPath.startsWith(tmpdir()), true);
    assert.equal(
      (await lstat(created.manifestPath)).isFile(),
      true,
    );
    assert.deepEqual(
      await cleanupPackedTriageGithubVoiceQaHandoff({
        manifestPath: created.manifestPath,
      }),
      { removed: true },
    );
    created = null;
  } finally {
    if (created) {
      await cleanupPackedTriageGithubVoiceQaHandoff({
        manifestPath: created.manifestPath,
      }).catch(() => undefined);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cleanup refuses an unmarked root and leaves it intact', async () => {
  const fixture = await createFixtureRoot();
  const outputRoot = join(fixture.root, 'handoff');
  try {
    const created = await createPackedTriageGithubVoiceQaHandoff(
      createInput({
        microphoneFixturePath: fixture.microphoneFixturePath,
        outputRoot,
      }),
    );
    await rm(join(outputRoot, '.triage-github-voice-qa-root.json'));

    await assert.rejects(
      cleanupPackedTriageGithubVoiceQaHandoff({
        manifestPath: created.manifestPath,
      }),
      /triage_github_voice_qa_handoff_cleanup_unauthorized/,
    );
    assert.equal((await lstat(outputRoot)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the operator parser takes the credential only from its named environment boundary', () => {
  const parsed = parsePackedTriageGithubVoiceQaHandoffArgs(
    [
      'create',
      '--candidate',
      '/tmp/candidate.json',
      '--scope-title',
      'happier-dev/happier',
      '--issue-a-title',
      'QA issue A',
      '--issue-b-title',
      'QA issue B',
      '--microphone-fixture',
      '/tmp/microphone.wav',
      '--output-root',
      '/tmp/new-handoff-root',
    ],
    {
      HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN: 'github-token-test',
    },
  );

  assert.equal(parsed.mode, 'create');
  assert.equal(parsed.token, 'github-token-test');
  assert.throws(
    () => parsePackedTriageGithubVoiceQaHandoffArgs([
      'create',
      '--github-token',
      'github-token-test',
    ], {}),
    /unknown option/i,
  );
});

test('the operator accepts exactly one complete candidate admission source', () => {
  const env = {
    HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN: 'github-token-test',
  };
  const directArgs = [
    'create',
    '--sdk-tarball',
    '/tmp/sdk.tgz',
    '--plugin-ui-tarball',
    '/tmp/plugin-ui.tgz',
    '--cli-tarball',
    '/tmp/cli.tgz',
    '--scope-title',
    'happier-dev/happier',
    '--issue-a-title',
    'QA issue A',
    '--issue-b-title',
    'QA issue B',
    '--microphone-fixture',
    '/tmp/microphone.wav',
  ];
  const parsed = parsePackedTriageGithubVoiceQaHandoffArgs(directArgs, env);
  assert.deepEqual(
    {
      sdkTarballPath: parsed.sdkTarballPath,
      pluginUiTarballPath: parsed.pluginUiTarballPath,
      cliTarballPath: parsed.cliTarballPath,
    },
    {
      sdkTarballPath: '/tmp/sdk.tgz',
      pluginUiTarballPath: '/tmp/plugin-ui.tgz',
      cliTarballPath: '/tmp/cli.tgz',
    },
  );
  assert.equal(parsed.candidateManifestPath, undefined);

  assert.throws(
    () => parsePackedTriageGithubVoiceQaHandoffArgs([
      ...directArgs,
      '--candidate',
      '/tmp/candidate.json',
    ], env),
    /triage_github_voice_qa_handoff_candidate_source_invalid/,
  );
  assert.throws(
    () => parsePackedTriageGithubVoiceQaHandoffArgs([
      'create',
      '--sdk-tarball',
      '/tmp/sdk.tgz',
      '--scope-title',
      'happier-dev/happier',
      '--issue-a-title',
      'QA issue A',
      '--issue-b-title',
      'QA issue B',
      '--microphone-fixture',
      '/tmp/microphone.wav',
    ], env),
    /triage_github_voice_qa_handoff_candidate_source_invalid/,
  );
});

test('the operator serializes a canonical schema-v2 identity from a row-local natural trio', async () => {
  const fixture = await createFixtureRoot();
  const outputRoot = join(fixture.root, 'handoff');
  try {
    const artifacts = await createNaturalArtifactFixture(fixture.root);
    const created = await runPackedTriageGithubVoiceQaHandoffCommand(
      [
        'create',
        '--sdk-tarball',
        artifacts.sdkTarballPath,
        '--plugin-ui-tarball',
        artifacts.pluginUiTarballPath,
        '--cli-tarball',
        artifacts.cliTarballPath,
        '--scope-title',
        'happier-dev/happier',
        '--issue-a-title',
        'QA issue A',
        '--issue-b-title',
        'QA issue B',
        '--microphone-fixture',
        fixture.microphoneFixturePath,
        '--output-root',
        outputRoot,
      ],
      {
        cwd: fixture.root,
        env: {
          HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN: 'github-token-test',
        },
      },
    );
    const handoff = await loadPackedTriageGithubVoiceQaHandoff({
      manifestPath: created.manifestPath,
    });
    assert.deepEqual(handoff.candidate, {
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '1.2.3',
        integrity: await sha512Sri(artifacts.sdkTarballPath),
      },
      pluginUi: {
        packageName: '@happier-dev/plugin-ui',
        version: '1.2.3',
        pluginSdkVersion: '1.2.3',
        integrity: await sha512Sri(artifacts.pluginUiTarballPath),
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '4.5.6',
        integrity: await sha512Sri(artifacts.cliTarballPath),
      },
    });
    await cleanupPackedTriageGithubVoiceQaHandoff({
      manifestPath: created.manifestPath,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
