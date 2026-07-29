export type PackedAuthorArchiveCensus = Readonly<{
  entryCount: number;
}>;

export function inspectPackedAuthorPackageArchive(params: Readonly<{
  archivePath: string;
  label: string;
}>): Promise<PackedAuthorArchiveCensus>;

export function assertPackedAuthorCandidateArchivesSafe(params: Readonly<{
  sdkTarballPath: string;
  cliTarballPath: string;
}>): Promise<Readonly<{
  sdk: PackedAuthorArchiveCensus;
  cli: PackedAuthorArchiveCensus;
}>>;
