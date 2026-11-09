import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveLegacyPluginGenerationRoot } from '../pathLayout';
import type { PluginStorePaths } from '../paths';
import type { PluginRegistryCommitRecord } from './commitRecord';
import {
  prepareImmutablePluginGeneration,
  readCurrentCommittedPluginGenerations,
  readPluginRegistryCommitInstallationAuthority,
  readPreparedImmutablePluginGeneration,
} from './generationStore';

/** Startup adopts the selected code root; private registry authority stays put. */
export async function restagePrivatePluginGenerationsForExternalRoot(input: Readonly<{
  paths: PluginStorePaths;
  commit: PluginRegistryCommitRecord;
}>): Promise<readonly string[]> {
  const { paths, commit } = input;
  const generationsDir = resolveLegacyPluginGenerationRoot(paths.happyHomeDir);
  if (paths.generationsDir === generationsDir) return [];

  const state = await readPluginRegistryCommitInstallationAuthority(paths, commit);
  const references = [
    ...Object.entries(commit.pluginOccurrenceIds).map(([pluginId, reference]) => ({
      pluginId, immutableGenerationId: reference.immutableGenerationId, current: true,
    })),
    ...(state?.rollbackRetention ?? []).filter(retention => retention.byteAvailability === 'available')
      .map(retention => ({ ...retention, current: false })),
  ];
  const legacyPaths = { ...paths, generationsDir };
  let legacyCurrent: ReturnType<typeof readCurrentCommittedPluginGenerations> | undefined;
  const failures: string[] = [];
  for (const reference of references) {
    try {
      try {
        // Existing external bytes keep their normal admission, including a
        // corrupt destination. Conversion never repairs or replaces them.
        await lstat(join(paths.generationsDir, reference.immutableGenerationId));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      }

      let source: Pick<Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>>, 'rootPath' | 'record'>;
      if (reference.current) {
        // The normal reader owns current installation/catalog trust agreement.
        legacyCurrent ??= readCurrentCommittedPluginGenerations(legacyPaths, {
          isolateInvalidInstalledGenerations: true,
        });
        const admitted = await legacyCurrent;
        const current = admitted?.generations.get(reference.pluginId);
        if (!current || current.immutableGenerationId !== reference.immutableGenerationId) {
          throw new Error(admitted?.rejectedGenerations.get(reference.pluginId)?.message
            ?? 'Retained private generation has no matching installation authority');
        }
        source = current;
      } else {
        source = await readPreparedImmutablePluginGeneration({
          paths: legacyPaths, immutableGenerationId: reference.immutableGenerationId,
        });
        if (source.record.pluginId !== reference.pluginId) {
          throw new Error('Retained private rollback generation plugin identity mismatch');
        }
      }
      await prepareImmutablePluginGeneration({
        paths, sourceRootPath: source.rootPath, record: source.record,
      });
    } catch (error) {
      failures.push(`${reference.pluginId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}
