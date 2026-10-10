import type { build, Metafile, Plugin, TransformOptions, TransformResult } from 'esbuild';

export const SOURCE_CONDITION: 'happier-source';
export function initialize(repoDir: string): Promise<void>;
export const resolve: import('node:module').ResolveHook;
export function sourceExport(value: unknown, label: string): string;
export type WorkspaceSourcePackage = Readonly<{ root: string; manifest: { name?: string; exports?: unknown } }>;
export function readWorkspacePackages(repoDir: string): Promise<Map<string, WorkspaceSourcePackage>>;
export function packageNameOfSpecifier(specifier: string): string;
export function runtimePackageExports(value: unknown): unknown;
export function resolveWorkspaceSource(packages: Map<string, WorkspaceSourcePackage>, specifier: string): string;
export function workspaceSourceCompilerPaths(packages: Map<string, WorkspaceSourcePackage>): Record<string, string[]>;
export type CliSourcePluginMetadata = Readonly<{
  prefix: string;
  sourceDir: string;
  manifest: Record<string, unknown>;
  package: Record<string, unknown>;
}>;
export function readCliSourceEntries(options: Readonly<{
  repoDir: string;
  manifest: { exports?: Record<string, unknown>; imports?: Record<string, unknown> };
  transform: (input: string, options: TransformOptions) => Promise<TransformResult>;
  cliPrefix?: string;
  mainOutput?: string;
  publicPrefix?: string;
  pluginPrefix?: (name: string) => string;
}>): Promise<{ entries: Record<string, string>; pluginMetadata: CliSourcePluginMetadata[] }>;
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
