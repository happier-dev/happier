import type { RegistryFetchContextV1 } from './formats/registryFormatAdapterV1.js';
import { HappierAppCatalogV1Schema } from './formats/happierAppCatalog.js';
import { RegistryFetchErrorV1 } from './registryListV1.js';
import type { RegistryPackagedSourceDescriptorV1 } from './registrySourcesV1.js';

/** The registry host and finite checker share one admitted package-data read. */
export async function readRegistryPackageAppCatalogV1(context: RegistryFetchContextV1, source: RegistryPackagedSourceDescriptorV1) {
  context.signal?.throwIfAborted();
  if (!source.enabled) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  if (!context.packageContent) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
  const response = await context.packageContent.read(source);
  context.signal?.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(response.text); }
  catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  const catalog = HappierAppCatalogV1Schema.safeParse(value);
  if (!catalog.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return { catalog: catalog.data, fetchedAt: response.fetchedAt };
}
