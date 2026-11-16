export declare const REQUIRED_BUNDLED_PLUGIN_PACKAGES: readonly string[];
export declare const BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH: '.project/tmp/bundled-plugin-publication/failures.json';
export declare const BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES: readonly [
  'plugin_package_build_failed', 'plugin_manifest_invalid', 'plugin_ui_artifact_invalid',
];
export declare const BUNDLED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH: 'dist/happier-plugin-ui/ui-artifacts.json';
export type BundledPluginPublicationDiagnosticCode = (typeof BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES)[number];
export type BundledPluginPublicationFailureRecord = Readonly<{
  packageName: string;
  pluginId: string;
  diagnostic: Readonly<{ code: BundledPluginPublicationDiagnosticCode; message: string }>;
  /** UI records only: the evaluated UI graph (`sha256:<hex>`), or null when none was published. */
  uiArtifactsDigest?: string | null;
}>;
export declare function isRequiredBundledPluginPackage(packageName: string): boolean;
export declare function parseBundledPluginPublicationFailures(raw: string): readonly BundledPluginPublicationFailureRecord[];
export declare function readBundledPluginUiArtifactsDigest(pluginRootPath: string): string | null;
export declare function classifyBundledPluginPublicationFailures<T extends BundledPluginPublicationFailureRecord>(
  failures: readonly T[],
  readUiArtifactsDigest?: (packageName: string) => string | null | undefined,
): Readonly<{ withdrawn: T[]; superseded: T[]; retained: T[] }>;
export declare function assertHostCanExcludeBundledPlugin(repoRoot: string, packageName: string, originalError?: unknown): void;
