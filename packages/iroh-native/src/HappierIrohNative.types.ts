export type NativeIrohModule = Readonly<{
  getAvailability?: () => Record<string, unknown>;
  startHomeTunnel: (request: {
    homeServerIdentityId: string;
    endpointId: string;
    relayPolicy: 'automatic' | 'disabled';
  }) => Promise<{
    leaseId: string;
    homeServerIdentityId: string;
    homeEndpointId: string;
    runtimeOrigin: string;
    carrier: 'iroh';
    observedPath: 'direct' | 'relay' | 'unknown';
    startedAtMs: number;
  }>;
  stopHomeTunnel: (leaseId: string) => Promise<void>;
  getHomeTunnelStatus?: (homeServerIdentityId: string) => Promise<Record<string, unknown> | null>;
}>;
