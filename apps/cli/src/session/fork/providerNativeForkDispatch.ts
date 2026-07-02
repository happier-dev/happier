import {
  type ProviderNativeForkPoint,
  toForkPointV1,
} from '@/session/fork/providerNativeForkHandler';
import type { ForkResultV1, ForkSurfaceV1 } from '@happier-dev/agents';

export async function dispatchProviderNativeFork(params: Readonly<{
  forkSurface: ForkSurfaceV1 | null;
  parentSessionId: string;
  parentMetadata: Record<string, unknown>;
  directory: string;
  forkPoint: ProviderNativeForkPoint;
}>): Promise<ForkResultV1 | null> {
  if (!params.forkSurface?.fork) {
    return null;
  }
  const result = await params.forkSurface.fork({
    parentSessionId: params.parentSessionId,
    parentMetadata: params.parentMetadata,
    directory: params.directory,
    forkPoint: toForkPointV1(params.forkPoint),
  });
  return result ?? null;
}
