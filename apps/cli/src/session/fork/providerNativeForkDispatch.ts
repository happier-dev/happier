import type { Credentials } from '@/persistence';
import { getProviderNativeForkHandler } from '@/backends/catalog';
import {
  type ProviderNativeForkDispatchResult,
  type ProviderNativeForkPoint,
} from '@/backends/forking/providerNativeForkHandler';

export async function dispatchProviderNativeFork(params: Readonly<{
  credentials: Credentials;
  agentId: string;
  parentSessionId: string;
  parentRawSession: Readonly<{ encryptionMode?: unknown; dataEncryptionKey?: unknown; metadata?: unknown }>;
  parentMetadata: Record<string, unknown>;
  directory: string;
  forkPoint: ProviderNativeForkPoint;
  targetSeqInclusive: number;
}>): Promise<ProviderNativeForkDispatchResult | null> {
  const handler = await getProviderNativeForkHandler(params.agentId as any);
  return handler ? await handler(params) : null;
}
