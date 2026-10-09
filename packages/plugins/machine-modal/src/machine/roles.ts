import { Buffer } from 'node:buffer';
import type { MachineProvisionerObservationV1, MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createModalNativeProvider } from './provider.js';
import type { ModalNativeClient } from './nativeClient.js';
import { MODAL_ROLE_SCHEMAS, MODAL_RECONCILIATION_SCHEMAS, ModalOptionsInputV1Schema, ModalLaunchV1Schema } from './schemas.js';
import type { ModalNativeOperationV1 } from './schemas.js';

export const MODAL_PLUGIN_ID = 'happier.machine.modal';
export const MODAL_PROVISIONER_ID = 'modal';
export const MODAL_CONTRIBUTION_REF = { pluginId: MODAL_PLUGIN_ID, localId: MODAL_PROVISIONER_ID } as const;
export const MODAL_BILLING = { location: 'cloud', stoppedBilling: 'not-billed' } as const;

function bytes(value: string): Uint8Array {
  return Buffer.from(value, 'base64');
}
function unavailable(code: string): never {
  throw Object.assign(new Error('Modal native operation unavailable'), { code });
}

/** Native roles adapt facts only; managed custody, enrollment and policy remain host-owned. */
export function createModalProvisionerRoles(client: ModalNativeClient, observedAt: number, signal?: AbortSignal) {
  const native = createModalNativeProvider(client);
  const pending = (value: ModalNativeOperationV1) => ({ kind: 'pending' as const,
    nativeOperationRef: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value } });
  const cancelled = () => { if (signal?.aborted) unavailable('modal_operation_cancelled'); };
  async function inspect(input: unknown): Promise<MachineProvisionerObservationV1> {
    const { resource } = MODAL_ROLE_SCHEMAS.resourceInput.parse(input);
    const observation = await native.inspect(resource);
    if (observation.state === 'unknown') return { observedAt, availability: 'unavailable', reason: observation.code };
    if (observation.state === 'running') return { observedAt, availability: 'present', power: 'running', storage: 'retained', billing: MODAL_BILLING };
    // A terminal Sandbox cannot execute again or retain a usable filesystem;
    // snapshots are separate explicitly acquired resources, never Start.
    return { observedAt, availability: 'absent', storage: 'lost', billing: MODAL_BILLING };
  }
  return {
    async check() {
      return client.version() === '0.11.0' ? { available: true } : { available: false, code: 'modal_sdk_unsupported' };
    },
    async options(input: unknown = {}) {
      const complete = ModalLaunchV1Schema.safeParse(ModalOptionsInputV1Schema.parse(input));
      if (!complete.success) return { choices: [] };
      const launch = complete.data;
      const selected = await native.check({ appReference: launch.appReference });
      if (!selected.ok) unavailable(selected.code);
      // The SDK cannot enumerate Apps or registry images. Shared schema-backed
      // inputs supply the explicit reviewed variant; no fabricated native catalog.
      return { choices: [{ id: 'reviewed', title: launch.appReference, launch,
        nativeFacts: { image: { id: launch.imageReference, title: launch.imageReference },
          size: { id: `${launch.resources.cpu}:${launch.resources.memoryMb}`, title: `${launch.resources.cpu} CPU · ${launch.resources.memoryMb} MiB`,
            cpuCores: launch.resources.cpu, memoryBytes: launch.resources.memoryMb * 1024 * 1024 },
          duration: { id: String(launch.timeoutMs), title: `${launch.timeoutMs / 1000} s`, afterMs: launch.timeoutMs } },
      }] };
    },
    async reconcile(input: unknown) {
      cancelled();
      const parsed = MODAL_RECONCILIATION_SCHEMAS.input.parse(input);
      const nativeOperation = 'nativeOperation' in parsed ? parsed.nativeOperation
        : { appReference: parsed.correlation.launch.appReference, managedId: parsed.correlation.managedId };
      const recovered = await native.reconcile(nativeOperation);
      return recovered.ok ? { kind: 'bound' as const, resource: {
        contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value: recovered.resource,
      } } : pending(nativeOperation);
    },
    async acquire(input: unknown) {
      const parsed = MODAL_ROLE_SCHEMAS.acquireInput.safeParse(input);
      if (!parsed.success) return { kind: 'rejected' as const, code: 'invalid_request' as const };
      const result = await native.acquire(parsed.data.launch, signal, parsed.data.managedId);
      if (result.ok) return { kind: 'bound' as const, resource: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value: result.resource } };
      if (result.code === 'modal_acquisition_unknown') return parsed.data.managedId ? pending({
        appReference: parsed.data.launch.appReference, managedId: parsed.data.managedId,
      }) : { kind: 'unknown' as const, recovery: { reference: parsed.data.launch.appReference, reason: result.code } };
      return { kind: 'rejected' as const, code: result.code === 'modal_launch_invalid' ? 'invalid_request' as const : 'provider_unavailable' as const };
    },
    async bootstrap(input: unknown) {
      cancelled();
      const { resource } = MODAL_ROLE_SCHEMAS.bootstrapInput.parse(input);
      const observation = await native.inspect(resource);
      if (observation.state !== 'running') unavailable(observation.state === 'unknown' ? observation.code : 'modal_resource_ended');
      return { kind: 'native' as const, transport: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1 } };
    },
    inspect,
    async destroy(input: unknown): Promise<MachineProvisionerPowerResultV1> {
      cancelled();
      const parsed = MODAL_RECONCILIATION_SCHEMAS.destroyInput.parse(input);
      let resource;
      if ('resource' in parsed) resource = parsed.resource;
      else {
        const recovered = await native.reconcile(parsed.nativeOperation);
        if (!recovered.ok) return { kind: 'unknown', code: recovered.code };
        resource = recovered.resource;
      }
      const prior = await native.inspect(resource);
      if (prior.state === 'absent' || prior.state === 'ended') return { kind: 'confirmed' };
      if (prior.state === 'unknown') return { kind: 'unknown', code: prior.code };
      cancelled();
      const result = await native.terminate(resource);
      return result.state === 'absent' || result.state === 'ended' ? { kind: 'confirmed' } : { kind: 'unknown',
        ...(result.state === 'unknown' ? { code: result.code } : {}) };
    },
    async exec(input: unknown) {
      cancelled();
      const parsed = MODAL_ROLE_SCHEMAS.execInput.parse(input);
      const result = await native.exec(parsed.resource, { argv: parsed.argv,
        input: parsed.inputBase64 === undefined ? undefined : bytes(parsed.inputBase64), captureOutput: true,
        ...(parsed.timeoutMs == null ? {} : { timeoutMs: parsed.timeoutMs }) });
      if (!result.ok) unavailable(result.code);
      return { termination: { observed: { kind: 'exit' as const, exitCode: result.exitCode }, requestedBy: { kind: 'none' as const } },
        stdoutBase64: Buffer.from(result.stdout ?? new Uint8Array()).toString('base64'),
        stderrBase64: Buffer.from(result.stderr ?? new Uint8Array()).toString('base64'),
        stdoutTruncated: false, stderrTruncated: false };
    },
    async putFile(input: unknown): Promise<MachineProvisionerPowerResultV1> {
      cancelled();
      const parsed = MODAL_ROLE_SCHEMAS.putFileInput.parse(input);
      const result = await native.putFile(parsed.resource, { path: parsed.guestPath, bytes: bytes(parsed.bytesBase64), mode: parsed.mode ?? 0o600 });
      return result.ok ? { kind: 'confirmed' } : { kind: result.code === 'modal_file_invalid' || result.code === 'modal_resource_invalid'
        || result.code === 'modal_identity_mismatch' || result.code === 'modal_resource_ended' ? 'refused' : 'unknown', code: result.code };
    },
  };
}
