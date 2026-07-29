interface CliDistBuildManifest {
  readonly fingerprint: string;
  readonly builtAt: string;
  readonly fileCount: number;
  readonly toolVersion: string;
  readonly inputFingerprint?: string;
}

interface CliDistBuildManifestOptions {
  readonly outputDir?: string;
  readonly maxFiles?: number;
  readonly builtAt?: string;
  readonly inputFingerprint?: string;
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
  readRecordedCliDistBuildManifestFingerprint(distDir: string): string | null;
  writeCliDistBuildManifest(entrypoint: string, options?: CliDistBuildManifestOptions): Readonly<{
    manifest: CliDistBuildManifest;
    manifestPath: string;
  }>;
};

export = cliDistBuildManifest;
