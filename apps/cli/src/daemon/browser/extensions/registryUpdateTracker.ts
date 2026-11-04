import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegistryUpstreamCheckV1 } from '@happier-dev/protocol/registries';
import type { RegistryUpdateTrackerV1 } from '../../../registries/updates/registryUpdateTracker';
import type { BrowserProfileStore } from '../profiles/store';
import { createConfiguredBrowserProfileStore } from '../profiles/configuredStore';
import { acquireBrowserExtension } from './acquisition';
import { managedBrowserExtensionChromeVersion } from './service';

/** Profile inventory and native source versions participate in the Store's existing update lifecycle. */
export function createBrowserExtensionRegistryUpdateTracker(input: Readonly<{
  signal?: AbortSignal; profileStore?: BrowserProfileStore;
}> = {}): RegistryUpdateTrackerV1 {
  const store = input.profileStore ?? createConfiguredBrowserProfileStore();
  return {
    kind: 'browserExtension',
    async list() {
      const items: Awaited<ReturnType<RegistryUpdateTrackerV1['list']>>[number][] = [];
      for (const profile of await store.listPersistentProfiles()) {
        input.signal?.throwIfAborted();
        const result = await store.listExtensions(profile.profileId);
        if (!result.ok) continue;
        items.push(...result.extensions.map(extension => ({ key: JSON.stringify([profile.profileId, extension.id]),
          installedVersion: extension.version,
          ...(extension.provenance ? { provenance: extension.provenance } : {}),
          ...(extension.upstream ? { upstream: extension.upstream } : {}) })));
      }
      return items;
    },
    async check(items) {
      const observations = new Map<string, RegistryUpstreamCheckV1>();
      const profiles = new Map<string, Awaited<ReturnType<BrowserProfileStore['listExtensions']>>>();
      for (const item of items) {
        input.signal?.throwIfAborted();
        // Keys originate in list(), not from external input.
        const [profileId, extensionId] = JSON.parse(item.key) as [string, string];
        let profile = profiles.get(profileId);
        if (!profile) { profile = await store.listExtensions(profileId); profiles.set(profileId, profile); }
        const extension = profile.ok ? profile.extensions.find(value => value.id === extensionId) : undefined;
        if (!extension) {
          observations.set(item.key, { state: 'unchecked', reason: { state: 'unreachable' } });
          continue;
        }
        const acquired = await acquireBrowserExtension({ source: extension.source,
          storageDirectory: join(store.resolveProfileDirectory(profileId), 'extensions', 'packages'),
          chromeVersion: managedBrowserExtensionChromeVersion(), existingDirectory: extension.directory, signal: input.signal });
        if (!acquired.ok) {
          input.signal?.throwIfAborted();
          observations.set(item.key, { state: 'unchecked', reason: {
            state: acquired.errorCode === 'extension_acquisition_failed' ? 'unreachable' : 'invalid_source' } });
          continue;
        }
        try {
          input.signal?.throwIfAborted();
          observations.set(item.key, acquired.extension.id !== extension.id
            ? { state: 'unchecked', reason: { state: 'invalid_source' } }
            : { state: acquired.extension.version === item.installedVersion ? 'current' : 'update_available',
              latest: { kind: 'version', version: acquired.extension.version } });
        } finally {
          await rm(acquired.extension.directory, { recursive: true, force: true });
        }
      }
      return observations;
    },
    async record(changes) {
      for (const change of changes) {
        input.signal?.throwIfAborted();
        const [profileId, extensionId] = JSON.parse(change.key) as [string, string];
        if (change.installedVersion === undefined) throw new Error('browser_extension_baseline_missing');
        await store.recordExtensionUpstream(profileId, extensionId, change.installedVersion, change.upstream);
      }
    },
  };
}
