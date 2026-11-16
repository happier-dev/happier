import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

// Modal 0.11.0 accepts milliseconds; native Sandboxes allow at most 24 hours.
export const MODAL_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MODAL_PREPARATION_HOME = '/opt/happier';
// Reference normalization belongs at the native query boundary, not in an
// unprojectable schema transform. Warm and stored/cold parsers stay identical.
const reference = defineProtocolString({ minLength: 1, pattern: '\\S' });
// The portable grammar preserves stored requests; native admission additionally
// checks the SDK encoder below before offering or creating reviewed compute.
const cpu = defineProtocolNumber({ minimum: 0.001 });
// modal-client@8f5ea792 js/src/sandbox.ts encodes Math.trunc(1000 * cpu).
// Refuse requests it changes, including floating-point boundaries like 1.001.
export function hasExactModalCpuEncoding(cpu: number) {
  return Math.trunc(1000 * cpu) / 1000 === cpu;
}
const memoryMb = defineProtocolNumber({ integer: true, minimum: 1 });
const timeoutMs = defineProtocolNumber({ integer: true, minimum: 1000, maximum: MODAL_MAX_TIMEOUT_MS, multipleOf: 1000 });
// modal@0.11.0 requires a positive whole-second idle timeout; it has no separate maximum.
const idleTimeoutMs = defineProtocolNumber({ integer: true, minimum: 1000, multipleOf: 1000 });
const closed = { policy: 'closed' } as const;

export const ModalCheckRequestV1Schema = defineProtocolObject({ appReference: reference }, closed);

export const ModalLaunchV1Schema = defineProtocolObject({
  imageReference: reference,
  preparedImageId: reference.optional(),
  appReference: reference,
  resources: defineProtocolObject({ cpu, memoryMb }, closed),
  timeoutMs,
  idleTimeoutMs: idleTimeoutMs.optional(),
}, closed);

// Native IDs are custody facts, not user-entered references. Never trim/alias a target.
const nativeId = defineProtocolString({ minLength: 1, pattern: '^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])' });
export const ModalResourceV1Schema = defineProtocolObject({ sandboxId: nativeId, appId: nativeId }, closed);
// Query selectors use executable launch paths so the shared Action fields owner
// can rehydrate and edit saved launches without a provider-specific mapping.
export const ModalOptionsInputV1Schema = defineProtocolObject({
  imageReference: reference.optional(),
  appReference: reference.optional(),
  resources: defineProtocolObject({ cpu: cpu.optional(), memoryMb: memoryMb.optional() }, closed).optional(),
  timeoutMs: timeoutMs.optional(),
  idleTimeoutMs: idleTimeoutMs.optional(),
}, closed);
// Read-only recovery retains the reviewed App reference and host row tag.
export const ModalNativeOperationV1Schema = defineProtocolObject({ appReference: reference, managedId: nativeId }, closed);
export const MODAL_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({
  launch: ModalLaunchV1Schema, resource: ModalResourceV1Schema, nativeOperation: ModalNativeOperationV1Schema,
});
export type ModalLaunchV1 = ProtocolSchemaOutput<typeof ModalLaunchV1Schema>;
export type ModalResourceV1 = ProtocolSchemaOutput<typeof ModalResourceV1Schema>;
export type ModalNativeOperationV1 = ProtocolSchemaOutput<typeof ModalNativeOperationV1Schema>;
export const MODAL_ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: ModalLaunchV1Schema, resource: ModalResourceV1Schema });
export const prepareModalStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: ModalLaunchV1Schema, resource: ModalResourceV1Schema, nativeOperation: ModalNativeOperationV1Schema });
