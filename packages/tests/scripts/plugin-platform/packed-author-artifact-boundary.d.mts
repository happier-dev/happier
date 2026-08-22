export type PackedAuthorArchiveCensus = Readonly<{
  entryCount: number;
}>;

export type PackedAuthorArtifactKind = 'sdk' | 'pluginUi' | 'channelsProtocol' | 'cli';

export type PackedAuthorArchiveLimits = Readonly<{
  maxArchiveBytes: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  timeoutMs: number;
}>;

export function resolvePackedAuthorPackageArchiveLimits(
  artifactKind: PackedAuthorArtifactKind,
): PackedAuthorArchiveLimits;

export function inspectPackedAuthorPackageArchive(params: Readonly<{
  archivePath: string;
  label: string;
  artifactKind: PackedAuthorArtifactKind;
}>): Promise<PackedAuthorArchiveCensus>;

export function assertPackedAuthorCandidateArchivesSafe(params: Readonly<{
  sdkTarballPath: string;
  pluginUiTarballPath: string;
  channelsProtocolTarballPath?: string;
  cliTarballPath: string;
}>): Promise<Readonly<{
  sdk: PackedAuthorArchiveCensus;
  pluginUi: PackedAuthorArchiveCensus;
  channelsProtocol?: PackedAuthorArchiveCensus;
  cli: PackedAuthorArchiveCensus;
}>>;
