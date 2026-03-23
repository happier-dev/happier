import { readSharedManagedOpenCodeServerStateBestEffort } from '@/backends/opencode/server/sharedManagedServer';
import { readOpenCodeSessionRuntimeHandleFromMetadata } from '@/backends/opencode/utils/opencodeSessionAffinity';

export type OpenCodeProviderAttachTarget =
  | Readonly<{
      eligible: true;
      vendorSessionId: string;
      directory: string;
      baseUrl: string;
    }>
  | Readonly<{
      eligible: false;
      reason: string;
    }>;

export type OpenCodeProviderAttachEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{ eligible: false; reason: string }>;

export function resolveOpenCodeProviderAttachTarget(
  metadata: Record<string, unknown>,
  options?: Readonly<{
    fallbackServerBaseUrl?: string | null;
  }>,
): OpenCodeProviderAttachTarget {
  const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata(metadata);
  const vendorSessionId = runtimeHandle.vendorSessionId;
  const directory = typeof metadata.path === 'string' && metadata.path.trim().length > 0
    ? metadata.path.trim()
    : null;
  const baseUrl = runtimeHandle.serverBaseUrl ?? options?.fallbackServerBaseUrl ?? null;

  if (!vendorSessionId) {
    return { eligible: false, reason: 'Session does not include an OpenCode vendor session id.' };
  }
  if (!directory) {
    return { eligible: false, reason: 'Session metadata is missing a working directory path.' };
  }
  if (runtimeHandle.backendMode !== 'server') {
    return { eligible: false, reason: 'OpenCode attach is only available for server-backed sessions.' };
  }
  if (!baseUrl) {
    return { eligible: false, reason: 'Session does not include an OpenCode server URL.' };
  }

  return {
    eligible: true,
    vendorSessionId,
    directory,
    baseUrl,
  };
}

export function evaluateOpenCodeProviderAttachEligibility(
  metadata: Record<string, unknown>,
  options?: Readonly<{
    fallbackServerBaseUrl?: string | null;
  }>,
): OpenCodeProviderAttachEligibility {
  const result = resolveOpenCodeProviderAttachTarget(metadata, options);
  return result.eligible
    ? { eligible: true }
    : { eligible: false, reason: result.reason };
}

export async function resolveOpenCodeProviderAttachTargetWithManagedServerFallback(params: Readonly<{
  metadata: Record<string, unknown>;
  readManagedServerStateFn?: typeof readSharedManagedOpenCodeServerStateBestEffort;
}>): Promise<OpenCodeProviderAttachTarget> {
  const managedState = await (params.readManagedServerStateFn ?? readSharedManagedOpenCodeServerStateBestEffort)().catch(() => null);
  return resolveOpenCodeProviderAttachTarget(params.metadata, {
    fallbackServerBaseUrl: managedState?.baseUrl ?? null,
  });
}
