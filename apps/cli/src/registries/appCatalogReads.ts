import type { RegistryFetchContextV1, RegistryHttpResultV1, RegistryHttpV1 } from '@happier-dev/protocol/registries/formats/registryFormatAdapterV1';

type CatalogRead = { commit: string; active: number; resources: Map<string, Promise<RegistryHttpResultV1<Uint8Array>>> };
type SourceReads = { signature: string; current: CatalogRead; entries: Map<string, CatalogRead> };
const sources = new Map<string, SourceReads>();

/** One daemon-process owner, scoped to the admitted Account and source. Only
 * the current SHA and older SHA reads still being consumed remain reachable. */
export function createAppCatalogReadsV1(scopeKey: string | null): NonNullable<RegistryFetchContextV1['withAppCatalog']> {
  return async ({ source, commit, current, http }, consume) => {
    const key = JSON.stringify([scopeKey, source.id]);
    const signature = JSON.stringify([source.url, source.ref, source.path, source.token]);
    let admitted = sources.get(key);
    if (!admitted || admitted.signature !== signature) {
      const entry: CatalogRead = { commit, active: 0, resources: new Map() };
      admitted = { signature, current: entry, entries: new Map([[commit, entry]]) };
      sources.set(key, admitted);
    }
    let entry = admitted.entries.get(commit);
    if (!entry) {
      entry = { commit, active: 0, resources: new Map() };
      admitted.entries.set(commit, entry);
      // A listing may resolve the new SHA in another process. Its complete pin
      // is already resolved; retaining it must not require a daemon HEAD fetch.
      admitted.current = entry;
    }
    if (current) admitted.current = entry;
    for (const [sha, previous] of admitted.entries) {
      if (previous !== admitted.current && previous.active === 0 && previous !== entry) admitted.entries.delete(sha);
    }
    entry.active++;
    const resources = entry.resources;
    const getBytes: RegistryHttpV1['getBytes'] = (url, options) => {
      const existing = resources.get(url);
      if (existing) return existing;
      const pending = http.getBytes(url, options).then(result => {
        // The transport already owns reset-proven throttling. Failures settle;
        // a later explicit read may recover, without a timer or retry loop here.
        if (!result.ok) resources.delete(url);
        return result;
      }, error => { resources.delete(url); throw error; });
      resources.set(url, pending);
      return pending;
    };
    const retainedHttp: RegistryHttpV1 = {
      getBytes,
      getText: async (url, options) => {
        const result = await getBytes(url, options);
        return result.ok ? { ...result, value: new TextDecoder().decode(result.value) } : result;
      },
      getJson: async (url, options) => {
        const result = await getBytes(url, options);
        if (!result.ok) return result;
        try { return { ...result, value: JSON.parse(new TextDecoder().decode(result.value)) as unknown }; }
        catch { return { ok: false, status: { state: 'invalid_source' } }; }
      },
    };
    try { return await consume(retainedHttp); }
    finally {
      entry.active--;
      if (entry !== admitted.current && entry.active === 0) admitted.entries.delete(entry.commit);
    }
  };
}
