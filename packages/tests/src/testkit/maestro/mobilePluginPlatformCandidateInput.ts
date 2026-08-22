import {
  assertPackedTriageGithubVoiceQaCandidate,
  assertPackedTriageGithubVoiceQaCompletionHandoff,
  loadPackedTriageGithubVoiceQaHandoff,
  requirePackedCandidateBrowserQaInputs,
  type PackedTriageGithubVoiceQaCandidate,
} from '../../../scripts/plugin-platform/run-packed-candidate-browser-qa.mjs';

export type MobilePluginPlatformQaArtifacts = PackedTriageGithubVoiceQaCandidate;

export type NativeTriageGithubVoiceQaInput = Readonly<{
  githubToken: string;
  githubScopeTitle: string;
  issueATitle: string;
  issueBTitle: string;
  voice: Readonly<{
    adapterId: 'local_conversation';
    conversationMode: 'agent';
    agentId: 'claude';
    sttProviderId: 'happier.voice.openai-compat/stt';
    microphoneFixturePath: string;
  }>;
}>;

export type MobilePluginPlatformCandidateQaInput =
  | Readonly<{
      artifactBasis: 'candidate_manifest';
      candidateManifestPath: string;
      packedNovelHandoffManifestPath: string;
      triageGithubVoiceHandoffManifestPath: string;
    }>
  | Readonly<{
      artifactBasis: 'row_local_natural';
      sdkTarballPath: string;
      pluginUiTarballPath: string;
      cliTarballPath: string;
      triageGithubVoiceHandoffManifestPath: string;
    }>;

/**
 * Native QA shares the browser runner's one artifact-admission parser. The
 * row-local trio is a separate exact-artifact basis; candidate-only G5 and
 * packed-novel requirements remain in the candidate preparation branch.
 */
export function resolveMobilePluginPlatformCandidateQaInput(input: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): MobilePluginPlatformCandidateQaInput {
  const resolved = requirePackedCandidateBrowserQaInputs({
    argv: [],
    cwd: input.cwd,
    env: {
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST:
        input.env.HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE,
      HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
        input.env.HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST,
      HAPPIER_E2E_UCX_WEB_SDK_TARBALL:
        input.env.HAPPIER_E2E_UCX_NATIVE_SDK_TARBALL,
      HAPPIER_E2E_UCX_WEB_PLUGIN_UI_TARBALL:
        input.env.HAPPIER_E2E_UCX_NATIVE_PLUGIN_UI_TARBALL,
      HAPPIER_E2E_UCX_WEB_CLI_TARBALL:
        input.env.HAPPIER_E2E_UCX_NATIVE_CLI_TARBALL,
      HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
        input.env.HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST,
    },
  });
  if (resolved.artifactBasis === 'candidate_manifest') {
    return Object.freeze({
      artifactBasis: 'candidate_manifest',
      candidateManifestPath: resolved.manifestPath,
      packedNovelHandoffManifestPath: resolved.novelHandoffManifestPath,
      triageGithubVoiceHandoffManifestPath:
        resolved.triageGithubVoiceHandoffManifestPath,
    });
  }
  return Object.freeze({
    artifactBasis: 'row_local_natural',
    sdkTarballPath: resolved.sdkTarballPath,
    pluginUiTarballPath: resolved.pluginUiTarballPath,
    cliTarballPath: resolved.cliTarballPath,
    triageGithubVoiceHandoffManifestPath:
      resolved.triageGithubVoiceHandoffManifestPath,
  });
}

export async function prepareNativeTriageGithubVoiceQa(input: Readonly<{
  artifacts: MobilePluginPlatformQaArtifacts;
  handoffManifestPath: string;
}>): Promise<NativeTriageGithubVoiceQaInput> {
  const handoff = assertPackedTriageGithubVoiceQaCompletionHandoff(
    await loadPackedTriageGithubVoiceQaHandoff({
      manifestPath: input.handoffManifestPath,
    }),
  );
  assertPackedTriageGithubVoiceQaCandidate({
    handoff,
    candidate: input.artifacts,
  });
  return Object.freeze({
    githubToken: handoff.github.token,
    githubScopeTitle: handoff.github.scopeTitle,
    issueATitle: handoff.github.issueA.title,
    issueBTitle: handoff.github.issueB.title,
    voice: Object.freeze({
      adapterId: handoff.voice.adapterId,
      conversationMode: handoff.voice.conversationMode,
      agentId: handoff.voice.agentId,
      sttProviderId: handoff.voice.sttProviderId,
      microphoneFixturePath: handoff.voice.microphoneFixturePath,
    }),
  });
}
