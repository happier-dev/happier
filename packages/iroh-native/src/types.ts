export type IrohRelayPolicy = 'automatic' | 'disabled';
export type IrohObservedPath = 'direct' | 'relay' | 'unknown';

export type IrohHomeTunnelLease = Readonly<{
  leaseId: string;
  homeServerIdentityId: string;
  homeEndpointId: string;
  runtimeOrigin: string;
  carrier: 'iroh';
  observedPath: IrohObservedPath;
  startedAtMs: number;
  release(): Promise<void>;
}>;

export type IrohNativeAdapter = Readonly<{
  ensureHomeTunnel(input: { homeServerIdentityId: string; endpointId: string; policy: IrohRelayPolicy }): Promise<IrohHomeTunnelLease>;
  releaseHomeTunnel(leaseId: string): Promise<void>;
}>;
