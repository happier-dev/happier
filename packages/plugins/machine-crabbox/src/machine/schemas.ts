import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerReconciliationSchemas, defineMachineProvisionerSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const cloudBackend = defineProtocolUnion([defineProtocolLiteral('aws'), defineProtocolLiteral('gcp'), defineProtocolLiteral('hetzner')]);
export const CrabboxBackendIdSchema = defineProtocolUnion([cloudBackend, defineProtocolLiteral('local-container'), defineProtocolLiteral('blacksmith-testbox')]);
// v0.71.0 worker/src/org-identity.ts: exact native label, not a slug.
const nativeNamespace = defineProtocolString({ minLength: 1, maxLength: 63, pattern: '^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$' });
const nativeString = defineProtocolString({ minLength: 1 });
const transport = defineProtocolUnion([defineProtocolLiteral('direct'), defineProtocolLiteral('coordinator')]);
const resourceShape = { namespace: nativeNamespace, nativeInstanceId: nativeString.optional(), transport };
const leaseId = defineProtocolString({ pattern: '^cbx_[0-9a-f]{12}$' });
const localRuntime = defineProtocolUnion([defineProtocolLiteral('docker'), defineProtocolLiteral('podman')]);

export const CrabboxResourceV1Schema = defineProtocolUnion([
  defineProtocolObject({ ...resourceShape, backendId: cloudBackend, leaseId }, closed),
  defineProtocolObject({ ...resourceShape, backendId: defineProtocolLiteral('local-container'), transport: defineProtocolLiteral('direct'),
    localContainerRuntime: localRuntime.optional(), leaseId }, closed),
  defineProtocolObject({ ...resourceShape, backendId: defineProtocolLiteral('blacksmith-testbox'), transport: defineProtocolLiteral('direct'),
    leaseId: defineProtocolString({ pattern: '^tbx_[A-Za-z0-9_-]+$' }) }, closed),
]);
export type CrabboxResourceV1 = ProtocolSchemaOutput<typeof CrabboxResourceV1Schema>;

const launchShape = {
  namespace: nativeNamespace, transport, nativeImageId: nativeString, nativeSizeId: nativeString,
  ttlSeconds: defineProtocolNumber({ integer: true, minimum: 1 }),
  idleTimeoutSeconds: defineProtocolNumber({ integer: true, minimum: 1 }),
};
export const CrabboxLaunchV1Schema = defineProtocolUnion([
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('aws'),
    target: defineProtocolUnion([defineProtocolLiteral('linux'), defineProtocolLiteral('macos')]) }, closed),
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('gcp'), target: defineProtocolLiteral('linux'),
    gcpProject: nativeString, gcpZone: nativeString }, closed),
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('hetzner'), target: defineProtocolLiteral('linux'), location: nativeString }, closed),
  defineProtocolObject({ namespace: nativeNamespace, nativeImageId: nativeString,
    ttlSeconds: launchShape.ttlSeconds, idleTimeoutSeconds: launchShape.idleTimeoutSeconds,
    localContainerRuntime: localRuntime.optional(),
    localContainerCpus: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    localContainerMemory: nativeString.optional(), backendId: defineProtocolLiteral('local-container'),
    transport: defineProtocolLiteral('direct'), target: defineProtocolLiteral('linux') }, closed),
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('blacksmith-testbox'),
    transport: defineProtocolLiteral('direct'), target: defineProtocolLiteral('linux') }, closed),
]);
export type CrabboxLaunchV1 = ProtocolSchemaOutput<typeof CrabboxLaunchV1Schema>;

export const CRABBOX_RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: CrabboxLaunchV1Schema,
  resource: CrabboxResourceV1Schema, nativeOperation: CrabboxResourceV1Schema });
export const CRABBOX_ROLE_SCHEMAS = { ...defineMachineProvisionerSchemas({ launch: CrabboxLaunchV1Schema,
  resource: CrabboxResourceV1Schema }), acquireResult: CRABBOX_RECONCILIATION.result };

// The canonical options Action exposes editable, reviewed native inputs. It
// returns a launch only when the whole selected native variant is valid.
export const CrabboxOptionsInputV1Schema = defineProtocolObject({
  backendId: CrabboxBackendIdSchema.optional(), transport: transport.optional(), namespace: nativeNamespace.optional(),
  target: defineProtocolUnion([defineProtocolLiteral('linux'), defineProtocolLiteral('macos')]).optional(),
  nativeImageId: nativeString.optional(), nativeSizeId: nativeString.optional(),
  ttlSeconds: launchShape.ttlSeconds.optional(), idleTimeoutSeconds: launchShape.idleTimeoutSeconds.optional(),
  gcpProject: nativeString.optional(), gcpZone: nativeString.optional(), location: nativeString.optional(),
  localContainerRuntime: localRuntime.optional(),
  localContainerCpus: defineProtocolNumber({ integer: true, minimum: 0 }).optional(), localContainerMemory: nativeString.optional(),
}, closed);

/** Retained form fields are a draft; only the active backend enters a launch. */
export function resolveCrabboxLaunchQueryCandidate(rawQuery: unknown) {
  const query = CrabboxOptionsInputV1Schema.parse(rawQuery);
  const common = { backendId: query.backendId, transport: query.transport, namespace: query.namespace,
    target: query.target, nativeImageId: query.nativeImageId,
    ttlSeconds: query.ttlSeconds, idleTimeoutSeconds: query.idleTimeoutSeconds };
  const candidate = query.backendId === 'local-container'
    ? { ...common,
      ...(query.localContainerRuntime === undefined ? {} : { localContainerRuntime: query.localContainerRuntime }),
      ...(query.localContainerCpus === undefined ? {} : { localContainerCpus: query.localContainerCpus }),
      ...(query.localContainerMemory === undefined ? {} : { localContainerMemory: query.localContainerMemory }) }
    : { ...common, nativeSizeId: query.nativeSizeId,
      ...(query.backendId === 'gcp' ? { gcpProject: query.gcpProject, gcpZone: query.gcpZone } : {}),
      ...(query.backendId === 'hetzner' ? { location: query.location } : {}) };
  return CrabboxLaunchV1Schema.safeParse(candidate);
}

// Persistence projections stay with the SDK/Protocol owner. Native ingress and
// writes retain the closed schemas above.
export const prepareCrabboxStoredSchemas = () => prepareMachineProvisionerStoredSchemas({
  launch: CrabboxLaunchV1Schema, resource: CrabboxResourceV1Schema,
  nativeOperation: CrabboxResourceV1Schema,
});
