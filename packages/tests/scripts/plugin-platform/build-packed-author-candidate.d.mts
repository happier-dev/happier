import type { PackedAuthorCandidate } from './run-packed-author-ui-compat.mjs';

export type PackedAuthorCandidateNativeMatrixResult = Readonly<
  Pick<
    NonNullable<PackedAuthorCandidate['standaloneCli']>,
    'archivePath' | 'archives' | 'checksums' | 'signature'
  >
>;

export type PackedAuthorCandidateBuilderInputs = Readonly<{
  monorepoRoot: string;
  outputRoot: string;
  runId: string;
  nativeTarget: 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64' | 'windows-x64';
  nativeArtifactsDir: string;
}>;

export type PackedAuthorCandidateBuilderCliInputs = Readonly<{
  outputRoot: string;
  runId: string;
  nativeTarget: PackedAuthorCandidateBuilderInputs['nativeTarget'];
  nativeArtifactsDir: PackedAuthorCandidateBuilderInputs['nativeArtifactsDir'];
}>;

export function parsePackedAuthorCandidateBuilderArgs(
  argv: readonly string[],
  options?: Readonly<{ cwd?: string }>,
): PackedAuthorCandidateBuilderCliInputs;

export function buildPackedAuthorCandidate(
  params: PackedAuthorCandidateBuilderInputs,
  dependencies?: Readonly<{
    importOwnedStandaloneCliMatrixImpl?: ((params: Readonly<{
      sourceDir: string;
      destinationDir: string;
      version: string;
      target: NonNullable<PackedAuthorCandidateBuilderInputs['nativeTarget']>;
    }>, dependencies?: Readonly<{
      verifyReleaseArchiveAdmissionImpl?: (params: Readonly<{
        archivePath: string;
        archiveName: string;
      }>) => Promise<readonly unknown[]>;
    }>) => Promise<PackedAuthorCandidateNativeMatrixResult>) | null;
  }>,
): Promise<Readonly<{
  manifestPath: string;
  candidate: PackedAuthorCandidate;
}>>;

export function main(argv?: readonly string[]): Promise<void>;
