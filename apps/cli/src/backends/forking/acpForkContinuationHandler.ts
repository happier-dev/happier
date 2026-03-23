import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

export type AcpForkContinuationResult = Readonly<{
  spawn: Partial<SpawnSessionOptions>;
  metadata: Record<string, unknown>;
  providerHint?: Readonly<{
    providerId: string;
    backendMode?: string;
    vendorSessionId: string;
  }>;
}>;

export type AcpForkContinuationHandler = (params: Readonly<{
  agentId: string;
  parentMetadata: Record<string, unknown>;
  vendorSessionId: string;
}>) => Promise<AcpForkContinuationResult | null>;
