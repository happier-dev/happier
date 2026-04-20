import type { Credentials } from '@/persistence';
import type { CatalogAgentId } from '@/backends/types';
import { getProviderNativeForkHandler } from '@/backends/catalog';
import {
  type ProviderNativeForkDispatchResult,
  type ProviderNativeForkPoint,
} from '@/session/fork/providerNativeForkHandler';

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
  const handler = await getProviderNativeForkHandler(params.agentId as CatalogAgentId);
  return handler ? await handler(params) : null;
}
