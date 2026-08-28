export type HostedArtifactQaConfig = Readonly<{
  appIdentifier: string;
  route: string;
  surfaceId: string;
  title: string;
  expected: Readonly<{
    pluginId: string;
    generation: string;
    artifactDigest: string;
    machineId: string;
    serverId: string;
  }>;
}>;

export type HostedArtifactRecordedProofState = Readonly<{
  kind: string;
  hostBoundaryOnly: boolean;
  nativeChildProofComplete: boolean;
}>;

/**
 * Fail-closed gate over the recorded proof state of a hosted-artifact capture.
 * Throws `desktop_hosted_artifact_native_child_proof_blocked:<kind>:<artifactRoot>`
 * unless actual native-child proof is recorded complete.
 */
export function assertHostedArtifactNativeChildProofComplete(result: Readonly<{
  artifactRoot: string;
  proof?: unknown;
}>): HostedArtifactRecordedProofState;

export function runHostedArtifactPluginUiMcpQa(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  config: HostedArtifactQaConfig;
  runtimeAttribution: Readonly<Record<string, unknown>>;
}>): Promise<Readonly<{
  artifactRoot: string;
  capability: unknown;
  identity: unknown;
  proof: HostedArtifactRecordedProofState;
}>>;
