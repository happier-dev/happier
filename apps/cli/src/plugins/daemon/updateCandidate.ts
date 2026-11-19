import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryFetchErrorV1 } from '@happier-dev/protocol/registries';
import type { PluginStateRecord } from '@/plugins/store/state';
import { isPluginTrustRecordAuthorized } from '@/plugins/store/install/trustIdentity';
import { resolveNpmArtifactMetadata, type NpmRegistryJsonClient } from '@/plugins/distribution/npm/resolver';
import { NpmRegistryHttpError, createNpmRegistryHttpsClient } from '@/plugins/distribution/npm/httpsClient';
import { NpmRegistryProfileOperationError, createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { withResolvedGitPluginSource } from '@/plugins/discovery/sources/git';
import { stageNpmCompatiblePluginArchive } from '@/plugins/distribution/archive';
import { materializeArchive } from './archiveCandidate';
import { DaemonPluginChangePreparationError } from './changeService';
import { resolveInstalledPluginUpdate } from './resolveInstalledUpdate';

export type InstalledPluginUpdateCandidate = Readonly<{
  pluginId: string; installedVersion: string;
}> & (
  | Readonly<{ state: 'resolved'; candidateVersion: string; candidateCommit?: string }>
  | Readonly<{ state: 'unavailable'; reason: Readonly<{ code: string; cause?: unknown }> }>
);

/** Resolution only: never prepares a generation, invokes plugin code or changes installed state. */
export async function readInstalledPluginUpdateCandidate(input: Readonly<{
  pluginId: string; installed: PluginStateRecord; happyHomeDir?: string; signal?: AbortSignal;
  createNpmClient?: (options: Parameters<typeof createNpmRegistryHttpsClient>[0]) => NpmRegistryJsonClient;
  readGitPluginPointer?: Parameters<typeof withResolvedGitPluginSource>[1]['readCatalogPointer'];
}>): Promise<InstalledPluginUpdateCandidate> {
  const baseline = { pluginId: input.pluginId, installedVersion: input.installed.install.manifestVersion };
  const unavailable = (code: string, cause?: unknown): InstalledPluginUpdateCandidate => ({ ...baseline, state: 'unavailable', reason: { code, ...(cause === undefined ? {} : { cause }) } });
  try {
    input.signal?.throwIfAborted();
    const update = resolveInstalledPluginUpdate(input.pluginId, input.installed);
    let candidateVersion: string;
    if (update.kind === 'npm') {
      const profiles = createNpmRegistryProfileService({ happyHomeDir: input.happyHomeDir });
      const candidate = await profiles.runArtifactRequest({ ...update.request, explicitProfileId: update.request.registryProfileId }, async access => {
        const client = (input.createNpmClient ?? createNpmRegistryHttpsClient)({ registryOrigin: access.request.registryOrigin,
          allowPrivateNetwork: access.allowPrivateNetwork, ...(access.authorizationHeader ? { authorizationHeader: access.authorizationHeader } : {}) });
        return await resolveNpmArtifactMetadata({ request: access.request, client, signal: input.signal });
      });
      // The install adapter requires a compatible projection for range-selected updates too.
      if (!candidate.compatibility?.automaticEligible) return unavailable(candidate.compatibility?.diagnostics[0]?.code ?? 'plugin_compatibility_projection_missing');
      if (candidate.compatibility.projection?.manifest.id !== input.pluginId) return unavailable('plugin_update_identity_mismatch');
      candidateVersion = candidate.version;
    } else if (update.kind === 'git') {
      return await withResolvedGitPluginSource<InstalledPluginUpdateCandidate>(update.request.source, {
        signal: input.signal, readCatalogPointer: input.readGitPluginPointer,
      }, async ({ resolved, commit, source, catalog }) => {
        if (!resolved.ok) return unavailable(resolved.diagnostics[0]?.code ?? 'plugin_source_unavailable');
        if (resolved.manifest.id !== input.pluginId) return unavailable('plugin_update_identity_mismatch');
        if (!isPluginTrustRecordAuthorized(input.installed.install.trust, {
          pluginId: input.pluginId, distribution: { kind: 'git', ...source, ...(catalog ? { catalog } : {}) },
        })) {
          return unavailable('plugin_update_trust_unavailable');
        }
        input.signal?.throwIfAborted();
        return { ...baseline, state: 'resolved', candidateVersion: resolved.manifest.version, candidateCommit: commit };
      });
    } else if (update.kind === 'path') {
      const source = await resolveLocalPathPluginSource({ locator: update.request.locator });
      if (!source.ok) return unavailable(source.diagnostics[0]?.code ?? 'plugin_source_unavailable');
      if (source.manifest.id !== input.pluginId) return unavailable('plugin_update_identity_mismatch');
      candidateVersion = source.manifest.version;
    } else {
      const root = await mkdtemp(join(tmpdir(), 'happier-plugin-update-read-'));
      try {
        const archivePath = join(root, 'candidate.tgz');
        const facts = await materializeArchive({ locator: update.request.locator, destinationPath: archivePath, signal: input.signal });
        input.signal?.throwIfAborted();
        const staged = await stageNpmCompatiblePluginArchive({ archivePath, ...facts, stagingParentPath: join(root, 'staging'), signal: input.signal });
        if (!staged.ok) return unavailable(staged.rejection.code);
        if (staged.candidate.manifest.id !== input.pluginId) return unavailable('plugin_update_identity_mismatch');
        candidateVersion = staged.candidate.manifest.version;
      } finally { await rm(root, { recursive: true, force: true }); }
    }
    input.signal?.throwIfAborted();
    return { ...baseline, state: 'resolved', candidateVersion };
  } catch (cause) {
    input.signal?.throwIfAborted();
    if (cause instanceof RegistryFetchErrorV1) {
      if (cause.status.state === 'rate_limited') return unavailable('rate_limited', cause);
      return unavailable(cause.status.state === 'auth_failed' ? 'authentication_failed' :
        cause.status.state === 'unreachable' ? 'request_failed' : 'plugin_source_unavailable', cause);
    }
    return unavailable(cause instanceof DaemonPluginChangePreparationError || cause instanceof NpmRegistryHttpError || cause instanceof NpmRegistryProfileOperationError
      ? cause.code : 'plugin_update_resolution_failed', cause);
  }
}
