import type { build, BuildOptions, Metafile, Plugin, TransformOptions, TransformResult } from 'esbuild';

export class SourceRuntimeReloadRequiredError extends Error {
  readonly code: 'SOURCE_RUNTIME_RELOAD_REQUIRED';
  readonly subtype: NonNullable<import('@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1').SessionSpawnLaunchErrorV1['subtype']>;
  readonly phase: 'dependencies';
  readonly retryable: false;
  readonly component: string;
  readonly entryGraph: string;
  constructor(component?: string, subtype?: SourceRuntimeReloadRequiredError['subtype']);
}
export type SourceRuntimeDependencyStatus = Readonly<Pick<SourceRuntimeReloadRequiredError, 'code' | 'subtype'>>;
export function observeSourceRuntimeDependencies(entrypoint: string, listener: (status: SourceRuntimeDependencyStatus | null) => void): () => void;
export function assertSourceRuntimeDependenciesCurrent(options: Readonly<{
  entrypoint?: string;
  record?: unknown;
  component?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>): Promise<void>;

export const SOURCE_CONDITION: 'happier-source';
export const SOURCE_RUNTIME_OUTPUT_OPTIONS: Readonly<Pick<BuildOptions,
  'charset' | 'minifyWhitespace' | 'legalComments' | 'supported'>>;
/** Gives split ESM chunks `require`, `__filename` and `__dirname`; strip it where unused. */
export const SOURCE_RUNTIME_COMMONJS_BANNER: string;
export const SOURCE_RUNTIME_COMMONJS_DEFINE: Readonly<{ __dirname: string; __filename: string }>;
export function stripUnusedSourceRuntimeBanner(code: string): string;
export function stripUnusedSourceRuntimeBanners(files: Iterable<string>): Promise<number>;
export function initialize(repoDir: string): Promise<void>;
export const resolve: import('node:module').ResolveHook;
export function sourceExport(value: unknown, label: string): string;
export type WorkspaceSourcePackage = Readonly<{ root: string; manifest: {
  name?: string;
  exports?: unknown;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  bundledDependencies?: readonly string[];
} }>;
export function readWorkspacePackages(repoDir: string): Promise<Map<string, WorkspaceSourcePackage>>;
export function workspaceSourcePackageClosure(packages: ReadonlyMap<string, WorkspaceSourcePackage>, roots: Iterable<string>): Set<string>;
export function packageNameOfSpecifier(specifier: string): string;
export function runtimePackageExports(value: unknown): unknown;
export function resolveWorkspaceSource(packages: Map<string, WorkspaceSourcePackage>, specifier: string, options?: Readonly<{ conditions?: readonly string[] }>): string;
export function workspaceSourceCompilerPaths(packages: Map<string, WorkspaceSourcePackage>): Record<string, string[]>;
export type CliSourcePluginMetadata = Readonly<{
  prefix: string;
  sourceDir: string;
  manifest: Record<string, unknown>;
  package: Record<string, unknown>;
}>;
export function readCliSourceEntries(options: Readonly<{
  repoDir: string;
  projectionRoot?: string;
  manifest: { exports?: Record<string, unknown>; imports?: Record<string, unknown> };
  transform: (input: string, options: TransformOptions) => Promise<TransformResult>;
  cliPrefix?: string;
  mainOutput?: string;
  publicPrefix?: string;
  pluginPrefix?: (name: string) => string;
}>): Promise<{ entries: Record<string, string>; pluginMetadata: CliSourcePluginMetadata[] }>;
export function createCliSourceProjectionResolver(options: Readonly<{ projectionRoot: string }>): Plugin;
export function createWorkspaceSourceResolver(options: Readonly<{
  workspacePackages: Map<string, WorkspaceSourcePackage>;
  requireFromProject: NodeRequire;
  externalPackages?: readonly string[];
}>): Plugin;
export function bundleCliSourceSidecars(options: Readonly<{
  repoDir: string;
  outputDir: string;
  build: typeof build;
  workspacePackages: Map<string, WorkspaceSourcePackage>;
  requireFromProject: NodeRequire;
}>): Promise<{codeFiles: string[]; metafile: Metafile}>;
