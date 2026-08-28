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

export function runHostedArtifactPluginUiMcpQa(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  config: HostedArtifactQaConfig;
  runtimeAttribution: Readonly<Record<string, unknown>>;
}>): Promise<Readonly<{
  artifactRoot: string;
  capability: unknown;
  identity: unknown;
}>>;
