interface CliRuntimeAssetBuildManifestEntry {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

interface CliDistBuildManifest {
  readonly fingerprint: string;
  readonly builtAt: string;
  readonly fileCount: number;
  readonly toolVersion: string;
  readonly inputFingerprint?: string;
  readonly workspaceRuntimeIdentity?: string;
  readonly workspaceRuntimePackages?: readonly string[];
  readonly runtimeAsset?: CliRuntimeAssetBuildManifestEntry;
}

interface CliDistBuildManifestOptions {
  readonly outputDir?: string;
  readonly maxFiles?: number;
  readonly builtAt?: string;
  readonly inputFingerprint?: string;
  readonly workspaceRuntimeIdentity?: string;
  readonly workspaceRuntimePackages?: readonly string[];
}

interface CliDistIntegrityResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly fingerprint: string | null;
  readonly maxMtimeMs: number | null;
  readonly fileCount: number;
  readonly manifestPath?: string | null;
  readonly manifest?: CliDistBuildManifest;
  readonly files?: readonly string[];
  readonly missing?: readonly string[];
  readonly observedFingerprint?: string;
  readonly recordedFingerprint?: string;
  readonly recordedFileCount?: number;
}

interface CliRuntimeAssetIntegrityResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly relativePath: string | null;
  readonly assetPath?: string;
  readonly manifestPath?: string | null;
  readonly expected?: CliRuntimeAssetBuildManifestEntry;
  readonly observedSha256?: string;
}

declare const cliDistBuildManifest: {
  readonly CLI_DIST_BUILD_MANIFEST: string;
  readonly CLI_DIST_BUILD_MANIFEST_TOOL_VERSION: string;
  buildCliDistManifest(entrypoint: string, options?: CliDistBuildManifestOptions): CliDistBuildManifest;
  extractRelativeModuleSpecifiers(source: string): readonly string[];
  readCliDistBuildManifest(entrypoint: string, options?: CliDistBuildManifestOptions): CliDistIntegrityResult;
  readCliDistClosure(entrypoint: string, options?: CliDistBuildManifestOptions): Readonly<{
    ok: boolean;
    reason: string;
    rootDir: string;
    files: readonly string[];
    missing: readonly string[];
  }>;
  readCliDistClosureFingerprint(entrypoint: string, options?: CliDistBuildManifestOptions): CliDistIntegrityResult;
  readCliRuntimeAssetIntegrity(params: Readonly<{
    runtimeRoot: string;
    relativePath: string;
    entrypoint?: string;
  }>): CliRuntimeAssetIntegrityResult;
  readRecordedCliDistBuildManifestFingerprint(distDir: string): string | null;
  refreshCliRuntimeAssetBuildManifest(params: Readonly<{
    runtimeRoot: string;
    entrypoint: string;
  }>): Readonly<{
    manifest: CliDistBuildManifest;
    manifestPath: string;
    runtimeAsset: CliRuntimeAssetBuildManifestEntry;
  }>;
  writeCliRuntimeAssetBuildManifest(params: Readonly<{
    runtimeRoot: string;
    entrypoint: string;
    relativePath: string;
  }>): Readonly<{
    manifest: CliDistBuildManifest;
    manifestPath: string;
    runtimeAsset: CliRuntimeAssetBuildManifestEntry;
  }>;
  writeCliDistBuildManifest(entrypoint: string, options?: CliDistBuildManifestOptions): Readonly<{
    manifest: CliDistBuildManifest;
    manifestPath: string;
  }>;
  writeCliDistWorkspaceRuntimeIdentity(params: Readonly<{
    entrypoint: string;
    workspaceRuntimeIdentity: string;
  }>): Readonly<{
    manifest: CliDistBuildManifest;
    manifestPath: string;
    workspaceRuntimeIdentity: string;
  }>;
};

export = cliDistBuildManifest;
