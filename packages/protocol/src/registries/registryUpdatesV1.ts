import type { RegistryHostDepsV1 } from './registryHostV1.js';
import type { RegistryContentRefV1, RegistryProvenanceV1, RegistryRemoteProvenanceV1 } from './registryItemsV1.js';
import { RegistryFetchErrorV1 } from './registryListV1.js';
import { resolveLegacyRegistrySourceRefV1, type RegistryRemoteSourceDescriptorV1, type RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1, RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';
import { REGISTRY_FORMAT_ADAPTERS_V1 } from './formats/index.js';
import { compareRegistryContentRefV1, type RegistryUpstreamCheckV1 } from './registryUpstreamV1.js';
import { readRegistryPackageAppCatalogV1 } from './registryPackageContentV1.js';
import { latestHappierAppCatalogRefsV1 } from './formats/happierAppCatalog.js';
import type { RegistryAppUpdateDemandV1 } from './registryActionsV1.js';
import type { DeploymentTemplateRefV1Schema } from '../deployments/storedAppInputV1.js';
import type { RegistryUpdateCheckResultV1 } from './registryUpstreamV1.js';
export * from './registryUpstreamV1.js';

/** Structural projection of the authorized, opened Environment; never a caller-supplied pin. */
export type RegistryAppUpdateEnvironmentV1 = Readonly<{
  environment: Readonly<{ id: string; revision: number }>;
  content: Readonly<{ template?: Readonly<{ templateRef: import('zod/mini').infer<typeof DeploymentTemplateRefV1Schema> }> }>;
}>;

export async function checkRegistryAppUpdatesV1(ctx: RegistryFetchContextV1, input: Readonly<{
  environments: readonly RegistryAppUpdateDemandV1[];
  readEnvironment: (environmentId: string) => Promise<RegistryAppUpdateEnvironmentV1>;
  readSources: () => Promise<readonly RegistrySourceDescriptorV1[]>;
  admitSource?: RegistryHostDepsV1['admitSource'];
}>): Promise<RegistryUpdateCheckResultV1> {
  ctx.signal?.throwIfAborted();
  const results: RegistryUpdateCheckResultV1['results'][number][] = [];
  const selected = await Promise.all(input.environments.map(async demand => {
    try {
      const current = await input.readEnvironment(demand.environmentId);
      ctx.signal?.throwIfAborted();
      if (current.environment.id !== demand.environmentId || current.environment.revision !== demand.expectedRevision) {
        throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      }
      return current.content.template ? { key: demand.environmentId, templateRef: current.content.template.templateRef } : null;
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      results.push({ kind: 'app', key: demand.environmentId, upstream: { state: 'unchecked', reason: error.status } });
      return null;
    }
  }));
  const templates = selected.filter(item => item !== null);
  let descriptors: readonly RegistrySourceDescriptorV1[] = [];
  if (templates.length) {
    try {
      const sources = await input.readSources();
      descriptors = sources;
      ctx.signal?.throwIfAborted();
      const byId = new Map(sources.map(source => [source.id, source]));
      const items: { key: string; provenance: RegistryProvenanceV1 }[] = [];
      for (const { key, templateRef } of templates) {
        const source = byId.get(resolveLegacyRegistrySourceRefV1(templateRef.sourceId));
        if (!source?.enabled || !source.kinds.includes('app')) {
          results.push({ kind: 'app', key, upstream: { state: 'unchecked', reason: { state: 'invalid_source' } } });
          continue;
        }
        if ('packageContent' in source) {
          if (templateRef.ref.kind !== 'packageContent') {
            results.push({ kind: 'app', key, upstream: { state: 'unchecked', reason: { state: 'invalid_source' } } });
            continue;
          }
          items.push({ key, provenance: { sourceId: source.id, format: source.format,
            itemId: templateRef.itemId, ref: templateRef.ref, importedAt: 0 } });
        } else {
          if (templateRef.ref.kind === 'packageContent') {
            results.push({ kind: 'app', key, upstream: { state: 'unchecked', reason: { state: 'invalid_source' } } });
            continue;
          }
          items.push({ key, provenance: { sourceId: source.id, format: source.format, sourceUrl: source.url,
            itemId: templateRef.itemId, ref: templateRef.ref, importedAt: 0 } });
        }
      }
      const observations = await checkRegistryUpstreamV1(ctx, { sources, items, admitSource: input.admitSource });
      for (const { key } of items) results.push({ kind: 'app', key, upstream: observations.get(key)! });
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      for (const { key } of templates) if (!results.some(result => result.key === key)) {
        results.push({ kind: 'app', key, upstream: { state: 'unchecked', reason: error.status } });
      }
    }
  }
  ctx.signal?.throwIfAborted();
  return { checkedAt: Date.now(), results: results.map(result => {
    if (result.upstream.state !== 'unchecked') return result;
    const selected = templates.find(template => template.key === result.key);
    // A refused Environment read has no admitted template/source to disclose.
    if (!selected) return result;
    const sourceId = resolveLegacyRegistrySourceRefV1(selected.templateRef.sourceId);
    const source = descriptors.find(source => source.id === sourceId);
    return { ...result, sourceId, ...(source?.title ? { sourceTitle: source.title } : {}) };
  }) };
}

type RegistryLatestRefsV1 = ReadonlyMap<string, RegistryContentRefV1 | 'removed' | RegistryFetchErrorV1>;

export async function checkRegistryUpstreamV1(ctx: RegistryFetchContextV1, input: Readonly<{
  sources: readonly RegistrySourceDescriptorV1[];
  admitSource?: RegistryHostDepsV1['admitSource'];
  items: readonly Readonly<{ key: string; provenance: RegistryProvenanceV1 }>[];
  /** The host can place reads on a carrier. This checker still owns source binding and comparison. */
  readLatest?: (source: RegistryRemoteSourceDescriptorV1, items: readonly RegistryRemoteProvenanceV1[],
    readDirect: () => Promise<RegistryLatestRefsV1>) => Promise<RegistryLatestRefsV1>;
}>): Promise<ReadonlyMap<string, RegistryUpstreamCheckV1>> {
  ctx.signal?.throwIfAborted();
  const result = new Map<string, RegistryUpstreamCheckV1>();
  const groups = new Map<RegistrySourceDescriptorV1, typeof input.items[number][]>();
  for (const item of input.items) {
    const source = input.sources.find(source => source.id === resolveLegacyRegistrySourceRefV1(item.provenance.sourceId));
    const ref = item.provenance.ref;
    if (!source?.enabled || source.format !== item.provenance.format || ('packageContent' in source
      ? ref.kind !== 'packageContent' || source.packageContent.pluginId !== ref.pluginId
        || source.packageContent.path !== ref.path
      : source.url !== item.provenance.sourceUrl)) {
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
      let latest: RegistryLatestRefsV1;
      if ('packageContent' in source) {
        const acquired = await readRegistryPackageAppCatalogV1(operationCtx, source);
        latest = latestHappierAppCatalogRefsV1({ sourceId: source.id, ...acquired,
          itemIds: items.map(item => item.provenance.itemId), packageContent: source.packageContent });
      } else {
        const adapter: RegistryFormatAdapterV1 | undefined = (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<string, RegistryFormatAdapterV1>>)[source.format];
        if (!adapter) throw new RegistryFetchErrorV1({ state: 'newer_format', found: source.format });
        const remote = items.map(item => item.provenance).filter((provenance): provenance is RegistryRemoteProvenanceV1 =>
          provenance.sourceUrl !== undefined);
        const readDirect = () => adapter.latest({ ...operationCtx, http }, remote, { source });
        latest = await (input.readLatest ? input.readLatest(source, remote, readDirect) : readDirect());
      }
      ctx.signal?.throwIfAborted();
      for (const { key, provenance } of items) {
        const ref = latest.get(provenance.itemId);
        if (ref instanceof RegistryFetchErrorV1 || ref === undefined) {
          result.set(key, { state: 'unchecked', reason: ref?.status ?? { state: 'invalid_source' } });
        } else {
          result.set(key, { state: compareRegistryContentRefV1(provenance.ref, ref), ...(ref !== 'removed' ? { latest: ref } : {}) });
        }
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
