import type { PackedAuthorCandidate } from './run-packed-author-ui-compat.mjs';

export type PackedAuthorCandidateInputs = Readonly<{
  runId: string;
  sdkTarballPath: string;
  cliTarballPath: string;
  standaloneCliArtifactPath?: string | null;
}>;

export function parseCandidateCreatorArgs(argv: readonly string[]): PackedAuthorCandidateInputs;

export function createPackedAuthorCandidate(
  params: PackedAuthorCandidateInputs,
): Promise<
  Omit<PackedAuthorCandidate, 'sourceBasis' | 'installers' | 'standaloneCli'>
  & Readonly<{
    standaloneCli?: Omit<
      NonNullable<PackedAuthorCandidate['standaloneCli']>,
      'archives' | 'checksums' | 'signature'
    >;
  }>
>;
