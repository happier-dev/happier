export type RuntimeDependency = Readonly<{
  name: string;
  optional: boolean;
  declaredSpec: string;
}>;

export type ResolvedRuntimePackage = Readonly<{
  packageDir: string;
  packageJsonPath: string;
  packageJson: any;
}>;

export function parsePackageNameSegments(packageName: unknown): string[];

export function collectExternalRuntimeDependencies(packageJson: any): ReadonlyArray<RuntimeDependency>;

export function assertResolvedRuntimeDependencyMatchesDeclaration(params: Readonly<{
  dependency: RuntimeDependency;
  resolvedPackageJsonPath: string;
  resolvedPackageJson: any;
}>): void;

export function assertPhysicalPathWithinApprovedRoot(params: Readonly<{
  approvedRootDir: string;
  sourcePath: string;
  dependencyName: string;
  errorPrefix?: string;
  realpathSyncImpl?: (path: string) => string;
}>): string;

export function resolveInstalledRuntimePackage(params: Readonly<{
  packageName: string;
  resolveFromPackageJsonPath: string;
  dereferenceRootDir?: string;
}>): ResolvedRuntimePackage;

export function copyDirDereferenceContainedSync(params: Readonly<{
  sourceDir: string;
  destDir: string;
  dereferenceRootDir?: string;
  shouldCopyPath?: (sourcePath: string) => boolean;
}>): void;

export function publishStagedDirectoryMountedSync(params: Readonly<{
  stagedDir: string;
  liveDir: string;
  rollbackDir: string;
  pruneStale?: boolean;
  fsOps?: Readonly<{
    existsSync?: typeof import('node:fs').existsSync;
    lstatSync?: typeof import('node:fs').lstatSync;
    mkdirSync?: typeof import('node:fs').mkdirSync;
    readdirSync?: (
      path: string,
    ) => Array<import('node:fs').Dirent>;
    renameSync?: typeof import('node:fs').renameSync;
    rmSync?: typeof import('node:fs').rmSync;
  }>;
}>): void;

export function vendorRuntimeDependencyTree(params: Readonly<{
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destNodeModulesDir: string;
  copyResolvedPackage: (params: Readonly<{
    sourcePackageDir: string;
    destPackageDir: string;
    dereferenceRootDir: string;
  }>) => void;
  visited?: Set<string>;
  activeSourcePackageDirs?: ReadonlySet<string>;
  validateResolvedPackage?: (resolved: Readonly<{
    packageName: string;
    packageDir: string;
    packageJsonPath: string;
  }>) => void;
  dereferenceRootDir?: string;
}>): void;
