export type PackageBuildOutputTarget = string;

export type ResolvePackageBuildOutputTargetPathOptions = Readonly<{
  packageDir: string;
  outputDir: string;
  target: PackageBuildOutputTarget;
}>;

export type ResolvePackageBuildOutputTargetMatchesOptions =
  ResolvePackageBuildOutputTargetPathOptions & Readonly<{
    existsSyncImpl?: (path: string) => boolean;
    readdirSyncImpl?: (
      path: string,
      options: Readonly<{ withFileTypes: true }>,
    ) => readonly Readonly<{
      name: string;
      isDirectory: () => boolean;
    }>[];
  }>;

export function collectPackageBuildOutputTargets(packageJson: unknown): PackageBuildOutputTarget[];
export function isLocalPackageBuildOutputTarget(target: PackageBuildOutputTarget): boolean;
export function isPackageBuildDistOutputTarget(target: PackageBuildOutputTarget): boolean;
export function resolvePackageBuildOutputTargetPath(options: ResolvePackageBuildOutputTargetPathOptions): string;
export function resolvePackageBuildOutputTargetMatches(
  options: ResolvePackageBuildOutputTargetMatchesOptions,
): string[];
