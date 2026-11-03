import type { RegistryHostDepsV1 } from './registryHostV1.js';
import type { RegistryProvenanceV1 } from './registryItemsV1.js';
import { RegistryFetchErrorV1 } from './registryListV1.js';
import { resolveLegacyRegistrySourceRefV1, type RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1, RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';
import { REGISTRY_FORMAT_ADAPTERS_V1 } from './formats/index.js';
import { compareRegistryContentRefV1, type RegistryUpstreamCheckV1 } from './registryUpstreamV1.js';
export * from './registryUpstreamV1.js';

export async function checkRegistryUpstreamV1(ctx: RegistryFetchContextV1, input: Readonly<{
  sources: readonly RegistrySourceDescriptorV1[];
  admitSource?: RegistryHostDepsV1['admitSource'];
  items: readonly Readonly<{ key: string; provenance: RegistryProvenanceV1 }>[];
}>): Promise<ReadonlyMap<string, RegistryUpstreamCheckV1>> {
  ctx.signal?.throwIfAborted();
  const result = new Map<string, RegistryUpstreamCheckV1>();
  const groups = new Map<RegistrySourceDescriptorV1, typeof input.items[number][]>();
  for (const item of input.items) {
    const source = input.sources.find(source => source.id === resolveLegacyRegistrySourceRefV1(item.provenance.sourceId));
    if (!source?.enabled || source.format !== item.provenance.format || source.url !== item.provenance.sourceUrl) {
      result.set(item.key, { state: 'unchecked', reason: { state: 'invalid_source' } });
      continue;
    }
    const group = groups.get(source) ?? [];
    group.push(item); groups.set(source, group);
  }
  // Classify rejection at the HTTP boundary, not TypeErrors in format/domain code.
  const transport = async <T>(read: () => Promise<T>): Promise<T> => {
    try { ctx.signal?.throwIfAborted(); return await read(); }
    catch (error) {
      ctx.signal?.throwIfAborted();
      if (error instanceof TypeError) throw new RegistryFetchErrorV1({ state: 'unreachable' });
      throw error;
    }
  };
  await Promise.all([...groups].map(async ([source, items]) => {
    try {
      const operationCtx = input.admitSource ? await input.admitSource(source) : ctx;
      const http: RegistryHttpV1 = {
        getJson: (...args) => transport(() => operationCtx.http.getJson(...args)),
        getText: (...args) => transport(() => operationCtx.http.getText(...args)),
        getBytes: (...args) => transport(() => operationCtx.http.getBytes(...args)),
      };
      const adapter: RegistryFormatAdapterV1 | undefined = (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<string, RegistryFormatAdapterV1>>)[source.format];
      if (!adapter) throw new RegistryFetchErrorV1({ state: 'newer_format', found: source.format });
      const latest = await adapter.latest({ ...operationCtx, http }, items.map(item => item.provenance), { source });
      ctx.signal?.throwIfAborted();
      for (const { key, provenance } of items) {
        const ref = latest.get(provenance.itemId);
        result.set(key, ref === undefined ? { state: 'unchecked', reason: { state: 'invalid_source' } }
          : { state: compareRegistryContentRefV1(provenance.ref, ref), ...(ref !== 'removed' ? { latest: ref } : {}) });
      }
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      for (const item of items) result.set(item.key, { state: 'unchecked', reason: error.status });
    }
  }));
  ctx.signal?.throwIfAborted();
  return result;
}
