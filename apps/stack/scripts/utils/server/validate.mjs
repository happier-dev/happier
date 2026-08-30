export function detectServerComponentDirMismatch({ rootDir, serverComponentName, serverDir }) {
  // Repo-only model: server flavors share the same monorepo checkout/worktree.
  // The previous "mismatch" check was specific to the legacy multi-repo components layout.
  void rootDir;
  void serverComponentName;
  void serverDir;
  return null;
}

export function assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir }) {
  void rootDir;
  void serverComponentName;
  void serverDir;
}

export function assertServerPrismaProviderMatches({ serverComponentName, serverDir }) {
  // Database provider is runtime configuration shared by both presets. The
  // repository intentionally contains multiple Prisma schemas.
  void serverComponentName;
  void serverDir;
}
