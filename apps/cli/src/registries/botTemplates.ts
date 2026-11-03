import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { readBotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { RegistryFetchErrorV1 } from '@happier-dev/protocol/registries';
import type { RegistryAvailableBotTemplateReaderV1, RegistryBotTemplateReaderV1 } from '@happier-dev/protocol/registries/registryHostV1';
import { resolveAndDownloadNpmArtifact } from '@/plugins/distribution/npm/adapter';
import { cleanupStagedNpmArtifactCandidate, stageDownloadedNpmArtifactCandidate } from '@/plugins/distribution/npm/stage';

/** Acquires a selected package as data using the install owner's npm and archive readers. */
export function createCliRegistryBotTemplateReaderV1(options: Readonly<{
  temporaryDirectory?: string;
  /** The existing Machine ingress may not lend its custodian's private npm profile to another Account. */
  allowMachineNpmProfiles?: boolean;
  readAvailableBotTemplate?: RegistryAvailableBotTemplateReaderV1;
}> = {}): RegistryBotTemplateReaderV1 {
  return async ({ item, source, context, contributionId }) => {
    if (item.payload.kind !== 'plugin' || 'packageContent' in source) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const listing = item.payload.listing;
    if (source.format === 'happier-catalog') {
      const available = await options.readAvailableBotTemplate?.({ source, item, contributionId, signal: context.signal,
        pointer: { sourceId: item.summary.sourceId, itemId: item.summary.itemId, version: listing.distribution.version } });
      if (available) return available;
    }
    const root = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'happier-template-'));
    try {
      const request = {
        input: { curatedExactOrigin: listing.distribution.registryOrigin, packageName: listing.distribution.packageName,
          selector: listing.distribution.version },
        destinationPath: join(root, 'package.tgz'), signal: context.signal,
      };
      const registryClient: Parameters<typeof resolveAndDownloadNpmArtifact>[0]['client'] = {
          getJson: async ({ url }) => {
            const response = await context.http.getJson(url, { source });
            if (!response.ok) throw new RegistryFetchErrorV1(response.status);
            return response.value;
          },
          getBody: async ({ url }) => {
            const response = await context.http.getBytes(url, { source });
            if (!response.ok) throw new RegistryFetchErrorV1(response.status);
            return { body: Readable.from([response.value]), contentLength: response.value.byteLength };
          },
      };
      const acquire = async () => {
        const profileId = listing.distribution.registryProfileId ?? source.npmRegistryProfileId;
        if (!profileId) return resolveAndDownloadNpmArtifact({ ...request, client: registryClient });
        if (options.allowMachineNpmProfiles === false) throw new RegistryFetchErrorV1({ state: 'auth_failed' });
        const [{ createNpmRegistryProfileService }, { createNpmRegistryHttpsClient }] = await Promise.all([
          import('@/plugins/distribution/npm/profiles/service'), import('@/plugins/distribution/npm/httpsClient'),
        ]);
        return createNpmRegistryProfileService().runArtifactRequest({ ...request.input, explicitProfileId: profileId }, access =>
          resolveAndDownloadNpmArtifact({ ...request, client: createNpmRegistryHttpsClient({ registryOrigin: access.request.registryOrigin,
            allowPrivateNetwork: access.allowPrivateNetwork, ...(access.authorizationHeader ? { authorizationHeader: access.authorizationHeader } : {}) }) }));
      };
      const downloaded = await acquire();
      if (downloaded.source.integrity !== listing.distribution.integrity) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const staged = await stageDownloadedNpmArtifactCandidate({ candidate: downloaded, stagingParentPath: root, signal: context.signal });
      if (!staged.ok) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      try {
        const candidate = staged.candidate;
        if (candidate.manifest.id !== listing.pluginId || candidate.manifest.digest !== listing.manifestDigest) {
          throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        }
        const contribution = candidate.manifest.value.contributes.botTemplates?.find(value => value.id === contributionId);
        if (!contribution) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        const path = contribution.path.replace(/^\.\//, '');
        if (!candidate.inventory.some(file => file.path === path)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        const value: unknown = JSON.parse(await readFile(join(candidate.rootPath, ...path.split('/')), { encoding: 'utf8', signal: context.signal }));
        try {
          return readBotTemplateReleaseV1(value, { kind: 'plugin', registryItem: {
            sourceId: item.summary.sourceId, itemId: item.summary.itemId, version: listing.distribution.version,
          }, contributionId });
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'update_required') {
            throw new RegistryFetchErrorV1({ state: 'newer_format', found: 'botTemplate' });
          }
          throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        }
      } finally { await cleanupStagedNpmArtifactCandidate(staged.candidate); }
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof RegistryFetchErrorV1) throw error;
      if (error && typeof error === 'object' && 'code' in error
        && (error.code === 'authentication_failed' || error.code === 'authentication_required' || error.code === 'source_changed')) {
        throw new RegistryFetchErrorV1({ state: 'auth_failed' });
      }
      throw new RegistryFetchErrorV1({ state: error instanceof SyntaxError ? 'invalid_source' : 'unreachable' });
    } finally { await rm(root, { recursive: true, force: true }); }
  };
}
