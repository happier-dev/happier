import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type SessionCatalogControlOperation = 'vendorPlugins' | 'skills';

export function unavailableSessionCatalog(operation: SessionCatalogControlOperation, diagnostic: string): unknown {
  return operation === 'vendorPlugins'
    ? { unsupported: true, vendorPlugins: [], diagnostic }
    : { unsupported: true, skills: [], diagnostic };
}

function isCatalogFallback(code: unknown): boolean {
  return code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || code === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || code === 'unsupported_session_runtime_method'
    || code === 'session_rpc_failed';
}

function shouldFallbackFromLiveSessionCatalogRpc(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  return isCatalogFallback(raw.errorCode) || isCatalogFallback(raw.error);
}

export async function routeSessionCatalogControl(params: Readonly<{
  active: boolean;
  metadataAvailable: boolean;
  operation: SessionCatalogControlOperation;
  callLiveSessionRpc: () => Promise<unknown>;
  callInactiveCatalog?: () => Promise<unknown>;
}>): Promise<unknown> {
  if (params.active) {
    try {
      const result = await params.callLiveSessionRpc();
      if (!shouldFallbackFromLiveSessionCatalogRpc(result)) return result;
    } catch (error) {
      if (!isCatalogFallback(readRpcErrorCode(error))) throw error;
    }
  }
  if (!params.metadataAvailable) {
    return unavailableSessionCatalog(params.operation, 'session_catalog_control_metadata_unavailable');
  }
  return params.callInactiveCatalog
    ? await params.callInactiveCatalog()
    : unavailableSessionCatalog(params.operation, 'session_catalog_control_current_machine_unknown');
}
