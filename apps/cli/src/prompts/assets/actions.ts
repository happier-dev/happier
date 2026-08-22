import type {
  PromptAssetDeleteRequest,
  PromptAssetDiscoverRequest,
  PromptAssetDiscoverResponseV1,
  PromptAssetMutationResponseV1,
  PromptAssetWriteRequest,
  PromptAssetWriteBundleRequest,
} from '@happier-dev/protocol';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';

function invalidRequest(error: string): Exclude<PromptAssetMutationResponseV1, { ok: true }> {
  return { ok: false, errorCode: 'invalid_request', error };
}

type PromptAssetDiscoverActionResult =
  | PromptAssetDiscoverResponseV1
  | Exclude<PromptAssetMutationResponseV1, { ok: true }>;

function isPromptAssetWriteBundleRequest(
  request: PromptAssetWriteRequest,
): request is PromptAssetWriteBundleRequest {
  return Object.prototype.hasOwnProperty.call(request, 'bundleBody');
}

export async function discoverPromptAssets(params: Readonly<{
  registry: ReadonlyMap<string, PromptAssetAdapter>;
  request: PromptAssetDiscoverRequest;
  signal?: AbortSignal;
}>): Promise<PromptAssetDiscoverActionResult> {
  const adapter = params.registry.get(params.request.assetTypeId);
  if (!adapter) return invalidRequest('unsupported asset type');

  return {
    ok: true,
    items: [...await adapter.discover(
      params.request,
      params.signal ? { signal: params.signal } : undefined,
    )],
  };
}

export async function deletePromptAsset(params: Readonly<{
  registry: ReadonlyMap<string, PromptAssetAdapter>;
  request: PromptAssetDeleteRequest;
  signal?: AbortSignal;
}>): Promise<PromptAssetMutationResponseV1> {
  const adapter = params.registry.get(params.request.assetTypeId);
  if (!adapter) return invalidRequest('unsupported asset type');

  return await adapter.delete(
    params.request,
    params.signal ? { signal: params.signal } : undefined,
  );
}

export async function writePromptAsset(params: Readonly<{
  registry: ReadonlyMap<string, PromptAssetAdapter>;
  request: PromptAssetWriteRequest;
  signal?: AbortSignal;
}>): Promise<PromptAssetMutationResponseV1> {
  params.signal?.throwIfAborted();
  const adapter = params.registry.get(params.request.assetTypeId);
  if (!adapter) return invalidRequest('unsupported asset type');

  const options = params.signal ? { signal: params.signal } : undefined;
  const result = isPromptAssetWriteBundleRequest(params.request)
    ? await adapter.writeBundle(params.request, options)
    : await adapter.writeDoc(params.request, options);
  params.signal?.throwIfAborted();
  return result;
}
