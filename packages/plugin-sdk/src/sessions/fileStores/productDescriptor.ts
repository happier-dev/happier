export type SessionFileStoreHeaderDescriptorV1 = Readonly<{
  sessionId: string;
  cwd: string | null;
  createdAtMs: number | null;
  title: string | null;
}>;

export type SessionFileStoreProductDescriptorV1 = Readonly<{
  productId: string;
  defaultAgentDirSegments: readonly string[];
  agentDirEnvVar: string;
  legacySessionDirEnvVars: readonly string[];
  readsSettingsSessionDir: boolean;
  configDirName: string;
  encodeCwdSubdir: ((cwd: string) => string) | null;
  parseSessionHeader?: (record: unknown) => SessionFileStoreHeaderDescriptorV1 | null;
}>;
