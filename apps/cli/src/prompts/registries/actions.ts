import type {
  PromptRegistryInstallRequestV1,
  PromptRegistryInstallResponseV1,
  PromptRegistryFetchItemResponseV1,
  PromptRegistryFetchedItemV1,
  PromptRegistryScanSourceRequestV1,
  PromptRegistryScanSourceResponseV1,
} from '@happier-dev/protocol';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';

import type { PromptRegistryRegistry } from './createPromptRegistryAdapterRegistry';

function invalidRequest(error: string) {
  return { ok: false as const, errorCode: 'invalid_request' as const, error };
}

function internalError(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return invalidRequest(error.message);
  }
  return invalidRequest('internal_error');
}

export async function scanPromptRegistrySource(params: Readonly<{
  registry: PromptRegistryRegistry;
  request: PromptRegistryScanSourceRequestV1;
}>): Promise<PromptRegistryScanSourceResponseV1> {
  try {
    const items = await params.registry.scanSource({
      sourceId: params.request.sourceId,
      configuredSources: params.request.configuredSources,
      query: params.request.query ?? null,
    });
    return { ok: true, items };
  } catch (error) {
    return internalError(error);
  }
}

export async function installPromptRegistryItem(params: Readonly<{
  registry: PromptRegistryRegistry;
  assetRegistry: ReadonlyMap<string, PromptAssetAdapter>;
  request: PromptRegistryInstallRequestV1;
  fetchedItem?: PromptRegistryFetchedItemV1;
  signal?: AbortSignal;
}>): Promise<PromptRegistryInstallResponseV1> {
  const adapter = params.assetRegistry.get(params.request.installTarget.assetTypeId);
  if (!adapter) return invalidRequest('unsupported asset type');
  if (adapter.descriptor.libraryKind !== 'bundle') {
    return invalidRequest('registry installs require a bundle-capable prompt asset type');
  }
  if (adapter.descriptor.capabilities.supportsCatalogInstall !== true) {
    return invalidRequest('prompt asset type does not support registry installs');
  }
  if (adapter.descriptor.supportsScope[params.request.installTarget.scope] !== true) {
    return invalidRequest('prompt asset type does not support the selected scope');
  }

  try {
    const fetched: PromptRegistryFetchItemResponseV1 = params.fetchedItem
      ? { ok: true, item: params.fetchedItem }
      : await params.registry.fetchItem({
          sourceId: params.request.sourceId,
          itemId: params.request.itemId,
          configuredSources: params.request.configuredSources,
        });
    if (!fetched.ok) {
      return {
        ok: false,
        errorCode: fetched.errorCode === 'not_found'
          ? 'not_found'
          : fetched.errorCode === 'unsupported'
            ? 'unsupported'
            : 'invalid_request',
        error: fetched.error,
      };
    }

    return await adapter.writeBundle({
      assetTypeId: params.request.installTarget.assetTypeId,
      scope: params.request.installTarget.scope,
      directory: params.request.installTarget.scope === 'project'
        ? (params.request.installTarget.directory ?? null)
        : null,
      targetName: params.request.installTarget.targetName,
      title: fetched.item.title,
      bundleSchemaId: fetched.item.bundleSchemaId,
      bundleBody: fetched.item.bundleBody,
      installMode: params.request.installTarget.installMode,
      previewOnly: params.request.previewOnly,
      expectedDigest: params.request.expectedDigest,
    }, params.signal ? { signal: params.signal } : undefined);
  } catch (error) {
    return internalError(error) as PromptRegistryInstallResponseV1;
  }
}

export async function fetchPromptRegistryItem(params: Readonly<{
  registry: PromptRegistryRegistry;
  sourceId: string;
  itemId: string;
  configuredSources: readonly PromptRegistryScanSourceRequestV1['configuredSources'][number][];
  signal?: AbortSignal;
}>): Promise<PromptRegistryFetchItemResponseV1> {
  params.signal?.throwIfAborted();
  try {
    const result = await params.registry.fetchItem({
      sourceId: params.sourceId,
      itemId: params.itemId,
      configuredSources: params.configuredSources,
    });
    params.signal?.throwIfAborted();
    return result;
  } catch (error) {
    return internalError(error) as PromptRegistryFetchItemResponseV1;
  }
}
