import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readBotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { RegistryFetchErrorV1 } from '@happier-dev/protocol/registries';
import type { RegistryAvailableBotTemplateReaderV1 } from '@happier-dev/protocol/registries/registryHostV1';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readAdmittedPluginRegistryState } from '@/plugins/store/registry/admittedState';
import { assertContainedRegularGenerationFile, readPreparedImmutablePluginGeneration } from '@/plugins/store/registry/generationStore';

export type CliAvailableBotTemplateReaderV1 = RegistryAvailableBotTemplateReaderV1;

/** Reads installed package data; enabled state and executable runtime readiness are irrelevant. */
export function createCliAvailableBotTemplateReaderV1(options: Readonly<{
  happyHomeDir?: string;
}> = {}): CliAvailableBotTemplateReaderV1 {
  return async ({ pointer, source, contributionId, signal, item }) => {
    signal?.throwIfAborted();
    if ('packageContent' in source || source.id !== pointer.sourceId
      || !(source.format === 'happier-npm' || source.format === 'happier-catalog')) return null;
    const listing = item?.payload.kind === 'plugin' ? item.payload.listing : null;
    if (item && !listing) return null;
    // Installation authority retains the npm channel, not a catalog's recommendation binding.
    // An indexed pointer therefore needs its listing before local bytes can be selected.
    if (!listing && source.format !== 'happier-npm') return null;
    if (listing && (listing.distribution.version !== pointer.version
      || pointer.itemId !== (source.format === 'happier-npm' ? listing.distribution.packageName : listing.pluginId))) return null;

    try {
      const registryOrigin = source.format === 'happier-npm' ? new URL(source.url).origin : listing!.distribution.registryOrigin;
      if (listing && listing.distribution.registryOrigin !== registryOrigin) return null;
      const packageName = listing?.distribution.packageName ?? pointer.itemId;
      const paths = resolvePluginStorePaths(options);
      const admitted = await readAdmittedPluginRegistryState(paths);
      if (!admitted) return null;
      const matching = Object.entries(admitted.catalog.plugins).find(([pluginId, record]) => {
        const acquisition = admitted.revision.plugins[pluginId]?.source;
        const distribution = acquisition?.distribution;
        return distribution?.kind === 'npm' && distribution.registryOrigin === registryOrigin
          && distribution.packageName === packageName && record.source.resolvedVersion === pointer.version
          && (!listing || pluginId === listing.pluginId && acquisition?.admittedIntegrity === listing.distribution.integrity);
      });
      if (!matching) return null;
      const [pluginId] = matching;
      const reference = admitted.commit.pluginOccurrenceIds[pluginId];
      if (!reference) return null;
      const generation = await readPreparedImmutablePluginGeneration({ paths, immutableGenerationId: reference.immutableGenerationId });
      if (generation.record.pluginId !== pluginId) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const manifestBytes = await readFile(join(generation.rootPath, ...generation.record.manifestRelativePath.split('/')), { signal });
      if (listing && listing.manifestDigest !== `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`) {
        throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      }
      const manifest = ingestPluginManifestV2(manifestBytes, { mode: 'load' });
      if (!manifest.ok || manifest.manifest.id !== pluginId) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const contribution = manifest.manifest.contributes.botTemplates.find(value => value.id === contributionId);
      if (!contribution) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const path = contribution.path.replace(/^\.\//, '');
      const file = generation.record.files.find(value => value.relativePath === path);
      if (!file) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      await assertContainedRegularGenerationFile(generation.rootPath, path, 'Bot template', { expectedByteLength: file.byteLength });
      const value: unknown = JSON.parse(await readFile(join(generation.rootPath, ...path.split('/')), { encoding: 'utf8', signal }));
      return readBotTemplateReleaseV1(value, { kind: 'plugin', registryItem: pointer, contributionId });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof RegistryFetchErrorV1) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'update_required') {
        throw new RegistryFetchErrorV1({ state: 'newer_format', found: 'botTemplate' });
      }
      throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    }
  };
}
