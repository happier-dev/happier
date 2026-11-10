import type { RegistryUpstreamCheckV1 } from '@happier-dev/protocol/registries';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readInstalledPluginUpdateCandidate } from '@/plugins/daemon/updateCandidate';
import type { RegistryUpdateTrackerV1 } from '../registryUpdateTracker';

/** Native plugin channels share the existing finite registry check and plugin review. */
export function createPluginRegistryUpdateTracker(input: Omit<Parameters<typeof readInstalledPluginUpdateCandidate>[0], 'pluginId' | 'installed'> = {}): RegistryUpdateTrackerV1 {
  const store = createPluginRegistryStateStore({ happyHomeDir: input.happyHomeDir });
  return {
    kind: 'plugin',
    async list(keys) {
      const state = await store.read();
      const selected = keys ? new Set(keys) : null;
      return Object.entries(state.plugins).filter(([key]) => !selected || selected.has(key))
        .map(([key, record]) => ({ key, installedVersion: record.install.manifestVersion }));
    },
    async check(items) {
      const state = await store.read();
      const observations = new Map<string, RegistryUpstreamCheckV1>();
      for (const item of items) {
        input.signal?.throwIfAborted();
        const installed = state.plugins[item.key];
        if (!installed) { observations.set(item.key, { state: 'unchecked', reason: { state: 'invalid_source' } }); continue; }
        const candidate = await readInstalledPluginUpdateCandidate({ ...input, pluginId: item.key, installed });
        if (candidate.state === 'unavailable' && candidate.reason.code === 'plugin_update_resolution_failed') throw candidate.reason.cause;
        observations.set(item.key, candidate.state === 'resolved'
          ? { state: candidate.candidateVersion === candidate.installedVersion ? 'current' : 'update_available', latest: { kind: 'version', version: candidate.candidateVersion } }
          : { state: 'unchecked', reason: { state: candidate.reason.code === 'authentication_required' || candidate.reason.code === 'authentication_failed'
            ? 'auth_failed' : candidate.reason.code === 'rate_limited' ? 'rate_limited'
            : candidate.reason.code === 'server_error' || candidate.reason.code === 'request_failed' ? 'unreachable' : 'invalid_source' } });
      }
      return observations;
    },
    // Observations are returned by checkNow; plugin installed/trust state changes only through reviewed lifecycle operations.
    async record() {},
  };
}
