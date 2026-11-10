import type { BundledPluginPublicationDiagnosticCode } from '../../packages/cli-common/bundledPluginPublicationPolicy.mjs';

export type BundledPluginPublicationFailure = Readonly<{
  packageName: string;
  pluginId: string;
  diagnostic: Readonly<{
    code: BundledPluginPublicationDiagnosticCode;
    message: string;
  }>;
}>;


export declare function createBundledPluginPublicationFailure(input: Readonly<{
  repoRoot: string;
  packageName: string;
  pluginId?: string;
  code?: BundledPluginPublicationFailure['diagnostic']['code'];
  retainsPublishedArtifact?: boolean;
  error: unknown;
}>): BundledPluginPublicationFailure;

export declare function assertHostCanExcludeBundledPlugin(repoRoot: string, packageName: string, originalError?: unknown): void;
export declare function resolveBundledPluginPublicationFailuresPath(repoRoot: string): string;
export declare function readBundledPluginPublicationFailures(repoRoot: string): BundledPluginPublicationFailure[];
export declare function resolveBundledPluginPublicationFailures(repoRoot: string, failures: readonly BundledPluginPublicationFailure[], evaluatedPackageNames?: readonly string[]): BundledPluginPublicationFailure[];
export declare function writeBundledPluginPublicationFailures(repoRoot: string, failures: readonly BundledPluginPublicationFailure[], evaluatedPackageNames?: readonly string[]): void;
