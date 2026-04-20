import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

export type ProviderNativeForkPoint = { type: 'latest' } | { type: 'seq'; upToSeqInclusive: number };

export type ProviderNativeForkDispatchResult = Readonly<{
  vendorSessionId: string;
  spawn: Partial<SpawnSessionOptions>;
  metadata: Record<string, unknown>;
  providerHint: {
    providerId: string;
    backendMode?: string;
    vendorSessionId: string;
  };
}>;

export type ProviderNativeForkHandler = (params: Readonly<{
  credentials: Credentials;
  agentId: string;
  parentSessionId: string;
  parentRawSession: Readonly<{ encryptionMode?: unknown; dataEncryptionKey?: unknown; metadata?: unknown }>;
  parentMetadata: Record<string, unknown>;
  directory: string;
  forkPoint: ProviderNativeForkPoint;
  targetSeqInclusive: number;
}>) => Promise<ProviderNativeForkDispatchResult | null>;
