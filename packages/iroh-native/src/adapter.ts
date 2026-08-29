import { IrohError } from './errors';
import { getOptionalHappierIrohNativeModule } from './HappierIrohNative';
import type { IrohHomeTunnelLease, IrohNativeAdapter } from './types';

/** Lifecycle-only adapter boundary. Native implementations supply the byte carrier. */
export function createIrohNativeAdapter(native?: {
  ensureHomeTunnel(input: { homeServerIdentityId: string; endpointId: string; policy: 'automatic' | 'disabled' }): Promise<Omit<IrohHomeTunnelLease, 'release'>>;
  releaseHomeTunnel(leaseId: string): Promise<void>;
}): IrohNativeAdapter {
  const leases = new Map<string, IrohHomeTunnelLease>();
  return {
    async ensureHomeTunnel(input) {
      if (!native) throw new IrohError('unavailable', 'Native Iroh transport is unavailable.');
      const result = await native.ensureHomeTunnel(input);
      const lease: IrohHomeTunnelLease = { ...result, release: async () => { await native.releaseHomeTunnel(result.leaseId); leases.delete(result.leaseId); } };
      leases.set(lease.leaseId, lease);
      return lease;
    },
    async releaseHomeTunnel(leaseId) {
      const lease = leases.get(leaseId);
      if (lease) await lease.release();
      else if (native) await native.releaseHomeTunnel(leaseId);
    },
  };
}

/** Creates the optional mobile/desktop adapter without making native presence mandatory. */
export function createOptionalIrohNativeAdapter(): IrohNativeAdapter {
  const native = getOptionalHappierIrohNativeModule();
  return createIrohNativeAdapter(native ? {
    ensureHomeTunnel: async ({ homeServerIdentityId, endpointId, policy }) =>
      native.startHomeTunnel({ homeServerIdentityId, endpointId, relayPolicy: policy }),
    releaseHomeTunnel: (leaseId) => native.stopHomeTunnel(leaseId),
  } : undefined);
}
