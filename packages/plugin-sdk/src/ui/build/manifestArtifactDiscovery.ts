import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, type win32 } from 'node:path';

import { PluginCollectionMigrationArtifactReferenceV1Schema } from '@happier-dev/protocol/plugins/data/collectionContributionV1';

import { PluginUiBuildError } from './errors.js';
import { UNIVERSAL_PLUGIN_UI_EXPORT_CONDITIONS } from './universalCommonJsCompiler.js';

type UnknownRecord = Readonly<Record<string, unknown>>;
type PathResolver = Readonly<
  Pick<typeof win32, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>
>;

export type DiscoveredExecutablePluginUiArtifact = Readonly<{
  artifactId: string;
  entryPath: string;
  requestedExports: readonly string[];
}>;

export type DiscoveredHostedStaticPluginUiArtifact = Readonly<{
  artifactId: string;
  sourceRoot: string;
}>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asRecords(value: unknown): readonly UnknownRecord[] {
  return Array.isArray(value)
    ? value
        .map(asRecord)
        .filter((entry): entry is UnknownRecord => entry !== null)
    : [];
}

function addReference(
  references: Map<string, Set<string>>,
  artifactId: unknown,
  exportName: unknown,
): void {
  if (typeof artifactId !== 'string' || !artifactId.trim()) return;
  if (typeof exportName !== 'string' || !exportName.trim()) return;
  const exports = references.get(artifactId) ?? new Set<string>();
  exports.add(exportName);
  references.set(artifactId, exports);
}

function discoverReferences(manifest: UnknownRecord): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  const contributes = asRecord(manifest.contributes);
  const ui = asRecord(contributes?.ui);
  for (const renderer of asRecords(ui?.renderers)) {
    if (renderer.kind === 'reactNative')
      addReference(references, renderer.artifact, 'renderSurface');
  }
  for (const action of asRecords(contributes?.actions)) {
    const execution = asRecord(action.execution);
    const client = asRecord(execution?.client);
    if (execution?.target === 'client')
      addReference(references, client?.artifactId, client?.exportName);
  }
  for (const provider of asRecords(contributes?.voiceProviders)) {
    if (provider.kind !== 'conversation') continue;
    const client = asRecord(provider.client);
    addReference(references, client?.artifactId, client?.exportName);
  }
  for (const family of ['dragSources', 'dropTargets'] as const) {
    for (const contribution of asRecords(contributes?.[family])) {
      const client = asRecord(contribution.client);
      addReference(references, client?.artifactId, client?.exportName);
    }
  }
  let migrationArtifact: Readonly<{
    artifactId: string;
    exportName: 'collectionMigrations';
  }> | null = null;
  for (const collection of asRecords(contributes?.accountCollections)) {
    if (asRecords(collection.migrations).length === 0) continue;
    const parsed = PluginCollectionMigrationArtifactReferenceV1Schema.safeParse(
      collection.migrationArtifact,
    );
    if (!parsed.success) {
      throw new PluginUiBuildError(
        'collection_migration_artifact_missing',
        `Account Collection "${String(collection.id ?? '')}" must declare its exact migration Artifact`,
      );
    }
    if (
      migrationArtifact &&
      (migrationArtifact.artifactId !== parsed.data.artifactId ||
        migrationArtifact.exportName !== parsed.data.exportName)
    ) {
      throw new PluginUiBuildError(
        'collection_migration_artifact_ambiguous',
        'All Account Collections with migrations must select the same exact migration Artifact',
      );
    }
    migrationArtifact = parsed.data;
  }
  if (migrationArtifact) {
    // An artifact may deliberately carry several declared executable
    // exports, but only this Account Collection reference grants migration
    // authority. A renderer-only declaration therefore remains
    // insufficient even when its bundle happens to export this name.
    addReference(
      references,
      migrationArtifact.artifactId,
      migrationArtifact.exportName,
    );
  }
  return references;
}

function collectRelevantExportTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  const record = asRecord(value);
  if (!record) return [];
  return UNIVERSAL_PLUGIN_UI_EXPORT_CONDITIONS.flatMap((condition) =>
    collectRelevantExportTargets(record[condition]),
  );
}

function readExportTarget(
  value: unknown,
  exportKey: string,
  artifactId: string,
  exportConditions?: readonly string[],
): string | null {
  // Development compiles the explicitly declared portable authored entry,
  // before npm's already-built platform branches. Public builds still require
  // the ordinary runtime conditions to agree below.
  const authoredSource = exportConditions?.includes('happier-source')
    ? asRecord(value)?.['happier-source']
    : undefined;
  if (typeof authoredSource === 'string') return authoredSource;
  const relevantTargets = collectRelevantExportTargets(value);
  if (new Set(relevantTargets).size > 1) {
    throw new PluginUiBuildError(
      'artifact_export_conditions_diverge',
      `Package export "${exportKey}" selects different executable entries for ${UNIVERSAL_PLUGIN_UI_EXPORT_CONDITIONS.join('/')}; Plugin UI artifacts must use one portable source entry`,
      artifactId,
    );
  }
  return relevantTargets[0] ?? null;
}

export function isManifestArtifactPathWithinProjectRoot(
  projectRoot: string,
  artifactPath: string,
  pathResolver: PathResolver = { isAbsolute, relative, resolve, sep },
): boolean {
  const resolvedProjectRoot = pathResolver.resolve(projectRoot);
  const resolvedArtifactPath = pathResolver.resolve(artifactPath);
  const relativeArtifactPath = pathResolver.relative(
    resolvedProjectRoot,
    resolvedArtifactPath,
  );
  return (
    relativeArtifactPath === '' ||
    (!pathResolver.isAbsolute(relativeArtifactPath) &&
      relativeArtifactPath !== '..' &&
      !relativeArtifactPath.startsWith(`..${pathResolver.sep}`))
  );
}

export async function discoverExecutablePluginUiArtifacts(
  projectRoot: string,
  manifestPath = resolve(projectRoot, '.happier-plugin/plugin.json'),
  exportConditions?: readonly string[],
): Promise<readonly DiscoveredExecutablePluginUiArtifact[]> {
  const packageJson = JSON.parse(
    await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
  ) as UnknownRecord;
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as UnknownRecord;
  const references = discoverReferences(manifest);
  const exportsMap = asRecord(packageJson.exports);
  for (const exportKey of Object.keys(exportsMap ?? {})) {
    const packagedArtifactId =
      /^\.\/happier-plugin-ui\/react-native\/(.+)\/entry\.cjs\.bundle$/u.exec(
        exportKey,
      )?.[1];
    if (packagedArtifactId && !references.has(packagedArtifactId)) {
      throw new PluginUiBuildError(
        'artifact_output_export_undeclared',
        `Packaged Plugin UI export "${exportKey}" requires a manifest artifact producer`,
        packagedArtifactId,
      );
    }
  }
  if (references.size === 0) return Object.freeze([]);
  if (!exportsMap) {
    throw new PluginUiBuildError(
      'package_exports_missing',
      'Plugin package must declare exact UI artifact exports',
    );
  }
  const wildcard = Object.keys(exportsMap).find(
    (key) => key.includes('*') && key.startsWith('./happier-plugin-ui/'),
  );
  if (wildcard) {
    throw new PluginUiBuildError(
      'artifact_export_wildcard_unsupported',
      `Plugin UI build declarations must use exact package exports, not "${wildcard}"`,
    );
  }

  const artifacts: DiscoveredExecutablePluginUiArtifact[] = [];
  for (const [artifactId, requestedExports] of [...references.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const exportKey = `./happier-plugin-ui/${artifactId}`;
    const target = readExportTarget(
      exportsMap[exportKey],
      exportKey,
      artifactId,
      exportConditions,
    );
    if (!target) {
      throw new PluginUiBuildError(
        'artifact_export_missing',
        `Executable Plugin UI artifact "${artifactId}" requires exact package export "${exportKey}"`,
        artifactId,
      );
    }
    const entryPath = resolve(projectRoot, target);
    if (!isManifestArtifactPathWithinProjectRoot(projectRoot, entryPath)) {
      throw new PluginUiBuildError(
        'artifact_export_escapes_root',
        `Package export "${exportKey}" escapes the plugin root`,
        artifactId,
      );
    }
    artifacts.push(
      Object.freeze({
        artifactId,
        entryPath,
        requestedExports: Object.freeze([...requestedExports].sort()),
      }),
    );
  }
  return Object.freeze(artifacts);
}

/**
 * Hosted content deliberately uses a static directory rather than a package
 * export or executable module. The artifact id in the manifest is the only
 * author-owned identity; its source bytes live at the matching conventional
 * directory beneath the manifest root.
 */
export async function discoverHostedStaticPluginUiArtifacts(
  projectRoot: string,
  manifestPath = resolve(projectRoot, '.happier-plugin/plugin.json'),
): Promise<readonly DiscoveredHostedStaticPluginUiArtifact[]> {
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as UnknownRecord;
  const contributes = asRecord(manifest.contributes);
  const ui = asRecord(contributes?.ui);
  const artifactIds = new Set<string>();
  for (const renderer of asRecords(ui?.renderers)) {
    if (renderer.kind !== 'hostedWeb') continue;
    const source = asRecord(renderer.source);
    if (
      source?.kind !== 'artifact' ||
      typeof source.artifact !== 'string' ||
      !source.artifact.trim()
    )
      continue;
    artifactIds.add(source.artifact);
  }
  return Object.freeze(
    [...artifactIds].sort().map((artifactId) =>
      Object.freeze({
        artifactId,
        sourceRoot: resolve(
          projectRoot,
          '.happier-plugin/ui/hosted-web',
          artifactId,
        ),
      }),
    ),
  );
}
