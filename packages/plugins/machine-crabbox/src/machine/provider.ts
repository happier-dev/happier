import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { decodeBase64, encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { MachineProvisionerAcquireResultV1, MachineProvisionerBootstrapCarrierV1, MachineProvisionerDestroyResultV1, MachineProvisionerObservationV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { observeMachineProvisionerNativeRead } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CrabboxCoordinatorClient, CrabboxNativeError } from './nativeClient.js';
import type { CrabboxHttp } from './nativeClient.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema } from './schemas.js';
import type { CrabboxLaunchV1, CrabboxResourceV1 } from './schemas.js';
import { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';

export { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';
const nativeContributionRef = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_PROVISIONER_ID };
export function crabboxLeaseId(managedId: string) {
  return `cbx_${computeSha256HexDigest(managedId).slice(0, 12)}`;
}
export function crabboxErrorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'native_transport_unknown';
}

/** A completed dependency observation, distinct from a failed host adapter. */
export class CrabboxDependencyUnavailable extends Error {
  readonly code = 'provider_unavailable';
  constructor() { super('Crabbox executable unavailable on this computer'); }
}

/** Vendor facts and exact native IO. The host owns admission, credentials,
 * retained connection custody, installation, trust and ordinary enrollment. */
export function createCrabboxProvider(options: Readonly<{
  connection: Readonly<{ endpoint: string; token: string; namespace: string }>;
  http?: CrabboxHttp; observedAt: number; signal?: AbortSignal;
  contributionRef?: PluginContributionRef;
}>) {
  const contributionRef = options.contributionRef ?? nativeContributionRef;
  const native = new CrabboxCoordinatorClient(options.connection, options.http);
  return {
    async reconcile(raw: CrabboxResourceV1): Promise<MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1>> {
      const parsed = CrabboxResourceV1Schema.safeParse(raw);
      if (!parsed.success) return { kind: 'rejected', code: 'invalid_request' };
      const resource = parsed.data;
      if (resource.transport !== 'coordinator') return { kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'native_route_unavailable' } };
      const pending = (error?: unknown): MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1> => ({ kind: 'pending',
        nativeOperationRef: { contributionRef, schemaVersion: 1, value: resource },
        ...(error instanceof CrabboxNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {}) });
      try {
        const observed = await native.inspect(resource, options.signal);
        // A native lease exists independently of guest readiness. Preserve
        // even a confirmed-ended lease so ordinary Inspect can show its loss.
        if (observed.leaseState === 'active' || observed.leaseState === 'pending' || observed.cleanup === 'confirmed') {
          return { kind: 'bound', resource: { contributionRef, schemaVersion: 1, value: observed.resource } };
        }
        return { ...pending(), ...(observed.nativeCause ? { nativeCause: observed.nativeCause } : {}) };
      } catch (error) {
        return crabboxErrorCode(error) === 'native_identity_mismatch' ? { kind: 'rejected', code: 'resource_mismatch' } : pending(error);
      }
    },
    async acquire(input: Readonly<{ launch: CrabboxLaunchV1; managedId?: string; bootstrapPublicKey?: string }>): Promise<MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1>> {
      const parsed = CrabboxLaunchV1Schema.safeParse(input.launch);
      if (!parsed.success || !input.managedId?.trim() || !input.bootstrapPublicKey) return { kind: 'rejected', code: 'invalid_request' };
      const launch = parsed.data;
      if (launch.transport !== 'coordinator' || launch.namespace !== options.connection.namespace) {
        return { kind: 'rejected', code: launch.transport !== 'coordinator' ? 'provider_unavailable' : 'resource_mismatch',
          ...(launch.transport !== 'coordinator' ? { nativeCause: { localCause: 'native_route_unavailable' as const } } : {}) };
      }
      // Native fixed identities are cbx_<6-byte hex>. The durable host tag,
      // never an invocation clock, slug or process-local occurrence, selects it.
      const leaseId = crabboxLeaseId(input.managedId);
      const resource = CrabboxResourceV1Schema.parse({ transport: launch.transport, backendId: launch.backendId, namespace: launch.namespace, leaseId });
      const result = await native.acquire(launch, resource, input.bootstrapPublicKey, options.signal);
      const cause = result.nativeCause ? { nativeCause: result.nativeCause } : {};
      if (result.status === 'refused') return { kind: 'rejected', code: 'provider_unavailable', ...cause };
      const reference = { contributionRef, schemaVersion: 1, value: result.resource };
      return result.status === 'allocated' ? { kind: 'bound', resource: reference }
        : { kind: 'pending', nativeOperationRef: reference, ...cause };
    },
    async bootstrap(input: Readonly<{ resource: CrabboxResourceV1; credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }> }>): Promise<MachineProvisionerBootstrapCarrierV1> {
      if (!input.credentialRef) throw Object.assign(new Error('retained bootstrap credential unavailable'), { code: 'credential_unavailable' });
      let endpoint;
      try { endpoint = await native.privateSshEndpoint(input.resource, options.signal); }
      catch (error) {
        if (error instanceof CrabboxNativeError) throw new PluginError({ code: error.code,
          ...(error.nativeCause ? { details: { nativeCause: error.nativeCause } } : {}) });
        throw error;
      }
      if (!endpoint) throw Object.assign(new Error('native SSH endpoint unavailable'), { code: 'provider_unavailable' });
      const encoded = endpoint.hostKey.trim().split(/\s+/)[1];
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw Object.assign(new Error('native SSH host key unavailable'), { code: 'provider_unavailable' });
      }
      const digest = computeSha256HexDigest(decodeBase64(encoded));
      const digestBytes = Uint8Array.from({ length: digest.length / 2 }, (_, index) => Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16));
      const fingerprint = `SHA256:${encodeBase64(digestBytes).replace(/=+$/, '')}`;
      return { kind: 'ssh', address: endpoint.host, user: endpoint.user, port: endpoint.port,
        hostKeyEvidence: { hostKey: endpoint.hostKey, fingerprint }, credentialRef: input.credentialRef };
    },
    async inspect(resource: CrabboxResourceV1): Promise<MachineProvisionerObservationV1> {
      try {
        const observed = await native.inspect(resource, options.signal);
        return observeMachineProvisionerNativeRead(options.observedAt, {
          kind: observed.cleanup === 'confirmed' ? 'absent' : observed.leaseState === 'active' || observed.leaseState === 'pending' ? 'present' : 'unknown',
          power: 'unknown', storage: observed.cleanup === 'confirmed' ? 'lost' : 'unknown',
          billing: { location: 'cloud', stoppedBilling: 'unknown' },
          ...(observed.cleanup === 'pending' ? { reason: 'native_cleanup_incomplete' } : {}),
          ...(observed.expiresAt === undefined ? {} : { nativeExpiry: observed.expiresAt }),
          ...(observed.nativeCause ? { nativeCause: observed.nativeCause } : {}) });
      } catch (error) { return observeMachineProvisionerNativeRead(options.observedAt, { kind: 'unknown', reason: crabboxErrorCode(error),
        ...(error instanceof CrabboxNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {}) }); }
    },
    async destroy(resource: CrabboxResourceV1): Promise<MachineProvisionerDestroyResultV1<CrabboxResourceV1>> {
      try {
        const result = await native.destroy(resource, options.signal);
        return { kind: result.cleanup === 'confirmed' ? 'confirmed' : result.cleanup === 'pending' ? 'pending' : 'unknown' };
      } catch (error) {
        const code = crabboxErrorCode(error);
        return { kind: code === 'native_identity_mismatch' ? 'refused' as const : 'unknown' as const, code,
          ...(error instanceof CrabboxNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {}) };
      }
    },
  };
}
