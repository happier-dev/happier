export type ArchiveBoundPackedChannelProviderFixture = Readonly<{
  source: string;
  manifest: unknown;
}>;

export declare function createArchiveBoundPackedChannelProviderFixture(
  input: Readonly<{
    source: string;
    manifest: unknown;
    origin: string;
    strictResultSentinel?: string;
  }>,
): ArchiveBoundPackedChannelProviderFixture;
