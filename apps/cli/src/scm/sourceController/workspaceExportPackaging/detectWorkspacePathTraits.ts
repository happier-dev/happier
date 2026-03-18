import { normalizeWorkspacePath } from './normalizeWorkspacePath';

export type WorkspacePathTraits = Readonly<{
  normalizedPath: string;
  segments: readonly string[];
  isRoot: boolean;
  isAbsolute: boolean;
  hasParentTraversal: boolean;
}>;

export function detectWorkspacePathTraits(value: string): WorkspacePathTraits {
  const normalizedPath = normalizeWorkspacePath(value);
  const segments = normalizedPath.length > 0 ? normalizedPath.split('/') : [];
    return {
        normalizedPath,
        segments,
        isRoot: segments.length === 0,
        isAbsolute: normalizedPath.startsWith('/'),
        hasParentTraversal: segments.includes('..'),
    };
}
