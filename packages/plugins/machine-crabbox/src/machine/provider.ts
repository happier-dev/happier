import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { MachineProvisionerAcquireResultV1, MachineProvisionerBootstrapCarrierV1, MachineProvisionerObservationV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CrabboxCoordinatorClient } from './nativeClient.js';
import type { CrabboxHttp } from './nativeClient.js';
import { CrabboxLaunchV1Schema, CrabboxResourceV1Schema } from './schemas.js';
import type { CrabboxLaunchV1, CrabboxResourceV1 } from './schemas.js';
import { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';

export { CRABBOX_PLUGIN_ID, CRABBOX_PROVISIONER_ID } from './constants.js';
const contributionRef = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_PROVISIONER_ID };
export function crabboxLeaseId(managedId: string) {
  return `cbx_${createHash('sha256').update(managedId).digest('hex').slice(0, 12)}`;
}
export function crabboxErrorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'native_transport_unknown';
}

/** Vendor facts and exact native IO. The host owns admission, credentials,
 * retained connection custody, installation, trust and ordinary enrollment. */
export function createCrabboxProvider(options: Readonly<{
  connection: Readonly<{ endpoint: string; token: string; namespace: string }>;
  http?: CrabboxHttp; observedAt: number; signal?: AbortSignal;
}>) {
  const native = new CrabboxCoordinatorClient(options.connection, options.http);
  return {
    async reconcile(raw: CrabboxResourceV1): Promise<MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1>> {
      const parsed = CrabboxResourceV1Schema.safeParse(raw);
      if (!parsed.success) return { kind: 'rejected', code: 'invalid_request' };
      const resource = parsed.data;
      if (resource.transport !== 'coordinator') return { kind: 'rejected', code: 'provider_unavailable' };
      const pending = (): MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1> => ({ kind: 'pending', nativeOperationRef: { contributionRef, schemaVersion: 1, value: resource } });
      try {
        const observed = await native.inspect(resource, options.signal);
        // A native lease exists independently of guest readiness. Preserve
        // even a confirmed-ended lease so ordinary Inspect can show its loss.
        if (observed.leaseState === 'active' || observed.leaseState === 'pending' || observed.cleanup === 'confirmed') {
          return { kind: 'bound', resource: { contributionRef, schemaVersion: 1, value: observed.resource } };
        }
        return pending();
      } catch (error) {
        return crabboxErrorCode(error) === 'native_identity_mismatch' ? { kind: 'rejected', code: 'resource_mismatch' } : pending();
      }
    },
    async acquire(input: Readonly<{ launch: CrabboxLaunchV1; managedId?: string; bootstrapPublicKey?: string }>): Promise<MachineProvisionerAcquireResultV1<CrabboxResourceV1, CrabboxResourceV1>> {
      const parsed = CrabboxLaunchV1Schema.safeParse(input.launch);
      if (!parsed.success || !input.managedId?.trim() || !input.bootstrapPublicKey) return { kind: 'rejected', code: 'invalid_request' };
      const launch = parsed.data;
      if (launch.transport !== 'coordinator' || launch.namespace !== options.connection.namespace) {
        return { kind: 'rejected', code: launch.transport !== 'coordinator' ? 'provider_unavailable' : 'resource_mismatch' };
      }
      // Native fixed identities are cbx_<6-byte hex>. The durable host tag,
      // never an invocation clock, slug or process-local occurrence, selects it.
      const leaseId = crabboxLeaseId(input.managedId);
      const resource = CrabboxResourceV1Schema.parse({ transport: launch.transport, backendId: launch.backendId, namespace: launch.namespace, leaseId });
      const result = await native.acquire(launch, resource, input.bootstrapPublicKey, options.signal);
      if (result.status === 'refused') return { kind: 'rejected', code: 'provider_unavailable' };
      const reference = { contributionRef, schemaVersion: 1, value: result.resource };
      return result.status === 'allocated' ? { kind: 'bound', resource: reference }
        : { kind: 'pending', nativeOperationRef: reference };
    },
    async bootstrap(input: Readonly<{ resource: CrabboxResourceV1; credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }> }>): Promise<MachineProvisionerBootstrapCarrierV1> {
      if (!input.credentialRef) throw Object.assign(new Error('retained bootstrap credential unavailable'), { code: 'credential_unavailable' });
      const endpoint = await native.privateSshEndpoint(input.resource, options.signal);
      if (!endpoint) throw Object.assign(new Error('native SSH endpoint unavailable'), { code: 'provider_unavailable' });
      const encoded = endpoint.hostKey.trim().split(/\s+/)[1];
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw Object.assign(new Error('native SSH host key unavailable'), { code: 'provider_unavailable' });
      }
      const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/, '')}`;
      return { kind: 'ssh', address: endpoint.host, user: endpoint.user, port: endpoint.port,
        hostKeyEvidence: { hostKey: endpoint.hostKey, fingerprint }, credentialRef: input.credentialRef };
    },
    async inspect(resource: CrabboxResourceV1): Promise<MachineProvisionerObservationV1> {
      try {
        const observed = await native.inspect(resource, options.signal);
        return { observedAt: options.observedAt,
          availability: observed.cleanup === 'confirmed' ? 'absent' : observed.leaseState === 'active' || observed.leaseState === 'pending' ? 'present' : 'unavailable',
          power: 'unknown', storage: observed.cleanup === 'confirmed' ? 'lost' : 'unknown',
          billing: { location: 'cloud', stoppedBilling: 'unknown' },
          ...(observed.expiresAt === undefined ? {} : { nativeExpiry: observed.expiresAt }) };
      } catch (error) { return { observedAt: options.observedAt, availability: 'unavailable', reason: crabboxErrorCode(error) }; }
    },
    async destroy(resource: CrabboxResourceV1) {
      try {
        const result = await native.destroy(resource, options.signal);
        return { kind: result.cleanup === 'confirmed' ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        const code = crabboxErrorCode(error);
        return { kind: code === 'native_identity_mismatch' ? 'refused' as const : 'unknown' as const, code };
      }
    },
  };
}
