import { join } from 'node:path';

import { readPluginManifest } from '@/plugins/manifest/read';
import type { PluginStorePaths } from '../paths';
import {
  ContainedGenerationFileError,
  assertContainedRegularGenerationFile,
  readCurrentCommittedPluginGenerations,
  type CurrentCommittedPluginGeneration,
} from './generationStore';

/**
 * A structural or loadability fact about one installed immutable generation.
 *
 * These are observations of what the daemon-owned copy currently *is*, never
 * an integrity verdict: the generation record carries a declared path and byte
 * length, so a drifted, absent, escaped or unreadable file is a fact the store
 * already knows how to state. No digest is computed and no tampering is
 * claimed.
 */
export type InstalledPluginGenerationDiagnostic = Readonly<{
  code:
    | 'plugin_installed_generation_unavailable'
    | 'plugin_installed_generation_file_missing'
    | 'plugin_installed_generation_file_escaped'
    | 'plugin_installed_generation_file_not_regular'
    | 'plugin_installed_generation_file_shared_inode'
    | 'plugin_installed_generation_file_size_mismatch'
    | 'plugin_installed_generation_manifest_unloadable';
  message: string;
  relativePath?: string;
}>;

/**
 * The one action that restores an installed generation. Both outcomes are
 * ordinary user commands, so the report names the command rather than
 * describing a recovery procedure the CLI does not perform.
 */
export type InstalledPluginGenerationRepair = 'reinstall';

export type InstalledPluginGenerationReport = Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  /** Declared files actually inspected; `0` when the record is unreadable. */
  inspectedFileCount: number;
  diagnostics: readonly InstalledPluginGenerationDiagnostic[];
  repair?: InstalledPluginGenerationRepair;
}>;

export type InstalledPluginGenerationDiagnosisResult = Readonly<{
  ok: boolean;
  plugins: readonly InstalledPluginGenerationReport[];
  /** Set when an explicitly requested plugin id has no installed generation. */
  unknownPluginId?: string;
}>;

const FILE_DIAGNOSTIC_CODE_BY_FAILURE = {
  root_not_directory: 'plugin_installed_generation_file_not_regular',
  missing: 'plugin_installed_generation_file_missing',
  escaped: 'plugin_installed_generation_file_escaped',
  not_regular: 'plugin_installed_generation_file_not_regular',
  shared_inode: 'plugin_installed_generation_file_shared_inode',
  size_mismatch: 'plugin_installed_generation_file_size_mismatch',
} as const satisfies Record<
  ContainedGenerationFileError['failure'],
  InstalledPluginGenerationDiagnostic['code']
>;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectDeclaredFiles(
  generation: CurrentCommittedPluginGeneration,
): Promise<readonly InstalledPluginGenerationDiagnostic[]> {
  const diagnostics: InstalledPluginGenerationDiagnostic[] = [];
  for (const file of generation.record.files) {
    try {
      await assertContainedRegularGenerationFile(
        generation.rootPath,
        file.relativePath,
        'Installed plugin generation file',
        { expectedByteLength: file.byteLength },
      );
    } catch (error) {
      if (!(error instanceof ContainedGenerationFileError)) throw error;
      diagnostics.push(Object.freeze({
        code: FILE_DIAGNOSTIC_CODE_BY_FAILURE[error.failure],
        message: error.message,
        relativePath: error.relativePath === '' ? file.relativePath : error.relativePath,
      }));
    }
  }
  return Object.freeze(diagnostics);
}

async function inspectManifestLoadability(
  generation: CurrentCommittedPluginGeneration,
): Promise<readonly InstalledPluginGenerationDiagnostic[]> {
  let manifest: Awaited<ReturnType<typeof readPluginManifest>>;
  try {
    manifest = await readPluginManifest({
      manifestPath: join(
        generation.rootPath,
        ...generation.record.manifestRelativePath.split('/'),
      ),
      manifestAuthority: 'external',
      sourceProvenance: generation.record.sourceProvenance,
    });
  } catch (error) {
    return Object.freeze([Object.freeze({
      code: 'plugin_installed_generation_manifest_unloadable' as const,
      message: messageFromError(error),
      relativePath: generation.record.manifestRelativePath,
    })]);
  }
  if (manifest.ok) {
    if (manifest.manifest.id === generation.pluginId) return Object.freeze([]);
    return Object.freeze([Object.freeze({
      code: 'plugin_installed_generation_manifest_unloadable' as const,
      message: `Installed manifest declares '${manifest.manifest.id}', but this generation is installed as '${generation.pluginId}'`,
      relativePath: generation.record.manifestRelativePath,
    })]);
  }
  return Object.freeze(manifest.diagnostics.map((diagnostic) => Object.freeze({
    code: 'plugin_installed_generation_manifest_unloadable' as const,
    message: diagnostic.message,
    relativePath: generation.record.manifestRelativePath,
  })));
}

/**
 * Inspects the installed immutable generations the registry currently commits.
 *
 * This is the installed counterpart of the author-source doctor: it never
 * evaluates author code and never touches a working tree. Host-bundled
 * generations are out of scope — they are the host's own shipped bytes, are not
 * reinstallable by the user, and are hard-linked by the package manager, so the
 * exclusive-inode rule that protects a daemon-owned copy does not describe them.
 */
export async function diagnoseInstalledPluginGenerations(input: Readonly<{
  paths: PluginStorePaths;
  pluginId?: string;
}>): Promise<InstalledPluginGenerationDiagnosisResult> {
  const current = await readCurrentCommittedPluginGenerations(input.paths, {
    isolateInvalidInstalledGenerations: true,
  });
  const reports: InstalledPluginGenerationReport[] = [];

  const committedPluginIds = Object.keys(current?.commit?.pluginGenerations ?? {}).sort();
  for (const pluginId of committedPluginIds) {
    if (input.pluginId !== undefined && input.pluginId !== pluginId) continue;
    const rejected = current?.rejectedGenerations.get(pluginId);
    if (rejected) {
      reports.push(Object.freeze({
        pluginId,
        immutableGenerationId: rejected.immutableGenerationId,
        inspectedFileCount: 0,
        diagnostics: Object.freeze([Object.freeze({
          code: 'plugin_installed_generation_unavailable' as const,
          message: rejected.message,
        })]),
        repair: 'reinstall' as const,
      }));
      continue;
    }
    const generation = current?.generations.get(pluginId);
    if (!generation || !generation.installation) continue;
    const diagnostics = [
      ...await inspectDeclaredFiles(generation),
      ...await inspectManifestLoadability(generation),
    ];
    reports.push(Object.freeze({
      pluginId,
      immutableGenerationId: generation.immutableGenerationId,
      inspectedFileCount: generation.record.files.length,
      diagnostics: Object.freeze(diagnostics),
      ...(diagnostics.length > 0 ? { repair: 'reinstall' as const } : {}),
    }));
  }

  const unknownPluginId = input.pluginId !== undefined
    && !reports.some((report) => report.pluginId === input.pluginId)
    ? input.pluginId
    : undefined;

  return Object.freeze({
    ok: unknownPluginId === undefined
      && reports.every((report) => report.diagnostics.length === 0),
    plugins: Object.freeze(reports),
    ...(unknownPluginId === undefined ? {} : { unknownPluginId }),
  });
}
