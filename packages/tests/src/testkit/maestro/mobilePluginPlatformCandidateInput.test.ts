import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  prepareNativeTriageGithubVoiceQa,
  resolveMobilePluginPlatformCandidateQaInput,
} from './mobilePluginPlatformCandidateInput';

const artifacts = {
  sdk: {
    packageName: '@happier-dev/plugin-sdk' as const,
    version: '1.2.3',
    integrity: 'sha512-sdk',
  },
  pluginUi: {
    packageName: '@happier-dev/plugin-ui' as const,
    version: '1.2.3',
    pluginSdkVersion: '1.2.3',
    integrity: 'sha512-plugin-ui',
  },
  cli: {
    packageName: '@happier-dev/cli' as const,
    version: '4.5.6',
    integrity: 'sha512-cli',
  },
};

async function createSchemaV2Handoff(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-native-row-local-handoff-'));
  const microphoneFixturePath = join(root, 'microphone.wav');
  const handoffManifestPath = join(root, 'triage-github-voice-qa.json');
  await writeFile(microphoneFixturePath, 'fixture');
  await writeFile(handoffManifestPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'happier_triage_github_voice_qa_handoff_v1',
    candidate: artifacts,
    github: {
      token: 'github-token',
      scopeTitle: 'happier-dev/happier',
      issueA: { title: 'Issue A' },
      issueB: { title: 'Issue B' },
    },
    voice: {
      adapterId: 'local_conversation',
      conversationMode: 'agent',
      agentId: 'claude',
      sttProviderId: 'happier.voice.openai-compat/stt',
      microphoneFixturePath,
    },
  }, null, 2)}\n`);
  return handoffManifestPath;
}

describe('native Plugin Platform artifact admission', () => {
  it('accepts a complete row-local trio with a matching schema-v2 handoff without candidate-only inputs', async () => {
    const handoffManifestPath = await createSchemaV2Handoff();

    const input = resolveMobilePluginPlatformCandidateQaInput({
      cwd: '/workspace',
      env: {
        HAPPIER_E2E_UCX_NATIVE_SDK_TARBALL: '/row/sdk.tgz',
        HAPPIER_E2E_UCX_NATIVE_PLUGIN_UI_TARBALL: '/row/plugin-ui.tgz',
        HAPPIER_E2E_UCX_NATIVE_CLI_TARBALL: '/row/cli.tgz',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
          handoffManifestPath,
      },
    });
    const triage = await prepareNativeTriageGithubVoiceQa({
      artifacts,
      handoffManifestPath: input.triageGithubVoiceHandoffManifestPath,
    });

    expect(input).toEqual({
      artifactBasis: 'row_local_natural',
      sdkTarballPath: '/row/sdk.tgz',
      pluginUiTarballPath: '/row/plugin-ui.tgz',
      cliTarballPath: '/row/cli.tgz',
      triageGithubVoiceHandoffManifestPath: handoffManifestPath,
    });
    expect(triage).toEqual({
      githubToken: 'github-token',
      githubScopeTitle: 'happier-dev/happier',
      issueATitle: 'Issue A',
      issueBTitle: 'Issue B',
      voice: {
        adapterId: 'local_conversation',
        conversationMode: 'agent',
        agentId: 'claude',
        sttProviderId: 'happier.voice.openai-compat/stt',
        microphoneFixturePath: expect.any(String),
      },
    });
  });

  it('fails closed for partial trios and candidate/trio split brains', async () => {
    const handoffManifestPath = await createSchemaV2Handoff();
    const sharedEnv = {
      HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
        handoffManifestPath,
    };

    expect(() => resolveMobilePluginPlatformCandidateQaInput({
      cwd: '/workspace',
      env: {
        ...sharedEnv,
        HAPPIER_E2E_UCX_NATIVE_SDK_TARBALL: '/row/sdk.tgz',
        HAPPIER_E2E_UCX_NATIVE_PLUGIN_UI_TARBALL: '/row/plugin-ui.tgz',
      },
    })).toThrow(/row_local_artifacts_required/);
    expect(() => resolveMobilePluginPlatformCandidateQaInput({
      cwd: '/workspace',
      env: {
        ...sharedEnv,
        HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE: '/candidate/candidate.json',
        HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST: '/candidate/novel.json',
        HAPPIER_E2E_UCX_NATIVE_SDK_TARBALL: '/row/sdk.tgz',
        HAPPIER_E2E_UCX_NATIVE_PLUGIN_UI_TARBALL: '/row/plugin-ui.tgz',
        HAPPIER_E2E_UCX_NATIVE_CLI_TARBALL: '/row/cli.tgz',
      },
    })).toThrow(/artifact_basis_conflict/);
  });
});
