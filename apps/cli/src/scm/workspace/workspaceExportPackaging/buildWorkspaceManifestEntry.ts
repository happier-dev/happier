import { detectWorkspacePathTraits } from './detectWorkspacePathTraits';

export type WorkspaceManifestEntry =
  | Readonly<{
      relativePath: string;
      kind: 'directory';
    }>
  | Readonly<{
      relativePath: string;
      kind: 'file';
      digest: string;
      sizeBytes: number;
      executable: boolean;
    }>
  | Readonly<{
      relativePath: string;
      kind: 'symlink';
      target: string;
    }>;

type WorkspaceManifestStatLike = Readonly<{
  mode: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

export function buildWorkspaceManifestEntry(params: Readonly<{
  relativePath: string;
  stats: WorkspaceManifestStatLike;
  fileDigest?: string;
  symlinkTarget?: string;
}>): WorkspaceManifestEntry {
  const traits = detectWorkspacePathTraits(params.relativePath);
  if (traits.isRoot || traits.isAbsolute || traits.hasParentTraversal) {
    throw new Error('Workspace manifest path must stay within the workspace root');
  }

  if (params.stats.isDirectory()) {
    return {
      relativePath: traits.normalizedPath,
      kind: 'directory',
    };
  }

  if (params.stats.isSymbolicLink()) {
    if (!params.symlinkTarget || params.symlinkTarget.trim().length === 0) {
      throw new Error('Workspace manifest symlink entries require a target');
    }
    return {
      relativePath: traits.normalizedPath,
      kind: 'symlink',
      target: params.symlinkTarget,
    };
  }

  if (params.stats.isFile()) {
    if (!params.fileDigest || params.fileDigest.trim().length === 0) {
      throw new Error('Workspace manifest file entries require a digest');
    }
    return {
      relativePath: traits.normalizedPath,
      kind: 'file',
      digest: params.fileDigest,
      sizeBytes: params.stats.size,
      executable: (params.stats.mode & 0o111) !== 0,
    };
  }

  throw new Error(`Unsupported workspace manifest entry kind for ${traits.normalizedPath}`);
}
