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
  /** Account Settings field whose non-empty value owns this Agent's root. */
  agentDirSettingId?: string;
  legacySessionDirEnvVars: readonly string[];
  readsSettingsSessionDir: boolean;
  configDirName: string;
  encodeCwdSubdir: ((cwd: string) => string) | null;
  parseSessionHeader?: (record: unknown) => SessionFileStoreHeaderDescriptorV1 | null;
}>;
