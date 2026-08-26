import {
  type ProviderNativeForkHandler,
  type ProviderNativeForkPoint,
  toForkPointV1,
} from '@/session/fork/providerNativeForkHandler';
import {
  readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata,
  type ForkResultV1,
  type ForkSessionMetadataV1,
  type ForkSurfaceV1,
} from '@happier-dev/agents';

export function buildForkSessionMetadata(
  metadata: Readonly<Record<string, unknown>>,
): ForkSessionMetadataV1 {
  const runtimeDescriptorV1 = readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(metadata);
  return Object.freeze({
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  });
}

export async function dispatchProviderNativeFork(params: Readonly<{
  forkSurface: (Omit<ForkSurfaceV1, 'fork'> & Readonly<{
    fork?: ProviderNativeForkHandler;
  }>) | null;
  parentSessionId: string;
  parentMetadata: Record<string, unknown>;
  directory: string;
  forkPoint: ProviderNativeForkPoint;
  signal?: AbortSignal;
}>): Promise<ForkResultV1 | null> {
  if (!params.forkSurface?.fork) {
    return null;
  }
  const result = await params.forkSurface.fork({
    parentSessionId: params.parentSessionId,
    parentMetadata: buildForkSessionMetadata(params.parentMetadata),
    directory: params.directory,
    forkPoint: toForkPointV1(params.forkPoint),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return result ?? null;
}
