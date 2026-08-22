export type PackedTriageGithubVoiceQaCandidate = Readonly<{
  sdk: Readonly<{
    packageName: '@happier-dev/plugin-sdk';
    version: string;
    integrity: string;
  }>;
  pluginUi: Readonly<{
    packageName: '@happier-dev/plugin-ui';
    version: string;
    pluginSdkVersion: string;
    integrity: string;
  }>;
  cli: Readonly<{
    packageName: '@happier-dev/cli';
    version: string;
    integrity: string;
  }>;
}>;

type PackedTriageGithubVoiceQaCommonHandoff = Readonly<{
  kind: 'happier_triage_github_voice_qa_handoff_v1';
  candidate: PackedTriageGithubVoiceQaCandidate;
  github: Readonly<{
    token: string;
    scopeTitle: string;
    issueA: Readonly<{ title: string }>;
    issueB: Readonly<{ title: string }>;
  }>;
}>;

export type PackedTriageGithubVoiceQaExternalRealtimeHandoff =
  PackedTriageGithubVoiceQaCommonHandoff & Readonly<{
    schemaVersion: 1;
    voice: Readonly<{
      providerId: 'happier.voice.openai/realtime-openai';
      optionId: 'byo';
      credentialSlotId: 'api_key';
      credential: string;
      microphoneFixturePath: string;
    }>;
  }>;

export type PackedTriageGithubVoiceQaLocalAgentHandoff =
  PackedTriageGithubVoiceQaCommonHandoff & Readonly<{
    schemaVersion: 2;
    voice: Readonly<{
      adapterId: 'local_conversation';
      conversationMode: 'agent';
      agentId: 'claude';
      sttProviderId: 'happier.voice.openai-compat/stt';
      microphoneFixturePath: string;
    }>;
  }>;

export type PackedTriageGithubVoiceQaHandoff =
  | PackedTriageGithubVoiceQaExternalRealtimeHandoff
  | PackedTriageGithubVoiceQaLocalAgentHandoff;

export type PackedCandidateBrowserQaInputs =
  | Readonly<{
      artifactBasis: 'candidate_manifest';
      manifestPath: string;
      novelHandoffManifestPath: string;
      triageGithubVoiceHandoffManifestPath: string;
    }>
  | Readonly<{
      artifactBasis: 'row_local_natural';
      sdkTarballPath: string;
      pluginUiTarballPath: string;
      cliTarballPath: string;
      triageGithubVoiceHandoffManifestPath: string;
    }>;

export type PackedCandidateBrowserQaInvocation = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  envPatch: NodeJS.ProcessEnv;
}>;

export function parsePackedTriageGithubVoiceQaHandoff(
  raw: string,
): PackedTriageGithubVoiceQaHandoff;

export function resolvePackedTriageGithubVoiceQaAdapter(
  handoff: PackedTriageGithubVoiceQaHandoff,
): 'external_realtime' | 'local_agent';

export function assertPackedTriageGithubVoiceQaCompletionHandoff(
  handoff: PackedTriageGithubVoiceQaHandoff,
): PackedTriageGithubVoiceQaLocalAgentHandoff;

export function assertPackedTriageGithubVoiceQaCandidate(input: Readonly<{
  handoff: PackedTriageGithubVoiceQaHandoff;
  candidate: PackedTriageGithubVoiceQaCandidate;
}>): PackedTriageGithubVoiceQaHandoff;

export function loadPackedTriageGithubVoiceQaHandoff(input: Readonly<{
  manifestPath: string;
}>): Promise<PackedTriageGithubVoiceQaHandoff>;

export function requirePackedCandidateBrowserQaInputs(input: Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}>): PackedCandidateBrowserQaInputs;

export function buildPackedCandidateBrowserQaInvocation(input: Readonly<{
  testsPackageRoot: string;
  artifactBasis?: 'candidate_manifest' | 'row_local_natural';
  manifestPath?: string;
  novelHandoffManifestPath?: string;
  sdkTarballPath?: string;
  pluginUiTarballPath?: string;
  cliTarballPath?: string;
  triageGithubVoiceHandoffManifestPath?: string;
  triageGithubVoiceMicrophoneFixturePath?: string;
  triageGithubVoiceAdapter?: 'external_realtime' | 'local_agent';
  processExecPath: string;
}>): PackedCandidateBrowserQaInvocation;
